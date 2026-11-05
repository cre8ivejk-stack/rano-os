// 라노 오피스: 현황판 상태를 도트 사무실 그림으로 보여 준다.
// 그림(바닥·가구·캐릭터)은 캔버스에 점으로 그리고, 한글 이름표·말풍선·누르는 곳은 그 위에 HTML 로 얹는다.
// 외부 이미지·글꼴을 쓰지 않는다(앱 밖으로 나가는 연결 없음).
//
// 배치: 왼쪽 세로 통로 + 미션 방 격자(방마다 아래에 가로 복도) + 맨 아래 로비(승인 창구·라노 책상·결과물 진열장).
// 사람은 목적지가 바뀌면 문 → 복도 → 통로 → 로비 순서로 걸어간다.
import { el, roleLabel, toDate } from './dom.js';

// ---------- 크기(논리 픽셀) ----------
const ROOM_W = 132;
const ROOM_H = 100;
const WALL = 16;
const GAP = 6;
const HALL = 12; // 방 아래 가로 복도
const SHAFT = 14; // 왼쪽 세로 통로
const LOBBY_H = 80;
const MIN_W = 300; // 로비가 너무 좁아지지 않게
const SPEED = 3.6; // 한 번 움직일 때 걸음(논리 픽셀)
const TICK_MS = 90;

// ---------- 색 ----------
const C = {
  frame: '#b9b1a0',
  hall: '#cdc6b6',
  hallLine: '#bfb7a6',
  desk: '#a8784e',
  deskDark: '#86603e',
  chair: '#4a4f58',
  monitor: '#3b3f46',
  screenOff: '#5b6370',
  screenOn: '#8fd3ff',
  skin: '#f1c9a5',
  crown: '#f2c230',
  paper: '#fbfbf6',
  paperLine: '#c9c9c0',
  coffee: '#6b4a34',
  machine: '#7d8590',
  safe: '#6d737c',
  safeAlert: '#e0453a',
  check: '#3d9a50',
  plant: '#4f8a4f',
  plantDark: '#3c6e3c',
  pot: '#b0683c',
  wood: '#8a6242',
  woodDark: '#5e432d',
  folder: ['#4f7cc2', '#c25b4f', '#e0b43c', '#5aa36a', '#8b62b8', '#3d9a8a'],
  lobbyA: '#e7ebee',
  lobbyB: '#dde2e6',
  window: '#bfe0f2',
  windowNight: '#2c3a5a',
  night: 'rgba(18, 22, 46, 0.42)',
  lamp: 'rgba(255, 230, 150, 0.32)',
  sofa: '#c46a4f',
  sofaDark: '#9c5038',
  cat: '#e3a25a',
  glass: 'rgba(200, 230, 245, 0.55)',
};

// 방마다 다른 색 (미션 순서대로 돌아가며)
const THEMES = [
  { wall: '#d9d2c3', floorA: '#efe7d7', floorB: '#e7ddca', rug: '#c9705a', rugB: '#b5604c', poster: '#4f7cc2' },
  { wall: '#c9d6df', floorA: '#e9eef1', floorB: '#dfe6ea', rug: '#5a8fc9', rugB: '#4a7cb3', poster: '#e0b43c' },
  { wall: '#d5dfc8', floorA: '#eef2e6', floorB: '#e4eada', rug: '#7aa35a', rugB: '#668c4a', poster: '#c25b4f' },
  { wall: '#e2d0db', floorA: '#f3e9ef', floorB: '#eadde5', rug: '#b05a8f', rugB: '#984c7a', poster: '#3d9a8a' },
  { wall: '#e3dcc2', floorA: '#f4efdd', floorB: '#ebe4cd', rug: '#c99a3c', rugB: '#b0862f', poster: '#8b62b8' },
];

// 역할별 옷 색과 들고 있는 물건
type Prop = 'book' | 'laptop' | 'glass' | 'list' | 'chart' | 'none';
function roleLook(role: string): { shirt: string; hair: string; prop: Prop } {
  const r = role.toLowerCase();
  if (/review/.test(r)) return { shirt: '#7a5cc2', hair: '#3a2a20', prop: 'glass' };
  if (/verif|test/.test(r)) return { shirt: '#3d9a8a', hair: '#1f1f1f', prop: 'list' };
  if (/docs|writer/.test(r)) return { shirt: '#4f7cc2', hair: '#5a3a22', prop: 'book' };
  if (/dev|ui|code/.test(r)) return { shirt: '#d07a3a', hair: '#2a2a2a', prop: 'laptop' };
  if (/data|analyst|spark|optim/.test(r)) return { shirt: '#5aa36a', hair: '#704a2a', prop: 'chart' };
  return { shirt: '#8a8f99', hair: '#3a3a3a', prop: 'none' };
}

type Pose = 'type' | 'review' | 'sleep' | 'coffee' | 'wait' | 'done' | 'sit';

interface Spot {
  zone: string; // 'lobby' · 'hall' · 미션 id
  x: number;
  y: number;
}
type Step = (Spot & { carry?: boolean }) | { pause: number };

interface Actor {
  key: string;
  missionId: string;
  kind: 'leader' | 'member' | 'rano';
  role: string;
  label: string;
  pose: Pose; // 목적지에 도착했을 때 자세
  dest: Spot;
  shirt: string;
  hair: string;
  prop: Prop;
  crown: boolean;
  bubble?: string;
  info: string;
}

interface Walker extends Spot {
  path: Step[];
  destKey: string;
  carry: boolean;
  walking: boolean;
}

interface RoomLayout {
  missionId: string;
  index: number;
  x: number;
  y: number;
  row: number;
  status: MissionStatus;
  blocked: boolean;
  waitingWho: Set<string>;
}

// 방 안 자리 (방 왼쪽 위 기준, 사람 발 위치)
const LEADER_SPOT = { x: 66, y: 40 };
const DESK_SLOTS: [number, number][] = [
  [42, 62],
  [66, 62],
  [90, 62],
  [42, 86],
  [66, 86],
  [90, 86],
];
const BREAK_SLOTS: [number, number][] = [
  [118, 46],
  [118, 66],
  [118, 86],
  [126, 56],
];
const DOOR_X = 16; // 방 문(아래 벽 왼쪽)

function clip(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** 최근 활동에서 "지금 승인을 기다리는 사람"을 찾는다 (그 사람의 가장 최근 승인 관련 줄이 '기다리는 중'이면). */
function waitingPeople(s: MissionStatus): Set<string> {
  const out = new Set<string>();
  if (!s.pendingApprovals) return out;
  const seen = new Set<string>();
  const recent = [...(s.recent ?? [])].sort((a, b) => toDate(b.at).getTime() - toDate(a.at).getTime());
  for (const a of recent) {
    if (seen.has(a.who)) continue;
    if (/^승인을 기다리는 중/.test(a.text)) {
      out.add(a.who);
      seen.add(a.who);
    } else if (/^(승인됨|반려됨|수정 요청)/.test(a.text)) {
      seen.add(a.who);
    }
  }
  return out;
}

function recentlyBlocked(s: MissionStatus, now: number): boolean {
  return (s.recent ?? []).some((a) => /^차단/.test(a.text) && now - toDate(a.at).getTime() < 30_000);
}

const spotKey = (s: Spot) => `${s.zone}:${Math.round(s.x)}:${Math.round(s.y)}`;

export class OfficeView {
  private statuses: MissionStatus[] = [];
  private ranoBusy = false;
  private outputsCount = 0;
  private frame = 0;
  private timer: number | null = null;
  private visible = false;
  private scale = 3;
  private cols = 1;
  private rows = 1;
  private rooms: RoomLayout[] = [];
  private actors: Actor[] = [];
  private walkers = new Map<string, Walker>();
  private prevTask = new Map<string, { id: string; status: string } | null>();
  private sceneW = 0;
  private sceneH = 0;
  private lobbyTop = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly overlay: HTMLDivElement;
  private readonly infoEl: HTMLDivElement;
  private actorEls = new Map<string, { btn: HTMLButtonElement; name: HTMLDivElement; bubble?: HTMLDivElement }>();
  private infoTimer = 0;

  onLeaderClick: (missionId: string) => void = () => {};
  onApprovalsClick: () => void = () => {};
  onOutputsClick: () => void = () => {};

  constructor(private readonly root: HTMLElement) {
    root.replaceChildren();
    const stage = el('div', 'office-stage');
    this.canvas = el('canvas', 'office-canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.overlay = el('div', 'office-overlay');
    stage.append(this.canvas, this.overlay);
    this.infoEl = el('div', 'office-info');
    this.infoEl.hidden = true;
    root.append(stage, this.infoEl);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d 를 쓸 수 없어요');
    this.ctx = ctx;
    new ResizeObserver(() => this.layout()).observe(root);
    document.addEventListener('visibilitychange', () => this.syncTimer());
  }

  update(statuses: MissionStatus[]): void {
    this.statuses = statuses.filter((s) => s && typeof s.missionId === 'string');
    this.layout();
  }

  setRanoBusy(busy: boolean): void {
    if (this.ranoBusy === busy) return;
    this.ranoBusy = busy;
    this.layout();
  }

  setOutputsCount(n: number): void {
    if (this.outputsCount === n) return;
    this.outputsCount = n;
    this.layout();
  }

  /** 사무실이 화면에 보일 때만 움직인다 */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.layout();
    this.syncTimer();
  }

  private syncTimer() {
    const run = this.visible && !document.hidden;
    if (run && this.timer === null) {
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
    } else if (!run && this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick() {
    this.frame++;
    for (const w of this.walkers.values()) this.step(w);
    this.placeActorEls();
    this.draw();
  }

  // ---------- 배치 ----------
  private roomPos(i: number): { x: number; y: number; row: number } {
    const col = i % this.cols;
    const row = Math.floor(i / this.cols);
    return { x: SHAFT + GAP + col * (ROOM_W + GAP), y: GAP + row * (ROOM_H + HALL), row };
  }

  private geometryKey = '';

  private layout() {
    const width = this.root.clientWidth || 800;
    const height = this.root.clientHeight || 600;
    const n = Math.max(1, this.statuses.length);
    // 한 줄에 놓을 방 수를 바꿔 보며 화면에 가장 크게 들어가는 배치를 고른다 (방이 늘면 한 줄에 4개까지)
    let best = { cols: 1, scale: 0 };
    for (let cols = 1; cols <= Math.min(n, 4); cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.max(MIN_W, SHAFT + GAP + cols * (ROOM_W + GAP));
      const h = GAP + rows * (ROOM_H + HALL) + LOBBY_H;
      const fit = Math.floor(Math.min(width / w, height / h) * 2) / 2;
      if (fit > best.scale || (fit === best.scale && cols > best.cols)) best = { cols, scale: fit };
    }
    this.cols = best.cols;
    this.rows = Math.ceil(n / this.cols);
    this.sceneW = Math.max(MIN_W, SHAFT + GAP + this.cols * (ROOM_W + GAP));
    this.lobbyTop = GAP + this.rows * (ROOM_H + HALL);
    this.sceneH = this.lobbyTop + LOBBY_H;
    this.scale = Math.max(2, Math.min(4, best.scale));
    this.canvas.width = this.sceneW;
    this.canvas.height = this.sceneH;
    this.canvas.style.width = `${this.sceneW * this.scale}px`;
    this.canvas.style.height = `${this.sceneH * this.scale}px`;
    this.overlay.style.width = this.canvas.style.width;
    this.overlay.style.height = this.canvas.style.height;

    const now = Date.now();
    this.rooms = this.statuses.map((s, i) => ({
      missionId: s.missionId,
      index: i,
      ...this.roomPos(i),
      status: s,
      blocked: recentlyBlocked(s, now),
      waitingWho: waitingPeople(s),
    }));
    this.actors = this.buildActors();
    // 방 배치가 바뀌면(창 크기·미션 수) 걸어가지 말고 모두 제자리로 옮긴다
    const geo = `${this.cols}:${this.sceneW}:${this.statuses.map((s) => s.missionId).join(',')}`;
    if (geo !== this.geometryKey) {
      this.geometryKey = geo;
      this.walkers.clear();
    }
    this.syncWalkers();
    this.detectErrands();
    this.renderOverlay();
    this.draw();
  }

  // 로비 안 고정 위치
  private readonly counterX = 14;
  private queueSpot(i: number): Spot {
    return { zone: 'lobby', x: 70 + i * 11, y: this.lobbyTop + 60 };
  }
  private ranoDesk(): Spot {
    return { zone: 'lobby', x: Math.floor(this.sceneW / 2) + 10, y: this.lobbyTop + 46 };
  }
  private cabinetSpot(): Spot {
    return { zone: 'lobby', x: this.sceneW - 64, y: this.lobbyTop + 58 };
  }

  private buildActors(): Actor[] {
    const out: Actor[] = [];
    let q = 0; // 승인 창구 줄 순서
    for (const room of this.rooms) {
      const s = room.status;
      const leaderName = `${s.name} 리더`;
      const working = s.leaderState === 'working';
      const leaderWaiting = room.waitingWho.has(leaderName);
      const task = s.currentTask;
      out.push({
        key: `${s.missionId}:leader`,
        missionId: s.missionId,
        kind: 'leader',
        role: 'leader',
        label: leaderName,
        pose: leaderWaiting ? 'wait' : working ? 'type' : 'sleep',
        dest: leaderWaiting ? this.queueSpot(q++) : { zone: s.missionId, x: room.x + LEADER_SPOT.x, y: room.y + LEADER_SPOT.y },
        shirt: '#2f4f6f',
        hair: '#2a2a2a',
        prop: 'none',
        crown: true,
        bubble: leaderWaiting ? `${s.name} 승인 대기` : working && task ? clip(task.title, 10) : undefined,
        info: `${leaderName} · ${working ? '일하는 중' : '쉬는 중'}${task ? `\n${task.status === 'running' ? '진행 중' : '최근'} 과제: ${clip(task.title, 60)}` : ''}${s.queued?.length ? `\n다음 과제 ${s.queued.length}건` : ''}\n누르면 리더와 대화할 수 있어요`,
      });
      let breakIdx = 0;
      s.members.slice(0, DESK_SLOTS.length).forEach((m, i) => {
        const look = roleLook(m.role);
        const waiting = room.waitingWho.has(m.role);
        let pose: Pose;
        if (waiting) pose = 'wait';
        else if (m.state === 'working') pose = 'type';
        else if (m.state === 'reviewing') pose = 'review';
        else if (m.state === 'done') pose = 'done';
        else pose = 'coffee';
        let dest: Spot;
        if (pose === 'wait') dest = this.queueSpot(q++);
        else if (pose === 'coffee') {
          const b = BREAK_SLOTS[breakIdx++ % BREAK_SLOTS.length];
          dest = { zone: s.missionId, x: room.x + b[0], y: room.y + b[1] };
        } else dest = { zone: s.missionId, x: room.x + DESK_SLOTS[i][0], y: room.y + DESK_SLOTS[i][1] };
        const stateText = { idle: '대기', working: '작업 중', reviewing: '검수 중', done: '완료' }[m.state] ?? m.state;
        out.push({
          key: `${s.missionId}:${m.role}`,
          missionId: s.missionId,
          kind: 'member',
          role: m.role,
          label: roleLabel(m.role) ?? m.role,
          pose,
          dest,
          ...look,
          crown: false,
          // 작업 중인 것은 동작·켜진 화면으로 보여 주고, 말풍선은 승인 대기 때만 (작업 내용은 누르면 보임)
          bubble: waiting ? `${s.name} 승인 대기` : undefined,
          info: `${s.name} · ${m.role}${roleLabel(m.role) ? ` (${roleLabel(m.role)})` : ''} · ${waiting ? '승인 기다리는 중' : stateText}${m.task ? `\n${clip(m.task, 60)}` : ''}`,
        });
      });
    }
    out.push({
      key: 'rano',
      missionId: '',
      kind: 'rano',
      role: 'rano',
      label: '라노',
      pose: this.ranoBusy ? 'type' : 'sit',
      dest: this.ranoDesk(),
      shirt: '#3f6b5c',
      hair: '#1f1f1f',
      prop: 'none',
      crown: false,
      bubble: this.ranoBusy ? '생각하는 중' : undefined,
      info: `라노 · ${this.ranoBusy ? '생각하는 중' : '대기'}\n미션 리더들에게 일을 나눠 주는 리더예요`,
    });
    return out;
  }

  // 목적지가 바뀐 사람만 길을 새로 잡는다
  private syncWalkers() {
    const keep = new Set<string>();
    for (const a of this.actors) {
      keep.add(a.key);
      const key = spotKey(a.dest);
      const w = this.walkers.get(a.key);
      if (!w) {
        this.walkers.set(a.key, { ...a.dest, path: [], destKey: key, carry: false, walking: false });
      } else if (w.destKey !== key) {
        w.destKey = key;
        w.path = this.route(w, a.dest);
      }
    }
    for (const k of [...this.walkers.keys()]) if (!keep.has(k)) this.walkers.delete(k);
  }

  // 새 과제 배정 → 라노가 서류를 들고 그 방 문까지 / 과제 완료 → 리더가 결과물을 들고 진열장까지
  private detectErrands() {
    for (const room of this.rooms) {
      const t = room.status.currentTask;
      const prev = this.prevTask.get(room.missionId);
      const now = t ? { id: t.id, status: t.status } : null;
      if (prev !== undefined && t) {
        if ((!prev || prev.id !== t.id) && t.status === 'running' && t.from === 'rano') this.errandRano(room);
        else if (prev && prev.id === t.id && prev.status === 'running' && t.status === 'done' && !t.stoppedByRejection) this.errandDeliver(room);
      }
      this.prevTask.set(room.missionId, now);
    }
  }

  private doorIn(room: RoomLayout): Spot {
    return { zone: room.missionId, x: room.x + DOOR_X, y: room.y + ROOM_H - 6 };
  }

  private errandRano(room: RoomLayout) {
    const w = this.walkers.get('rano');
    if (!w) return;
    const door = this.doorIn(room);
    const home = this.ranoDesk();
    const go = this.route(w, door).map((p) => ({ ...p, carry: true }));
    w.path = [...go, { pause: 10 }, ...this.route(door, home)];
  }

  private errandDeliver(room: RoomLayout) {
    const w = this.walkers.get(`${room.missionId}:leader`);
    if (!w) return;
    const cab = this.cabinetSpot();
    const desk: Spot = { zone: room.missionId, x: room.x + LEADER_SPOT.x, y: room.y + LEADER_SPOT.y };
    const go = this.route(w, cab).map((p) => ({ ...p, carry: true }));
    w.path = [...go, { pause: 10 }, ...this.route(cab, desk)];
  }

  // 길 찾기: 방 안은 ㄱ자로, 방 밖은 문 → 가로 복도 → 왼쪽 통로 → (다른 방 복도 또는 로비)
  private route(from: Spot, to: Spot): Spot[] {
    const shaftX = Math.floor(SHAFT / 2) + 2;
    const lane = this.lobbyTop + 10;
    const roomOf = (z: string) => this.rooms.find((r) => r.missionId === z);
    const hallY = (r: RoomLayout) => r.y + ROOM_H + Math.floor(HALL / 2);
    const out: Spot[] = [];
    const push = (zone: string, x: number, y: number) => out.push({ zone, x, y });
    if (from.zone === to.zone) {
      push(to.zone, to.x, from.y);
      push(to.zone, to.x, to.y);
      return out;
    }
    // 출발: 방이면 문 밖 복도까지
    const fromRoom = roomOf(from.zone);
    let cur: { x: number; y: number };
    if (fromRoom) {
      const d = this.doorIn(fromRoom);
      push(from.zone, from.x, d.y);
      push(from.zone, d.x, d.y);
      push('hall', d.x, hallY(fromRoom));
      cur = { x: d.x, y: hallY(fromRoom) };
    } else if (from.zone === 'lobby') {
      push('lobby', from.x, lane);
      cur = { x: from.x, y: lane };
    } else {
      cur = { x: from.x, y: from.y };
    }
    const toRoom = roomOf(to.zone);
    if (toRoom) {
      const d = this.doorIn(toRoom);
      const hy = hallY(toRoom);
      if (!(fromRoom && fromRoom.row === toRoom.row)) {
        push('hall', shaftX, cur.y);
        push('hall', shaftX, hy);
      }
      push('hall', d.x, hy);
      push(to.zone, d.x, d.y);
      push(to.zone, to.x, d.y);
      push(to.zone, to.x, to.y);
    } else {
      push('hall', shaftX, cur.y);
      push('hall', shaftX, lane);
      push('lobby', to.x, lane);
      push('lobby', to.x, to.y);
    }
    return out;
  }

  private step(w: Walker) {
    const next = w.path[0];
    if (!next) {
      w.walking = false;
      w.carry = false;
      return;
    }
    if ('pause' in next) {
      w.walking = false;
      w.carry = false;
      next.pause -= 1;
      if (next.pause <= 0) w.path.shift();
      return;
    }
    const dx = next.x - w.x;
    const dy = next.y - w.y;
    const dist = Math.hypot(dx, dy);
    w.walking = true;
    w.carry = !!next.carry;
    if (dist <= SPEED) {
      w.x = next.x;
      w.y = next.y;
      w.zone = next.zone;
      w.path.shift();
    } else {
      w.x += (dx / dist) * SPEED;
      w.y += (dy / dist) * SPEED;
    }
  }

  // ---------- 글자·누르는 곳 ----------
  private place(node: HTMLElement, x: number, y: number) {
    node.style.left = `${x * this.scale}px`;
    node.style.top = `${y * this.scale}px`;
    this.overlay.appendChild(node);
  }

  private renderOverlay() {
    const S = this.scale;
    this.overlay.replaceChildren();
    this.actorEls.clear();

    for (const room of this.rooms) {
      const s = room.status;
      const title = el('div', `office-room-title${s.leaderState === 'working' ? ' working' : ''}`);
      title.appendChild(el('span', 'office-room-name', s.name));
      title.appendChild(el('span', 'office-room-state', s.leaderState === 'working' ? '일하는 중' : '쉬는 중'));
      this.place(title, room.x + 3, room.y + 2);
      if (s.queued?.length) {
        const q = el('div', 'office-tag', `다음 ${s.queued.length}`);
        q.title = `다음 과제\n${s.queued.map((x, i) => `${i + 1}. ${x.title}`).join('\n')}`;
        this.place(q, room.x + 30, room.y + 25);
      }
      if (room.blocked) this.place(el('div', 'office-tag alert', '차단됨'), room.x + ROOM_W - 42, room.y + ROOM_H - 12);
    }

    // 로비: 승인 창구, 결과물 진열장
    const L = this.lobbyTop;
    const pending = this.rooms.reduce((n, r) => n + (r.status.pendingApprovals ?? 0), 0);
    const counter = el('button', `office-hot office-counter${pending ? ' has' : ''}`);
    counter.type = 'button';
    counter.title = `승인 창구 · 기다리는 요청 ${pending}건\n누르면 승인함으로 가요`;
    counter.setAttribute('aria-label', `승인 창구, 기다리는 요청 ${pending}건`);
    counter.style.width = `${48 * S}px`;
    counter.style.height = `${34 * S}px`;
    if (pending) counter.appendChild(el('span', 'office-badge', String(pending)));
    counter.addEventListener('click', () => this.onApprovalsClick());
    this.place(counter, this.counterX - 2, L + 16);
    this.place(el('div', 'office-sign', '승인 창구'), this.counterX, L + 14);

    const cabX = this.sceneW - 58;
    const cab = el('button', 'office-hot office-cabinet');
    cab.type = 'button';
    cab.title = `결과물 진열장 · 끝난 과제 ${this.outputsCount}건\n누르면 결과물함으로 가요`;
    cab.setAttribute('aria-label', `결과물 진열장, 끝난 과제 ${this.outputsCount}건`);
    cab.style.width = `${46 * S}px`;
    cab.style.height = `${46 * S}px`;
    if (this.outputsCount) cab.appendChild(el('span', 'office-badge soft', String(this.outputsCount)));
    cab.addEventListener('click', () => this.onOutputsClick());
    this.place(cab, cabX - 2, L + 12);
    this.place(el('div', 'office-sign', '결과물 진열장'), cabX, L + 14);

    const now = new Date();
    this.place(
      el('div', 'office-clock', `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${this.isNight() ? '퇴근 시간' : '근무 시간'}`),
      Math.floor(this.sceneW / 2) - 18,
      L + 16,
    );

    for (const a of this.actors) {
      const btn = el('button', `office-actor office-${a.kind}`);
      btn.type = 'button';
      btn.title = a.info;
      btn.setAttribute('aria-label', a.info.replace(/\n/g, ', '));
      btn.style.width = `${12 * S}px`;
      btn.style.height = `${18 * S}px`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (a.kind === 'leader') this.onLeaderClick(a.missionId);
        else this.showInfo(a.info);
      });
      this.overlay.appendChild(btn);
      const name = el('div', `office-name office-name-${a.kind}`, a.label);
      this.overlay.appendChild(name);
      let bubble: HTMLDivElement | undefined;
      if (a.bubble) {
        bubble = el('div', `office-bubble pose-${a.pose}`, a.bubble);
        this.overlay.appendChild(bubble);
      }
      this.actorEls.set(a.key, { btn, name, bubble });
    }
    this.placeActorEls();
  }

  // 걸어 다니는 사람을 따라 이름표·말풍선·누르는 곳을 옮긴다
  private placeActorEls() {
    const S = this.scale;
    for (const [key, els] of this.actorEls) {
      const w = this.walkers.get(key);
      if (!w) continue;
      els.btn.style.left = `${(w.x - 6) * S}px`;
      els.btn.style.top = `${(w.y - 17) * S}px`;
      els.name.style.left = `${w.x * S}px`;
      els.name.style.top = `${(w.y + 1) * S}px`;
      if (els.bubble) {
        els.bubble.style.left = `${w.x * S}px`;
        els.bubble.style.top = `${(w.y - 20) * S}px`;
        els.bubble.hidden = w.walking;
      }
    }
  }

  private showInfo(text: string) {
    this.infoEl.textContent = text;
    this.infoEl.hidden = false;
    window.clearTimeout(this.infoTimer);
    this.infoTimer = window.setTimeout(() => (this.infoEl.hidden = true), 4000);
  }

  private isNight(): boolean {
    const h = new Date().getHours();
    return h < 8 || h >= 19;
  }

  // ---------- 그리기 ----------
  private px(x: number, y: number, w: number, h: number, color: string) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  private draw() {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.sceneW, this.sceneH);
    // 건물 바탕과 복도
    this.px(0, 0, this.sceneW, this.sceneH, C.frame);
    this.px(2, 2, SHAFT, this.lobbyTop, C.hall);
    for (let r = 0; r < this.rows; r++) {
      const y = GAP + r * (ROOM_H + HALL) + ROOM_H;
      this.px(2, y + 1, this.sceneW - 4, HALL - 2, C.hall);
      for (let x = 6; x < this.sceneW - 6; x += 12) this.px(x, y + Math.floor(HALL / 2), 5, 1, C.hallLine);
    }
    for (let y = 6; y < this.lobbyTop; y += 12) this.px(Math.floor(SHAFT / 2) + 1, y, 1, 5, C.hallLine);
    for (const room of this.rooms) this.drawRoom(room);
    this.drawLobby();
    // 뒤(위)에 있는 사람부터
    const list = this.actors.map((a) => ({ a, w: this.walkers.get(a.key) })).filter((p): p is { a: Actor; w: Walker } => !!p.w);
    for (const { a, w } of list.sort((p, q) => p.w.y - q.w.y)) this.drawActor(a, w);
    if (this.isNight()) {
      this.px(0, 0, this.sceneW, this.sceneH, C.night);
      for (const { a, w } of list) if (!w.walking && (a.pose === 'type' || a.pose === 'review')) this.px(w.x - 9, w.y - 16, 18, 16, C.lamp);
    }
  }

  private drawRoom(r: RoomLayout) {
    const { x, y } = r;
    const T = THEMES[r.index % THEMES.length];
    const night = this.isNight();
    // 바닥
    for (let ty = WALL; ty < ROOM_H; ty += 6) {
      for (let tx = 0; tx < ROOM_W; tx += 6) this.px(x + tx, y + ty, 6, 6, ((tx + ty) / 6) % 2 === 0 ? T.floorA : T.floorB);
    }
    // 벽: 화이트보드(일하는 사람 수만큼 메모), 창문, 포스터
    this.px(x, y, ROOM_W, WALL, T.wall);
    this.px(x, y + WALL - 1, ROOM_W, 1, 'rgba(0,0,0,0.12)');
    this.px(x + 50, y + 3, 32, 10, '#f6f6f2');
    this.px(x + 50, y + 3, 32, 1, '#9aa0a8');
    const busy = r.status.members.filter((m) => m.state === 'working' || m.state === 'reviewing').length;
    for (let i = 0; i < Math.min(6, busy + (r.status.leaderState === 'working' ? 1 : 0)); i++) {
      this.px(x + 53 + i * 5, y + 5, 3, 3, ['#f2c230', '#8fd3ff', '#f29a8a', '#a8e09a'][i % 4]);
    }
    this.px(x + 54, y + 10, 20, 1, '#c9c9c0');
    this.px(x + 90, y + 4, 16, 9, '#9a9384');
    this.px(x + 91, y + 5, 14, 7, night ? C.windowNight : C.window);
    this.px(x + 97, y + 5, 1, 7, '#9a9384');
    this.px(x + 112, y + 4, 8, 10, T.poster);
    this.px(x + 113, y + 6, 6, 2, '#ffffff');
    // 러그(팀 책상 밑)
    this.px(x + 28, y + 50, 76, 44, T.rugB);
    this.px(x + 30, y + 52, 72, 40, T.rug);
    // 리더 책상과 다음 과제 서류 더미
    this.drawDesk(x + LEADER_SPOT.x, y + LEADER_SPOT.y, r.status.leaderState === 'working', true);
    const q = Math.min(5, r.status.queued?.length ?? 0);
    for (let i = 0; i < q; i++) {
      this.px(x + 50, y + 33 - i * 2, 7, 2, C.paper);
      this.px(x + 50, y + 34 - i * 2, 7, 1, C.paperLine);
    }
    // 팀원 책상 (2줄 × 3자리)
    const members = r.status.members;
    DESK_SLOTS.forEach(([dx, dy], i) => {
      const m = members[i];
      this.drawDesk(x + dx, y + dy, !!m && (m.state === 'working' || m.state === 'reviewing'), false);
    });
    // 탕비실: 커피 머신, 작은 소파, 화분
    this.px(x + ROOM_W - 10, y + WALL + 1, 8, 12, C.machine);
    this.px(x + ROOM_W - 8, y + WALL + 3, 4, 2, '#2b2f35');
    this.px(x + ROOM_W - 7, y + WALL + 8, 2, 2, C.coffee);
    this.px(x + ROOM_W - 16, y + 60, 14, 6, C.sofa);
    this.px(x + ROOM_W - 16, y + 58, 14, 3, C.sofaDark);
    this.drawPlant(x + 4, y + WALL + 2);
    this.drawPlant(x + ROOM_W - 10, y + ROOM_H - 14);
    // 금고(차단 목록)
    const alert = r.blocked && this.frame % 6 < 3;
    this.px(x + ROOM_W - 26, y + ROOM_H - 13, 10, 10, alert ? C.safeAlert : C.safe);
    this.px(x + ROOM_W - 25, y + ROOM_H - 12, 8, 8, alert ? '#ff7a6e' : '#868d97');
    this.px(x + ROOM_W - 22, y + ROOM_H - 10, 2, 3, '#3b3f46');
    // 아래 벽과 문(왼쪽)
    this.px(x, y + ROOM_H - 2, ROOM_W, 2, T.wall);
    this.px(x + DOOR_X - 6, y + ROOM_H - 2, 12, 2, C.hall);
  }

  private drawPlant(x: number, y: number) {
    this.px(x + 1, y + 6, 5, 5, C.pot);
    this.px(x, y + 1, 7, 5, C.plant);
    this.px(x + 2, y, 3, 2, C.plantDark);
  }

  private drawDesk(cx: number, cy: number, on: boolean, big: boolean) {
    // cy = 앉은 사람 발 위치. 의자는 뒤, 책상은 앞(아래)
    const w = big ? 22 : 18;
    const x = cx - Math.floor(w / 2);
    const y = cy - 5;
    this.px(cx - 4, cy - 12, 8, 3, C.chair);
    this.px(x + Math.floor(w / 2) - 4, y - 7, 8, 6, C.monitor);
    this.px(x + Math.floor(w / 2) - 3, y - 6, 6, 4, on ? (this.frame % 6 < 3 ? '#bfe9ff' : C.screenOn) : C.screenOff);
    this.px(x, y, w, 4, C.desk);
    this.px(x, y + 4, w, 1, C.deskDark);
    this.px(x + 1, y + 5, 2, 3, C.deskDark);
    this.px(x + w - 3, y + 5, 2, 3, C.deskDark);
    if (big) this.px(x + 2, y - 2, 3, 2, '#c25b4f'); // 리더 책상 머그잔
  }

  private drawLobby() {
    const L = this.lobbyTop;
    const W = this.sceneW;
    for (let ty = 0; ty < LOBBY_H; ty += 8) {
      for (let tx = 0; tx < W; tx += 8) this.px(tx, L + ty, 8, 8, ((tx + ty) / 8) % 2 === 0 ? C.lobbyA : C.lobbyB);
    }
    this.px(0, L, W, 2, C.frame);
    this.px(4, L, SHAFT - 2, 2, C.hall); // 통로 → 로비 입구
    // 승인 창구: 카운터, 종, 기다리는 서류
    const cx = this.counterX;
    const cy = L + 30;
    const pending = this.rooms.reduce((n, r) => n + (r.status.pendingApprovals ?? 0), 0);
    this.px(cx, cy, 44, 4, '#c9b48a');
    this.px(cx, cy + 4, 44, 12, '#a88a5a');
    this.px(cx + 2, cy + 6, 40, 1, '#8a6e44');
    this.px(cx + 30, cy - 3, 5, 3, pending && this.frame % 4 < 2 ? '#f2d24a' : '#d4b23a');
    this.px(cx + 32, cy - 4, 1, 1, '#8a7a3a');
    for (let i = 0; i < Math.min(6, pending); i++) {
      this.px(cx + 6, cy - 2 - i * 2, 9, 2, C.paper);
      this.px(cx + 6, cy - 1 - i * 2, 9, 1, C.paperLine);
    }
    // 줄 서는 곳 표시
    this.px(cx + 50, L + 62, Math.max(20, Math.min(W - 160, 60)), 1, '#c0c6cc');
    // 라노 책상(로비 가운데)과 화분
    const r = this.ranoDesk();
    this.drawDesk(r.x, r.y, this.ranoBusy, true);
    this.drawPlant(r.x - 22, r.y - 10);
    // 결과물 진열장: 유리장 안에 끝난 과제 폴더
    const bx = W - 58;
    const by = L + 16;
    this.px(bx, by, 42, 40, C.wood);
    this.px(bx + 2, by + 2, 38, 36, C.woodDark);
    for (let row = 0; row < 3; row++) {
      this.px(bx + 2, by + 13 + row * 12, 38, 1, C.wood);
      const have = Math.max(0, Math.min(8, this.outputsCount - row * 8));
      for (let b = 0; b < have; b++) this.px(bx + 4 + b * 4, by + 4 + row * 12, 3, 8, C.folder[(b + row) % C.folder.length]);
    }
    this.px(bx + 2, by + 2, 38, 36, C.glass);
    this.px(bx + 6, by + 4, 1, 10, 'rgba(255,255,255,0.7)');
    // 로비 소품: 소파와 고양이, 정수기
    const sx = Math.floor(W / 2) - 60;
    this.px(sx, L + 56, 24, 8, C.sofa);
    this.px(sx, L + 52, 24, 5, C.sofaDark);
    this.px(sx - 2, L + 54, 3, 10, C.sofaDark);
    this.px(sx + 23, L + 54, 3, 10, C.sofaDark);
    const tail = this.frame % 10 < 5 ? 0 : 1;
    this.px(sx + 8, L + 53, 8, 4, C.cat);
    this.px(sx + 14, L + 51, 4, 3, C.cat);
    this.px(sx + 14, L + 50, 1, 1, C.cat);
    this.px(sx + 17, L + 50, 1, 1, C.cat);
    this.px(sx + 6, L + 54 - tail, 2, 2, C.cat);
    this.px(W - 72, L + 40, 6, 14, '#dfe7ee');
    this.px(W - 72, L + 36, 6, 5, '#8fc8ea');
  }

  private drawActor(a: Actor, w: Walker) {
    const f = this.frame;
    const walking = w.walking;
    const pose: Pose = walking ? 'wait' : a.pose;
    const x = Math.round(w.x - 5);
    let y = Math.round(w.y - 15);
    const sitting = !walking && (pose === 'type' || pose === 'review' || pose === 'sleep' || pose === 'sit' || pose === 'done');
    if (!walking && pose === 'coffee' && f % 12 < 2) y -= 1;
    if (!walking && pose === 'wait' && f % 8 < 4) y -= 1;
    // 머리
    this.px(x + 2, y, 6, 2, a.hair);
    this.px(x + 2, y + 2, 6, 4, C.skin);
    this.px(x + 1, y + 1, 1, 3, a.hair);
    this.px(x + 8, y + 1, 1, 3, a.hair);
    if (pose === 'sleep') {
      this.px(x + 3, y + 4, 2, 1, '#6b4a34');
      this.px(x + 6, y + 4, 2, 1, '#6b4a34');
    } else {
      this.px(x + 3, y + 3, 1, 1, '#222');
      this.px(x + 6, y + 3, 1, 1, '#222');
    }
    if (a.crown) {
      this.px(x + 2, y - 3, 6, 2, C.crown);
      this.px(x + 2, y - 4, 1, 1, C.crown);
      this.px(x + 4, y - 4, 2, 1, C.crown);
      this.px(x + 7, y - 4, 1, 1, C.crown);
    }
    // 몸과 팔
    this.px(x + 1, y + 6, 8, 5, a.shirt);
    const typing = !walking && pose === 'type';
    this.px(x, y + 7 - (typing && f % 4 < 2 ? 1 : 0), 1, 4, a.shirt);
    this.px(x + 9, y + 7 - (typing && f % 4 >= 2 ? 1 : 0), 1, 4, a.shirt);
    // 다리: 걸으면 번갈아
    if (sitting) {
      this.px(x + 2, y + 11, 6, 2, '#3b3f46');
    } else if (walking) {
      const s = f % 4 < 2;
      this.px(x + 2, y + 11, 2, s ? 4 : 3, '#3b3f46');
      this.px(x + 6, y + 11, 2, s ? 3 : 4, '#3b3f46');
    } else {
      this.px(x + 2, y + 11, 2, 4, '#3b3f46');
      this.px(x + 6, y + 11, 2, 4, '#3b3f46');
    }
    // 들고 있는 것
    if (walking && w.carry) {
      this.px(x + 9, y + 6, 5, 6, a.kind === 'rano' ? C.paper : C.folder[0]);
      if (a.kind === 'rano') this.px(x + 10, y + 8, 3, 1, C.paperLine);
    } else if (!walking && pose === 'coffee') {
      this.px(x + 10, y + 7, 3, 3, '#f6f6f2');
      this.px(x + 11, y + 8, 1, 1, C.coffee);
      if (f % 9 < 3) this.px(x + 11, y + 4, 1, 2, '#d8d8d8');
    } else if (!walking && (pose === 'review' || (a.prop === 'glass' && pose === 'type'))) {
      this.px(x + 9, y + 4, 4, 4, '#cfe8ff');
      this.px(x + 9, y + 4, 4, 1, '#555');
      this.px(x + 12, y + 8, 2, 2, '#555');
    } else if (!walking && pose === 'wait') {
      this.px(x + 9, y, 7, 7, '#fff7d6');
      this.px(x + 12, y + 1, 1, 3, '#c0533a');
      this.px(x + 12, y + 5, 1, 1, '#c0533a');
      this.px(x + 11, y + 7, 1, 4, C.wood);
    } else if (typing && a.prop === 'book') {
      this.px(x - 3, y + 7, 3, 4, '#4f7cc2');
    } else if (typing && a.prop === 'list') {
      this.px(x - 3, y + 6, 3, 5, '#f6f6f2');
      this.px(x - 2, y + 7, 1, 1, C.check);
      this.px(x - 2, y + 9, 1, 1, C.check);
    }
    if (!walking && pose === 'done') {
      this.px(x + 3, y - 5, 1, 1, C.check);
      this.px(x + 4, y - 4, 1, 1, C.check);
      this.px(x + 5, y - 5, 1, 1, C.check);
      this.px(x + 6, y - 6, 1, 1, C.check);
      this.px(x + 7, y - 7, 1, 1, C.check);
    }
    if (!walking && pose === 'sleep') {
      const k = Math.floor(f / 4) % 3;
      const zx = x + 9 + k;
      const zy = y - 2 - k;
      this.px(zx, zy, 3, 1, '#7b8794');
      this.px(zx + 1, zy + 1, 1, 1, '#7b8794');
      this.px(zx, zy + 2, 3, 1, '#7b8794');
    }
  }
}

// ---------- 시연용 가짜 상태 (현황판 주소 끝에 #office-demo 를 붙이면 몇 초마다 장면이 바뀐다) ----------
export function demoStatuses(stage: number): MissionStatus[] {
  const now = Date.now();
  const at = (sec: number) => new Date(now - sec * 1000).toISOString();
  const st = stage % 4;
  const siteTask: MissionTask = { id: 'demo-p1', title: '리뉴얼 메뉴 구조 정리', from: 'rano', status: st === 3 ? 'done' : 'running', startedAt: at(600), ...(st === 3 ? { endedAt: at(1) } : {}) };
  const site: MissionStatus = {
    missionId: 'homepage',
    name: '홈페이지',
    leaderState: st === 0 || st === 3 ? 'idle' : 'working',
    currentTask: st === 0 ? null : siteTask,
    members:
      st === 0
        ? []
        : [
            { role: 'work-writer', state: st === 3 ? 'done' : 'working', task: '메뉴 구조 문서 초안 작성', updatedAt: at(30) },
            { role: 'work-reviewer', state: st === 3 ? 'done' : st === 2 ? 'reviewing' : 'idle', task: '현행 매핑 검수', updatedAt: at(20) },
            { role: 'work-coder', state: st === 1 ? 'working' : 'done', task: '메뉴 목록 뽑기', updatedAt: at(200) },
            { role: 'work-writer', state: 'idle', updatedAt: at(400) },
          ],
    pendingApprovals: st === 2 ? 1 : 0,
    queued: st === 0 ? [] : [{ title: '모바일 톡톡업무 정리', from: 'rano', queuedAt: at(120) }],
    recent: st === 2 ? [{ at: at(3), who: 'work-writer', text: '승인을 기다리는 중: 홈페이지 리포 파일 고치기: 리뉴얼-메뉴구조-안.md' }] : [],
  };
  const data: MissionStatus = {
    missionId: 'data',
    name: '데이터 정리',
    leaderState: st >= 2 ? 'working' : 'idle',
    currentTask: st >= 2 ? { id: 'demo-e1', title: '테스트 실행', from: 'rano', status: 'running', startedAt: at(60) } : null,
    members: st >= 2 ? [{ role: 'work-reviewer', state: 'working', task: '테스트 실행', updatedAt: at(10) }, { role: 'work-coder', state: 'idle', updatedAt: at(10) }] : [],
    pendingApprovals: 0,
    queued: [],
    recent: st === 3 ? [{ at: at(2), who: '앱', text: '차단: work-reviewer의 검색 결과에서 민감한 위치의 내용 1줄을 가렸어요' }] : [],
  };
  const extra: MissionStatus = { missionId: 'demo3', name: '새 미션', leaderState: 'idle', currentTask: null, members: [], pendingApprovals: 0, queued: [], recent: [] };
  return [site, data, extra];
}
