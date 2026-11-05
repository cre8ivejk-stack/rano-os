// 화면에서 쓰는 window.rano 타입. renderer 는 src/shared 를 불러올 수 없어 src/shared/types.ts 에서 복제했다.
// types.ts 의 대화·미션·이벤트·RanoApi 가 바뀌면 여기도 같이 고친다.

type ChatRole = 'user' | 'rano' | 'leader';

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: string; // ISO 시각
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
  | { kind: 'orgOpenProposal'; proposal: MissionProposal };

type Zone = 'work' | 'personal';

/** 처음 켰을 때 안내 */
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
  | 'other';

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
  status: 'pending' | 'approved' | 'rejected' | 'revise' | 'expired';
  decisionNote?: string;
  rememberFile?: boolean;
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
  send(text: string): Promise<void>;
  onEvent(cb: (e: RanoUiEvent) => void): () => void;
  missionList(): Promise<MissionStatus[]>;
  missionHistory(missionId: string): Promise<ChatMessage[]>;
  missionSend(missionId: string, text: string): Promise<void>;
  approvalsList(): Promise<ApprovalRequest[]>;
  approvalDecide(id: string, decision: ApprovalDecision): Promise<void>;
  approvalOpenPreview(id: string, itemId: string, optionKey: string): Promise<{ ok: boolean; message?: string }>;
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
}

interface RoleDraft {
  zone?: Zone;
  name: string;
  description: string;
  canWrite: boolean;
  canRun: boolean;
  body: string;
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
