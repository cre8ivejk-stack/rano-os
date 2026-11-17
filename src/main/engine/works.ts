// 업무(대화 방): 한 가지 일에 딸린 과제·말을 한 줄기로 묶는다 (0.9.15).
// 과제 하나가 아니라 "김○○ 답장"처럼 사용자가 떠올리는 일 단위다. 라노가 일을 맡길 때 짧은 이름을 붙이고,
// 이어서 시킨 과제·승인 카드·보고·그 방에서 주고받은 말이 같은 업무에 달린다. 저장은 runs/rano/works.json 하나.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Work } from '../../shared/types.js';

export const WORK_NAME_MAX = 24;
const WORK_COLORS = 6;
const KEEP_WORKS = 300; // 이보다 많아지면 오래된 정리된 업무부터 지운다
const KEEP_MSGS = 2000; // 업무 하나에 달아 두는 말 id 수

/** 업무 이름 다듬기: 한 줄, 앞뒤 꾸밈 기호 떼기, 길면 자르기. 쓸 수 없으면 빈 글 */
export function cleanWorkName(v: unknown): string {
  const t = String(typeof v === 'string' ? v : '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s「『"'\[(]+|[\s」』"'\])]+$/g, '')
    .trim();
  return t.length > WORK_NAME_MAX ? `${t.slice(0, WORK_NAME_MAX - 1)}…` : t;
}

/** 지시문에서 업무 이름을 대신 만든다(라노가 이름을 주지 않았을 때) */
export function nameFromTask(title: string): string {
  const t = String(title ?? '')
    .replace(/^\[[^\]]{1,16}\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "로그인 화면 문구를 고쳐 주세요" → "로그인 화면 문구": 목적어 조사(을·를) 앞까지, 없으면 앞 16자(낱말 끝에서)
  const obj = /^(.{2,18}?)(을|를)\s/.exec(t)?.[1];
  const head = t.split(/[:：]/)[0].trim(); // "사과 점검: …" 처럼 제목을 먼저 적은 지시는 그 제목
  let cut = head.length >= 2 && head.length <= 18 && head !== t ? head : (obj ?? t.split(/[,.]/)[0].trim());
  if (cut.length > 16) cut = cut.slice(0, 16).replace(/\s+\S*$/, '') || cut.slice(0, 16);
  return cleanWorkName(cut) || '새 업무';
}

export class WorkStore {
  private items: Work[];
  private readonly file: string;
  private byTaskId = new Map<string, string>();

  constructor(
    runsDir: string,
    private readonly onChange: (items: Work[]) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.file = path.join(runsDir, 'rano', 'works.json');
    this.items = this.load();
    for (const w of this.items) for (const t of w.taskIds) this.byTaskId.set(t, w.id);
  }

  private load(): Work[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
      const list = Array.isArray(raw?.works) ? raw.works : [];
      return list
        .filter((w: Work) => w && typeof w.id === 'string' && typeof w.name === 'string')
        .map((w: Work) => ({
          id: w.id,
          name: cleanWorkName(w.name) || '업무',
          ...(typeof w.missionId === 'string' && w.missionId ? { missionId: w.missionId } : {}),
          color: Number.isInteger(w.color) ? w.color % WORK_COLORS : 0,
          createdAt: String(w.createdAt ?? ''),
          updatedAt: String(w.updatedAt ?? w.createdAt ?? ''),
          ...(w.archived === true ? { archived: true } : {}),
          taskIds: Array.isArray(w.taskIds) ? w.taskIds.filter((x) => typeof x === 'string') : [],
          msgIds: Array.isArray(w.msgIds) ? w.msgIds.filter((x) => typeof x === 'string') : [],
        }));
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ works: this.items }, null, 1), 'utf-8');
      renameSync(tmp, this.file);
    } catch (e) {
      console.error('[works] 저장 실패:', e);
    }
    try {
      this.onChange(this.list());
    } catch (e) {
      console.error('[works] 알림 실패:', e);
    }
  }

  list(): Work[] {
    return this.items.map((w) => ({ ...w, taskIds: [...w.taskIds], msgIds: [...w.msgIds] }));
  }

  get(id: string | undefined | null): Work | undefined {
    return id ? this.items.find((w) => w.id === id) : undefined;
  }

  byTask(taskId: string | undefined | null): Work | undefined {
    return taskId ? this.get(this.byTaskId.get(taskId)) : undefined;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  create(name: string, missionId?: string): Work {
    const at = this.stamp();
    const used = new Set(this.items.filter((w) => !w.archived).slice(-(WORK_COLORS - 1)).map((w) => w.color));
    let color = this.items.length % WORK_COLORS;
    for (let i = 0; i < WORK_COLORS && used.has(color); i++) color = (color + 1) % WORK_COLORS; // 요즘 업무와 색이 겹치지 않게
    const w: Work = { id: `w_${randomUUID().slice(0, 8)}`, name: cleanWorkName(name) || '새 업무', ...(missionId ? { missionId } : {}), color, createdAt: at, updatedAt: at, taskIds: [], msgIds: [] };
    this.items.push(w);
    if (this.items.length > KEEP_WORKS) {
      const drop = this.items.find((x) => x.archived) ?? this.items[0];
      this.items = this.items.filter((x) => x !== drop);
      for (const t of drop.taskIds) this.byTaskId.delete(t);
    }
    this.save();
    return { ...w };
  }

  /**
   * 맡길 과제가 달릴 업무를 정한다: 준 id 가 있으면 그 업무, 이름을 줬으면 새 업무(정리되지 않은 같은 이름·같은 미션이 있으면 그 업무),
   * 둘 다 없으면 이번 차례의 방(fallbackId), 그것도 없으면 지시문으로 이름을 지어 새 업무
   */
  resolve(opts: { workId?: string; workName?: string; missionId?: string; fallbackId?: string | null; title: string }): Work {
    const byId = this.get(opts.workId?.trim());
    if (byId) return byId;
    const name = cleanWorkName(opts.workName);
    if (name) {
      const same = this.items.find((w) => !w.archived && w.name === name && (!w.missionId || !opts.missionId || w.missionId === opts.missionId));
      return same ?? this.create(name, opts.missionId);
    }
    return this.get(opts.fallbackId) ?? this.create(nameFromTask(opts.title), opts.missionId);
  }

  private touch(w: Work): void {
    w.updatedAt = this.stamp();
    if (w.archived) delete w.archived; // 새 일이 달리면 다시 꺼낸다
  }

  linkTask(workId: string, taskId: string): void {
    const w = this.items.find((x) => x.id === workId);
    if (!w || !taskId || w.taskIds.includes(taskId)) return;
    w.taskIds.push(taskId);
    this.byTaskId.set(taskId, w.id);
    this.touch(w);
    this.save();
  }

  /** 말을 업무에 단다. 이미 다른 업무에 달린 말은 옮기지 않는다(옮기려면 force) */
  linkMsgs(workId: string | undefined | null, msgIds: string[], force = false): void {
    const w = this.items.find((x) => x.id === workId);
    if (!w) return;
    let changed = false;
    for (const id of msgIds) {
      if (!id || w.msgIds.includes(id)) continue;
      const other = this.items.find((x) => x !== w && x.msgIds.includes(id));
      if (other && !force) continue;
      if (other) other.msgIds = other.msgIds.filter((x) => x !== id);
      w.msgIds.push(id);
      changed = true;
    }
    if (!changed) return;
    if (w.msgIds.length > KEEP_MSGS) w.msgIds = w.msgIds.slice(-KEEP_MSGS);
    this.touch(w);
    this.save();
  }

  /** 그 말이 달린 업무 */
  ofMsg(msgId: string): Work | undefined {
    return this.items.find((w) => w.msgIds.includes(msgId));
  }

  rename(id: string, name: string): boolean {
    const w = this.items.find((x) => x.id === id);
    const n = cleanWorkName(name);
    if (!w || !n) return false;
    w.name = n;
    this.save();
    return true;
  }

  archive(id: string, on: boolean): boolean {
    const w = this.items.find((x) => x.id === id);
    if (!w) return false;
    if (on) w.archived = true;
    else delete w.archived;
    this.save();
    return true;
  }

  /** 라노에게 보여 줄 업무 목록(정리하지 않은 요즘 업무). running: 그 업무에서 지금 도는 과제 id */
  describe(running: (w: Work) => string[] = () => [], missionName: (id: string) => string = (id) => id, max = 12): string {
    const open = this.items.filter((w) => !w.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, max);
    if (!open.length) return '';
    const lines = open.map((w) => {
      const run = running(w);
      return `- ${w.id} · ${w.name}${w.missionId ? ` · ${missionName(w.missionId)}` : ''} · 과제 ${w.taskIds.length}건${run.length ? ` · 진행 중 ${run.join(', ')}` : ''}`;
    });
    return `[업무 목록] 사용자는 일을 "업무"로 묶어 봐요. 리더에게 맡길 때, 아래 업무에 이어지는 일이면 assign_to_mission 의 workId 에 그 id 를, 새 일이면 workName 에 짧은 이름을 넣으세요.\n${lines.join('\n')}`;
  }
}

/** 라노의 이번 차례가 어느 업무의 일인지(차례를 시작할 때 라노 세션이 적고, 맡기기 도구가 읽고 덧붙인다) */
export class WorkTurn {
  workId: string | null = null; // 이번 차례의 업무(그 방에서 한 말이거나 그 업무의 보고)
  userIds: string[] = []; // 이번 차례가 답하는 내 말
  assigned: string[] = []; // 이번 차례에 과제를 맡긴 업무들
  begin(workId: string | null, userIds: string[]): void {
    this.workId = workId;
    this.userIds = [...userIds];
    this.assigned = [];
  }
}

/** 업무 방에서 한 말 앞에 붙이는 안내(라노가 그 업무의 일로 다루게) */
export function roomNoteText(w: Work, running: { id: string; title: string }[], missionName?: string): string {
  const run = running.length ? ` 지금 이 업무에서 진행 중인 과제: ${running.map((t) => `「${t.title}」(taskId ${t.id})`).join(', ')}.` : ' 지금 이 업무에서 진행 중인 과제는 없어요.';
  return `[앱 안내] 사용자가 「${w.name}」 업무 방(workId ${w.id}${w.missionId ? `, 미션 ${missionName ?? w.missionId} = ${w.missionId}` : ''})에서 한 말이에요. 이 업무에 이어지는 말로 다루세요: 리더에게 맡길 때 assign_to_mission 의 workId 에 ${w.id} 를 넣고, 진행 중인 과제에 덧붙이는 말이면 tell_running_task 에 그 taskId 를 넣어 그 과제에만 전하세요. 다른 업무 이야기와 섞지 마세요.${run}`;
}
