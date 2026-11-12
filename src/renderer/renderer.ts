// 라노 OS 화면의 시작점: 탭 전환, 라노 대화, 현황판을 잇는다.
// 원칙: 대화 말은 앱 본체가 보내는 이벤트로만 그린다(내 말도 이벤트로 온다). 글은 모두 textContent 로 넣는다.
import { GuideButton, openGuideIfMarked } from './guide.js';
import { ApprovalsView } from './approvals.js';
import { Board } from './board.js';
import { OrgView } from './org.js';
import { OutputsView } from './outputs.js';
import { TodoView } from './todo.js';
import { ChatNow } from './chatNow.js';
import { proposalCard } from './orgProposal.js';
import { ChatView, type SpeakerStyle } from './chatView.js';
import { bindComposer, el, mustGet, setRoleLabels, setZoneInfo } from './dom.js';
import { SetupGuide } from './setup.js';
import { ImageTray } from './attach.js';
import { skillSuggestCard } from './orgSkills.js';
import { AccountButton } from './account.js';
import { SettingsButton } from './settings.js';
import { SearchButton } from './search.js';
import { startUpdateNotice } from './update.js';

const rano = window.rano;

// ---------- 탭 ----------
type TabName = 'chat' | 'board' | 'approvals' | 'outputs' | 'org';
const TAB_NAMES: TabName[] = ['chat', 'board', 'approvals', 'outputs', 'org'];
const TAB_TITLES: Record<TabName, string> = {
  chat: '라노와 대화',
  board: '현황판',
  approvals: '승인함',
  outputs: '결과물함',
  org: '조직',
};
const tabButtons: Record<TabName, HTMLButtonElement> = {
  chat: mustGet('tab-chat'),
  board: mustGet('tab-board'),
  approvals: mustGet('tab-approvals'),
  outputs: mustGet('tab-outputs'),
  org: mustGet('tab-org'),
};
const tabViews: Record<TabName, HTMLElement> = {
  chat: mustGet('view-chat'),
  board: mustGet('view-board'),
  approvals: mustGet('view-approvals'),
  outputs: mustGet('view-outputs'),
  org: mustGet('view-org'),
};
const approvalsBadge = mustGet<HTMLSpanElement>('approvals-badge');
const boardDot = mustGet<HTMLSpanElement>('board-dot');
const brandSub = mustGet<HTMLParagraphElement>('brand-sub');
let currentTab: TabName = 'chat';

function showTab(name: TabName): void {
  currentTab = name;
  brandSub.textContent = TAB_TITLES[name];
  for (const key of TAB_NAMES) {
    const active = key === name;
    tabButtons[key].classList.toggle('tab-active', active);
    tabButtons[key].setAttribute('aria-selected', String(active));
    tabViews[key].hidden = !active;
  }
  board.setTabVisible(name === 'board');
  if (name === 'outputs') outputs.markSeen();
  if (name === 'chat') {
    chat.scrollToBottom();
    chatInput.focus();
  } else if (name === 'board') {
    board.shown();
  } else if (name === 'org') {
    org.shown(); // 조직 화면은 열 때마다 최신 목록으로 (고치던 화면은 그대로)
  } else {
    tabViews[name].scrollTop = 0;
  }
}
for (const name of TAB_NAMES) tabButtons[name].addEventListener('click', () => showTab(name));

// ---------- 라노 대화 ----------
const chatInput = mustGet<HTMLTextAreaElement>('input');
// 그림 첨부(붙여 넣기·끌어다 놓기·📎)
const tray = new ImageTray(mustGet('composer'), chatInput, mustGet('view-chat'));
tray.onChange = () => refreshBusy();
const chatSendBtn = mustGet<HTMLButtonElement>('send');
const thinkingEl = mustGet<HTMLDivElement>('thinking');

const chat = new ChatView(mustGet('scroll'), mustGet('log'), mustGet('empty'), (role): SpeakerStyle => {
  if (role === 'user') return { side: 'right', className: 'from-user', rich: false };
  if (role === 'rano') return { side: 'left', name: '라노', className: 'from-rano', rich: true };
  return { side: 'left', name: '리포 리더', className: 'from-leader', rich: true };
});

let thinking = false; // 앱 본체가 알려 준 상태
let sending = false; // 보내는 순간(저장될 때까지)만. 라노가 바빠도 보낼 수 있다

// ---- "쓰는 중" 자리: 생각 중 칸 안에 회색 진행 줄 + 흘려 쓰는 말풍선 (화면 전용, 저장 안 함) ----
const thinkingNameEl = thinkingEl.querySelector<HTMLElement>('.thinking-name');
const thinkingTextEl = thinkingEl.querySelector<HTMLElement>('.thinking-text');
const thinkingDefault = thinkingTextEl ? Array.from(thinkingTextEl.childNodes).map((n) => n.cloneNode(true)) : [];
const liveSteps = document.createElement('div');
liveSteps.className = 'live-steps';
liveSteps.style.display = 'flex';
liveSteps.style.flexDirection = 'column';
liveSteps.style.gap = '2px';
liveSteps.style.margin = '0 4px 4px';
thinkingEl.insertBefore(liveSteps, thinkingTextEl ?? null);
let activeTurn: number | null = null; // 지금 도는 차례 번호 (다른 차례 조각은 버린다)
let answeredTurn: number | null = null; // 답이 확정된 차례 (그 뒤 조각은 버린다)
let liveHasText = false;
const waitNotes = new Map<string, HTMLElement>(); // 내 말 id → "앞 일을 마치면 바로 답해요"

function setThinkingName(label?: string): void {
  if (thinkingNameEl) thinkingNameEl.textContent = label ? `라노 · ${label}` : '라노';
}

function resetLive(): void {
  liveSteps.replaceChildren();
  liveHasText = false;
  if (thinkingTextEl) {
    thinkingTextEl.replaceChildren(...thinkingDefault.map((n) => n.cloneNode(true)));
    thinkingTextEl.style.whiteSpace = '';
    thinkingTextEl.style.color = '';
  }
}

function showLive(text: string, steps: LiveStep[]): void {
  const stick = chat.isNearBottom();
  liveSteps.replaceChildren(
    ...steps.map((s) => {
      const line = el('div', 'activity', s.tone === 'said' ? `“${s.text}”` : s.tone === 'doing' ? `● ${s.text}` : `✓ ${s.text}`);
      if (s.tone === 'said') line.style.fontStyle = 'italic';
      return line;
    }),
  );
  if (thinkingTextEl) {
    if (text) {
      thinkingTextEl.textContent = `${text} ▍`; // 쓰는 중에는 꾸밈 없는 글. 확정되면 꾸밈이 적용된 말풍선으로 바뀐다
      thinkingTextEl.style.whiteSpace = 'pre-wrap';
      thinkingTextEl.style.color = 'var(--text)';
      liveHasText = true;
    } else if (liveHasText) {
      thinkingTextEl.replaceChildren(...thinkingDefault.map((n) => n.cloneNode(true)));
      thinkingTextEl.style.whiteSpace = '';
      thinkingTextEl.style.color = '';
      liveHasText = false;
    }
  }
  if (stick) chat.scrollToBottom();
}

function refreshBusy(): void {
  const stick = chat.isNearBottom();
  thinkingEl.hidden = !thinking || (answeredTurn !== null && answeredTurn === activeTurn);
  if (!thinkingEl.hidden && stick) chat.scrollToBottom();
  chatSendBtn.disabled = sending || (!chatInput.value.trim() && !tray.count);
  chatSendBtn.textContent = '보내기';
}

const { autosize } = bindComposer({
  form: mustGet('composer'),
  input: chatInput,
  onSubmit: () => void submit(),
  onInput: refreshBusy,
});

async function submit(): Promise<void> {
  const text = chatInput.value.trim();
  if ((!text && !tray.count) || sending) return;

  sending = true;
  const images = tray.items();
  chatInput.value = '';
  tray.clear();
  autosize();
  refreshBusy();
  const giveBack = () => {
    // 아직 새로 적은 글이 없으면 보냈던 글과 그림을 되돌려 놓는다.
    if (!chatInput.value.trim()) {
      chatInput.value = text;
      autosize();
    }
    tray.restore(images);
  };
  try {
    // 저장·화면 표시까지만 기다린다(라노 답은 이벤트로 온다)
    const r = await rano.send(text, images);
    if (r && r.ok === false) {
      chat.addError(r.message ?? '라노에게 말을 전하지 못했어요.', new Date().toISOString());
      giveBack();
    }
  } catch {
    chat.addError('라노에게 말을 전하지 못했어요. 잠시 뒤 다시 보내 주세요.', new Date().toISOString());
    giveBack();
  } finally {
    sending = false;
    refreshBusy();
    if (currentTab === 'chat') chatInput.focus();
  }
}

// ---------- 현황판 ----------
const board = new Board();
board.onWorkingChange = (anyWorking, names) => {
  boardDot.hidden = !anyWorking;
  tabButtons.board.title = anyWorking ? `${names.join('·')} 리더가 일하고 있어요` : '';
};

board.onApprovalsClick = () => showTab('approvals');
board.onFirstMission = () => {
  showTab('org');
  org.openNewMission();
};
board.onAskRano = () => {
  showTab('chat');
  if (!chatInput.value.trim()) chatInput.value = '이런 일을 맡기고 싶어: ';
  chatInput.focus();
  refreshBusy();
};
board.office.onOutputsClick = () => showTab('outputs');

// ---------- 승인함 · 결과물함 ----------
const approvals = new ApprovalsView();
const outputs = new OutputsView();
const outputsBadge = mustGet<HTMLSpanElement>('outputs-badge');
outputs.onUnseen = (n) => {
  // 결과물함을 보고 있으면 바로 본 것으로 친다
  if (n > 0 && currentTab === 'outputs') {
    outputs.markSeen();
    return;
  }
  outputsBadge.textContent = n > 0 ? String(n) : '';
  outputsBadge.hidden = n <= 0;
  outputsBadge.setAttribute('aria-label', n > 0 ? `새 결과물 ${n}개` : '');
};
approvals.missionName = outputs.missionName = (id) => board.nameOf(id);
approvals.onPendingCount = (n) => {
  approvalsBadge.textContent = n > 0 ? String(n) : '';
  approvalsBadge.hidden = n === 0;
  tabButtons.approvals.title = n > 0 ? `기다리는 승인 요청 ${n}건` : '';
};
// ---------- 조직 ----------
const org = new OrgView();

// ---------- 할 일 ----------
const todo = new TodoView();
todo.onOpenOutputs = () => showTab('outputs');
// 할 일 ↔ 대화 잇기: 말풍선에 마우스를 올리면 그 말의 할 일을, 가장 최근 라노 답의 할 일은 "지금 이야기 중"으로 강조
chat.onHoverTodos = (ids) => todo.setHover(ids);
todo.onTalk = (id) => chat.filterTodo(id);
todo.onStart = (item) => {
  void rano
    .send(`할 일 「${item.title}」(id: ${item.id})을 시작해 주세요.`, [])
    .then((r) => {
      if (r && r.ok === false) chat.addError(r.message ?? '라노에게 말을 전하지 못했어요.', new Date().toISOString());
    })
    .catch(() => chat.addError('라노에게 말을 전하지 못했어요. 잠시 뒤 다시 눌러 주세요.', new Date().toISOString()));
};
// 대화 화면의 "지금" 줄: 진행 중 과제 멈추기, 승인 카드 바로 처리
const chatNow = new ChatNow();
chatNow.onOpenApprovals = () => showTab('approvals');

board.onNamesChange = () => {
  approvals.refresh();
  outputs.refresh();
};

// ---------- 대화 사이 카드 ----------
/** 리더 보고 도착 카드: 라노 요약을 기다리지 않고 바로. 보고 첫 줄은 꾸밈 없는 글자로 */
function reportCard(e: { missionId: string; missionName: string; ok: boolean; firstLine: string }): HTMLElement {
  const card = el('div', 'item activity');
  card.style.flexWrap = 'wrap';
  card.appendChild(el('span', 'activity-text', `📋 ${e.missionName} 리더 보고 · ${e.ok ? '완료' : '중단'} — ${e.firstLine}`));
  const go = el('button', 'btn btn-small btn-plain', '현황판에서 보기');
  go.type = 'button';
  go.addEventListener('click', () => {
    showTab('board');
    void board.open(e.missionId);
  });
  card.appendChild(go);
  return card;
}

/** 답을 받지 못한 내 말 안내 (앱이 꺼졌거나 오류·끊김으로 답이 없던 말. 자동으로 다시 실행하지 않음) */
function unansweredCard(id: string, text: string): HTMLElement {
  const card = el('div', 'item activity');
  card.style.flexWrap = 'wrap';
  const short = text.replace(/\s+/g, ' ').trim();
  card.appendChild(el('span', 'activity-text', `답을 받지 못한 말이에요: ‘${short.length > 40 ? `${short.slice(0, 40)}…` : short || '(그림)'}’`));
  const again = el('button', 'btn btn-small', '다시 보내기');
  again.type = 'button';
  again.addEventListener('click', async () => {
    again.disabled = true;
    try {
      const r = await rano.resend(id);
      if (r?.ok) card.remove();
      else {
        chat.addError(r?.message ?? '다시 보내지 못했어요.', new Date().toISOString());
        again.disabled = false;
      }
    } catch {
      chat.addError('다시 보내지 못했어요. 잠시 뒤 다시 눌러 주세요.', new Date().toISOString());
      again.disabled = false;
    }
  });
  card.appendChild(again);
  return card;
}

// ---------- 이벤트 ----------
let historyLoaded = false;
const pendingChat: RanoUiEvent[] = [];

function handleChatEvent(e: RanoUiEvent): void {
  switch (e.kind) {
    case 'message':
      chat.addMessage(e.message, false);
      if (e.message.role === 'rano') todo.setNow(chat.latestTodos());
      if (e.message.role === 'user' && e.queued) {
        const what = e.waitFor ? `앞 일(${e.waitFor.replace(/\s*중$/, '')})을 마치면 바로 답해요` : '앞 일을 마치면 바로 답해요';
        waitNotes.set(e.message.id, chat.addTransient(what, e.message.at, 'right'));
        // 지금 쓰는 말풍선은 앞 차례 것: 방금 보낸 말의 답처럼 보이지 않게 표시를 붙인다
        if (thinking && !e.waitFor) setThinkingName('앞 말에 답하는 중');
      }
      if (e.message.role === 'rano' && typeof e.turn === 'number' && e.turn === activeTurn) {
        // 답이 확정되면 쓰던 말풍선·회색 줄은 지운다 (확정 말풍선이 대신 보임)
        answeredTurn = e.turn;
        resetLive();
        refreshBusy();
      }
      break;
    case 'status':
      thinking = e.status === 'thinking';
      if (thinking) {
        activeTurn = typeof e.turn === 'number' ? e.turn : null;
        answeredTurn = null;
        setThinkingName(e.label);
        for (const id of e.users ?? []) {
          waitNotes.get(id)?.remove();
          waitNotes.delete(id);
        }
      } else {
        // 안전망: 차례가 끝나면 쓰던 말풍선·회색 줄을 반드시 지운다
        activeTurn = null;
        answeredTurn = null;
        setThinkingName();
      }
      resetLive();
      board.office.setRanoBusy(thinking);
      refreshBusy();
      break;
    case 'live':
      // 지금 차례 것만. 다른 차례(앞 차례가 남긴 조각)나 답이 확정된 뒤 조각은 버린다
      if (!thinking || e.turn !== activeTurn || e.turn === answeredTurn) break;
      if (!e.text && !e.steps.length) resetLive();
      else showLive(e.text, e.steps);
      break;
    case 'report':
      chat.addCard(reportCard(e), e.at);
      break;
    case 'activity':
      chat.addActivity(e.text, e.at);
      break;
    case 'skillSuggest':
      chat.addCard(skillSuggestCard(e.need, e.items, () => void org.load()), e.at);
      break;
    case 'orgProposal':
      chat.addCard(
        proposalCard(e.proposal, () => {
          showTab('org');
          org.openProposal(e.proposal);
        }),
        e.at,
      );
      break;
    case 'error':
      chat.addError(e.text, e.at);
      break;
  }
}

function handleEvent(e: RanoUiEvent): void {
  if (!e || typeof e !== 'object') return;
  if ((e.kind === 'activity' || e.kind === 'error') && typeof e.missionId === 'string' && e.missionId) {
    // 미션에서 온 한 줄은 그 리포 리더 대화 패널로 (닫혀 있으면 버린다)
    board.leaderLine(e.missionId, e.kind, e.text, e.at);
  } else if (e.kind === 'approvals') {
    approvals.update(e.items);
    chatNow.setApprovals(e.items);
  } else if (e.kind === 'outputs') {
    outputs.update(e.items);
    board.office.setOutputsCount(Array.isArray(e.items) ? e.items.filter((x) => x.status === 'done').length : 0);
  } else if (e.kind === 'navigate') {
    if (TAB_NAMES.includes(e.tab)) showTab(e.tab);
  } else if (e.kind === 'orgOpenProposal') {
    showTab('org');
    org.openProposal(e.proposal);
  } else if (e.kind === 'todos') {
    todo.update(e.items);
    outputs.setTodos(e.items);
  } else if (e.kind === 'mission') {
    board.updateMission(e.status);
    todo.updateMission(e.status);
    chatNow.setMission(e.status);
  } else if (e.kind === 'leaderMessage') {
    board.leaderMessage(e.missionId, e.message);
  } else if (historyLoaded) {
    handleChatEvent(e);
  } else {
    // 라노 대화 기록을 불러오는 사이에 온 이벤트는 모아 두었다가 기록 다음에 그린다.
    pendingChat.push(e);
  }
}

// ---------- 시작 ----------
async function start(): Promise<void> {
  try {
    const s = await rano.appSettings();
    setRoleLabels(s.roleLabels);
    setZoneInfo(s.zones);
  } catch {
    // 쉬운 이름이 없으면 역할 이름 그대로 보인다
  }
  rano.onEvent(handleEvent);
  const topbar = document.querySelector<HTMLElement>('.topbar');
  if (topbar) {
    const right = document.createElement('div');
    right.className = 'topbar-right';
    topbar.appendChild(right);
    new GuideButton(right);
    const finder = new SearchButton(right);
    finder.onGo = (h) => {
      if (h.kind === 'rano') showTab('chat');
      else if (h.kind === 'leader' && h.missionId) {
        showTab('board');
        void board.open(h.missionId);
      } else if (h.kind === 'output') showTab('outputs');
      else showTab('approvals');
    };
    new SettingsButton(right);
    new AccountButton(right);
  }
  void new SetupGuide().openIfNeeded();
  openGuideIfMarked();
  startUpdateNotice();
  void board.load();
  void approvals.load();
  void outputs.load();
  rano.outputsList().then((items) => board.office.setOutputsCount(Array.isArray(items) ? items.filter((x) => x.status === 'done').length : 0)).catch(() => undefined);
  void todo.load();
  void org.load();
  void rano.approvalsList().then((items) => chatNow.setApprovals(items)).catch(() => undefined);
  void rano.missionList().then((list) => { for (const s of Array.isArray(list) ? list : []) chatNow.setMission(s); }).catch(() => undefined);

  let history: ChatMessage[] = [];
  try {
    const h = await rano.loadHistory();
    if (Array.isArray(h)) history = h;
    for (const m of history) chat.addMessage(m, true);
  } catch {
    chat.addError('이전 대화를 불러오지 못했어요. 새 대화는 그대로 할 수 있어요.', new Date().toISOString());
  }
  // 앱이 꺼져 답하지 못한 내 말: 표시만 하고, 다시 보내기는 사용자가 누를 때만
  try {
    const ids = await rano.unanswered();
    for (const id of Array.isArray(ids) ? ids : []) {
      const m = history.find((x) => x.id === id);
      if (m) chat.addCard(unansweredCard(id, m.text ?? ''), new Date().toISOString());
    }
  } catch {
    // 표시만 못 할 뿐 대화는 그대로
  }

  historyLoaded = true;
  todo.setNow(chat.latestTodos());
  for (const e of pendingChat.splice(0)) handleChatEvent(e);
  chat.setReady(true);
  refreshBusy();
  chat.scrollToBottom();
  chatInput.focus();
}

void start();
