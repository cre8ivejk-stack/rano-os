// 라노 OS 화면의 시작점: 탭 전환, 라노 대화, 현황판을 잇는다.
// 원칙: 대화 말은 앱 본체가 보내는 이벤트로만 그린다(내 말도 이벤트로 온다). 글은 모두 textContent 로 넣는다.
import { ApprovalsView } from './approvals.js';
import { Board } from './board.js';
import { OrgView } from './org.js';
import { OutputsView } from './outputs.js';
import { TodoView } from './todo.js';
import { proposalCard } from './orgProposal.js';
import { ChatView, type SpeakerStyle } from './chatView.js';
import { bindComposer, mustGet, setRoleLabels, setZoneInfo } from './dom.js';
import { SetupGuide } from './setup.js';
import { ImageTray } from './attach.js';
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
let sending = false; // 보낸 뒤 답이 끝날 때까지

function refreshBusy(): void {
  const busy = thinking || sending;
  const stick = chat.isNearBottom();
  thinkingEl.hidden = !busy;
  if (busy && stick) chat.scrollToBottom();
  chatSendBtn.disabled = busy || (!chatInput.value.trim() && !tray.count);
  chatSendBtn.textContent = busy ? '답을 기다리는 중' : '보내기';
}

const { autosize } = bindComposer({
  form: mustGet('composer'),
  input: chatInput,
  onSubmit: () => void submit(),
  onInput: refreshBusy,
});

async function submit(): Promise<void> {
  const text = chatInput.value.trim();
  if ((!text && !tray.count) || thinking || sending) return;

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

board.onNamesChange = () => {
  approvals.refresh();
  outputs.refresh();
};

// ---------- 이벤트 ----------
let historyLoaded = false;
const pendingChat: RanoUiEvent[] = [];

function handleChatEvent(e: RanoUiEvent): void {
  switch (e.kind) {
    case 'message':
      chat.addMessage(e.message, false);
      break;
    case 'status':
      thinking = e.status === 'thinking';
      board.office.setRanoBusy(thinking);
      refreshBusy();
      break;
    case 'activity':
      chat.addActivity(e.text, e.at);
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
  } else if (e.kind === 'mission') {
    board.updateMission(e.status);
    todo.updateMission(e.status);
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
  startUpdateNotice();
  void board.load();
  void approvals.load();
  void outputs.load();
  rano.outputsList().then((items) => board.office.setOutputsCount(Array.isArray(items) ? items.filter((x) => x.status === 'done').length : 0)).catch(() => undefined);
  void todo.load();
  void org.load();

  try {
    const history = await rano.loadHistory();
    if (Array.isArray(history)) for (const m of history) chat.addMessage(m, true);
  } catch {
    chat.addError('이전 대화를 불러오지 못했어요. 새 대화는 그대로 할 수 있어요.', new Date().toISOString());
  }

  historyLoaded = true;
  for (const e of pendingChat.splice(0)) handleChatEvent(e);
  chat.setReady(true);
  refreshBusy();
  chat.scrollToBottom();
  chatInput.focus();
}

void start();
