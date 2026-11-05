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
} from '../shared/types.js' with { 'resolution-mode': 'import' };

const CH_LOAD_HISTORY = 'rano:load-history';
const CH_SEND = 'rano:send';
const CH_EVENT = 'rano:event';
const CH_MISSION_LIST = 'mission:list';
const CH_MISSION_HISTORY = 'mission:history';
const CH_MISSION_SEND = 'mission:send';
const CH_APPROVALS_LIST = 'approvals:list';
const CH_APPROVAL_DECIDE = 'approvals:decide';
const CH_APPROVAL_OPEN_PREVIEW = 'approvals:open-preview';
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
  async send(text: string): Promise<void> {
    await ipcRenderer.invoke(CH_SEND, String(text));
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
  async missionSend(missionId: string, text: string): Promise<void> {
    await ipcRenderer.invoke(CH_MISSION_SEND, String(missionId), String(text));
  },
  approvalsList(): Promise<ApprovalRequest[]> {
    return ipcRenderer.invoke(CH_APPROVALS_LIST);
  },
  async approvalDecide(id: string, decision: ApprovalDecision): Promise<void> {
    // 화면이 넘긴 값에서 약속된 칸만 골라 보낸다.
    const clean: ApprovalDecision = { decision: decision.decision };
    if (typeof decision.note === 'string') clean.note = decision.note;
    if (typeof decision.rememberFile === 'boolean') clean.rememberFile = decision.rememberFile;
    if (decision.choices && typeof decision.choices === 'object') {
      const c: Record<string, string> = {};
      for (const [k, v] of Object.entries(decision.choices)) if (typeof v === 'string') c[String(k)] = v;
      clean.choices = c;
    }
    await ipcRenderer.invoke(CH_APPROVAL_DECIDE, String(id), clean);
  },
  approvalOpenPreview(id: string, itemId: string, optionKey: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke(CH_APPROVAL_OPEN_PREVIEW, String(id), String(itemId), String(optionKey));
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
  todosUpdate(id: string, patch: { title?: string; status?: TodoStatus }): Promise<TodoItem[]> {
    const clean: { title?: string; status?: TodoStatus } = {};
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
