// 현황판: 움직이는 사무실(미션 방)과, 고른 미션의 자세한 내용·리더 대화 패널.
import { ChatView, type SpeakerStyle } from './chatView.js';
import { demoStatuses } from './office.js';
import { FloorView } from './floor.js';
import { ImageTray } from './attach.js';
import { UsageView } from './usage.js';
import { bindComposer, el, formatTime, formatWhen, mustGet, roleLabel, toDate } from './dom.js';

const MEMBER_STATE_LABEL: Record<MemberState, string> = {
  idle: '대기',
  working: '작업 중',
  reviewing: '검수 중',
  done: '완료',
};
const TASK_STATUS_LABEL: Record<MissionTask['status'], string> = {
  running: '진행 중',
  done: '완료',
  failed: '중단',
};

/**
 * 라노가 리더에게 넘긴 지시에서 사용자가 읽을 부분만 남긴다.
 * 앱이 붙인 안내("[사용자가 직접 쓴 말] 이 과제의 범위는 …", "[앱 안내]", "[첨부 그림]")는 빼고, 사용자가 직접 쓴 말은 "내가 한 말"로 보인다.
 */
export function shortAssignment(text: string): string {
  const cut = text.search(/\n\s*(\[사용자가 직접 쓴 말\]|---\s*\n\[앱 안내\]|\[앱 안내\]|\[첨부 그림\])/);
  if (cut < 0) return text;
  const head = text.slice(0, cut).trim();
  const said = /\[사용자가 직접 쓴 말\][^\n]*\n(?:[^\n>]*\n)*?((?:>[^\n]*\n?)+)/.exec(text)?.[1];
  const mine = said ? said.split('\n').map((l) => l.replace(/^>\s?/, '').trim()).filter(Boolean).join(' ') : '';
  return mine ? `${head}\n\n**내가 한 말:** ${mine}` : head;
}

type PendingLine = { type: 'message'; message: ChatMessage } | { type: 'activity' | 'error'; text: string; at: string };

export class Board {
  private rano = window.rano;
  private statuses = new Map<string, MissionStatus>();
  private order: string[] = [];
  private listLoaded = false;
  private listFailed = false;

  // 리포 리더 대화 패널
  private openId: string | null = null;
  private openToken = 0;
  private historyLoaded = false;
  private pending: PendingLine[] = [];
  private sending = false;

  private cardsEl = mustGet<HTMLDivElement>('board-cards');
  private boardEl = mustGet<HTMLElement>('view-board');
  private officeEl = mustGet<HTMLDivElement>('office');
  private officeBtn = mustGet<HTMLButtonElement>('view-office-btn');
  private listBtn = mustGet<HTMLButtonElement>('view-list-btn');
  readonly office: FloorView;
  private detailEl = mustGet<HTMLDivElement>('leader-detail');
  private confirmStop: string | null = null;
  private stopping = new Set<string>();
  private emptyEl = el('div', 'board-empty');
  /** 첫 미션 안내 버튼 */
  onFirstMission: () => void = () => {};
  onAskRano: () => void = () => {};
  private mode: 'office' | 'usage' = 'office';
  private usageBtn = mustGet<HTMLButtonElement>('view-usage-btn');
  private usage = new UsageView();
  private readonly demo = location.hash === '#office-demo';
  private demoStage = 0;
  private tabVisible = false;
  private placeholderEl = mustGet<HTMLDivElement>('leader-placeholder');
  private panelEl = mustGet<HTMLElement>('leader-panel');
  private titleEl = mustGet<HTMLHeadingElement>('leader-title');
  private stateEl = mustGet<HTMLSpanElement>('leader-state');
  private closeBtn = mustGet<HTMLButtonElement>('leader-close');
  private workingEl = mustGet<HTMLDivElement>('leader-working');
  private workingTextEl = mustGet<HTMLSpanElement>('leader-working-text');
  private formEl = mustGet<HTMLFormElement>('leader-form');
  private tray: ImageTray | null = null;
  private inputEl = mustGet<HTMLTextAreaElement>('leader-input');
  private sendBtn = mustGet<HTMLButtonElement>('leader-send');
  private view: ChatView;
  private autosize: () => void;

  /** 리더가 일하는지 바뀔 때 머리말 표시를 고치도록 알린다. */
  onWorkingChange: (anyWorking: boolean, names: string[]) => void = () => {};
  /** 카드의 "승인 대기 N건"을 눌렀을 때 */
  onApprovalsClick: (id?: string) => void = () => {};
  /** 미션 이름이 새로 알려졌을 때(승인함·결과물함 다시 그리기용) */
  onNamesChange: () => void = () => {};

  constructor() {
    this.view = new ChatView(
      mustGet('leader-scroll'),
      mustGet('leader-log'),
      mustGet('leader-empty'),
      (role) => this.speaker(role),
    );
    this.autosize = bindComposer({
      form: this.formEl,
      input: this.inputEl,
      onSubmit: () => void this.submit(),
      onInput: () => this.refreshComposer(),
    }).autosize;
    // 리더에게 직접 보내는 말에도 그림(캡처·표시)을 붙일 수 있다
    this.tray = new ImageTray(this.formEl, this.inputEl, mustGet('leader-panel'));
    this.tray.onChange = () => this.refreshComposer();
    this.closeBtn.addEventListener('click', () => this.close());
    // 미션이 하나도 없을 때 사무실 위에 보이는 첫 미션 안내
    this.emptyEl.hidden = true;
    this.emptyEl.appendChild(el('strong', undefined, '아직 미션이 없어요.'));
    this.emptyEl.appendChild(el('span', undefined, ' 미션은 리더 한 명이 팀원들과 맡는 일이에요. 라노에게 하고 싶은 일을 말하면 구성안을 만들어 드리고, 조직 탭에서 직접 만들 수도 있어요.'));
    const firstBtns = el('div', 'board-empty-actions');
    const ask = el('button', 'btn', '라노에게 말하기');
    ask.type = 'button';
    ask.addEventListener('click', () => this.onAskRano());
    const make = el('button', 'btn btn-confirm', '조직 탭에서 첫 미션 만들기');
    make.type = 'button';
    make.addEventListener('click', () => this.onFirstMission());
    firstBtns.append(ask, make);
    this.emptyEl.appendChild(firstBtns);
    this.officeEl.before(this.emptyEl);
    this.office = new FloorView(this.officeEl);
    this.office.onUsageClick = () => this.setMode('usage');
    // 리더 대화 창: 긴 보고는 접고, 배정 말은 앱 안내문을 뺀 짧은 판으로
    this.view.clampLong = true;
    this.view.shortOf = (m) => (m.role === 'rano' ? shortAssignment(m.text ?? '') : null);
    this.office.showVacant = !this.demo;
    this.office.onNewMission = () => this.onFirstMission();
    this.office.onLeaderClick = (id) => void this.open(id);
    this.office.onApprovalsClick = (id) => this.onApprovalsClick(id);
    try {
      const saved = localStorage.getItem('rano.boardMode');
      if (saved === 'office' || saved === 'usage') this.mode = saved;
    } catch {
      // 저장소를 못 쓰면 기본값
    }
    this.officeBtn.addEventListener('click', () => this.setMode('office'));
    this.usageBtn.addEventListener('click', () => this.setMode('usage'));
    this.cardsEl.after(this.usage.root);
    this.boardEl.classList.add('leader-closed');
    this.applyMode();
    this.renderCards();
    // 시연 모드: 5초마다 장면을 바꿔 걷기·배달·승인 줄서기를 보여 준다
    if (this.demo) window.setInterval(() => {
      this.demoStage++;
      this.refreshOffice();
    }, 9000);
  }

  // ---------- 사무실 / 목록 전환 ----------
  private setMode(mode: 'office' | 'usage') {
    this.mode = mode;
    if (mode === 'usage') this.close(); // 사용량 표는 넓게 본다
    try {
      localStorage.setItem('rano.boardMode', mode);
    } catch {
      // 무시
    }
    this.applyMode();
  }

  private applyMode() {
    const office = this.mode === 'office';
    const usage = this.mode === 'usage';
    this.boardEl.classList.add('office-mode');
    this.officeEl.hidden = !office;
    this.cardsEl.hidden = true;
    this.listBtn.hidden = true;
    this.usage.root.hidden = !usage;
    if (usage) void this.usage.load();
    for (const [b, on] of [[this.officeBtn, office], [this.usageBtn, usage]] as const) {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.refreshOffice();
  }

  private refreshOffice() {
    const list = this.demo ? demoStatuses(this.demoStage) : this.order.map((id) => this.statuses.get(id)).filter((s): s is MissionStatus => !!s);
    this.office.update(list);
    this.emptyEl.hidden = this.demo || !this.listLoaded || list.length > 0;
    this.office.setVisible(this.mode === 'office' && this.tabVisible);
  }

  /** 현황판 탭이 보이는지 (사무실 그림은 보일 때만 움직인다) */
  setTabVisible(v: boolean): void {
    this.tabVisible = v;
    this.office.setVisible(this.mode === 'office' && v);
  }

  /** 과제 제목(진행 중이거나 가장 최근 과제에서 찾는다. 모르면 undefined) */
  taskTitle(missionId: string, taskId: string): string | undefined {
    const s = this.statuses.get(missionId);
    return [...(s?.running ?? []), ...(s?.currentTask ? [s.currentTask] : [])].find((t) => t.id === taskId)?.title;
  }

  /** 미션 id → 이름 (모르면 undefined) */
  nameOf(id: string): string | undefined {
    return this.statuses.get(id)?.name;
  }

  private missionName(id: string | null): string {
    return (id && this.statuses.get(id)?.name) || '미션';
  }

  private speaker(role: ChatRole): SpeakerStyle {
    if (role === 'user') return { side: 'right', name: '나', className: 'from-user', rich: false };
    if (role === 'rano') return { side: 'left', name: '라노의 배정', className: 'from-assign', rich: true };
    return { side: 'left', name: `${this.missionName(this.openId)} 리더`, className: 'from-leader', rich: true };
  }

  // ---------- 처음 불러오기 ----------
  async load(): Promise<void> {
    try {
      const list = await this.rano.missionList();
      if (Array.isArray(list)) {
        for (const s of list) {
          if (!s || typeof s.missionId !== 'string') continue;
          if (!this.order.includes(s.missionId)) this.order.push(s.missionId);
          // 불러오는 사이에 이벤트로 더 새 상태가 왔으면 그것을 지킨다.
          if (!this.statuses.has(s.missionId)) this.statuses.set(s.missionId, s);
        }
      }
    } catch {
      this.listFailed = true;
    }
    this.listLoaded = true;
    this.renderCards();
    this.refreshOffice();
    this.notifyWorking();
    this.onNamesChange();
  }

  // ---------- 이벤트 ----------
  updateMission(s: MissionStatus): void {
    if (!s || typeof s.missionId !== 'string') return;
    const nameChanged = this.statuses.get(s.missionId)?.name !== s.name;
    if (!this.order.includes(s.missionId)) this.order.push(s.missionId);
    this.statuses.set(s.missionId, s);
    this.listFailed = false;
    if (nameChanged) this.onNamesChange();
    const old = this.cardsEl.querySelector<HTMLElement>(`[data-mission="${CSS.escape(s.missionId)}"]`);
    if (old && this.listLoaded) old.replaceWith(this.renderCard(s));
    else this.renderCards();
    if (s.missionId === this.openId) this.refreshPanelState();
    this.notifyWorking();
    if (!this.demo) this.refreshOffice();
  }

  leaderMessage(missionId: string, m: ChatMessage): void {
    if (missionId !== this.openId) return; // 닫혀 있는 미션은 열 때 기록으로 불러온다
    if (!this.historyLoaded) this.pending.push({ type: 'message', message: m });
    else this.view.addMessage(m, false);
  }

  /** missionId 가 붙은 한 줄 보고·오류. 그 미션의 대화 패널이 열려 있을 때만 보여 준다. */
  leaderLine(missionId: string, type: 'activity' | 'error', text: string, at: string): void {
    if (missionId !== this.openId) return;
    if (!this.historyLoaded) this.pending.push({ type, text, at });
    else this.showLine({ type, text, at });
  }

  private showLine(p: PendingLine): void {
    if (p.type === 'message') this.view.addMessage(p.message, false);
    else if (p.type === 'activity') this.view.addActivity(p.text, p.at);
    else this.view.addError(p.text, p.at);
  }

  /** 현황판 탭이 다시 보일 때 */
  shown(): void {
    if (this.openId) this.view.scrollToBottom();
  }

  private notifyWorking(): void {
    const names = this.order
      .map((id) => this.statuses.get(id))
      .filter((s): s is MissionStatus => !!s && s.leaderState === 'working')
      .map((s) => s.name);
    this.onWorkingChange(names.length > 0, names);
  }

  // ---------- 카드 ----------
  private renderCards(): void {
    this.cardsEl.replaceChildren();
    if (!this.listLoaded && this.order.length === 0) {
      this.cardsEl.appendChild(el('p', 'board-note', '현황판을 불러오는 중이에요…'));
      return;
    }
    if (this.order.length === 0) {
      this.cardsEl.appendChild(
        el('p', 'board-note', this.listFailed ? '현황판을 불러오지 못했어요. 앱을 다시 열어 주세요.' : '등록된 미션이 없어요.'),
      );
      return;
    }
    for (const id of this.order) {
      const s = this.statuses.get(id);
      if (s) this.cardsEl.appendChild(this.renderCard(s));
    }
  }

  private renderCard(s: MissionStatus): HTMLElement {
    const working = s.leaderState === 'working';
    const running = Array.isArray(s.running) ? s.running : [];
    const card = el('article', `card${s.missionId === this.openId ? ' card-open' : ''}`);
    card.dataset.mission = s.missionId;
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${s.name} 미션 카드. 누르면 리더와 대화합니다.`);
    card.addEventListener('click', () => void this.open(s.missionId));
    card.addEventListener('keydown', (e) => {
      if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        void this.open(s.missionId);
      }
    });

    // 머리
    const head = el('div', 'card-head');
    head.appendChild(el('h2', 'card-title', s.name));
    const pill = el('span', `pill ${working ? 'pill-working' : 'pill-idle'}`);
    if (working) pill.appendChild(el('span', 'pulse'));
    pill.appendChild(document.createTextNode(working ? (running.length > 1 ? `리더 ${running.length}명 일하는 중` : '리더 일하는 중') : '리더 쉬는 중'));
    head.appendChild(pill);
    card.appendChild(head);

    // 과제 (같은 미션에서 여러 과제가 동시에 돌면 모두 보여 준다)
    const task = s.currentTask;
    const shown = running.length > 1 ? running : task ? [task] : [];
    const taskSec = this.section(
      card,
      running.length > 1 ? `진행 중 과제 ${running.length}건 (동시에)` : task && task.status !== 'running' ? '최근 과제' : '진행 중 과제',
    );
    if (!shown.length) {
      taskSec.appendChild(el('p', 'muted', '진행 중인 과제가 없어요'));
    }
    for (const t of shown) {
      const row = el('div', 'task');
      const titleRow = el('div', 'task-title-row');
      titleRow.appendChild(el('span', 'task-title', t.title));
      titleRow.appendChild(t.stoppedByRejection
          ? el('span', 'badge task-failed', '반려로 멈춤')
          : el('span', `badge task-${t.status}`, TASK_STATUS_LABEL[t.status] ?? t.status));
      row.appendChild(titleRow);
      const meta = [t.from === 'rano' ? '라노 배정' : '직접 지시', `시작 ${formatWhen(t.startedAt)}`];
      if (t.endedAt) meta.push(`끝남 ${formatWhen(t.endedAt)}`);
      row.appendChild(el('div', 'task-meta', meta.join(' · ')));
      taskSec.appendChild(row);
    }

    // 팀원
    // 기다리는 과제 (앞 과제가 끝나면 차례로 시작)
    const queued = Array.isArray(s.queued) ? s.queued : [];
    if (queued.length) {
      const qSec = this.section(card, `다음 과제 ${queued.length}건`);
      const ol = el('ol', 'queue');
      for (const q of queued) {
        const li = el('li');
        li.appendChild(el('span', 'queue-title', q.title));
        const meta = `${q.from === 'rano' ? '라노 배정' : '직접 지시'} · ${formatWhen(q.queuedAt)}${q.resumed ? ' · 앱을 다시 켜서 이어 받음' : ''}`;
        li.appendChild(el('span', 'queue-meta', meta));
        ol.appendChild(li);
      }
      qSec.appendChild(ol);
    }

    const memSec = this.section(card, '팀원');
    if (!s.members || s.members.length === 0) {
      memSec.appendChild(el('p', 'muted', '아직 부른 팀원이 없어요'));
    } else {
      const list = el('ul', 'members');
      for (const m of s.members) {
        const li = el('li', 'member');
        const top = el('div', 'member-top');
        const name = el('span', 'member-role', m.role);
        const label = roleLabel(m.role);
        if (label) name.appendChild(el('span', 'member-label', label));
        top.appendChild(name);
        top.appendChild(el('span', `badge state-${m.state}`, MEMBER_STATE_LABEL[m.state] ?? m.state));
        li.appendChild(top);
        const forTask = running.length > 1 && m.taskId ? running.find((t) => t.id === m.taskId) : undefined;
        if (m.task || forTask) li.appendChild(el('div', 'member-task', `${forTask ? `[${forTask.title.slice(0, 20)}] ` : ''}${m.task ?? ''}`));
        list.appendChild(li);
      }
      memSec.appendChild(list);
    }

    // 승인 대기
    const appr = el('button', 'approvals');
    appr.type = 'button';
    appr.title = '승인함으로 가기';
    appr.appendChild(el('span', 'approvals-label', '승인 대기'));
    appr.appendChild(el('span', `approvals-count${s.pendingApprovals > 0 ? ' has' : ''}`, `${s.pendingApprovals ?? 0}건`));
    appr.appendChild(el('span', 'approvals-go', '승인함 열기 ›'));
    appr.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onApprovalsClick();
    });
    card.appendChild(appr);

    // 최근 활동
    const actSec = this.section(card, '최근 활동');
    const recent = [...(s.recent ?? [])]
      .sort((a, b) => toDate(b.at).getTime() - toDate(a.at).getTime())
      .slice(0, 5);
    if (recent.length === 0) {
      actSec.appendChild(el('p', 'muted', '아직 활동이 없어요'));
    } else {
      const list = el('ul', 'recent');
      for (const a of recent) {
        const li = el('li');
        li.appendChild(el('span', 'recent-time', formatTime(a.at)));
        li.appendChild(el('span', 'recent-who', a.who));
        li.appendChild(el('span', 'recent-text', a.text));
        list.appendChild(li);
      }
      actSec.appendChild(list);
    }

    // 버튼
    const btn = el('button', 'card-open-btn', s.missionId === this.openId ? '대화 열려 있음' : '리더와 대화');
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.open(s.missionId);
    });
    card.appendChild(btn);
    return card;
  }

  private section(card: HTMLElement, title: string): HTMLElement {
    const sec = el('section', 'card-sec');
    sec.appendChild(el('h3', 'card-sec-title', title));
    card.appendChild(sec);
    return sec;
  }

  // ---------- 리포 리더 대화 ----------
  /** 그 미션의 리포 리더 대화창을 연다 */
  async open(missionId: string): Promise<void> {
    if (this.mode !== 'office') this.setMode('office');
    if (this.openId === missionId) {
      this.inputEl.focus();
      return;
    }
    const token = ++this.openToken;
    this.openId = missionId;
    this.confirmStop = null;
    this.office.setSelected(missionId);
    this.boardEl.classList.remove('leader-closed');
    this.historyLoaded = false;
    this.pending = [];
    this.view.clear();
    this.placeholderEl.hidden = true;
    this.panelEl.hidden = false;
    this.renderCards();
    this.refreshPanelState();

    let history: ChatMessage[] = [];
    let failed = false;
    try {
      const got = await this.rano.missionHistory(missionId);
      if (Array.isArray(got)) history = got;
    } catch {
      failed = true;
    }
    if (token !== this.openToken) return; // 그사이 다른 카드를 열었다

    for (const m of history) this.view.addMessage(m, true);
    if (failed) this.view.addError('이전 대화를 불러오지 못했어요. 새로 지시하는 것은 그대로 할 수 있어요.', new Date().toISOString());
    this.historyLoaded = true;
    for (const p of this.pending.splice(0)) this.showLine(p);
    this.view.setReady(true);
    this.view.scrollToBottom();
    this.inputEl.focus();
  }

  private close(): void {
    this.openToken++;
    this.openId = null;
    this.office.setSelected(null);
    this.boardEl.classList.add('leader-closed');
    this.historyLoaded = false;
    this.pending = [];
    this.view.clear();
    this.panelEl.hidden = true;
    this.placeholderEl.hidden = false;
    this.renderCards();
  }

  private refreshPanelState(): void {
    const s = this.openId ? this.statuses.get(this.openId) : undefined;
    const name = this.missionName(this.openId);
    const working = s?.leaderState === 'working';
    this.titleEl.textContent = `${name} 리더와 대화`;
    this.stateEl.className = `pill ${working ? 'pill-working' : 'pill-idle'}`;
    this.stateEl.replaceChildren();
    if (working) this.stateEl.appendChild(el('span', 'pulse'));
    this.stateEl.appendChild(document.createTextNode(working ? '일하는 중' : '쉬는 중'));
    this.workingTextEl.textContent = `${name} 리더가 일하고 있어요`;
    const stick = this.view.isNearBottom();
    this.workingEl.hidden = !working;
    if (working && stick) this.view.scrollToBottom();
    this.inputEl.placeholder = `${name} 리더에게 할 일을 적어 주세요`;
    this.renderDetail(s);
    this.refreshComposer();
  }

  /** 대화 창 위쪽: 고른 미션의 진행 중 과제([멈추기])·기다리는 과제·최근 활동 */
  private renderDetail(s: MissionStatus | undefined): void {
    const box = this.detailEl;
    box.replaceChildren();
    if (!s) return;
    const running = s.running?.length ? s.running : s.leaderState === 'working' && s.currentTask?.status === 'running' ? [s.currentTask] : [];
    if (running.length) {
      box.appendChild(el('div', 'detail-label', `진행 중 과제${running.length > 1 ? ` ${running.length}건` : ''}`));
      for (const t of running) {
        const row = el('div', 'detail-task');
        row.appendChild(el('span', 'detail-task-title', t.title));
        const meta = el('div', 'detail-task-meta');
        const min = Math.max(0, Math.floor((Date.now() - toDate(t.startedAt).getTime()) / 60000));
        const mine = (s.members ?? []).filter((m) => (!m.taskId || m.taskId === t.id) && (m.state === 'working' || m.state === 'reviewing'));
        const what = mine.some((m) => m.state === 'reviewing') ? ' · 검수 중' : mine.length ? ` · 팀원 ${mine.length}명 작업 중` : '';
        meta.appendChild(el('span', undefined, `${t.from === 'rano' ? '라노 배정' : '직접 지시'} · ${min < 1 ? '방금 시작' : `${min}분째`}${what}`));
        meta.appendChild(el('span', 'fl-sp'));
        if (this.confirmStop === t.id) {
          const yes = el('button', 'now-btn now-btn-danger', '정말 멈추기');
          yes.type = 'button';
          yes.addEventListener('click', () => void this.stopTask(s.missionId, t.id));
          const no = el('button', 'now-btn', '계속하기');
          no.type = 'button';
          no.addEventListener('click', () => {
            this.confirmStop = null;
            this.renderDetail(this.statuses.get(s.missionId));
          });
          meta.append(yes, no);
        } else {
          const stop = el('button', 'now-btn', this.stopping.has(t.id) ? '멈추는 중…' : '멈추기');
          stop.type = 'button';
          stop.disabled = this.stopping.has(t.id);
          stop.title = '이 과제를 멈춰요. 이미 고친 파일은 그대로 남아요';
          stop.addEventListener('click', () => {
            this.confirmStop = t.id;
            this.renderDetail(this.statuses.get(s.missionId));
          });
          meta.appendChild(stop);
        }
        row.appendChild(meta);
        box.appendChild(row);
      }
    }
    const queued = Array.isArray(s.queued) ? s.queued : [];
    if (queued.length) {
      box.appendChild(el('div', 'detail-label', `다음 과제 ${queued.length}건`));
      for (const q of queued.slice(0, 3)) box.appendChild(el('div', 'detail-line', q.title));
    }
    const recent = [...(s.recent ?? [])].sort((a, b) => toDate(b.at).getTime() - toDate(a.at).getTime()).slice(0, 4);
    if (recent.length) {
      box.appendChild(el('div', 'detail-label', '최근 활동'));
      const list = el('div', 'detail-acts');
      for (const a of recent) {
        list.appendChild(el('span', 'detail-time', formatTime(a.at)));
        list.appendChild(el('span', undefined, `${a.who}: ${a.text}`));
      }
      box.appendChild(list);
    }
  }

  private async stopTask(missionId: string, taskId: string): Promise<void> {
    this.confirmStop = null;
    this.stopping.add(taskId);
    this.renderDetail(this.statuses.get(missionId));
    try {
      await this.rano.missionStop(missionId, taskId);
    } catch {
      // 현황이 바뀌지 않으면 줄이 그대로 남는다
    }
    this.stopping.delete(taskId);
    if (this.openId === missionId) this.renderDetail(this.statuses.get(missionId));
  }

  private refreshComposer(): void {
    this.sendBtn.disabled = this.sending || !this.openId || (!this.inputEl.value.trim() && !this.tray?.count);
  }

  private async submit(): Promise<void> {
    const missionId = this.openId;
    const text = this.inputEl.value.trim();
    if (!missionId || (!text && !this.tray?.count) || this.sending) return;

    this.sending = true;
    const images = this.tray?.items() ?? [];
    this.inputEl.value = '';
    this.tray?.clear();
    this.autosize();
    this.refreshComposer();
    const giveBack = (msg: string) => {
      if (this.openId !== missionId) return;
      this.view.addError(msg, new Date().toISOString());
      if (!this.inputEl.value.trim()) {
        this.inputEl.value = text;
        this.autosize();
      }
      this.tray?.restore(images);
    };
    try {
      const r = await this.rano.missionSend(missionId, text, images);
      if (r && r.ok === false) giveBack(r.message ?? '리더에게 지시를 전하지 못했어요.');
    } catch {
      giveBack('리더에게 지시를 전하지 못했어요. 잠시 뒤 다시 보내 주세요.');
    } finally {
      this.sending = false;
      this.refreshComposer();
      this.inputEl.focus();
    }
  }
}
