// 현황판: 미션 카드와 리포 리더 대화 패널.
import { ChatView, type SpeakerStyle } from './chatView.js';
import { demoStatuses, OfficeView } from './office.js';
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
  readonly office: OfficeView;
  private emptyEl = el('div', 'board-empty');
  /** 첫 미션 안내 버튼 */
  onFirstMission: () => void = () => {};
  onAskRano: () => void = () => {};
  private mode: 'office' | 'list' = 'office';
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
  private inputEl = mustGet<HTMLTextAreaElement>('leader-input');
  private sendBtn = mustGet<HTMLButtonElement>('leader-send');
  private view: ChatView;
  private autosize: () => void;

  /** 리더가 일하는지 바뀔 때 머리말 표시를 고치도록 알린다. */
  onWorkingChange: (anyWorking: boolean, names: string[]) => void = () => {};
  /** 카드의 "승인 대기 N건"을 눌렀을 때 */
  onApprovalsClick: () => void = () => {};
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
    this.office = new OfficeView(this.officeEl);
    this.office.onLeaderClick = (id) => void this.open(id);
    this.office.onApprovalsClick = () => this.onApprovalsClick();
    try {
      const saved = localStorage.getItem('rano.boardMode');
      if (saved === 'list' || saved === 'office') this.mode = saved;
    } catch {
      // 저장소를 못 쓰면 기본값
    }
    this.officeBtn.addEventListener('click', () => this.setMode('office'));
    this.listBtn.addEventListener('click', () => this.setMode('list'));
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
  private setMode(mode: 'office' | 'list') {
    this.mode = mode;
    try {
      localStorage.setItem('rano.boardMode', mode);
    } catch {
      // 무시
    }
    this.applyMode();
  }

  private applyMode() {
    const office = this.mode === 'office';
    this.boardEl.classList.toggle('office-mode', office);
    this.officeEl.hidden = !office;
    this.cardsEl.hidden = office;
    this.officeBtn.classList.toggle('on', office);
    this.listBtn.classList.toggle('on', !office);
    this.officeBtn.setAttribute('aria-pressed', String(office));
    this.listBtn.setAttribute('aria-pressed', String(!office));
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

  /** 미션 id → 이름 (모르면 undefined) */
  nameOf(id: string): string | undefined {
    return this.statuses.get(id)?.name;
  }

  private missionName(id: string | null): string {
    return (id && this.statuses.get(id)?.name) || '리포';
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
    const card = el('article', `card${s.missionId === this.openId ? ' card-open' : ''}`);
    card.dataset.mission = s.missionId;
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${s.name} 미션 카드. 누르면 리포 리더와 대화합니다.`);
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
    pill.appendChild(document.createTextNode(working ? '리더 일하는 중' : '리더 쉬는 중'));
    head.appendChild(pill);
    card.appendChild(head);

    // 과제
    const task = s.currentTask;
    const taskSec = this.section(card, task && task.status !== 'running' ? '최근 과제' : '진행 중 과제');
    if (!task) {
      taskSec.appendChild(el('p', 'muted', '진행 중인 과제가 없어요'));
    } else {
      const row = el('div', 'task');
      const titleRow = el('div', 'task-title-row');
      titleRow.appendChild(el('span', 'task-title', task.title));
      titleRow.appendChild(task.stoppedByRejection
          ? el('span', 'badge task-failed', '반려로 멈춤')
          : el('span', `badge task-${task.status}`, TASK_STATUS_LABEL[task.status] ?? task.status));
      row.appendChild(titleRow);
      const meta = [task.from === 'rano' ? '라노 배정' : '직접 지시', `시작 ${formatWhen(task.startedAt)}`];
      if (task.endedAt) meta.push(`끝남 ${formatWhen(task.endedAt)}`);
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
        if (m.task) li.appendChild(el('div', 'member-task', m.task));
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
    const btn = el('button', 'card-open-btn', s.missionId === this.openId ? '대화 열려 있음' : '리포 리더와 대화');
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
  private async open(missionId: string): Promise<void> {
    if (this.openId === missionId) {
      this.inputEl.focus();
      return;
    }
    const token = ++this.openToken;
    this.openId = missionId;
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
    this.refreshComposer();
  }

  private refreshComposer(): void {
    this.sendBtn.disabled = this.sending || !this.openId || !this.inputEl.value.trim();
  }

  private async submit(): Promise<void> {
    const missionId = this.openId;
    const text = this.inputEl.value.trim();
    if (!missionId || !text || this.sending) return;

    this.sending = true;
    this.inputEl.value = '';
    this.autosize();
    this.refreshComposer();
    try {
      await this.rano.missionSend(missionId, text);
    } catch {
      if (this.openId === missionId) {
        this.view.addError('리포 리더에게 지시를 전하지 못했어요. 잠시 뒤 다시 보내 주세요.', new Date().toISOString());
        if (!this.inputEl.value.trim()) {
          this.inputEl.value = text;
          this.autosize();
        }
      }
    } finally {
      this.sending = false;
      this.refreshComposer();
      this.inputEl.focus();
    }
  }
}
