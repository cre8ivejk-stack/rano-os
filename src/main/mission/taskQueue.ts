// 미션별 과제 대기열 기록: runs/missions/<id>/queue.json
// 리더에게 넘긴 과제를 시작 전(queued)·진행 중(running)으로 적어 두었다가 끝나면 지운다.
// 앱이 꺼졌다 켜지면 queued 는 이어서 맡기고, running 은 "하다 멈춘 과제"로 정리한다.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ChatAttachment, QueuedTaskView } from '../../shared/types.js';
import { oneLine } from './tracker.js';

export interface QueueEntry {
  id: string;
  text: string; // 리더에게 넘긴 지시 원문
  from: 'rano' | 'user';
  todoId?: string;
  state: 'queued' | 'running';
  queuedAt: string;
  resumed?: boolean;
  planFirst?: boolean; // 기획(안 선택) 먼저
  preSync?: boolean; // 사용자가 직접 받아오기를 시킴
  attachments?: ChatAttachment[]; // 사용자가 직접 지시하며 붙인 그림
}

export class TaskQueueStore {
  private entries: QueueEntry[];
  private readonly file: string;

  constructor(runsDir: string, missionId: string) {
    this.file = path.join(runsDir, 'missions', missionId, 'queue.json');
    this.entries = this.load();
  }

  private load(): QueueEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
      return (Array.isArray(raw?.entries) ? raw.entries : []).filter(
        (e: QueueEntry) => e && typeof e.id === 'string' && typeof e.text === 'string' && (e.state === 'queued' || e.state === 'running'),
      );
    } catch {
      return [];
    }
  }

  all(): QueueEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  add(e: { text: string; from: 'rano' | 'user'; todoId?: string; resumed?: boolean; planFirst?: boolean; preSync?: boolean; attachments?: ChatAttachment[] }): QueueEntry {
    const entry: QueueEntry = { id: randomUUID(), text: e.text, from: e.from, state: 'queued', queuedAt: new Date().toISOString(), ...(e.todoId ? { todoId: e.todoId } : {}), ...(e.resumed ? { resumed: true } : {}), ...(e.planFirst ? { planFirst: true } : {}), ...(e.preSync ? { preSync: true } : {}), ...(e.attachments?.length ? { attachments: e.attachments } : {}) };
    this.entries.push(entry);
    this.save();
    return { ...entry };
  }

  markRunning(id: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.state = 'running';
    this.save();
  }

  remove(id: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((x) => x.id !== id);
    if (this.entries.length !== before) this.save();
  }

  // 현황판에 보일 "기다리는 과제" (진행 중인 것은 빼고 받은 순서대로)
  view(): QueuedTaskView[] {
    return this.entries
      .filter((e) => e.state === 'queued')
      .map((e) => ({ title: oneLine(e.text.replace(/^\s*\[[^\]]{1,20}\]\s*/, ''), 60), from: e.from, queuedAt: e.queuedAt, ...(e.resumed ? { resumed: true } : {}) }));
  }

  private save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2), 'utf-8');
        renameSync(tmp, this.file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } catch (e) {
      console.error('[queue] 저장 실패:', e);
    }
  }
}
