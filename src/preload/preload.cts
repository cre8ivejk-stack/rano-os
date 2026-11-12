// 화면과 앱 본체 사이의 다리. 샌드박스 preload 라 electron 외 모듈은 불러올 수 없다.
// 채널 이름은 src/shared/types.ts 의 IPC 와 똑같이 직접 적는다 (바꿀 때는 두 곳 모두).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AdminResult,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  FolderInspection,
  MissionDraft,
  MissionStatus,
  MissionSummary,
  RanoApi,
  RanoUiEvent,
  RoleDraft,
  RoleInfo,
  TaskOutput,
  TodoItem,
  TodoStatus,
  Zone,
  AppSettings,
  SetupFolderCheck,
  SetupInput,
  SetupStatus,
  AuthStatus,
  AuthResult,
  UpdateInfo,
  UsageSummary,
  MissionDoc,
  SearchHit,
  MobileStatus,
  ChatAttachment,
  NewAttachment,
} from '../shared/types.js' with { 'resolution-mode': 'import' };

const CH_LOAD_HISTORY = 'rano:load-history';
const CH_SEND = 'rano:send';
const CH_UNANSWERED = 'rano:unanswered';
const CH_RESEND = 'rano:resend';
const CH_EVENT = 'rano:event';
const CH_MISSION_LIST = 'mission:list';
const CH_MISSION_HISTORY = 'mission:history';
const CH_MISSION_SEND = 'mission:send';
const CH_APPROVALS_LIST = 'approvals:list';
const CH_APPROVAL_DECIDE = 'approvals:decide';
const CH_APPROVAL_OPEN_PREVIEW = 'approvals:open-preview';
const CH_APPROVAL_REVEAL_PREVIEW = 'approvals:reveal-preview';
const CH_OUTPUTS_LIST = 'outputs:list';
const CH_OPEN_FILE = 'outputs:open';
const CH_REVEAL_FILE = 'outputs:reveal';
const CH_ORG_MISSIONS = 'org:missions';
const CH_ORG_PICK_FOLDER = 'org:pick-folder';
const CH_ORG_INSPECT = 'org:inspect';
const CH_ORG_CREATE_MISSION = 'org:create-mission';
const CH_ORG_UPDATE_MISSION = 'org:update-mission';
const CH_ORG_ARCHIVE_MISSION = 'org:archive-mission';
const CH_ORG_ROLES = 'org:roles';
const CH_ORG_ROLE = 'org:role';
const CH_ORG_SAVE_ROLE = 'org:save-role';
const CH_ORG_RESTART = 'org:restart';
const CH_APP_SETTINGS = 'app:settings';
const CH_SETUP_STATUS = 'setup:status';
const CH_UPDATE_CHECK = 'update:check';
const CH_UPDATE_OPEN = 'update:open-page';
const CH_SET_PROFILE = 'settings:save-profile';
const CH_SET_ZONES = 'settings:save-zones';
const CH_OPEN_DATA = 'settings:open-data-folder';
const CH_AUTH = {
  status: 'auth:status',
  start: 'auth:start-login',
  code: 'auth:submit-code',
  cancel: 'auth:cancel-login',
  logout: 'auth:logout',
  saveKey: 'auth:save-api-key',
  method: 'auth:use-method',
  removeKey: 'auth:remove-api-key',
  open: 'auth:open-login-page',
} as const;
const CH_SETUP_PICK = 'setup:pick-folder';
const CH_SETUP_CHECK = 'setup:check-folder';
const CH_SETUP_SAVE = 'setup:save';
const CH_TODOS_LIST = 'todos:list';
const CH_TODOS_ADD = 'todos:add';
const CH_TODOS_UPDATE = 'todos:update';
const CH_TODOS_MOVE = 'todos:move';
const CH_TODOS_REMOVE = 'todos:remove';

// ---- 조직: 화면이 넘긴 값에서 약속된 칸만 골라 깨끗하게 만든다 ----
function purposeOf(p: unknown): 'target' | 'ref' {
  return p === 'ref' ? 'ref' : 'target';
}
function zoneOf(z: unknown): Zone {
  return z === 'personal' ? 'personal' : 'work';
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => String(x)) : [];
}
function cleanMissionDraft(d: MissionDraft): MissionDraft {
  return {
    name: String(d?.name ?? ''),
    goal: String(d?.goal ?? ''),
    zone: zoneOf(d?.zone),
    target: String(d?.target ?? ''),
    readonlyRefs: strList(d?.readonlyRefs),
    blocked: strList(d?.blocked),
    writeMode: d?.writeMode === 'approval' ? 'approval' : 'readOnly',
    writeConfirmed: d?.writeConfirmed === true,
    roles: strList(d?.roles),
    reviewerRoles: strList(d?.reviewerRoles),
  };
}
function cleanRoleDraft(d: RoleDraft): RoleDraft {
  return {
    zone: zoneOf(d?.zone),
    name: String(d?.name ?? ''),
    description: String(d?.description ?? ''),
    canWrite: d?.canWrite === true,
    canRun: d?.canRun === true,
    body: String(d?.body ?? ''),
  };
}

const api: RanoApi = {
  loadHistory(): Promise<ChatMessage[]> {
    return ipcRenderer.invoke(CH_LOAD_HISTORY);
  },
  send(text: string, attachments?: NewAttachment[]): Promise<{ ok: boolean; message?: string }> {
    const list = Array.isArray(attachments) ? attachments.slice(0, 6).map((x) => ({ name: String(x?.name ?? ''), mime: String(x?.mime ?? ''), data: String(x?.data ?? ''), ...(x?.marked === true ? { marked: true } : {}) })) : [];
    return ipcRenderer.invoke(CH_SEND, String(text), list);
  },
  unanswered(): Promise<string[]> {
    return ipcRenderer.invoke(CH_UNANSWERED);
  },
  resend(messageId: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke(CH_RESEND, String(messageId ?? ''));
  },
  attachmentData(a: ChatAttachment): Promise<string | null> {
    return ipcRenderer.invoke('rano:attachment-data', { id: String(a?.id ?? ''), mime: String(a?.mime ?? '') });
  },
  onEvent(cb: (e: RanoUiEvent) => void): () => void {
    // 화면에 ipcRenderer 이벤트 객체를 넘기지 않고 내용만 넘긴다.
    const listener = (_event: IpcRendererEvent, payload: RanoUiEvent) => cb(payload);
    ipcRenderer.on(CH_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(CH_EVENT, listener);
    };
  },
  missionList(): Promise<MissionStatus[]> {
    return ipcRenderer.invoke(CH_MISSION_LIST);
  },
  missionHistory(missionId: string): Promise<ChatMessage[]> {
    return ipcRenderer.invoke(CH_MISSION_HISTORY, String(missionId));
  },
  missionSend(missionId: string, text: string, attachments?: NewAttachment[]): Promise<{ ok: boolean; message?: string }> {
    const list = Array.isArray(attachments) ? attachments.slice(0, 6).map((x) => ({ name: String(x?.name ?? ''), mime: String(x?.mime ?? ''), data: String(x?.data ?? ''), ...(x?.marked === true ? { marked: true } : {}) })) : [];
    return ipcRenderer.invoke(CH_MISSION_SEND, String(missionId), String(text), list);
  },
  missionStop(missionId: string, taskId?: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('mission:stop', String(missionId), typeof taskId === 'string' ? taskId : undefined);
  },
  approvalsList(): Promise<ApprovalRequest[]> {
    return ipcRenderer.invoke(CH_APPROVALS_LIST);
  },
  async approvalDecide(id: string, decision: ApprovalDecision): Promise<void> {
    // 화면이 넘긴 값에서 약속된 칸만 골라 보낸다.
    const clean: ApprovalDecision = { decision: decision.decision };
    if (typeof decision.note === 'string') clean.note = decision.note;
    if (typeof decision.rememberFile === 'boolean') clean.rememberFile = decision.rememberFile;
    if (Array.isArray(decision.picked)) clean.picked = decision.picked.filter((x): x is string => typeof x === 'string').slice(0, 50);
    if (decision.choices && typeof decision.choices === 'object') {
      const c: Record<string, string> = {};
      for (const [k, v] of Object.entries(decision.choices)) if (typeof v === 'string') c[String(k)] = v;
      clean.choices = c;
    }
    await ipcRenderer.invoke(CH_APPROVAL_DECIDE, String(id), clean);
  },
  approvalOpenPreview(id: string, itemId: string, optionKey: string): Promise<{ ok: boolean; message?: string; reveal?: boolean }> {
    return ipcRenderer.invoke(CH_APPROVAL_OPEN_PREVIEW, String(id), String(itemId), String(optionKey));
  },
  approvalRevealPreview(id: string, itemId: string, optionKey: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke(CH_APPROVAL_REVEAL_PREVIEW, String(id), String(itemId), String(optionKey));
  },
  outputsList(): Promise<TaskOutput[]> {
    return ipcRenderer.invoke(CH_OUTPUTS_LIST);
  },
  openFile(absPath: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke(CH_OPEN_FILE, String(absPath));
  },
  revealFile(absPath: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke(CH_REVEAL_FILE, String(absPath));
  },
  orgMissions(): Promise<MissionSummary[]> {
    return ipcRenderer.invoke(CH_ORG_MISSIONS);
  },
  orgPickFolder(purpose: 'target' | 'ref', zone: Zone): Promise<string | null> {
    return ipcRenderer.invoke(CH_ORG_PICK_FOLDER, purposeOf(purpose), zoneOf(zone));
  },
  orgInspect(absPath: string, purpose: 'target' | 'ref', zone: Zone, editingId?: string): Promise<FolderInspection> {
    if (typeof editingId === 'string') return ipcRenderer.invoke(CH_ORG_INSPECT, String(absPath), purposeOf(purpose), zoneOf(zone), editingId);
    return ipcRenderer.invoke(CH_ORG_INSPECT, String(absPath), purposeOf(purpose), zoneOf(zone));
  },
  orgCreateMission(draft: MissionDraft): Promise<AdminResult> {
    return ipcRenderer.invoke(CH_ORG_CREATE_MISSION, cleanMissionDraft(draft));
  },
  orgUpdateMission(id: string, draft: MissionDraft): Promise<AdminResult> {
    return ipcRenderer.invoke(CH_ORG_UPDATE_MISSION, String(id), cleanMissionDraft(draft));
  },
  orgArchiveMission(id: string, archived: boolean): Promise<AdminResult> {
    return ipcRenderer.invoke(CH_ORG_ARCHIVE_MISSION, String(id), archived === true);
  },
  orgRoles(): Promise<RoleInfo[]> {
    return ipcRenderer.invoke(CH_ORG_ROLES);
  },
  orgRole(name: string): Promise<RoleInfo | null> {
    return ipcRenderer.invoke(CH_ORG_ROLE, String(name));
  },
  orgSaveRole(draft: RoleDraft, originalName?: string): Promise<AdminResult> {
    if (typeof originalName === 'string') return ipcRenderer.invoke(CH_ORG_SAVE_ROLE, cleanRoleDraft(draft), originalName);
    return ipcRenderer.invoke(CH_ORG_SAVE_ROLE, cleanRoleDraft(draft));
  },
  async orgRestart(): Promise<void> {
    await ipcRenderer.invoke(CH_ORG_RESTART);
  },
  appSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(CH_APP_SETTINGS);
  },
  authStatus(): Promise<AuthStatus> {
    return ipcRenderer.invoke(CH_AUTH.status);
  },
  authStartLogin(kind: 'claudeai' | 'console'): Promise<{ ok: boolean; url?: string; message?: string }> {
    return ipcRenderer.invoke(CH_AUTH.start, kind === 'console' ? 'console' : 'claudeai');
  },
  authSubmitCode(code: string): Promise<AuthResult> {
    return ipcRenderer.invoke(CH_AUTH.code, String(code ?? ''));
  },
  async authCancelLogin(): Promise<void> {
    await ipcRenderer.invoke(CH_AUTH.cancel);
  },
  authLogout(): Promise<AuthResult> {
    return ipcRenderer.invoke(CH_AUTH.logout);
  },
  authSaveApiKey(key: string): Promise<AuthResult> {
    return ipcRenderer.invoke(CH_AUTH.saveKey, String(key ?? ''));
  },
  authUseMethod(method: 'max' | 'apiKey'): Promise<AuthResult> {
    return ipcRenderer.invoke(CH_AUTH.method, method === 'apiKey' ? 'apiKey' : 'max');
  },
  authRemoveApiKey(): Promise<AuthResult> {
    return ipcRenderer.invoke(CH_AUTH.removeKey);
  },
  async authOpenLoginPage(url: string): Promise<void> {
    await ipcRenderer.invoke(CH_AUTH.open, String(url ?? ''));
  },
  settingsSaveProfile(p: SetupInput['profile']): Promise<AuthResult> {
    return ipcRenderer.invoke(CH_SET_PROFILE, { name: String(p?.name ?? ''), callName: String(p?.callName ?? ''), org: String(p?.org ?? ''), job: String(p?.job ?? ''), devLevel: String(p?.devLevel ?? '') });
  },
  settingsSaveZones(z: Record<Zone, string>): Promise<{ ok: boolean; message: string; needsRestart: boolean }> {
    return ipcRenderer.invoke(CH_SET_ZONES, { work: String(z?.work ?? ''), personal: String(z?.personal ?? '') });
  },
  async openDataFolder(): Promise<void> {
    await ipcRenderer.invoke(CH_OPEN_DATA);
  },
  updateCheck(): Promise<UpdateInfo> {
    return ipcRenderer.invoke(CH_UPDATE_CHECK);
  },
  guideRead(): Promise<any> {
    return ipcRenderer.invoke('guide:read');
  },
  async openReleasePage(url: string): Promise<void> {
    await ipcRenderer.invoke(CH_UPDATE_OPEN, String(url ?? ''));
  },
  missionDocs(missionId: string): Promise<MissionDoc[]> {
    return ipcRenderer.invoke('org:mission-docs', String(missionId));
  },
  search(query: string): Promise<SearchHit[]> {
    return ipcRenderer.invoke('search:all', String(query ?? '').slice(0, 200));
  },
  mobileStatus(): Promise<MobileStatus> {
    return ipcRenderer.invoke('mobile:status');
  },
  mobileConnect(token: string): Promise<{ ok: boolean; message: string }> {
    return ipcRenderer.invoke('mobile:connect', String(token ?? ''));
  },
  mobileDisconnect(): Promise<{ ok: boolean; message: string }> {
    return ipcRenderer.invoke('mobile:disconnect');
  },
  async mobileOptions(o: { allRano?: boolean; approvals?: boolean; keepAwake?: boolean }): Promise<void> {
    await ipcRenderer.invoke('mobile:options', { ...(typeof o?.allRano === 'boolean' ? { allRano: o.allRano } : {}), ...(typeof o?.approvals === 'boolean' ? { approvals: o.approvals } : {}), ...(typeof o?.keepAwake === 'boolean' ? { keepAwake: o.keepAwake } : {}) });
  },
  async mobileNewCode(): Promise<void> {
    await ipcRenderer.invoke('mobile:new-code');
  },
  skillsList(): Promise<any> {
    return ipcRenderer.invoke('skills:list');
  },
  skillRead(name: string): Promise<any> {
    return ipcRenderer.invoke('skills:read', String(name ?? ''));
  },
  roleSkills(): Promise<any> {
    return ipcRenderer.invoke('skills:role-map');
  },
  setRoleSkills(role: string, names: string[]): Promise<any> {
    return ipcRenderer.invoke('skills:set-role', String(role ?? ''), Array.isArray(names) ? names.filter((x) => typeof x === 'string').slice(0, 50) : String(names ?? ''));
  },
  skillPreview(source: string): Promise<any> {
    return ipcRenderer.invoke('skills:preview', String(source ?? ''));
  },
  skillInstall(token: string): Promise<any> {
    return ipcRenderer.invoke('skills:install', String(token ?? ''));
  },
  skillRemove(name: string): Promise<any> {
    return ipcRenderer.invoke('skills:remove', String(name ?? ''));
  },
  connectorsList(): Promise<any> {
    return ipcRenderer.invoke('connectors:list');
  },
  connectorCandidates(): Promise<any> {
    return ipcRenderer.invoke('connectors:candidates');
  },
  connectorImport(name: string): Promise<any> {
    return ipcRenderer.invoke('connectors:import', String(name ?? ''));
  },
  connectorSetSecret(name: string, key: string, value: string): Promise<any> {
    return ipcRenderer.invoke('connectors:set-secret', String(name ?? ''), String(key ?? ''), String(value ?? '').slice(0, 8000));
  },
  connectorRemove(name: string): Promise<any> {
    return ipcRenderer.invoke('connectors:remove', String(name ?? ''));
  },
  setMissionConnectors(missionId: string, names: string[]): Promise<any> {
    return ipcRenderer.invoke('connectors:set-mission', String(missionId ?? ''), Array.isArray(names) ? names.filter((x) => typeof x === 'string').slice(0, 30) : []);
  },
  toolsStatus(): Promise<any> {
    return ipcRenderer.invoke('tools:status');
  },
  toolsInstall(kind?: 'docs' | 'browser'): Promise<any> {
    return ipcRenderer.invoke('tools:install', kind === 'browser' ? 'browser' : 'docs');
  },
  skillsAuto(): Promise<boolean> {
    return ipcRenderer.invoke('skills:auto');
  },
  setSkillsAuto(on: boolean): Promise<{ ok: boolean; message: string }> {
    return ipcRenderer.invoke('skills:set-auto', on === true);
  },
  skillRegistry(): Promise<any> {
    return ipcRenderer.invoke('skills:registry');
  },
  usageSummary(): Promise<UsageSummary> {
    return ipcRenderer.invoke('usage:summary');
  },
  setupStatus(): Promise<SetupStatus> {
    return ipcRenderer.invoke(CH_SETUP_STATUS);
  },
  setupPickFolder(zone: Zone, current: string): Promise<string | null> {
    return ipcRenderer.invoke(CH_SETUP_PICK, zoneOf(zone), String(current ?? ''));
  },
  setupCheckFolder(zone: Zone, p: string): Promise<SetupFolderCheck> {
    return ipcRenderer.invoke(CH_SETUP_CHECK, zoneOf(zone), String(p ?? ''));
  },
  setupSave(input: SetupInput): Promise<{ ok: boolean; message: string; needsRestart: boolean }> {
    const p = input?.profile ?? ({} as SetupInput['profile']);
    return ipcRenderer.invoke(CH_SETUP_SAVE, {
      profile: { name: String(p.name ?? ''), callName: String(p.callName ?? ''), org: String(p.org ?? ''), job: String(p.job ?? ''), devLevel: String(p.devLevel ?? '') },
      zones: { work: String(input?.zones?.work ?? ''), personal: String(input?.zones?.personal ?? '') },
    });
  },
  todosList(): Promise<TodoItem[]> {
    return ipcRenderer.invoke(CH_TODOS_LIST);
  },
  todosAdd(missionId: string | null, title: string): Promise<TodoItem[]> {
    return ipcRenderer.invoke(CH_TODOS_ADD, missionId === null ? null : String(missionId), String(title));
  },
  todosUpdate(id: string, patch: { title?: string; status?: TodoStatus; steps?: string[]; doneSteps?: number[]; undoneSteps?: number[] }): Promise<TodoItem[]> {
    const clean: { title?: string; status?: TodoStatus; steps?: string[]; doneSteps?: number[]; undoneSteps?: number[] } = {};
    if (Array.isArray(patch.steps)) clean.steps = patch.steps.slice(0, 12).map((x) => String(x));
    if (Array.isArray(patch.doneSteps)) clean.doneSteps = patch.doneSteps.slice(0, 12).map((x) => Number(x));
    if (Array.isArray(patch.undoneSteps)) clean.undoneSteps = patch.undoneSteps.slice(0, 12).map((x) => Number(x));
    if (typeof patch.title === 'string') clean.title = patch.title;
    if (typeof patch.status === 'string') clean.status = patch.status;
    return ipcRenderer.invoke(CH_TODOS_UPDATE, String(id), clean);
  },
  todosMove(id: string, dir: -1 | 1): Promise<TodoItem[]> {
    return ipcRenderer.invoke(CH_TODOS_MOVE, String(id), dir === -1 ? -1 : 1);
  },
  todosRemove(id: string): Promise<TodoItem[]> {
    return ipcRenderer.invoke(CH_TODOS_REMOVE, String(id));
  },
};

contextBridge.exposeInMainWorld('rano', api);
