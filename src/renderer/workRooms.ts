// 업무 방 목록(대화 화면 왼쪽): 한 가지 일에 딸린 과제·카드·보고·말을 한 방에서 본다 (0.9.15).
// "전체 대화"는 모든 말을 시간 순서로, 업무 방은 그 업무에 달린 것만 보인다.
import { el, mustGet } from './dom.js';

const STALE_MS = 20 * 60 * 60_000; // 이만큼 조용했던 업무는 "지난 업무"로 접는다
const SEEN_KEY = 'rano.workSeen';

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / (60 * 24))}일 전`;
}

/** 업무 색 점 + 이름 꼬리표. onPick 이 있으면 단추 */
export function workChip(w: { id: string; name: string; color: number }, onPick?: (id: string) => void): HTMLElement {
  const chip = el(onPick ? 'button' : 'span', `work-chip work-c${w.color % 6}`);
  if (onPick) {
    (chip as HTMLButtonElement).type = 'button';
    chip.title = `「${w.name}」 업무 방 열기`;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(w.id);
    });
  }
  chip.dataset.work = w.id;
  chip.appendChild(el('span', 'work-dot'));
  chip.appendChild(el('span', 'work-chip-text', w.name));
  return chip;
}

export class WorkRooms {
  private rano = window.rano;
  private works: Work[] = [];
  private byMsg = new Map<string, Work>();
  private byTask = new Map<string, Work>();
  private pending: ApprovalRequest[] = [];
  private runningIds = new Set<string>();
  private missionRunning = new Map<string, string[]>(); // 미션 → 진행 중 과제 id
  private room: string | null = null;
  private seen: Record<string, number> = {};
  private seenLoaded = false;
  private showOld = false;
  private renaming: string | null = null;
  private readonly box = mustGet<HTMLElement>('work-list');

  /** 방을 바꿨을 때(null = 전체 대화) */
  onRoom: (id: string | null) => void = () => {};
  /** 업무 목록·딸린 것이 바뀌었을 때(대화 목록의 꼬리표·거르기를 다시 맞춘다) */
  onChange: () => void = () => {};
  missionName: (id: string) => string | undefined = () => undefined;

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null');
      if (raw && typeof raw === 'object') {
        this.seen = raw as Record<string, number>;
        this.seenLoaded = true;
      }
    } catch {
      this.seen = {};
    }
    setInterval(() => this.render(), 60_000);
  }

  current(): string | null {
    return this.room;
  }
  get(id: string | null | undefined): Work | undefined {
    return id ? this.works.find((w) => w.id === id) : undefined;
  }
  ofMsg(msgId: string): Work | undefined {
    return this.byMsg.get(msgId);
  }
  ofTask(taskId: string | undefined): Work | undefined {
    return taskId ? this.byTask.get(taskId) : undefined;
  }

  setWorks(items: Work[]): void {
    if (!Array.isArray(items)) return;
    this.works = items.filter((w) => w && typeof w.id === 'string');
    this.byMsg.clear();
    this.byTask.clear();
    for (const w of this.works) {
      for (const id of w.msgIds ?? []) this.byMsg.set(id, w);
      for (const id of w.taskIds ?? []) this.byTask.set(id, w);
    }
    // 처음 받은 목록은 모두 본 것으로 친다(앱을 켤 때마다 새 표시가 쏟아지지 않게)
    if (!this.seenLoaded) {
      for (const w of this.works) this.seen[w.id] = w.msgIds.length;
      this.seenLoaded = true;
      this.saveSeen();
    }
    if (this.room && !this.get(this.room)) this.open(null);
    this.markSeen();
    this.render();
    this.onChange();
  }

  setApprovals(items: ApprovalRequest[]): void {
    if (!Array.isArray(items)) return;
    this.pending = items.filter((a) => a.status === 'pending');
    this.render();
  }

  setMission(s: MissionStatus): void {
    if (!s || typeof s.missionId !== 'string') return;
    const list = s.running?.length ? s.running : s.leaderState === 'working' && s.currentTask?.status === 'running' ? [s.currentTask] : [];
    this.missionRunning.set(s.missionId, list.map((t) => t.id));
    this.runningIds = new Set([...this.missionRunning.values()].flat());
    this.render();
  }

  open(id: string | null): void {
    const next = id && this.get(id) ? id : null;
    if (next === this.room) return;
    this.room = next;
    this.renaming = null;
    this.markSeen();
    this.render();
    this.onRoom(this.room);
  }

  private saveSeen(): void {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(this.seen));
    } catch {
      // 저장하지 못해도 화면은 그대로 쓴다
    }
  }

  /** 보고 있는 방(전체 대화면 모든 업무)의 말을 본 것으로 */
  private markSeen(): void {
    let changed = false;
    for (const w of this.works) {
      if (this.room !== null && this.room !== w.id) continue;
      if (this.seen[w.id] !== w.msgIds.length) {
        this.seen[w.id] = w.msgIds.length;
        changed = true;
      }
    }
    if (changed) this.saveSeen();
  }

  private waiting(w: Work): number {
    return this.pending.filter((a) => a.taskId && w.taskIds.includes(a.taskId)).length;
  }
  private running(w: Work): number {
    return w.taskIds.filter((t) => this.runningIds.has(t)).length;
  }
  private unread(w: Work): number {
    return Math.max(0, w.msgIds.length - (this.seen[w.id] ?? 0));
  }
  private isOld(w: Work): boolean {
    if (this.room === w.id) return false;
    if (w.archived) return true;
    return !this.waiting(w) && !this.running(w) && Date.now() - new Date(w.updatedAt).getTime() > STALE_MS;
  }

  private row(w: Work): HTMLElement {
    const row = el('div', `work-row work-c${w.color % 6}${this.room === w.id ? ' work-on' : ''}`);
    row.dataset.work = w.id;
    if (this.renaming === w.id) {
      const input = el('input', 'work-rename');
      input.value = w.name;
      input.maxLength = 24;
      input.setAttribute('aria-label', '업무 이름');
      const done = (save: boolean) => {
        if (this.renaming !== w.id) return;
        this.renaming = null;
        const name = input.value.trim();
        if (save && name && name !== w.name) void this.rano.workRename(w.id, name).catch(() => undefined);
        this.render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') done(true);
        else if (e.key === 'Escape') done(false);
      });
      input.addEventListener('blur', () => done(true));
      row.appendChild(el('span', 'work-dot'));
      row.appendChild(input);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      return row;
    }
    const main = el('button', 'work-main');
    main.type = 'button';
    main.setAttribute('aria-pressed', String(this.room === w.id));
    main.addEventListener('click', () => this.open(w.id));
    const top = el('span', 'work-top');
    top.appendChild(el('span', 'work-dot'));
    top.appendChild(el('span', 'work-name', w.name));
    const waiting = this.waiting(w);
    const running = this.running(w);
    const unread = this.unread(w);
    if (waiting) {
      const b = el('span', 'work-badge', String(waiting));
      b.title = `내 답을 기다리는 카드 ${waiting}장`;
      top.appendChild(b);
    } else if (unread) {
      const b = el('span', 'work-new');
      b.title = '새 말이 있어요';
      top.appendChild(b);
    }
    main.appendChild(top);
    const state = waiting ? '내 답을 기다려요' : running ? `진행 중${running > 1 ? ` ${running}건` : ''}` : unread ? '새 보고가 왔어요' : ago(w.updatedAt);
    const sub = el('span', `work-sub${waiting ? ' work-sub-wait' : running ? ' work-sub-run' : ''}`, [w.missionId ? (this.missionName(w.missionId) ?? w.missionId) : '', state].filter(Boolean).join(' · '));
    main.appendChild(sub);
    row.appendChild(main);
    const acts = el('span', 'work-acts');
    const ren = el('button', 'work-act', '✎');
    ren.type = 'button';
    ren.title = '이름 바꾸기';
    ren.setAttribute('aria-label', `${w.name} 이름 바꾸기`);
    ren.addEventListener('click', () => {
      this.renaming = w.id;
      this.render();
    });
    const arc = el('button', 'work-act', w.archived ? '↩' : '✓');
    arc.type = 'button';
    arc.title = w.archived ? '지난 업무에서 꺼내기' : '끝난 업무로 정리하기(지난 업무로 접혀요)';
    arc.setAttribute('aria-label', w.archived ? `${w.name} 꺼내기` : `${w.name} 정리하기`);
    arc.addEventListener('click', () => {
      if (!w.archived && this.room === w.id) this.open(null);
      void this.rano.workArchive(w.id, !w.archived).catch(() => undefined);
    });
    acts.append(ren, arc);
    row.appendChild(acts);
    return row;
  }

  render(): void {
    if (this.renaming && this.box.querySelector('.work-rename') === document.activeElement) return; // 이름을 적는 중에는 다시 그리지 않는다
    this.box.replaceChildren();
    this.box.appendChild(el('h2', 'work-heading', '업무'));
    const all = el('button', `work-all${this.room === null ? ' work-on' : ''}`);
    all.type = 'button';
    all.setAttribute('aria-pressed', String(this.room === null));
    all.appendChild(el('span', 'work-name', '전체 대화'));
    all.appendChild(el('span', 'work-sub', '라노와 나눈 모든 말'));
    all.addEventListener('click', () => this.open(null));
    this.box.appendChild(all);

    const rank = (w: Work) => (this.waiting(w) ? 0 : this.running(w) ? 1 : 2);
    const sorted = [...this.works].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
    const open = sorted.filter((w) => !this.isOld(w));
    const old = sorted.filter((w) => this.isOld(w));
    const list = el('div', 'work-rows');
    for (const w of open) list.appendChild(this.row(w));
    if (!open.length) list.appendChild(el('p', 'work-empty', '라노에게 일을 맡기면 여기에 업무 방이 생겨요.'));
    if (old.length) {
      const fold = el('button', 'work-fold', `${this.showOld ? '▾' : '▸'} 지난 업무 ${old.length}`);
      fold.type = 'button';
      fold.addEventListener('click', () => {
        this.showOld = !this.showOld;
        this.render();
      });
      list.appendChild(fold);
      if (this.showOld) for (const w of old.slice(0, 40)) list.appendChild(this.row(w));
    }
    this.box.appendChild(list);
  }
}
