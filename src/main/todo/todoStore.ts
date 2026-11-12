// 할 일 목록: 사용자와 라노가 함께 보는 미션별 굵직한 일. memory/todo.json 에 저장하고 기억 폴더와 함께 자동 커밋한다.
// 규칙: 완료(done)는 사용자만 표시한다. 라노와 앱은 대기·진행 중·확인 요청까지만 바꾼다.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Emit, RanoConfig, TodoItem, TodoStatus, TodoStoreApi } from '../../shared/types.js';
import { autoCommit } from '../memory/autoCommit.js';

const STATUSES: TodoStatus[] = ['waiting', 'active', 'review', 'done'];
export const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  waiting: '대기',
  active: '진행 중',
  review: '확인 요청',
  done: '완료',
};
const MAX_ITEMS = 200;
const MAX_TITLE = 120;

function cleanTitle(t: unknown): string {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1)}…` : s;
}

/** 할 일 하나의 단계(마일스톤) 수 한도 */
export const MAX_STEPS = 6;

export class TodoStore implements TodoStoreApi {
  private items: TodoItem[];
  private readonly file: string;
  private commitTimer: NodeJS.Timeout | null = null;
  private commitReasons: string[] = [];
  private commitQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: RanoConfig,
    private readonly emit: Emit,
  ) {
    this.file = path.join(config.memoryDir, 'todo.json');
    this.items = this.load();
    // 지난번에 저장 기록을 남기기 전에 앱이 꺼졌다면 지금 남긴다 (바뀐 게 없으면 아무 일도 하지 않음)
    if (config.autoCommit && this.items.length) {
      this.commitReasons.push('할 일 목록 (지난 실행에서 남은 변경)');
      this.commitTimer = setTimeout(() => this.flushCommit(), 3000);
    }
  }

  private load(): TodoItem[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
      const arr: unknown[] = Array.isArray(raw?.items) ? raw.items : [];
      return arr
        .filter((x): x is TodoItem => !!x && typeof (x as TodoItem).id === 'string' && typeof (x as TodoItem).title === 'string')
        .map((x) => ({ ...x, status: STATUSES.includes(x.status) ? x.status : 'waiting', queued: false, ...(Array.isArray(x.steps) ? { steps: x.steps.filter((s) => s && typeof s.title === 'string').map((s) => ({ title: s.title, done: !!s.done })).slice(0, MAX_STEPS) } : {}) }));
      // 앱이 꺼지면 줄 서 있던 과제는 사라지므로 queued 는 풀어 둔다
    } catch {
      return [];
    }
  }

  private missionOk(id: string | null): string | null {
    if (id === null || id === undefined || id === '') return null;
    if (!this.config.missions.some((m) => m.id === id)) {
      const ids = this.config.missions.map((m) => m.id).join(', ') || '없음';
      throw new Error(`"${id}" 미션을 찾지 못했어요. 등록된 미션: ${ids}`);
    }
    return id;
  }

  list(): TodoItem[] {
    return this.items.map((x) => ({ ...x }));
  }

  get(id: string): TodoItem | undefined {
    const x = this.items.find((i) => i.id === id);
    return x ? { ...x } : undefined;
  }

  add(missionId: string | null, title: string, by: 'user' | 'rano'): TodoItem {
    const t = cleanTitle(title);
    if (!t) throw new Error('할 일 제목이 비어 있어요');
    if (this.items.length >= MAX_ITEMS) throw new Error(`할 일은 ${MAX_ITEMS}개까지 둘 수 있어요. 완료한 일을 지운 뒤 다시 해 주세요`);
    const now = new Date().toISOString();
    const item: TodoItem = { id: randomUUID().slice(0, 8), missionId: this.missionOk(missionId), title: t, status: 'waiting', createdAt: now, updatedAt: now };
    this.items.push(item);
    this.changed(`${by === 'rano' ? '라노가' : '사용자가'} 할 일 추가: ${t}`);
    return { ...item };
  }

  update(id: string, patch: { title?: string; status?: TodoStatus; queued?: boolean; note?: string; taskId?: string; steps?: string[]; doneSteps?: number[]; undoneSteps?: number[] }, by: 'user' | 'rano' | 'app'): TodoItem {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`할 일 "${id}" 을(를) 찾지 못했어요`);
    const parts: string[] = [];
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) throw new Error(`알 수 없는 상태예요: ${String(patch.status)}`);
      if (patch.status === 'done' && by !== 'user') throw new Error('완료 표시는 사용자만 할 수 있어요. 사용자가 결과를 확인하도록 "확인 요청"으로 두세요');
      if (item.status === 'done' && by !== 'user') throw new Error('사용자가 완료로 표시한 일은 사용자만 되돌릴 수 있어요');
      if (patch.status !== item.status) {
        item.status = patch.status;
        item.doneAt = patch.status === 'done' ? new Date().toISOString() : undefined;
        if (patch.status !== 'active') item.queued = false;
        parts.push(`상태 ${TODO_STATUS_LABEL[patch.status]}`);
      }
    }
    if (patch.title !== undefined) {
      const t = cleanTitle(patch.title);
      if (!t) throw new Error('할 일 제목이 비어 있어요');
      if (t !== item.title) parts.push(`제목 "${t}"`);
      item.title = t;
    }
    // 단계(마일스톤): 목록을 새로 정하면 같은 이름의 단계는 끝남 표시를 이어 간다. 번호는 1부터
    if (patch.steps !== undefined) {
      const titles = [...new Set(patch.steps.map((t) => cleanTitle(String(t)).slice(0, 40)).filter(Boolean))].slice(0, MAX_STEPS);
      const old = item.steps ?? [];
      item.steps = titles.length ? titles.map((t) => ({ title: t, done: old.find((o) => o.title === t)?.done ?? false })) : undefined;
      parts.push(titles.length ? `단계 ${titles.length}개` : '단계 지움');
    }
    const mark = (nums: number[] | undefined, done: boolean) => {
      for (const n of nums ?? []) {
        const st = item.steps?.[n - 1];
        if (!st) throw new Error(`단계 ${n}번이 없어요 (이 할 일의 단계는 ${item.steps?.length ?? 0}개)`);
        // 마지막 단계는 사용자가 결과를 확인하는 단계라 사용자만 끝낼 수 있다
        if (done && by !== 'user' && n === item.steps!.length) throw new Error('마지막 단계는 사용자가 확인한 뒤 직접 표시해요. 사용자에게 확인을 부탁하세요');
        if (st.done !== done) {
          st.done = done;
          parts.push(`단계 "${st.title}" ${done ? '끝남' : '되돌림'}`);
        }
      }
    };
    mark(patch.doneSteps, true);
    mark(patch.undoneSteps, false);
    if (patch.queued !== undefined) item.queued = patch.queued && item.status === 'active';
    if (patch.note !== undefined) item.note = cleanTitle(patch.note) || undefined;
    if (patch.taskId !== undefined && by === 'app') item.taskId = patch.taskId || undefined; // 결과물 카드와 잇기(앱만)
    item.updatedAt = new Date().toISOString();
    const who = by === 'user' ? '사용자' : by === 'rano' ? '라노' : '앱';
    this.changed(parts.length ? `${who}: ${item.title} — ${parts.join(', ')}` : '', parts.length > 0);
    return { ...item };
  }

  move(id: string, dir: -1 | 1): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    // 같은 미션 안에서 옆 항목과 자리를 바꾼다
    const mission = this.items[i].missionId;
    let j = i + dir;
    while (j >= 0 && j < this.items.length && this.items[j].missionId !== mission) j += dir;
    if (j < 0 || j >= this.items.length) return;
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    this.changed(`할 일 순서 변경: ${this.items[j].title}`);
  }

  remove(id: string, by: 'user' | 'rano'): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`할 일 "${id}" 을(를) 찾지 못했어요`);
    const [gone] = this.items.splice(i, 1);
    this.changed(`${by === 'rano' ? '라노가' : '사용자가'} 할 일 삭제: ${gone.title}`);
  }

  describe(): string {
    if (!this.items.length) return '(아직 할 일이 없음)';
    const groups = new Map<string, TodoItem[]>();
    for (const x of this.items) {
      const key = x.missionId ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(x);
    }
    const out: string[] = [];
    for (const [key, list] of groups) {
      const name = key ? (this.config.missions.find((m) => m.id === key)?.name ?? key) : '미션 밖';
      out.push(`### ${name}${key ? ` (missionId: ${key})` : ''}`);
      for (const x of list) {
        const st = TODO_STATUS_LABEL[x.status] + (x.queued ? '·앞 과제 대기' : '');
        out.push(`- [${st}] ${x.title} (id: ${x.id})${x.note ? ` — ${x.note}` : ''}`);
        if (x.steps?.length) out.push(`    단계: ${x.steps.map((s, i) => `${i + 1}.${s.done ? '✓' : ''}${s.title}`).join(' → ')}`);
      }
    }
    return out.join('\n');
  }

  // 저장 → 화면 알림 → (잠깐 모아서) 자동 커밋
  private changed(reason: string, commit = true) {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2) + '\n', 'utf-8');
        renameSync(tmp, this.file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } catch (e) {
      console.error('[todo] 저장 실패:', e);
      this.emit({ kind: 'error', text: '할 일 목록을 저장하지 못했어요', at: new Date().toISOString() });
    }
    try {
      this.emit({ kind: 'todos', items: this.list() });
    } catch {
      // 창이 닫혀 있어도 계속
    }
    if (!commit || !reason || !this.config.autoCommit) return;
    this.commitReasons.push(reason);
    // 첫 변경 1.5초 뒤에 그동안 모인 변경을 한 번에 저장한다(계속 미루지 않음)
    if (!this.commitTimer) this.commitTimer = setTimeout(() => this.flushCommit(), 1500);
  }

  private flushCommit() {
    this.commitTimer = null;
    const reasons = this.commitReasons.splice(0);
    if (!reasons.length) return;
    const msg = reasons.length === 1 ? reasons[0] : `할 일 ${reasons.length}건 변경: ${reasons.slice(0, 3).join(' / ')}${reasons.length > 3 ? ' …' : ''}`;
    this.commitQueue = this.commitQueue
      .then(() => autoCommit(this.config.memoryDir, msg.slice(0, 200)))
      .catch((e) => console.error('[todo] 자동 저장 실패:', e));
  }
}
