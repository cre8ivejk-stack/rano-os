// 현황판의 사무실: 미션마다 방 하나. 일하는 방은 크게 맨 앞에, 쉬는 방은 작고 어둡게.
// 방 안의 도트 사람들이 상태에 따라 움직이고(타자·돋보기·손 들기·졸기), 말풍선에 과제 제목과 걸린 시간이 보인다.
// 승인을 기다리는 방에서는 그 자리에서 승인·반려할 수 있다.
import { SIMPLE_APPROVALS } from './chatNow.js';
import { el, formatTime, roleLabel } from './dom.js';

type ActorKind = 'lead' | 'member' | 'rano' | 'cat';
type ActorState = 'type' | 'review' | 'wait' | 'sleep' | 'rest' | 'idle';

const S = 3; // 도트 한 칸 크기(px)
const GW = 18;
const GH = 20;
const FRAME_MS = 380;
const DONE_GLOW_MS = 90_000; // 과제가 끝난 방에 고양이가 머무는 시간
const CONFETTI_MS = 2600;

/** 방 색(바닥·벽). 미션 순서대로 돌려 쓴다 */
const ROOM_COLORS: [string, string][] = [
  ['#f0e2c8', '#e3cfa6'],
  ['#dde8f2', '#bcd0e2'],
  ['#e3ead9', '#c5d3b3'],
  ['#eedfe9', '#dcc3d4'],
  ['#e9e4d6', '#d3ccb6'],
  ['#dfe9e8', '#bdd3d0'],
];
const SHIRTS = ['#33598c', '#b0683c', '#6b7f4f', '#8a6fb0', '#3f6b5c', '#a14f5f'];

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}
function elapsedText(iso: string): string {
  const m = minutesSince(iso);
  return m < 1 ? '방금 시작' : m < 60 ? `${m}분째` : `${Math.floor(m / 60)}시간 ${m % 60}분째`;
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, col: string) {
  ctx.fillStyle = col;
  ctx.fillRect(x * S, y * S, w * S, h * S);
}

function drawPerson(ctx: CanvasRenderingContext2D, kind: ActorKind, state: ActorState, col: string, f: number) {
  const bob = state === 'type' && f % 2 ? 1 : 0;
  const y = state === 'sleep' ? 4 : 2 + bob;
  const skin = '#f0c8a0';
  const hair = '#3a2a1e';
  const line = '#2b2b2b';
  px(ctx, 6, y, 6, 6, skin);
  px(ctx, 6, y, 6, 2, hair);
  px(ctx, 5, y + 1, 1, 3, hair);
  px(ctx, 12, y + 1, 1, 3, hair);
  if (state === 'sleep') {
    px(ctx, 7, y + 4, 2, 1, line);
    px(ctx, 10, y + 4, 2, 1, line);
  } else if (f % 8 !== 7) {
    px(ctx, 7, y + 3, 1, 1, line);
    px(ctx, 10, y + 3, 1, 1, line);
  }
  if (kind === 'lead') {
    px(ctx, 6, y - 2, 6, 2, '#e0a92b');
    px(ctx, 6, y - 3, 1, 1, '#e0a92b');
    px(ctx, 8, y - 3, 2, 1, '#e0a92b');
    px(ctx, 11, y - 3, 1, 1, '#e0a92b');
  }
  if (kind === 'rano') {
    // 머리띠 전화기
    px(ctx, 5, y + 2, 1, 2, line);
    px(ctx, 12, y + 2, 1, 2, line);
    px(ctx, 5, y - 1, 8, 1, line);
  }
  px(ctx, 5, y + 6, 8, 6, state === 'rest' ? '#a9a8a2' : col);
  if (state === 'type') {
    px(ctx, 4, y + 8 + (f % 2), 1, 3, skin);
    px(ctx, 13, y + 9 - (f % 2), 1, 3, skin);
  } else if (state === 'wait') {
    px(ctx, 13, y + 2 - (f % 2), 1, 5, skin);
    px(ctx, 4, y + 8, 1, 3, skin);
  } else if (state === 'review') {
    const d = f % 2;
    px(ctx, 13, y + 6, 1, 3, skin);
    px(ctx, 14, y + 3 + d, 3, 3, '#9fd0e8');
    px(ctx, 14, y + 3 + d, 3, 1, line);
    px(ctx, 14, y + 5 + d, 3, 1, line);
    px(ctx, 14, y + 3 + d, 1, 3, line);
    px(ctx, 16, y + 3 + d, 1, 3, line);
    px(ctx, 15, y + 6 + d, 1, 2, line);
    px(ctx, 4, y + 8, 1, 3, skin);
  } else {
    px(ctx, 4, y + 8, 1, 3, skin);
    px(ctx, 13, y + 8, 1, 3, skin);
  }
  // 책상과 모니터(사람 앞)
  px(ctx, 1, 15, 16, 2, '#a8743f');
  px(ctx, 1, 17, 16, 1, '#7d5226');
  px(ctx, 2, 18, 1, 2, '#7d5226');
  px(ctx, 15, 18, 1, 2, '#7d5226');
  px(ctx, 6, 11, 6, 4, line);
  px(ctx, 7, 12, 4, 2, state === 'sleep' || state === 'rest' || state === 'idle' ? '#44484f' : f % 4 < 2 ? '#bfe8c8' : '#d8f2dd');
}

function drawCat(ctx: CanvasRenderingContext2D, col: string, f: number) {
  const line = '#2b2b2b';
  const t = f % 4 < 2 ? 0 : 1;
  px(ctx, 4, 12, 9, 5, col);
  px(ctx, 11, 8, 5, 5, col);
  px(ctx, 11, 7, 1, 1, col);
  px(ctx, 15, 7, 1, 1, col);
  px(ctx, 12, 10, 1, 1, line);
  px(ctx, 14, 10, 1, 1, line);
  px(ctx, 2, 10 + t, 2, 1, col);
  px(ctx, 3, 11 + t, 1, 2, col);
  px(ctx, 5, 17, 2, 2, col);
  px(ctx, 10, 17, 2, 2, col);
}

function actorCanvas(kind: ActorKind, state: ActorState, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'fl-actor';
  c.width = GW * S;
  c.height = GH * S;
  c.dataset.kind = kind;
  c.dataset.state = state;
  c.dataset.color = color;
  return c;
}

export class FloorView {
  private statuses: MissionStatus[] = [];
  private pending: ApprovalRequest[] = [];
  private doneToday = 0;
  private outputsCount = 0;
  private ranoBusy = false;
  private visible = false;
  private selected: string | null = null;
  private frame = 0;
  private animTimer: number | null = null;
  private clockTimer: number | null = null;
  private busy = new Set<string>(); // 승인·반려를 보내는 중인 카드
  private prevRunning = new Map<string, Set<string>>(); // 미션 → 지난번에 돌던 과제 id
  private lastDone = new Map<string, number>(); // 미션 → 과제가 끝난 시각(ms)
  private confetti = new Map<string, number>(); // 미션 → 폭죽을 터뜨린 시각(ms)
  private readonly still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  /** 미션이 없을 때 "+ 새 미션"을 보일지 */
  showVacant = true;
  onLeaderClick: (missionId: string) => void = () => {};
  onApprovalsClick: (id?: string) => void = () => {};
  onOutputsClick: () => void = () => {};
  onNewMission: () => void = () => {};
  onUsageClick: () => void = () => {};

  constructor(private readonly root: HTMLElement) {
    root.classList.add('floor');
  }

  update(statuses: MissionStatus[]): void {
    // 과제가 끝난 방을 알아챈다(폭죽·고양이)
    for (const s of statuses) {
      const now = new Set(this.runningOf(s).map((t) => t.id));
      const before = this.prevRunning.get(s.missionId);
      if (before) {
        const ended = [...before].some((id) => !now.has(id));
        if (ended && s.currentTask?.status === 'done') {
          this.lastDone.set(s.missionId, Date.now());
          this.confetti.set(s.missionId, Date.now());
          window.setTimeout(() => this.render(), CONFETTI_MS + 50);
          window.setTimeout(() => this.render(), DONE_GLOW_MS + 50);
        }
      }
      this.prevRunning.set(s.missionId, now);
    }
    this.statuses = statuses;
    this.render();
  }

  setApprovals(items: ApprovalRequest[]): void {
    if (!Array.isArray(items)) return;
    this.pending = items.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.render();
  }

  /** 결과물 기록: 진열장 숫자와 "오늘 끝난 과제" */
  setOutputs(items: TaskOutput[]): void {
    if (!Array.isArray(items)) return;
    const today = new Date().toDateString();
    this.outputsCount = items.filter((x) => x.status === 'done').length;
    this.doneToday = items.filter((x) => x.status === 'done' && x.endedAt && new Date(x.endedAt).toDateString() === today).length;
    this.render();
  }

  setOutputsCount(n: number): void {
    this.outputsCount = n;
    this.render();
  }

  setRanoBusy(busy: boolean): void {
    if (this.ranoBusy === busy) return;
    this.ranoBusy = busy;
    this.render();
  }

  setSelected(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.render();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && !this.still && this.animTimer === null) this.animTimer = window.setInterval(() => this.tick(), FRAME_MS);
    if (!visible && this.animTimer !== null) {
      window.clearInterval(this.animTimer);
      this.animTimer = null;
    }
    // 걸린 시간·커피잔·창밖은 30초마다 새로
    if (visible && this.clockTimer === null) this.clockTimer = window.setInterval(() => this.render(), 30_000);
    if (!visible && this.clockTimer !== null) {
      window.clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (visible) this.render();
  }

  private runningOf(s: MissionStatus): MissionTask[] {
    return s.running?.length ? s.running : s.leaderState === 'working' && s.currentTask?.status === 'running' ? [s.currentTask] : [];
  }

  private tick() {
    this.frame++;
    this.paint();
  }

  private paint() {
    for (const c of Array.from(this.root.querySelectorAll<HTMLCanvasElement>('canvas.fl-actor'))) {
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      ctx.clearRect(0, 0, c.width, c.height);
      if (c.dataset.kind === 'cat') drawCat(ctx, c.dataset.color ?? '#e39a4a', this.frame);
      else drawPerson(ctx, (c.dataset.kind as ActorKind) ?? 'member', (c.dataset.state as ActorState) ?? 'idle', c.dataset.color ?? '#33598c', this.frame);
    }
  }

  private sky(): string {
    const h = new Date().getHours();
    return h >= 7 && h < 17 ? '#bfe0f5' : h >= 17 && h < 20 ? '#f3b98a' : '#2c3560';
  }

  private async decide(a: ApprovalRequest, decision: 'approve' | 'reject') {
    if (this.busy.has(a.id)) return;
    this.busy.add(a.id);
    this.render();
    try {
      await window.rano.approvalDecide(a.id, { decision });
    } catch {
      // 실패하면 띠가 그대로 남아 다시 누를 수 있다
    }
    this.busy.delete(a.id);
    this.render();
  }

  private seat(canvas: HTMLCanvasElement, name: string, say?: { title: string; sub: string }, mark?: 'bang' | 'zzz'): HTMLElement {
    const seat = el('div', 'fl-seat');
    if (say) {
      const b = el('div', 'fl-say');
      b.appendChild(el('span', 'fl-say-title', say.title));
      b.appendChild(el('small', undefined, say.sub));
      seat.appendChild(b);
    }
    const body = el('div', 'fl-body');
    if (mark === 'bang') body.appendChild(el('span', 'fl-bang', '!'));
    if (mark === 'zzz') body.appendChild(el('span', 'fl-zzz', 'z Z'));
    body.appendChild(canvas);
    seat.appendChild(body);
    seat.appendChild(el('span', 'fl-who', name));
    return seat;
  }

  private room(s: MissionStatus, index: number): HTMLElement {
    const running = this.runningOf(s);
    const working = running.length > 0;
    const mine = this.pending.filter((a) => a.missionId === s.missionId);
    const [fl, wl] = ROOM_COLORS[index % ROOM_COLORS.length];
    const shirt = SHIRTS[index % SHIRTS.length];
    const room = el('div', `fl-room${working ? ' fl-wide' : ' fl-dark'}${s.missionId === this.selected ? ' fl-sel' : ''}`);
    room.style.setProperty('--fl', fl);
    room.style.setProperty('--wl', wl);
    room.dataset.mission = s.missionId;
    room.tabIndex = 0;
    room.setAttribute('role', 'button');
    room.setAttribute('aria-label', `${s.name} 방. 누르면 자세한 내용과 리더 대화가 열려요`);
    room.addEventListener('click', () => this.onLeaderClick(s.missionId));
    room.addEventListener('keydown', (e) => {
      if (e.target === room && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.onLeaderClick(s.missionId);
      }
    });

    const wall = el('div', 'fl-wall');
    wall.appendChild(el('b', undefined, s.name));
    wall.appendChild(el('span', `fl-pill${working ? ' run' : ''}`, working ? (running.length > 1 ? `리더 ${running.length}명 일하는 중` : '리더 일하는 중') : '쉬는 중'));
    if (mine.length) wall.appendChild(el('span', 'fl-pill wait', `승인 대기 ${mine.length}`));
    if (s.queued?.length) wall.appendChild(el('span', 'fl-pill', `다음 과제 ${s.queued.length}`));
    wall.appendChild(el('span', 'fl-sp'));
    wall.appendChild(el('span', 'fl-win'));
    if (working) wall.appendChild(el('span', 'fl-win'));
    room.appendChild(wall);

    const floor = el('div', 'fl-floor');
    if (working) {
      running.forEach((t, i) => {
        const waiting = mine.some((a) => a.taskId === t.id) || (running.length === 1 && mine.length > 0);
        const members = (s.members ?? []).filter((m) => (m.taskId ? m.taskId === t.id : i === 0));
        const busyMembers = members.filter((m) => m.state === 'working' || m.state === 'reviewing');
        const what = waiting ? '승인 기다리는 중' : busyMembers.some((m) => m.state === 'reviewing') ? '검수 중' : busyMembers.length ? `팀원 ${busyMembers.length}명 작업 중` : '';
        const group = el('div', 'fl-group');
        group.appendChild(
          this.seat(
            actorCanvas('lead', waiting ? 'wait' : 'type', shirt),
            running.length > 1 ? `리더 ${i + 1}` : '리더',
            { title: t.title, sub: `${elapsedText(t.startedAt)}${what ? ` · ${what}` : ''}` },
            waiting ? 'bang' : undefined,
          ),
        );
        // 오래 걸리면 커피잔: 10분마다 하나(여섯 개까지)
        const cups = Math.min(6, Math.floor(minutesSince(t.startedAt) / 10));
        if (cups) {
          const box = el('div', 'fl-cups');
          box.title = `${elapsedText(t.startedAt)} (10분마다 커피잔 하나)`;
          for (let n = 0; n < cups; n++) box.appendChild(el('span', 'fl-cup'));
          group.appendChild(box);
        }
        for (const m of members.slice(0, 6)) {
          const st: ActorState = m.state === 'working' ? 'type' : m.state === 'reviewing' ? 'review' : 'rest';
          const label = roleLabel(m.role) || m.role;
          const stateText = m.state === 'working' ? '작업 중' : m.state === 'reviewing' ? '검수 중' : m.state === 'done' ? '끝남' : '대기';
          group.appendChild(this.seat(actorCanvas('member', st, m.state === 'reviewing' ? '#3f6b5c' : '#8a6fb0'), `${label} · ${stateText}`));
        }
        floor.appendChild(group);
      });
    } else {
      floor.appendChild(this.seat(actorCanvas('lead', 'sleep', shirt), '리더', undefined, 'zzz'));
      const last = s.currentTask;
      if (last) {
        const b = el('div', 'fl-say fl-last');
        b.appendChild(el('span', 'fl-say-title', `마지막: ${last.title.length > 48 ? `${last.title.slice(0, 48)}…` : last.title}`));
        b.appendChild(el('small', undefined, last.endedAt ? `${formatTime(last.endedAt)} ${last.status === 'failed' ? '중단' : '끝남'}` : last.status === 'failed' ? '중단' : ''));
        floor.appendChild(b);
      }
    }
    // 방금 끝난 방: 고양이가 와 있고, 폭죽이 잠깐 터진다
    const doneAt = this.lastDone.get(s.missionId) ?? 0;
    const props = el('div', 'fl-props');
    if (Date.now() - doneAt < DONE_GLOW_MS) props.appendChild(actorCanvas('cat', 'idle', '#e39a4a'));
    props.appendChild(el('span', 'fl-plant'));
    floor.appendChild(props);
    if (!this.still && Date.now() - (this.confetti.get(s.missionId) ?? 0) < CONFETTI_MS) {
      const burst = el('div', 'fl-confetti');
      for (let n = 0; n < 14; n++) {
        const p = el('i');
        p.style.setProperty('--x', `${(n * 37) % 100}%`);
        p.style.setProperty('--d', `${(n % 5) * 0.12}s`);
        p.style.setProperty('--c', ['#e0a92b', '#c96a4a', '#5d8fbf', '#6fa06a'][n % 4]);
        burst.appendChild(p);
      }
      room.appendChild(burst);
    }
    room.appendChild(floor);

    // 승인을 기다리는 방: 그 자리에서 승인·반려
    const a = mine[0];
    if (a) {
      const bar = el('div', 'fl-actbar');
      bar.addEventListener('click', (e) => e.stopPropagation());
      bar.appendChild(el('span', 'fl-act-text', `${a.who}가 손을 들고 있어요: ${a.title}${mine.length > 1 ? ` (외 ${mine.length - 1}건)` : ''}`));
      const simple = SIMPLE_APPROVALS.has(a.kind) && !a.decisionItems?.length && !a.bundle?.length;
      if (simple) {
        const ok = el('button', 'now-btn now-btn-main', '승인');
        ok.type = 'button';
        ok.disabled = this.busy.has(a.id);
        ok.addEventListener('click', () => void this.decide(a, 'approve'));
        const no = el('button', 'now-btn', '반려');
        no.type = 'button';
        no.disabled = this.busy.has(a.id);
        no.addEventListener('click', () => void this.decide(a, 'reject'));
        bar.append(ok, no);
      }
      const more = el('button', `now-btn${simple ? '' : ' now-btn-main'}`, simple ? '자세히' : '열어서 정하기');
      more.type = 'button';
      more.addEventListener('click', () => this.onApprovalsClick(a.id));
      bar.appendChild(more);
      room.appendChild(bar);
    }
    return room;
  }

  private chip(text: string, n: number | null, cls: string, onClick?: () => void): HTMLElement {
    const c = el(onClick ? 'button' : 'span', `fl-chip ${cls}`);
    if (onClick) {
      (c as HTMLButtonElement).type = 'button';
      c.addEventListener('click', onClick);
    }
    c.appendChild(document.createTextNode(text));
    if (n !== null) {
      c.appendChild(el('b', undefined, String(n)));
      c.appendChild(document.createTextNode('건'));
    }
    return c;
  }

  private render() {
    if (!this.visible) return;
    const root = this.root;
    root.style.setProperty('--sky', this.sky());
    const runningAll = this.statuses.reduce((n, s) => n + this.runningOf(s).length, 0);

    const sum = el('div', 'fl-sum');
    sum.appendChild(this.chip('진행 중 ', runningAll, runningAll ? 'run' : ''));
    sum.appendChild(this.chip('승인 대기 ', this.pending.length, this.pending.length ? 'wait' : '', () => this.onApprovalsClick()));
    sum.appendChild(this.chip('오늘 끝난 과제 ', this.doneToday, '', () => this.onOutputsClick()));

    const building = el('div', 'fl-building');
    // 일하는 방이 먼저(시작이 이른 순), 그다음 쉬는 방(등록 순)
    const indexed = this.statuses.map((s, i) => ({ s, i }));
    const workingRooms = indexed.filter((x) => this.runningOf(x.s).length > 0);
    const idleRooms = indexed.filter((x) => this.runningOf(x.s).length === 0);
    for (const x of [...workingRooms, ...idleRooms]) building.appendChild(this.room(x.s, x.i));
    if (idleRooms.length % 2 === 1) building.lastElementChild?.classList.add('fl-wide'); // 홀수면 마지막 쉬는 방이 줄을 채운다

    // 로비: 승인 창구, 라노, 소파와 고양이, 새 미션, 결과물 진열장
    const lobby = el('div', 'fl-lobby');
    const counter = el('button', 'fl-counter');
    counter.type = 'button';
    counter.title = '승인함으로 가기';
    counter.addEventListener('click', () => this.onApprovalsClick());
    counter.appendChild(el('span', `fl-bell${this.pending.length ? ' ringing' : ''}`));
    counter.appendChild(el('span', 'fl-deskbar'));
    counter.appendChild(el('span', 'fl-who', `승인 창구${this.pending.length ? ` ${this.pending.length}` : ''}`));
    lobby.appendChild(counter);
    lobby.appendChild(this.seat(actorCanvas('rano', this.ranoBusy ? 'type' : 'idle', '#3f6b5c'), '라노', this.ranoBusy ? { title: '생각하는 중', sub: '곧 답해요' } : undefined));
    const lounge = el('div', 'fl-counter');
    const catHere = !this.statuses.some((s) => Date.now() - (this.lastDone.get(s.missionId) ?? 0) < DONE_GLOW_MS);
    if (catHere) lounge.appendChild(actorCanvas('cat', 'idle', '#e39a4a'));
    lounge.appendChild(el('span', 'fl-sofa'));
    lobby.appendChild(lounge);
    lobby.appendChild(el('span', 'fl-sp'));
    if (this.showVacant) {
      const add = el('button', 'fl-chip', '+ 새 미션');
      (add as HTMLButtonElement).type = 'button';
      add.addEventListener('click', () => this.onNewMission());
      lobby.appendChild(add);
    }
    const shelf = el('button', 'fl-counter');
    shelf.type = 'button';
    shelf.title = '결과물함으로 가기';
    shelf.addEventListener('click', () => this.onOutputsClick());
    shelf.appendChild(el('span', 'fl-shelf'));
    shelf.appendChild(el('span', 'fl-who', `결과물 진열장 ${this.outputsCount}`));
    lobby.appendChild(shelf);
    building.appendChild(lobby);

    root.replaceChildren(sum, building);
    this.paint();
  }
}
