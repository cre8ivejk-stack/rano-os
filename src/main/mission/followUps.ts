// 나중에 다시 확인하기(0.9.21): 리더가 오래 걸리는 바깥 작업(배포·시험 실행·일괄 처리)을 기다리지 않고
// "몇 분 뒤 다시 확인"을 예약하면, 그 시각에 앱이 같은 미션·같은 업무로 확인 과제를 맡긴다.
// 예약은 파일(runs/missions/<미션>/followups.json)에 남겨 앱을 다시 켜도 이어진다.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface FollowUp {
  id: string;
  dueAt: number; // 다시 확인할 시각(ms)
  what: string; // 무엇을 확인할지(리더가 적은 말)
  fromTaskId?: string; // 예약한 과제
  workId?: string;
  todoId?: string;
  round: number; // 이 업무에서 몇 번째 다시 확인인지(1부터)
}

export const FOLLOW_MIN_MINUTES = 3;
export const FOLLOW_MAX_MINUTES = 240;
/** 한 업무에서 이어서 예약할 수 있는 횟수: 끝없이 되풀이하지 않게 */
export const FOLLOW_MAX_ROUNDS = 8;

export class FollowUpStore {
  private items: FollowUp[];
  private readonly file: string;

  constructor(runsDir: string, missionId: string) {
    this.file = path.join(runsDir, 'missions', missionId, 'followups.json');
    this.items = this.load();
  }

  private load(): FollowUp[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
      return (Array.isArray(raw) ? raw : []).filter((x: FollowUp) => x && typeof x.id === 'string' && typeof x.what === 'string' && Number.isFinite(x.dueAt));
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.items, null, 1), 'utf-8');
    } catch {
      // 저장에 실패해도 이번 실행 동안은 기억한다
    }
  }

  all(): FollowUp[] {
    return this.items.map((x) => ({ ...x }));
  }

  /** 같은 업무(없으면 같은 과제)의 앞 예약은 새 예약으로 바꾼다 */
  add(x: Omit<FollowUp, 'id'>): FollowUp {
    const same = (y: FollowUp) => (x.workId ? y.workId === x.workId : !!x.fromTaskId && y.fromTaskId === x.fromTaskId);
    this.items = this.items.filter((y) => !same(y));
    const item = { id: randomUUID(), ...x };
    this.items.push(item);
    this.save();
    return item;
  }

  remove(id: string): void {
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
  }
}

/** "14:05" 같은 시각 글 */
export function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 다시 확인 과제의 지시 글 */
export function followUpTask(f: FollowUp): string {
  const title = `다시 확인: ${f.what.replace(/\s+/g, ' ').slice(0, 18)}`;
  return [
    `[제목: ${title.replace(/[\[\]]/g, ' ')}]`,
    '',
    `[앱 알림: 예약된 다시 확인 ${f.round}번째] 앞 과제에서 리더가 이 시각에 다시 확인하기로 예약한 일이에요.`,
    `확인할 것: ${f.what}`,
    '',
    `- 앞 과제의 보고는 past_reports 도구로 읽으세요${f.fromTaskId ? `(과제 id: ${f.fromTaskId.slice(0, 8)})` : ''}.`,
    '- 확인만 하고 짧게 보고하세요. 끝났으면 결과를, 문제가 있으면 무엇이 문제인지와 권장하는 다음 일을 적으세요.',
    `- 아직 끝나지 않았으면 check_later 로 다시 예약하고 지금 상태만 보고하세요(한 업무에 ${FOLLOW_MAX_ROUNDS}번까지). 오래 기다리며 붙잡고 있지 않아요.`,
    '- 새로 고치거나 커밋·배포하는 일은 이 과제에서 하지 않아요(필요하면 보고에 적어요).',
  ].join('\n');
}
