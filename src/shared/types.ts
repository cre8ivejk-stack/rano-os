// 라노 OS 공통 약속(계약). 앱 본체·엔진·기억·화면이 함께 쓰는 타입과 IPC 채널 이름.
// 이 파일은 리더만 고친다. 바꿀 일이 있으면 리더에게 요청한다.

// ---------- 설정 (config/rano.json 을 읽어 경로를 풀어 둔 형태) ----------
export type Zone = 'work' | 'personal';

/** Claude 계정 연결 상태 */
export interface AuthStatus {
  method: 'max' | 'apiKey'; // 지금 일할 때 쓰는 방식
  loggedIn: boolean; // 이 맥의 Claude 계정 로그인
  account?: { kind: 'subscription' | 'console'; email?: string; orgName?: string; plan?: string; expiresAt?: string };
  apiKeySaved: boolean;
  apiKeyHint?: string; // 끝 4자리
  error?: string;
}
export type AuthResult = { ok: boolean; message: string };

/** 새 버전 확인 결과 */
export interface UpdateInfo {
  current: string;
  latest?: string;
  newer: boolean;
  url?: string; // 배포본 페이지
  notes?: string; // 바뀐 내용 (배포본 설명)
  publishedAt?: string;
  error?: string;
}

/** 현황판 사용량 보기 */
export interface UsageSummary {
  weekStart: string;
  rows: { who: string; name: string; weekRuns: number; weekTokens: number; weekCost: number; todayRuns: number; todayTokens: number; todayCost: number }[];
  days: { date: string; tokens: number }[]; // 최근 7일
  limits: { type: string; status?: string; utilization?: number; resetsAt?: string; at?: string }[]; // 구독 사용 한도 (엔진이 알려 준 최신값)
}

/** 미션 기록 보기: 미션 홈의 문서 하나 */
export interface MissionDoc {
  file: string; // 미션 홈 기준 (charter.md, memory/결정로그.md …)
  label: string; // 화면 이름
  content: string;
  updatedAt?: string;
}

/** 지난 일 찾기 결과 하나 */
export interface SearchHit {
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
export interface MobileStatus {
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
export interface SkillInfo {
  name: string;
  description: string;
  builtin: boolean; // 라노 OS 기본 스킬
  files: number;
  hasScripts: boolean;
  usedBy: string[]; // 이 스킬을 쓰는 역할
}
export interface SkillPreview {
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
export interface ToolsStatus {
  installed: boolean;
  installing: boolean;
  packages: { name: string; version?: string }[];
  python?: string;
  browser?: boolean; // 웹 화면 확인 도구(playwright·chromium)
  log?: string; // 설치 중 마지막 줄
}

/** 추천 스킬 하나 */
export interface SkillSuggestion {
  name: string;
  url: string;
  license: string;
  why: string;
  installed: boolean;
  matched: string[]; // 하려는 일에서 맞은 낱말
}

/** 처음 켰을 때 안내 */
export interface SetupStatus {
  needed: boolean; // 안내를 띄워야 하는지 (처음 쓰는 사람)
  dataDir: string; // 데이터 폴더 (~ 로 줄임)
  profile: { name: string; callName: string; org: string; job: string; devLevel: string };
  zones: Record<Zone, { label: string; root: string; exists: boolean }>;
}
export interface SetupInput {
  profile: { name: string; callName: string; org: string; job: string; devLevel: 'none' | 'some' | 'dev' | string };
  zones: Record<Zone, string>; // 절대 경로 또는 ~ 경로
}
export interface SetupFolderCheck {
  ok: boolean;
  path: string;
  display: string;
  exists: boolean;
  problem?: string;
}

/** 화면이 켤 때 받는 설정 요약 */
export interface AppSettings {
  roleLabels: Record<string, string>; // 역할 이름 → 쉬운 이름 (rano.json roleLabels)
  zones: Record<Zone, { label: string; root: string }>; // root 는 ~ 로 줄인 경로
  version: string; // 앱 버전
}

/** 구역: 회사(~/work)와 개인(~/personal). 미션은 자기 구역 루트 아래 폴더만 쓰고, denyRead 는 그 구역 미션이 읽지도 쓰지도 못한다. */
export interface ZoneConfig {
  label: string; // '회사' | '개인'
  root: string; // 구역 루트 절대 경로 (~/work, ~/personal)
  denyRead: string[]; // 이 구역 미션이 열 수 없는 절대 경로 (다른 구역 폴더)
}

export interface RanoConfig {
  rootDir: string; // 절대 경로 (~ 풀림)
  zones?: Record<Zone, ZoneConfig>; // 없으면 기본값(회사 ~/work, 개인 ~/personal)
  authMethod: 'max' | 'apiKey';
  models: { rano: string; repoLeader: string; member: string };
  blocked: string[]; // 절대 경로 또는 ** 패턴 (~ 풀림)
  memoryDir: string; // 절대 경로
  memoryFiles: string[]; // 예: ['me.md', 'priorities.md', 'missions.md']
  autoCommit: boolean;
  runsDir: string; // 절대 경로
  missions: MissionConfig[];
  raw: unknown; // rano.json 원본
}

// ---------- 미션 (2단계) ----------
export interface MissionConfig {
  id: string; // 'homepage'
  name: string; // '홈페이지'
  zone: 'work' | 'personal';
  home: string; // 미션 홈 절대 경로 (~/rano/missions/work/homepage)
  targets: string[]; // 작업 대상 폴더 절대 경로
  readonlyRefs: string[]; // 참고용(읽기 전용) 절대 경로
  rulesFiles: string[]; // 리포 리더가 그대로 읽는 규칙 파일 절대 경로
  rolesDir: string; // 역할 파일 폴더 절대 경로 (~/work/.claude/agents)
  roleDirs: string[]; // 역할을 찾을 폴더들(앞에서부터). rolesDir 가 첫째, 이어서 인재풀(~/rano/pool/<구역>)·회사 공용 역할 폴더
  roles: string[]; // 이 미션에서 부를 수 있는 역할 이름
  reviewerRoles: string[]; // 이 역할이 일하는 동안은 '검수 중'
  stagePolicy: 'readOnly' | 'approval'; // 2단계 readOnly: 읽기만. 3단계 approval: 쓰기는 승인 규칙대로
  directWriteDirs: string[]; // 3단계: 승인 없이 바로 쓸 수 있는 폴더(절대 경로). 비어 있으면 모든 쓰기가 승인함 (2026-11-04 사용자 결정: 비움)
  // rano.json 에 archived: true 인 미션은 loadConfig 가 config.missions 에서 뺀다(현황판·리더 없음). 조직 화면은 원본에서 읽는다.
}

export type MemberState = 'idle' | 'working' | 'reviewing' | 'done'; // 대기·작업 중·검수 중·완료

export interface MemberStatus {
  role: string; // 'work-writer'
  state: MemberState;
  task?: string; // 지금 맡은 일 한 줄
  updatedAt: string;
}

export interface MissionTask {
  id: string;
  title: string; // 지시 내용 한 줄 요약(앞 60자 정도)
  from: 'rano' | 'user'; // 라노 배정 / 사용자 직접 지시
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  report?: string; // 리포 리더의 최종 보고
  stoppedByRejection?: boolean; // 승인함 반려로 팀원 없이 멈춘 과제 (현황판에 '반려로 멈춤'으로 보임)
}

export interface ActivityItem {
  at: string;
  who: string; // '라노' | '홈페이지 리더' | 역할 이름 | '앱'
  text: string; // 쉬운 한국어 한 줄
}

export interface MissionStatus {
  missionId: string;
  name: string;
  leaderState: 'idle' | 'working';
  currentTask: MissionTask | null; // 진행 중이거나 가장 최근 과제
  members: MemberStatus[]; // 이번 과제에 불린 팀원만 (과제가 바뀌면 초기화)
  pendingApprovals: number; // 3단계 전까지 0
  recent: ActivityItem[]; // 최신순 최대 5건
  queued?: QueuedTaskView[]; // 리더가 앞 과제를 마치길 기다리는 과제 (받은 순서)
}

export interface QueuedTaskView {
  title: string; // 한 줄 요약
  from: 'rano' | 'user';
  queuedAt: string;
  resumed?: boolean; // 앱을 다시 켜면서 이어 받은 과제
}

// ---------- 대화 ----------
export type ChatRole = 'user' | 'rano' | 'leader'; // leader = 미션 리포 리더

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: string; // ISO 시각
  attachments?: ChatAttachment[]; // 사용자가 붙인 그림
  via?: 'mobile'; // 휴대폰(텔레그램)에서 보낸 말
}
/** 대화 첨부 그림 */
export interface ChatAttachment {
  id: string; // 12자리
  name: string; // 원래 파일 이름 (없으면 '캡처')
  mime: string; // image/png 등
  marked?: boolean; // 사용자가 펜·네모·화살표·번호로 표시한 그림
}
/** 화면에서 보낼 새 그림 (base64) */
export interface NewAttachment {
  name: string;
  mime: string;
  data: string;
  marked?: boolean;
}


// 화면으로 보내는 이벤트
export type RanoUiEvent =
  | { kind: 'status'; status: 'idle' | 'thinking' } // 라노가 생각 중인지
  | { kind: 'message'; message: ChatMessage } // 대화에 새 말이 추가됨 (사용자·라노 모두)
  | { kind: 'activity'; text: string; at: string; missionId?: string } // 한 줄 보고. missionId 가 있으면 그 리포 리더 대화 패널에 표시
  | { kind: 'error'; text: string; at: string; missionId?: string } // 쉬운 한국어 오류 문구. missionId 가 있으면 리포 리더 대화 패널에 표시
  // ---- 2단계 ----
  | { kind: 'mission'; status: MissionStatus } // 현황판 카드 갱신 (상태가 바뀔 때마다 전체를 보냄)
  | { kind: 'leaderMessage'; missionId: string; message: ChatMessage } // 리포 리더 대화창에 새 말 (role: user=사용자 직접 지시, rano=라노의 배정, leader=리포 리더)
  // ---- 3단계 ----
  | { kind: 'approvals'; items: ApprovalRequest[] } // 승인함 전체 목록 (바뀔 때마다)
  | { kind: 'outputs'; items: TaskOutput[] } // 결과물함 전체 목록 (바뀔 때마다)
  | { kind: 'navigate'; tab: 'chat' | 'board' | 'approvals' | 'outputs' } // 맥 알림을 눌렀을 때 해당 탭으로
  // ---- 할 일 목록 ----
  | { kind: 'todos'; items: TodoItem[] } // 할 일 전체 목록 (바뀔 때마다)
  // ---- 조직: 라노의 미션 구성안 ----
  | { kind: 'orgProposal'; proposal: MissionProposal; at: string } // 라노가 구성안을 만들었다 → 대화에 카드로 보인다
  | { kind: 'orgOpenProposal'; proposal: MissionProposal }
  | { kind: 'skillSuggest'; need: string; items: SkillSuggestion[]; at: string } // 라노의 스킬 추천 카드; // 사용자가 동의 → 조직 탭 미션 추가 화면을 채워서 연다

// ---------- IPC 채널 이름 (preload 는 샌드박스라 이 파일을 불러올 수 없으니 같은 문자열을 그대로 적는다) ----------
export const IPC = {
  loadHistory: 'rano:load-history', // invoke → ChatMessage[]
  send: 'rano:send', // invoke(text: string) → void (라노 답이 끝나면 resolve)
  event: 'rano:event', // main → renderer, payload: RanoUiEvent
  // ---- 2단계 ----
  missionList: 'mission:list', // invoke → MissionStatus[]
  missionHistory: 'mission:history', // invoke(missionId) → ChatMessage[] (리포 리더 대화)
  missionSend: 'mission:send', // invoke(missionId, text) → void (접수되면 바로 resolve, 일은 뒤에서 진행)
  // ---- 3단계 ----
  approvalsList: 'approvals:list', // invoke → ApprovalRequest[]
  approvalDecide: 'approvals:decide', // invoke(id, ApprovalDecision) → void
  approvalOpenPreview: 'approvals:open-preview', // invoke(id, itemId, optionKey) → { ok, message? } (시안 폴더 안 파일만 연다)
  outputsList: 'outputs:list', // invoke → TaskOutput[]
  openFile: 'outputs:open', // invoke(absPath) → { ok: boolean; message?: string } (작업 대상 폴더 안 파일만)
  revealFile: 'outputs:reveal', // invoke(absPath) → { ok: boolean; message?: string } (Finder 에서 보기)
  // ---- 조직(미션 관리·인재풀) ----
  orgMissions: 'org:missions', // invoke → MissionSummary[] (보관한 미션 포함)
  orgPickFolder: 'org:pick-folder', // invoke(purpose: 'target'|'ref', zone) → string | null (맥 폴더 선택 창, 구역 루트에서 시작)
  orgInspect: 'org:inspect', // invoke(absPath, purpose: 'target'|'ref', zone, editingId?: string) → FolderInspection (읽기만)
  orgCreateMission: 'org:create-mission', // invoke(MissionDraft) → AdminResult
  orgUpdateMission: 'org:update-mission', // invoke(id, MissionDraft) → AdminResult
  orgArchiveMission: 'org:archive-mission', // invoke(id, archived: boolean) → AdminResult
  orgRoles: 'org:roles', // invoke → RoleInfo[] (본문 없이)
  orgRole: 'org:role', // invoke(name) → RoleInfo | null (본문 포함)
  orgSaveRole: 'org:save-role', // invoke(RoleDraft, originalName?: string) → AdminResult (인재풀 역할만)
  orgRestart: 'org:restart', // invoke → void (앱 다시 시작: 설정 다시 읽기)
  appSettings: 'app:settings', // invoke → AppSettings (역할 쉬운 이름, 구역 이름·폴더)
  setupStatus: 'setup:status', // invoke → SetupStatus
  usageSummary: 'usage:summary', // invoke → UsageSummary
  mobileStatus: 'mobile:status',
  mobileConnect: 'mobile:connect', // invoke(token) 봇 토큰은 키체인 암호화로만 저장
  mobileDisconnect: 'mobile:disconnect',
  mobileOptions: 'mobile:options',
  mobileNewCode: 'mobile:new-code',
  search: 'search:all', // invoke(query) → SearchHit[]
  missionDocs: 'org:mission-docs', // invoke(missionId) → MissionDoc[] (미션 홈 문서 읽기만)
  attachmentData: 'rano:attachment-data', // invoke(ChatAttachment) → data URL | null
  updateCheck: 'update:check', // invoke → UpdateInfo (GitHub Releases 최신 버전)
  openReleasePage: 'update:open-page', // github.com 주소만 연다
  settingsSaveProfile: 'settings:save-profile', // invoke(profile) → me.md
  settingsSaveZones: 'settings:save-zones', // invoke(zones) 미션이 있는 구역은 거절
  openDataFolder: 'settings:open-data-folder', // Finder 로 데이터 폴더 열기
  authStatus: 'auth:status',
  authStartLogin: 'auth:start-login', // invoke(kind) → { ok, url? } 로그인 페이지를 브라우저로 연다
  authSubmitCode: 'auth:submit-code', // invoke(code) 브라우저에 나온 코드
  authCancelLogin: 'auth:cancel-login',
  authLogout: 'auth:logout',
  authSaveApiKey: 'auth:save-api-key', // 키는 키체인으로 암호화해서 저장, 화면으로는 돌려주지 않음
  authUseMethod: 'auth:use-method',
  authRemoveApiKey: 'auth:remove-api-key',
  authOpenLoginPage: 'auth:open-login-page', // claude.com 로그인 주소만 연다
  setupPickFolder: 'setup:pick-folder', // invoke(zone, current) → string | null (폴더 만들기 가능)
  setupCheckFolder: 'setup:check-folder', // invoke(zone, path) → SetupFolderCheck
  setupSave: 'setup:save', // invoke(SetupInput) → { ok, message, needsRestart }
  // ---- 할 일 목록 ----
  todosList: 'todos:list', // invoke → TodoItem[]
  todosAdd: 'todos:add', // invoke(missionId|null, title) → TodoItem[]
  todosUpdate: 'todos:update', // invoke(id, { title?, status? }) → TodoItem[] (사용자는 완료 포함 모든 상태로 바꿀 수 있음)
  todosMove: 'todos:move', // invoke(id, -1|1) → TodoItem[]
  todosRemove: 'todos:remove', // invoke(id) → TodoItem[]
} as const;

// 화면(window.rano)에 노출되는 API
export interface RanoApi {
  loadHistory(): Promise<ChatMessage[]>;
  send(text: string, attachments?: NewAttachment[]): Promise<{ ok: boolean; message?: string }>;
  attachmentData(a: ChatAttachment): Promise<string | null>; // 미리보기 data URL
  onEvent(cb: (e: RanoUiEvent) => void): () => void; // 해제 함수 반환
  // ---- 2단계 ----
  missionList(): Promise<MissionStatus[]>;
  missionHistory(missionId: string): Promise<ChatMessage[]>;
  missionSend(missionId: string, text: string, attachments?: NewAttachment[]): Promise<{ ok: boolean; message?: string }>;
  // ---- 3단계 ----
  approvalsList(): Promise<ApprovalRequest[]>;
  approvalDecide(id: string, decision: ApprovalDecision): Promise<void>;
  approvalOpenPreview(id: string, itemId: string, optionKey: string): Promise<{ ok: boolean; message?: string }>;
  outputsList(): Promise<TaskOutput[]>;
  openFile(absPath: string): Promise<{ ok: boolean; message?: string }>;
  revealFile(absPath: string): Promise<{ ok: boolean; message?: string }>;
  // ---- 조직 ----
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
  // ---- 할 일 목록 ----
  todosList(): Promise<TodoItem[]>;
  todosAdd(missionId: string | null, title: string): Promise<TodoItem[]>;
  todosUpdate(id: string, patch: { title?: string; status?: TodoStatus }): Promise<TodoItem[]>;
  todosMove(id: string, dir: -1 | 1): Promise<TodoItem[]>;
  todosRemove(id: string): Promise<TodoItem[]>;
}

// ---------- 할 일 목록 (사용자와 라노가 함께 보는 굵직한 일) ----------
// 상태: waiting 대기 · active 진행 중(리더에게 넘김) · review 확인 요청(리더 보고 도착, 사용자가 볼 차례) · done 완료
// 규칙: 완료(done)는 사용자만 표시한다. 라노는 waiting/active/review 까지만 바꾼다.
export type TodoStatus = 'waiting' | 'active' | 'review' | 'done';
export interface TodoItem {
  id: string;
  missionId: string | null; // null = 미션 밖의 일
  title: string;
  status: TodoStatus;
  queued?: boolean; // active 인데 리더가 앞 과제를 하느라 아직 시작 못 함
  note?: string; // 짧은 메모 (예: "리더 보고 도착 11/04 23:10", "중단됨")
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
}
export const TODO_MCP_NAME = 'rano-todo';
export interface TodoStoreApi {
  list(): TodoItem[];
  get(id: string): TodoItem | undefined;
  add(missionId: string | null, title: string, by: 'user' | 'rano'): TodoItem;
  update(id: string, patch: { title?: string; status?: TodoStatus; queued?: boolean; note?: string }, by: 'user' | 'rano' | 'app'): TodoItem;
  move(id: string, dir: -1 | 1): void;
  remove(id: string, by: 'user' | 'rano'): void;
  describe(): string; // 라노 프롬프트용 글
}

// ---------- 모듈 사이 약속 ----------
export type Emit = (e: RanoUiEvent) => void;

// 기억 담당이 구현: src/main/memory/memoryService.ts
//   export class MemoryService implements MemoryServiceApi { constructor(config: RanoConfig, emit: Emit) }
export interface MemoryFile {
  name: string; // 'me.md'
  content: string;
}
export interface MemoryServiceApi {
  readAll(): Promise<MemoryFile[]>; // config.memoryFiles 순서대로. 없는 파일은 빈 문자열
  read(name: string): Promise<string>;
  // 파일 전체를 바꿔 쓰고, autoCommit 이면 memory 폴더 로컬 git 에 자동 커밋
  write(name: string, content: string, reason: string): Promise<{ committed: boolean; note?: string }>;
}
// 기억 담당이 구현: src/main/memory/memoryTools.ts
//   export function createMemoryMcpServer(memory: MemoryServiceApi): McpSdkServerConfigWithInstance
//   서버 이름은 MEMORY_MCP_NAME, 도구는 read_memory / update_memory
export const MEMORY_MCP_NAME = 'rano-memory';

// 엔진 담당이 구현: src/main/engine/conversationStore.ts
//   export class ConversationStore { constructor(config: RanoConfig, file?: string) } — 기본은 runs/rano/conversation.json.
//   2단계: file 을 주면 그 절대 경로에 저장 (리포 리더 대화: runs/missions/<id>/conversation.json)
export interface ConversationStoreApi {
  load(): Promise<{ sessionId: string | null; messages: ChatMessage[] }>;
  append(message: ChatMessage): Promise<void>;
  setSessionId(sessionId: string): Promise<void>;
}
// 엔진 담당이 구현: src/main/engine/ranoSession.ts
//   export class RanoSession { constructor(deps: { config; memory: MemoryServiceApi; store: ConversationStoreApi; emit: Emit; memoryMcp: unknown }) }
export interface RanoSessionApi {
  send(text: string, attachments?: ChatAttachment[], via?: 'mobile'): Promise<void>; // 사용자 말 저장·emit → 라노 답 저장·emit. 동시에 두 번 오면 앞의 것이 끝난 뒤 처리
  // 2단계: 앱이 라노에게 알림(리포 리더 보고, 사용자의 직접 지시 사실). 사용자 말풍선은 만들지 않고
  // activity 한 줄을 emit 한 뒤 라노 차례를 돌린다. 라노 답은 평소처럼 저장·emit. send 와 같은 큐를 쓴다.
  notify(text: string): Promise<void>;
}
//   2단계: RanoSession deps 에 missionMcp(라노의 미션 도구 서버)가 추가된다. mcpServers 에 함께 넣고 권한 허용.
// 엔진 담당이 구현: src/main/engine/permissions.ts
//   export function createPermissionGate(config: RanoConfig, log: (line: PermissionLogEntry) => void): CanUseTool
export interface PermissionLogEntry {
  at: string;
  agent: string; // 'rano'
  tool: string;
  decision: 'allow' | 'deny';
  reason: string;
}

// ================= 2단계 모듈 약속 =================
// 서버 이름. 라노 도구는 mcp__rano-mission__assign_to_mission, mcp__rano-mission__get_mission_status
export const MISSION_MCP_NAME = 'rano-mission';

// 조율·현황 담당이 구현: src/main/mission/tracker.ts
//   export class MissionTracker implements MissionTrackerApi { constructor(config: RanoConfig, mission: MissionConfig, emit: Emit) }
//   상태는 runs/missions/<id>/state.json 에 저장, 바뀔 때마다 emit({kind:'mission'}) 와 runs/events.jsonl 기록
export interface MissionTrackerApi {
  status(): MissionStatus;
  taskStart(task: { title: string; from: 'rano' | 'user' }): MissionTask; // 팀원 목록 초기화, 리더 working
  taskEnd(result: { ok: boolean; report: string }): void; // 리더 idle, 아직 working 인 팀원은 done 처리
  memberStart(role: string, task: string): void; // reviewerRoles 면 reviewing, 아니면 working
  memberEnd(role: string, ok: boolean): void; // done
  activity(who: string, text: string): void; // 최근 활동에 추가
  setPendingApprovals(n: number): void; // 3단계: 승인 대기 건수 (승인함이 바뀔 때 main 이 부름)
  setQueue(items: QueuedTaskView[]): void; // 기다리는 과제 목록 (디스패처가 바뀔 때마다 부름)
}

// 리포 리더 담당이 구현: src/main/mission/leaderSession.ts
//   export class MissionLeader implements MissionLeaderApi
//   constructor(deps: { config: RanoConfig; mission: MissionConfig; tracker: MissionTrackerApi; store: ConversationStoreApi; emit: Emit })
//   run 은 큐로 하나씩 처리. 시작 시 tracker.taskStart, 팀원 호출 시 memberStart/End, 끝나면 tracker.taskEnd.
//   대화 기록(store)과 emit({kind:'leaderMessage'}) 로 지시(role rano/user)와 리더 답(role leader)을 남긴다.
export interface MissionLeaderApi {
  run(task: { text: string; from: 'rano' | 'user'; onStart?: () => void; planFirst?: boolean; attachments?: ChatAttachment[] }): Promise<{ ok: boolean; report: string }>; // planFirst: 기획(안 선택) 먼저, 고른 뒤 구현 // onStart: 앞 과제가 끝나고 이 과제를 실제로 시작할 때
  busy(): boolean;
  close?(): void; // 3단계: 앱을 끌 때 진행 중인 일과 승인 대기를 정리
}

// 조율·현황 담당이 구현: src/main/mission/dispatcher.ts
//   export class MissionDispatcher implements MissionDispatcherApi
//   constructor(deps: { config: RanoConfig; leaders: Map<string, MissionLeaderApi>; trackers: Map<string, MissionTrackerApi>;
//                      notifyRano: (text: string) => Promise<void> })
//   assign/userSend 는 기다리지 않고 바로 접수 문구를 돌려준다. 리더 일이 끝나면 미션 기억(진행업무.md)에 한 줄 남기고
//   미션 홈 자동 저장(autoCommit, 기억 담당 모듈 재사용) 후 notifyRano 로 보고를 전달한다.
//   userSend 는 시작할 때 notifyRano 로 "사용자가 ○○ 리더에게 직접 지시함: …" 을 알린다 (결정 11).
export interface MissionDispatcherApi {
  assign(missionId: string, text: string, todoId?: string, planFirst?: boolean): Promise<string>; // 라노가 배정. 접수 문구 반환. todoId 를 주면 그 할 일과 연결
  userSend(missionId: string, text: string): Promise<void>; // 사용자가 미션 카드에서 직접 지시
  statuses(): MissionStatus[];
  resumePending?(): void; // 앱을 켤 때 한 번: 지난번에 기다리던 과제를 이어서 맡기고, 하다 멈춘 과제를 정리한다
}
// 조율·현황 담당이 구현: src/main/mission/missionTools.ts
//   export function createMissionMcpServer(dispatcher: MissionDispatcherApi, config: RanoConfig): McpSdkServerConfigWithInstance

// ================= 3단계 모듈 약속 =================
export type ApprovalKind =
  | 'teamPlan' // 팀 구성안
  | 'decision' // 결정 필요 사항 묶음 (선택지·권장안)
  | 'write' // 작업 대상 폴더 안 파일 쓰기
  | 'outsideWrite' // 작업 대상 폴더 밖 쓰기
  | 'commit' // git commit·push
  | 'delete' // 파일·폴더 삭제
  | 'db' // DB 쓰기
  | 'deploy' // 배포·운영 설정 변경
  | 'external' // 타인 Confluence 공간 게시·수정, 메일·제출
  | 'numbers' // 수치 레지스트리 상태 변경
  | 'reverseDecision' // 기존 결정 번복
  | 'estimate' // 추정값 사용
  | 'command' // 그 밖에 판단이 필요한 실행 명령
  | 'bundle' // 여러 파일 쓰기를 한 번에 (파일마다 골라서 승인)
  | 'other';

/** 묶음 승인의 파일 하나 */
export interface BundleFile {
  rel: string; // 작업 폴더 기준 경로 (화면 표시·고르기용)
  abs: string; // 반영할 절대 경로
  draft: string; // 시안 폴더의 새 내용 파일 절대 경로
  change?: FileChange;
}

/** 파일 쓰기 승인: 바뀌기 전·후 내용 (비밀로 보이는 줄은 가림) */
export interface FileChange {
  before: string; // 지금 내용 (새 파일이면 '')
  after: string; // 바뀐 뒤 내용
  isNew: boolean;
  truncated?: boolean; // 너무 커서 앞부분만
}

export interface ApprovalRequest {
  id: string;
  missionId: string;
  taskId?: string;
  who: string; // '홈페이지 리더' 또는 역할 이름(work-writer)
  kind: ApprovalKind;
  title: string; // 한 줄 제목. 예: "홈페이지 리포에 변경 내용 기록(커밋)"
  what: string; // 무엇을 하려는지 (기능·화면 기준 쉬운 말)
  why: string; // 왜 하려는지
  recommendation: string; // 리포 리더의 권장안 (없으면 '')
  detail?: string; // 자세히: 파일 위치, 바뀌는 내용 미리보기, 명령 원문 등 (화면에서 접어서 보여줌, 비밀 값 금지)
  filePath?: string; // 쓰기·삭제 대상 절대 경로
  change?: FileChange; // 파일 쓰기면 바뀌기 전·후 (승인함에서 색으로 비교)
  bundle?: BundleFile[]; // 묶음 승인: 파일 여러 개
  picked?: string[]; // 묶음 승인에서 사용자가 반영하기로 고른 파일(rel)
  status: 'pending' | 'approved' | 'rejected' | 'revise' | 'expired';
  decisionNote?: string; // 반려·수정 요청 때 사용자가 남긴 말
  rememberFile?: boolean; // 승인하면서 "이번 과제 동안 이 파일은 다시 묻지 않기"를 골랐는지
  createdAt: string;
  decidedAt?: string;
  // ---- 결정 필요(kind: decision) 카드: 항목마다 안을 고른다 ----
  decisionItems?: DecisionItem[];
  planGate?: boolean; // 기획 단계 결정: 승인되기 전에는 작업 폴더를 고칠 수 없다(앱이 막음)
  choices?: Record<string, string>; // 사용자가 고른 안 (항목 id → 안 key). 승인 때만
}

export interface DecisionOption {
  key: string; // 'A', 'B', 'C' …
  label: string; // 한 줄 설명
  detail?: string; // 장단점 등
  preview?: string; // 시안 파일 절대 경로 (이 과제의 시안 폴더 안, 앱이 확인함) — 승인함의 [시안 열기]
}
export interface DecisionItem {
  id: string; // '1', '2' …
  question: string; // 무엇을 정할지
  options: DecisionOption[];
  recommended: string; // 권장안 key
}

export interface ApprovalDecision {
  decision: 'approve' | 'reject' | 'revise';
  note?: string; // 반려·수정 요청 사유
  rememberFile?: boolean; // write/outsideWrite 승인 때만 의미
  choices?: Record<string, string>; // decision 카드 승인 때 고른 안 (항목 id → 안 key). 없으면 권장안대로
  picked?: string[]; // 묶음 승인 때 고른 파일(rel). 없으면 모두
}

// 승인함·결과물 담당이 구현: src/main/approvals/approvalQueue.ts
//   export class ApprovalQueue implements ApprovalQueueApi
//   constructor(deps: { config: RanoConfig; emit: Emit; onChange?: () => void; notify?: (title: string, body: string) => void })
//   runs/approvals.json 에 저장. 앱 시작 때 남아 있던 pending 은 'expired'(앱이 꺼져 요청한 에이전트가 사라짐).
//   바뀔 때마다 emit({kind:'approvals'}) + onChange() + runs/events.jsonl 기록. 새 pending 이 생기면 notify(맥 알림).
export interface ApprovalQueueApi {
  // 결정될 때까지 기다린다(이 동안 요청한 에이전트는 멈춘다). signal 이 abort 되면 'expired' 로 바꾸고 reject 로 끝낸다.
  request(
    req: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt' | 'decidedAt' | 'decisionNote' | 'rememberFile'>,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision & { id: string }>;
  decide(id: string, d: ApprovalDecision): void; // pending 이 아니면 무시
  list(): ApprovalRequest[]; // 대기 먼저, 그다음 최신순 (최근 100건)
  pendingCount(missionId?: string): number;
  isFileGranted(taskId: string, filePath: string): boolean; // rememberFile 로 승인된 파일인지 (같은 과제 안에서만)
}

export interface TaskOutput {
  taskId: string;
  missionId: string;
  title: string;
  from: 'rano' | 'user';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  leaderReport?: string; // 리포 리더 최종 보고
  reviewReports: { role: string; text: string; at: string }[]; // 검수 역할(reviewerRoles)이 돌려준 결과
  changedFiles: { path: string; change: 'added' | 'modified' | 'deleted'; rel?: string; folder?: string }[]; // 과제 동안 작업 대상 폴더에서 바뀐 파일(절대 경로). rel = 작업 폴더 기준 경로, folder = 작업 폴더 이름
}

// 승인함·결과물 담당이 구현: src/main/approvals/outputs.ts
//   export class OutputsStore implements OutputsApi
//   constructor(deps: { config: RanoConfig; emit: Emit })
//   runs/missions/<id>/outputs.json 에 저장. 바뀔 때마다 emit({kind:'outputs'}).
//   taskStarted: 작업 대상 폴더마다 git 상태(+ 이미 바뀌어 있던 파일의 내용 해시)를 찍어 둔다(읽기 명령만).
//   taskEnded: 다시 찍어 비교해 changedFiles 를 만들고, 미션 홈 outputs.md 표에 한 줄 추가한다.
export interface OutputsApi {
  taskStarted(mission: MissionConfig, task: MissionTask): Promise<void>;
  reviewReport(missionId: string, taskId: string, role: string, text: string): void;
  taskEnded(mission: MissionConfig, task: MissionTask, report: string): Promise<void>;
  list(missionId?: string): TaskOutput[]; // 최신 과제 먼저
}

// 권한 담당(리포 리더 쪽)이 구현:
//   MissionLeader deps 에 approvals: ApprovalQueueApi, outputs: OutputsApi 추가.
//   리더 전용 도구 서버 이름 LEADER_MCP_NAME, 도구 request_approval { kind, title, what, why, recommendation, detail? }
//   (kind 는 teamPlan | numbers | reverseDecision | estimate | external | other). 결과 문구로 승인·반려·수정 요청과 사유를 돌려준다.
//   팀 구성안(teamPlan)이 그 과제에서 승인되기 전에는 팀원 호출(Agent)을 거절한다.
export const LEADER_MCP_NAME = 'rano-leader';

// ================= 조직(미션 관리·인재풀) 약속 =================
// 본체 담당 구현: src/main/admin/ (createOrgAdmin). 화면 담당 구현: src/renderer/org*.ts
// 원칙: ~/work 아래는 읽기만 한다(폴더 점검은 이름·목록만 보고 파일 내용은 열지 않는다). 앱이 쓰는 곳은 ~/rano 안뿐이다
//   (config/rano.json, missions/<구역>/<id>/, pool/<구역>/, memory/missions.md).

/** 작업 폴더·참고 폴더 후보를 점검한 결과. 화면은 problems 가 있으면 고를 수 없게 하고, warnings 는 보여 주기만 한다. */
export interface FolderInspection {
  path: string; // 절대 경로(심볼릭 링크 푼 것)
  display: string; // 홈을 ~ 로 줄인 경로
  ok: boolean; // problems 가 없으면 true
  problems: string[]; // 고를 수 없는 이유(쉬운 한국어). 예: "~/work 안의 폴더만 고를 수 있어요"
  warnings: string[]; // 예: "홈페이지 미션과 같은 폴더예요"
  isGitRepo: boolean;
  branch?: string;
  ruleFiles: string[]; // 리포 규칙 파일 절대 경로 (CLAUDE.md, AGENTS.md 등 맨 위 폴더에 있는 것)
  secretCandidates: string[]; // 비밀로 보이는 파일·폴더 절대 경로 (이름만 보고 판단, 깊이 3까지) — 차단 후보
  deploysOnPush: boolean; // push 하면 배포될 수 있다는 흔적이 있는지
  deployHints: string[]; // 흔적 이름. 예: ['Jenkinsfile', 'Diyfile.yaml']
}

/** 인재풀의 역할 하나 */
export interface RoleInfo {
  name: string; // 파일 이름(확장자 빼고) = 부를 때 쓰는 이름
  description: string;
  tools: string[] | null; // 역할 파일의 tools (없으면 null = 기본 도구)
  canWrite: boolean; // Write/Edit 를 쓸 수 있는지
  canRun: boolean; // Bash 를 쓸 수 있는지
  zone: Zone; // 이 역할을 쓸 수 있는 구역
  source: 'work' | 'pool' | 'mission'; // work = ~/work/.claude/agents(읽기만), pool = ~/rano/pool/<구역>, mission = 미션 홈 roles/
  dir: string; // 역할 파일이 있는 폴더 절대 경로
  editable: boolean; // 앱이 고칠 수 있는지 (pool 만 true)
  usedBy: string[]; // 이 역할을 쓰는 미션 id
  body?: string; // 지침 본문 (orgRole 에서만 채움)
}

/** 역할 만들기·고치기 입력 (pool 에만 저장) */
export interface RoleDraft {
  zone?: Zone; // 저장할 인재풀 구역 (없으면 회사)
  name: string; // 영문 소문자·숫자·- 만 (예: 'report-writer')
  description: string;
  canWrite: boolean;
  canRun: boolean;
  body: string;
}

/** 미션 만들기·고치기 입력 */
export interface MissionDraft {
  name: string;
  goal: string; // 헌장 '목표'에 들어감
  zone: Zone; // 고치기에서는 바꿀 수 없음
  target: string; // 작업 폴더 절대 경로 (orgInspect ok 인 것)
  readonlyRefs: string[];
  blocked: string[]; // 추가로 막을 파일·폴더 절대 경로 (secretCandidates 에서 고른 것 등)
  writeMode: 'readOnly' | 'approval'; // approval = 승인함을 거쳐 쓰기
  writeConfirmed: boolean; // approval 이면 사용자가 확인 창에서 확인했는지 (false 면 본체가 거절)
  roles: string[];
  reviewerRoles: string[]; // roles 의 일부. 작업 담당(검수 아닌 역할) 1개 이상 + 검수 1개 이상이어야 함
}

export interface MissionSummary {
  id: string;
  name: string;
  zone: 'work' | 'personal';
  goal?: string;
  target: string; // 첫 작업 폴더 절대 경로
  readonlyRefs: string[];
  blocked: string[]; // 이 미션 작업 폴더 안에 걸린 차단 항목
  writeMode: 'readOnly' | 'approval';
  roles: string[];
  reviewerRoles: string[];
  archived: boolean;
  home: string;
  active: boolean; // 지금 실행 중인 앱에 반영돼 있는지 (false 면 다시 시작해야 반영)
}

export interface AdminResult {
  ok: boolean;
  message: string; // 쉬운 한국어 결과 문구
  id?: string; // 만든 미션 id 또는 역할 이름
  needsRestart?: boolean; // true 면 화면이 "앱 다시 시작" 버튼을 보여 준다
}

/** 라노가 대화를 듣고 만든 미션 구성안. 아무것도 만들거나 쓰지 않는다. 사용자가 조직 탭에서 확인·고친 뒤 직접 만든다.
 *  쓰기 권한·비밀 파일 차단은 구성안에 넣지 않는다(사용자가 미션 추가 화면에서 직접 정한다). */
export interface MissionProposal {
  id: string;
  createdAt: string;
  name: string;
  goal: string;
  zone: Zone;
  target?: string; // 작업 폴더 제안 (절대 경로, 구역 루트 아래). 모르면 비움
  targetNote?: string; // 폴더 점검에서 나온 문제·경고 요약 (있으면)
  readonlyRefs: string[];
  roles: string[]; // 기존 역할 이름 + newRoles 의 이름
  reviewerRoles: string[];
  newRoles: RoleDraft[]; // 인재풀에 새로 만들 역할 초안 (미션을 만들 때 함께 만든다)
  reason: string; // 왜 이렇게 짰는지 한두 줄
}
export const ORG_MCP_NAME = 'rano-org';
