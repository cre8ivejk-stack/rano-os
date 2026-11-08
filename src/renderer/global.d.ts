// 화면에서 쓰는 window.rano 타입. renderer 는 src/shared 를 불러올 수 없어 src/shared/types.ts 에서 복제했다.
// types.ts 의 대화·미션·이벤트·RanoApi 가 바뀌면 여기도 같이 고친다.

type ChatRole = 'user' | 'rano' | 'leader';

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: string; // ISO 시각
  attachments?: ChatAttachment[];
  via?: 'mobile'; // 휴대폰(텔레그램)에서 보낸 말
}

type MemberState = 'idle' | 'working' | 'reviewing' | 'done';

interface MemberStatus {
  role: string;
  state: MemberState;
  task?: string;
  updatedAt: string;
}

interface MissionTask {
  id: string;
  title: string;
  from: 'rano' | 'user';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  report?: string;
  stoppedByRejection?: boolean;
}

interface ActivityItem {
  at: string;
  who: string;
  text: string;
}

interface MissionStatus {
  missionId: string;
  name: string;
  leaderState: 'idle' | 'working';
  currentTask: MissionTask | null;
  members: MemberStatus[];
  pendingApprovals: number;
  recent: ActivityItem[];
  queued?: { title: string; from: 'rano' | 'user'; queuedAt: string; resumed?: boolean }[];
}

type RanoUiEvent =
  | { kind: 'status'; status: 'idle' | 'thinking' }
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'activity'; text: string; at: string; missionId?: string }
  | { kind: 'error'; text: string; at: string; missionId?: string }
  | { kind: 'mission'; status: MissionStatus }
  | { kind: 'leaderMessage'; missionId: string; message: ChatMessage }
  | { kind: 'approvals'; items: ApprovalRequest[] }
  | { kind: 'outputs'; items: TaskOutput[] }
  | { kind: 'navigate'; tab: 'chat' | 'board' | 'approvals' | 'outputs' }
  | { kind: 'todos'; items: TodoItem[] }
  | { kind: 'orgProposal'; proposal: MissionProposal; at: string }
  | { kind: 'orgOpenProposal'; proposal: MissionProposal }
  | { kind: 'skillSuggest'; need: string; items: SkillSuggestion[]; at: string };

type Zone = 'work' | 'personal';

/** 처음 켰을 때 안내 */
/** Claude 계정 연결 상태 */
interface AuthStatus {
  method: 'max' | 'apiKey'; // 지금 일할 때 쓰는 방식
  loggedIn: boolean; // 이 맥의 Claude 계정 로그인
  account?: { kind: 'subscription' | 'console'; email?: string; orgName?: string; plan?: string; expiresAt?: string };
  apiKeySaved: boolean;
  apiKeyHint?: string; // 끝 4자리
  error?: string;
}
type AuthResult = { ok: boolean; message: string };

/** 새 버전 확인 결과 */
interface UpdateInfo {
  current: string;
  latest?: string;
  newer: boolean;
  url?: string; // 배포본 페이지
  notes?: string; // 바뀐 내용 (배포본 설명)
  publishedAt?: string;
  error?: string;
}

/** 대화 첨부 그림 */
interface ChatAttachment {
  id: string; // 12자리
  name: string; // 원래 파일 이름 (없으면 '캡처')
  mime: string; // image/png 등
  marked?: boolean; // 사용자가 펜·네모·화살표·번호로 표시한 그림
}
/** 화면에서 보낼 새 그림 (base64) */
interface NewAttachment {
  name: string;
  mime: string;
  data: string;
  marked?: boolean;
}

/** 현황판 사용량 보기 */
interface UsageSummary {
  weekStart: string;
  rows: { who: string; name: string; weekRuns: number; weekTokens: number; weekCost: number; todayRuns: number; todayTokens: number; todayCost: number }[];
  days: { date: string; tokens: number }[]; // 최근 7일
  limits: { type: string; status?: string; utilization?: number; pct?: boolean; expired?: boolean; resetsAt?: string; at?: string }[]; // 구독 사용 한도 (엔진이 알려 준 최신값). pct: utilization 이 0~100 % 값. expired: 다시 채워지는 시각이 지나 값이 지난 구간 것
}

/** 미션 기록 보기: 미션 홈의 문서 하나 */
interface MissionDoc {
  file: string; // 미션 홈 기준 (charter.md, memory/결정로그.md …)
  label: string; // 화면 이름
  content: string;
  updatedAt?: string;
}

/** 지난 일 찾기 결과 하나 */
interface SearchHit {
  kind: 'rano' | 'leader' | 'output' | 'approval';
  missionId?: string;
  missionName?: string;
  who: string;
  title: string;
  snippet: string; // 찾은 낱말 주변
  text: string; // 전체 (펼쳐 보기)
  at?: string;
}

/** 휴대폰(텔레그램) 연결 상태 */
interface MobileStatus {
  connected: boolean; // 봇 토큰이 있음
  paired: boolean; // 휴대폰 대화방과 짝지음
  running: boolean;
  botName?: string;
  pairedName?: string;
  pairCode?: string; // 짝짓기 전에만
  allRano: boolean; // 라노의 답을 모두 휴대폰으로도
  approvals: boolean; // 승인 요청 알림
  keepAwake: boolean; // 잠자기 막기 설정
  keepingAwake: boolean; // 지금 실제로 막고 있는지
  error?: string;
}

/** 스킬 보관함 */
interface ConnectorInfo {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;
  missingSecrets: string[];
  label: string;
  command: string;
  args: string[];
  envNames: string[];
  secretEnv: string[];
  usedBy: string[];
  from?: string;
}
interface ConnectorCandidate {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;
  command: string;
  args: string[];
  envNames: string[];
  imported: boolean;
}
interface SkillInfo {
  name: string;
  description: string;
  builtin: boolean; // 라노 OS 기본 스킬
  files: number;
  hasScripts: boolean;
  usedBy: string[]; // 이 스킬을 쓰는 역할
}
interface SkillPreview {
  token: string;
  name: string;
  description: string;
  source: string;
  files: { path: string; size: number; script: boolean }[];
  skillMd: string;
  license?: string;
  exists: boolean; // 같은 이름이 이미 있음(바꿔 넣게 됨)
  builtin: boolean; // 기본 스킬과 같은 이름(넣을 수 없음)
}
interface ToolsStatus {
  installed: boolean;
  installing: boolean;
  packages: { name: string; version?: string }[];
  python?: string;
  browser?: boolean; // 웹 화면 확인 도구(playwright·chromium)
  log?: string; // 설치 중 마지막 줄
}

/** 추천 스킬 하나 */
interface SkillSuggestion {
  name: string;
  url: string;
  license: string;
  why: string;
  installed: boolean;
  matched: string[]; // 하려는 일에서 맞은 낱말
}

interface SetupStatus {
  needed: boolean; // 안내를 띄워야 하는지 (처음 쓰는 사람)
  dataDir: string; // 데이터 폴더 (~ 로 줄임)
  profile: { name: string; callName: string; org: string; job: string; devLevel: string };
  zones: Record<Zone, { label: string; root: string; exists: boolean }>;
}
interface SetupInput {
  profile: { name: string; callName: string; org: string; job: string; devLevel: 'none' | 'some' | 'dev' | string };
  zones: Record<Zone, string>; // 절대 경로 또는 ~ 경로
}
interface SetupFolderCheck {
  ok: boolean;
  path: string;
  display: string;
  exists: boolean;
  problem?: string;
}

interface AppSettings {
  roleLabels: Record<string, string>;
  zones: Record<Zone, { label: string; root: string }>;
  version: string;
}

interface MissionProposal {
  id: string;
  createdAt: string;
  name: string;
  goal: string;
  zone: Zone;
  target?: string;
  targetNote?: string;
  readonlyRefs: string[];
  roles: string[];
  reviewerRoles: string[];
  newRoles: RoleDraft[];
  reason: string;
}

type ApprovalKind =
  | 'teamPlan'
  | 'decision'
  | 'write'
  | 'outsideWrite'
  | 'commit'
  | 'delete'
  | 'db'
  | 'deploy'
  | 'external'
  | 'numbers'
  | 'reverseDecision'
  | 'estimate'
  | 'command'
  | 'bundle'
  | 'other';

interface BundleFile {
  rel: string;
  abs: string;
  draft: string;
  change?: FileChange;
}

/** 파일 쓰기 승인: 바뀌기 전·후 내용 (비밀로 보이는 줄은 가림) */
interface FileChange {
  before: string; // 지금 내용 (새 파일이면 '')
  after: string; // 바뀐 뒤 내용
  isNew: boolean;
  truncated?: boolean; // 너무 커서 앞부분만
}

interface ApprovalRequest {
  id: string;
  missionId: string;
  taskId?: string;
  who: string;
  kind: ApprovalKind;
  title: string;
  what: string;
  why: string;
  recommendation: string;
  detail?: string;
  filePath?: string;
  change?: FileChange;
  bundle?: BundleFile[];
  picked?: string[];
  status: 'pending' | 'approved' | 'rejected' | 'revise' | 'expired';
  decisionNote?: string;
  rememberFile?: boolean;
  rememberKey?: string;
  rememberLabel?: string;
  tool?: string; // 요청을 만든 도구. 'Bash' 면 "다시 묻지 않기" 체크 칸을 띄우지 않는다
  createdAt: string;
  decidedAt?: string;
  decisionItems?: DecisionItem[];
  planGate?: boolean;
  choices?: Record<string, string>;
}

interface ApprovalDecision {
  decision: 'approve' | 'reject' | 'revise';
  note?: string;
  rememberFile?: boolean;
  choices?: Record<string, string>;
  picked?: string[];
}

interface DecisionOption {
  key: string;
  label: string;
  detail?: string;
  preview?: string;
}
interface DecisionItem {
  id: string;
  question: string;
  options: DecisionOption[];
  recommended: string;
}

interface TaskOutput {
  taskId: string;
  missionId: string;
  title: string;
  from: 'rano' | 'user';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  leaderReport?: string;
  reviewReports: { role: string; text: string; at: string }[];
  changedFiles: { path: string; change: 'added' | 'modified' | 'deleted'; rel?: string; folder?: string }[];
}

interface RanoApi {
  loadHistory(): Promise<ChatMessage[]>;
  send(text: string, attachments?: NewAttachment[]): Promise<{ ok: boolean; message?: string }>;
  attachmentData(a: ChatAttachment): Promise<string | null>;
  onEvent(cb: (e: RanoUiEvent) => void): () => void;
  missionList(): Promise<MissionStatus[]>;
  missionHistory(missionId: string): Promise<ChatMessage[]>;
  missionSend(missionId: string, text: string, attachments?: NewAttachment[]): Promise<{ ok: boolean; message?: string }>;
  approvalsList(): Promise<ApprovalRequest[]>;
  approvalDecide(id: string, decision: ApprovalDecision): Promise<void>;
  approvalOpenPreview(id: string, itemId: string, optionKey: string): Promise<{ ok: boolean; message?: string; reveal?: boolean }>;
  approvalRevealPreview(id: string, itemId: string, optionKey: string): Promise<{ ok: boolean; message?: string }>;
  outputsList(): Promise<TaskOutput[]>;
  openFile(absPath: string): Promise<{ ok: boolean; message?: string }>;
  revealFile(absPath: string): Promise<{ ok: boolean; message?: string }>;
  orgMissions(): Promise<MissionSummary[]>;
  orgPickFolder(purpose: 'target' | 'ref', zone: Zone): Promise<string | null>;
  orgInspect(absPath: string, purpose: 'target' | 'ref', zone: Zone, editingId?: string): Promise<FolderInspection>;
  orgCreateMission(draft: MissionDraft): Promise<AdminResult>;
  orgUpdateMission(id: string, draft: MissionDraft): Promise<AdminResult>;
  orgArchiveMission(id: string, archived: boolean): Promise<AdminResult>;
  orgRoles(): Promise<RoleInfo[]>;
  orgRole(name: string): Promise<RoleInfo | null>;
  orgSaveRole(draft: RoleDraft, originalName?: string): Promise<AdminResult>;
  orgRestart(): Promise<void>;
  appSettings(): Promise<AppSettings>;
  authStatus(): Promise<AuthStatus>;
  authStartLogin(kind: 'claudeai' | 'console'): Promise<{ ok: boolean; url?: string; message?: string }>;
  authSubmitCode(code: string): Promise<AuthResult>;
  authCancelLogin(): Promise<void>;
  authLogout(): Promise<AuthResult>;
  authSaveApiKey(key: string): Promise<AuthResult>;
  authUseMethod(method: 'max' | 'apiKey'): Promise<AuthResult>;
  authRemoveApiKey(): Promise<AuthResult>;
  authOpenLoginPage(url: string): Promise<void>;
  settingsSaveProfile(profile: SetupInput['profile']): Promise<AuthResult>;
  settingsSaveZones(zones: Record<Zone, string>): Promise<{ ok: boolean; message: string; needsRestart: boolean }>;
  openDataFolder(): Promise<void>;
  updateCheck(): Promise<UpdateInfo>;
  openReleasePage(url: string): Promise<void>;
  guideRead(): Promise<{ ok: boolean; text: string; url?: string }>;
  mobileStatus(): Promise<MobileStatus>;
  mobileConnect(token: string): Promise<{ ok: boolean; message: string }>;
  mobileDisconnect(): Promise<{ ok: boolean; message: string }>;
  mobileOptions(o: { allRano?: boolean; approvals?: boolean; keepAwake?: boolean }): Promise<void>;
  mobileNewCode(): Promise<void>;
  skillsList(): Promise<SkillInfo[]>;
  skillRead(name: string): Promise<{ name: string; description: string; body: string; files: string[] } | null>;
  roleSkills(): Promise<Record<string, string[]>>;
  setRoleSkills(role: string, names: string[]): Promise<{ ok: boolean; message: string }>;
  skillPreview(source: string): Promise<{ ok: true; preview: SkillPreview } | { ok: false; message: string }>;
  skillInstall(token: string): Promise<{ ok: boolean; message: string; name?: string }>;
  skillRemove(name: string): Promise<{ ok: boolean; message: string }>;
  connectorsList(): Promise<ConnectorInfo[]>;
  connectorCandidates(): Promise<ConnectorCandidate[]>;
  connectorImport(name: string): Promise<{ ok: boolean; message: string }>;
  connectorRemove(name: string): Promise<{ ok: boolean; message: string }>;
  connectorSetSecret(name: string, key: string, value: string): Promise<{ ok: boolean; message: string }>;
  setMissionConnectors(missionId: string, names: string[]): Promise<{ ok: boolean; message: string }>;
  toolsStatus(): Promise<ToolsStatus>;
  skillRegistry(): Promise<SkillSuggestion[]>;
  skillsAuto(): Promise<boolean>;
  setSkillsAuto(on: boolean): Promise<{ ok: boolean; message: string }>;
  toolsInstall(kind?: 'docs' | 'browser'): Promise<{ ok: boolean; message: string }>;
  usageSummary(): Promise<UsageSummary>;
  search(query: string): Promise<SearchHit[]>;
  missionDocs(missionId: string): Promise<MissionDoc[]>;
  setupStatus(): Promise<SetupStatus>;
  setupPickFolder(zone: Zone, current: string): Promise<string | null>;
  setupCheckFolder(zone: Zone, p: string): Promise<SetupFolderCheck>;
  setupSave(input: SetupInput): Promise<{ ok: boolean; message: string; needsRestart: boolean }>;
  todosList(): Promise<TodoItem[]>;
  todosAdd(missionId: string | null, title: string): Promise<TodoItem[]>;
  todosUpdate(id: string, patch: { title?: string; status?: TodoStatus }): Promise<TodoItem[]>;
  todosMove(id: string, dir: -1 | 1): Promise<TodoItem[]>;
  todosRemove(id: string): Promise<TodoItem[]>;
}

type TodoStatus = 'waiting' | 'active' | 'review' | 'done';

interface TodoItem {
  id: string;
  missionId: string | null;
  title: string;
  status: TodoStatus;
  queued?: boolean;
  note?: string;
  taskId?: string; // 이 할 일로 돌린 마지막 과제(결과물함 카드와 잇는다)
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
}

// ---- 조직(미션 관리·인재풀) ----
interface FolderInspection {
  path: string;
  display: string;
  ok: boolean;
  problems: string[];
  warnings: string[];
  isGitRepo: boolean;
  branch?: string;
  ruleFiles: string[];
  secretCandidates: string[];
  deploysOnPush: boolean;
  deployHints: string[];
}

interface RoleInfo {
  name: string;
  description: string;
  tools: string[] | null;
  canWrite: boolean;
  canRun: boolean;
  zone: Zone;
  source: 'work' | 'pool' | 'mission';
  dir: string;
  editable: boolean;
  usedBy: string[];
  body?: string;
  model: RoleModel;
}

type RoleModel = 'default' | 'opus' | 'sonnet';

interface RoleDraft {
  zone?: Zone;
  name: string;
  description: string;
  canWrite: boolean;
  canRun: boolean;
  body: string;
  model?: RoleModel;
}

interface MissionDraft {
  name: string;
  goal: string;
  zone: Zone;
  target: string;
  readonlyRefs: string[];
  blocked: string[];
  writeMode: 'readOnly' | 'approval';
  writeConfirmed: boolean;
  roles: string[];
  reviewerRoles: string[];
}

interface MissionSummary {
  id: string;
  name: string;
  zone: 'work' | 'personal';
  goal?: string;
  target: string;
  readonlyRefs: string[];
  blocked: string[];
  writeMode: 'readOnly' | 'approval';
  roles: string[];
  reviewerRoles: string[];
  archived: boolean;
  home: string;
  active: boolean;
}

interface AdminResult {
  ok: boolean;
  message: string;
  id?: string;
  needsRestart?: boolean;
}

interface Window {
  rano: RanoApi;
}
