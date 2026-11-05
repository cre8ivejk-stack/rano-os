// 앱 본체: 창을 띄우고, 화면 ↔ 라노 세션 ↔ 미션 리포 리더 사이를 잇는다.
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRootDir, loadConfig } from './config.js';
import { defaultsDir, ensureDataHome } from './dataHome.js';
import { IPC, type NewAttachment, type MissionLeaderApi, type MissionTrackerApi, type RanoUiEvent } from '../shared/types.js';
import { MemoryService } from './memory/memoryService.js';
import { createMemoryMcpServer } from './memory/memoryTools.js';
import { ConversationStore } from './engine/conversationStore.js';
import { RanoSession } from './engine/ranoSession.js';
import { MissionTracker } from './mission/tracker.js';
import { MissionLeader } from './mission/leaderSession.js';
import { MissionDispatcher } from './mission/dispatcher.js';
import { createMissionMcpServer } from './mission/missionTools.js';
import { ApprovalQueue } from './approvals/approvalQueue.js';
import { OutputsStore } from './approvals/outputs.js';
import { isBlockedPath } from './engine/permissions.js';
import { TodoStore } from './todo/todoStore.js';
import { createTodoMcpServer } from './todo/todoTools.js';
import { createOrgAdmin } from './admin/orgAdmin.js';
import { createOrgMcpServer } from './admin/ranoOrgTools.js';
import { zoneText } from './admin/paths.js';
import { createSetup } from './setup.js';
import { createAuth } from './engine/auth.js';
import { checkForUpdate } from './engine/update.js';
import { initUsage, usageSummary } from './engine/usage.js';
import { searchAll } from './engine/search.js';
import { TelegramBridge } from './mobile/telegram.js';
import { attachmentDataUrl, saveAttachments } from './engine/attachments.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// 맥에서 Finder로 실행하면 PATH 가 짧아 node·git 을 못 찾는다. 흔한 위치를 앞에 붙인다.
process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH ?? ''].join(':');

let win: BrowserWindow | null = null;
let dispatcherForQuit: MissionDispatcher | null = null;
const leadersForQuit: MissionLeaderApi[] = [];

let mobile: TelegramBridge | null = null; // 휴대폰(텔레그램) 연결

function emit(e: RanoUiEvent) {
  win?.webContents.send(IPC.event, e);
  try {
    mobile?.onEvent(e);
  } catch {
    // 휴대폰 쪽 실패가 앱을 막지 않게 한다
  }
}

async function boot() {
  // 데이터 폴더가 비어 있으면(처음 쓰는 사람) 앱의 기본 틀로 채운다
  const home = ensureDataHome(defaultRootDir(), defaultsDir(app.getAppPath()));
  if (home.created) console.log(`[rano] 새 데이터 폴더를 만들었어요: ${defaultRootDir()} (${home.copied}개 파일)`);
  const config = loadConfig();
  initUsage(config.runsDir);
  const memory = new MemoryService(config, emit);
  const store = new ConversationStore(config);

  // 3단계: 승인함과 결과물함
  const trackers = new Map<string, MissionTrackerApi>();
  const approvals = new ApprovalQueue({
    config,
    emit,
    onChange: () => {
      for (const [id, t] of trackers) t.setPendingApprovals(approvals.pendingCount(id));
      try {
        mobile?.onApprovalsChanged();
      } catch {
        // 무시
      }
    },
    notify: (title: string, body: string) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on('click', () => {
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        emit({ kind: 'navigate', tab: 'approvals' });
      });
      n.show();
    },
  });
  const outputs = new OutputsStore({ config, emit });
  const todos = new TodoStore(config, emit);

  // 결과물함에서 열 수 있는 파일: 미션 작업 대상 폴더 안, 차단 목록 밖, 실제로 있는 파일만
  const canOpen = (p: unknown): string | null => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
    const abs = path.resolve(p);
    const inTarget = config.missions.some((m) => m.targets.some((t) => abs === t || abs.startsWith(t + path.sep)));
    if (!inTarget || isBlockedPath(config, abs) || !existsSync(abs)) return null;
    return abs;
  };

  // 미션: 미션마다 현황 기록기 하나, 리포 리더 하나
  const leaders = new Map<string, MissionLeaderApi>();
  const leaderStores = new Map<string, ConversationStore>();
  for (const mission of config.missions) {
    const tracker = new MissionTracker(config, mission, emit);
    const leaderStore = new ConversationStore(config, path.join(config.runsDir, 'missions', mission.id, 'conversation.json'));
    trackers.set(mission.id, tracker);
    leaderStores.set(mission.id, leaderStore);
    const leader = new MissionLeader({ config, mission, tracker, store: leaderStore, emit, approvals, outputs });
    leaders.set(mission.id, leader);
    leadersForQuit.push(leader);
  }

  // 조직(미션 관리·인재풀): 화면과 라노의 조직 도구가 함께 쓴다
  const org = createOrgAdmin({ config, memory, activeMissionIds: config.missions.map((m) => m.id) });

  // 라노 세션과 디스패처는 서로를 참조하므로 notifyRano 는 나중에 묶는다
  let session: RanoSession | null = null;
  const dispatcher = new MissionDispatcher({
    config,
    leaders,
    trackers,
    notifyRano: async (text: string) => {
      await session?.notify(text);
    },
    todos,
  });
  session = new RanoSession({
    config,
    memory,
    store,
    emit,
    memoryMcp: createMemoryMcpServer(memory),
    missionMcp: createMissionMcpServer(dispatcher, config),
    todoMcp: createTodoMcpServer(todos, config),
    todoText: () => todos.describe(),
    orgMcp: createOrgMcpServer(org, emit, config),
  });
  const rano = session;
  dispatcherForQuit = dispatcher;

  ipcMain.handle(IPC.loadHistory, async () => (await store.load()).messages);
  ipcMain.handle(IPC.send, async (_e, text: unknown, attachments: unknown) => {
    const t = typeof text === 'string' ? text.trim() : '';
    const list = Array.isArray(attachments) ? (attachments as NewAttachment[]) : [];
    if (!t && !list.length) return { ok: false, message: '보낼 내용이 없어요' };
    const saved = saveAttachments(config.runsDir, list);
    if (!saved.ok) return { ok: false, message: saved.message };
    await rano.send(t || '(그림만 보냈어요)', saved.saved);
    return { ok: true };
  });
  ipcMain.handle(IPC.attachmentData, (_e, a: any) => attachmentDataUrl(config.runsDir, { id: String(a?.id ?? ''), mime: String(a?.mime ?? '') }));
  ipcMain.handle(IPC.missionList, async () => dispatcher.statuses());
  ipcMain.handle(IPC.missionHistory, async (_e, missionId: unknown) => {
    const s = typeof missionId === 'string' ? leaderStores.get(missionId) : undefined;
    return s ? (await s.load()).messages : [];
  });
  ipcMain.handle(IPC.approvalsList, async () => approvals.list());
  ipcMain.handle(IPC.approvalDecide, async (_e, id: unknown, d: any) => {
    if (typeof id !== 'string' || !d || !['approve', 'reject', 'revise'].includes(d.decision)) return;
    approvals.decide(id, {
      decision: d.decision,
      note: typeof d.note === 'string' ? d.note.slice(0, 2000) : undefined,
      rememberFile: d.rememberFile === true,
      // 결정 카드에서 고른 안 (항목 id → 안 key). 승인함이 항목에 있는 안인지 다시 확인한다
      ...(Array.isArray(d.picked) ? { picked: d.picked.filter((x: unknown): x is string => typeof x === 'string').slice(0, 50) } : {}),
      ...(d.choices && typeof d.choices === 'object'
        ? { choices: Object.fromEntries(Object.entries(d.choices).filter(([k, v]) => typeof k === 'string' && typeof v === 'string').slice(0, 20)) as Record<string, string> }
        : {}),
    });
  });
  // 결정 카드의 시안 열기: 그 요청에 붙은 시안 파일만, 시안 폴더(runs/drafts) 안에 있을 때만 연다
  ipcMain.handle(IPC.approvalOpenPreview, async (_e, id: unknown, itemId: unknown, key: unknown) => {
    const item = approvals.list().find((a) => a.id === id);
    const opt = item?.decisionItems?.find((it) => it.id === itemId)?.options.find((o) => o.key === key);
    const draftsRoot = path.join(config.runsDir, 'drafts');
    const p = opt?.preview;
    if (!p || !path.isAbsolute(p) || !(p === draftsRoot || p.startsWith(draftsRoot + path.sep) || p.includes(`${path.sep}runs${path.sep}drafts${path.sep}`)) || !existsSync(p)) {
      return { ok: false, message: '시안 파일을 찾지 못했어요' };
    }
    const err = await shell.openPath(p);
    return err ? { ok: false, message: '시안을 여는 프로그램을 찾지 못했어요' } : { ok: true };
  });
  ipcMain.handle(IPC.outputsList, async () => outputs.list());
  ipcMain.handle(IPC.openFile, async (_e, p: unknown) => {
    const abs = canOpen(p);
    if (!abs) return { ok: false, message: '이 파일은 열 수 없어요 (작업 폴더 밖이거나 지워진 파일이에요)' };
    const err = await shell.openPath(abs);
    return err ? { ok: false, message: '파일을 여는 프로그램을 찾지 못했어요' } : { ok: true };
  });
  ipcMain.handle(IPC.revealFile, async (_e, p: unknown) => {
    const abs = canOpen(p);
    if (!abs) return { ok: false, message: '이 파일은 보여 드릴 수 없어요 (작업 폴더 밖이거나 지워진 파일이에요)' };
    shell.showItemInFolder(abs);
    return { ok: true };
  });
  // 할 일 목록: 화면에서 온 요청은 사용자가 한 일이다(완료 표시 가능). 실패하면 쉬운 문구로 알린다.
  const todoAct = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      emit({ kind: 'error', text: e instanceof Error ? e.message : '할 일을 바꾸지 못했어요', at: new Date().toISOString() });
    }
    return todos.list();
  };
  const STATUS_OK = ['waiting', 'active', 'review', 'done'];
  ipcMain.handle(IPC.todosList, async () => todos.list());
  ipcMain.handle(IPC.todosAdd, async (_e, missionId: unknown, title: unknown) =>
    todoAct(() => {
      if (typeof title !== 'string') return;
      todos.add(typeof missionId === 'string' && missionId ? missionId : null, title.slice(0, 500), 'user');
    }),
  );
  ipcMain.handle(IPC.todosUpdate, async (_e, id: unknown, patch: any) =>
    todoAct(() => {
      if (typeof id !== 'string' || !patch || typeof patch !== 'object') return;
      todos.update(
        id,
        {
          ...(typeof patch.title === 'string' ? { title: patch.title.slice(0, 500) } : {}),
          ...(STATUS_OK.includes(patch.status) ? { status: patch.status } : {}),
        },
        'user',
      );
    }),
  );
  ipcMain.handle(IPC.todosMove, async (_e, id: unknown, dir: unknown) =>
    todoAct(() => {
      if (typeof id === 'string' && (dir === -1 || dir === 1)) todos.move(id, dir);
    }),
  );
  ipcMain.handle(IPC.todosRemove, async (_e, id: unknown) =>
    todoAct(() => {
      if (typeof id === 'string') todos.remove(id, 'user');
    }),
  );
  // ---- 조직(미션 관리·인재풀) ----
  const orgSafe = async <T>(fn: () => T | Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      console.error('[org] 처리 실패:', e);
      return fallback;
    }
  };
  const fail = (message: string) => ({ ok: false, message });
  ipcMain.handle(IPC.orgMissions, () => orgSafe(() => org.missions(), []));
  ipcMain.handle(IPC.orgPickFolder, async (_e, purpose: unknown, zone: unknown) => {
    const z = zone === 'personal' ? 'personal' : 'work';
    const opts = {
      title: `${purpose === 'ref' ? '참고 폴더 고르기 (읽기 전용)' : '작업 폴더 고르기'} · ${zoneText(config)[z].label} 구역`,
      defaultPath: config.zones?.[z]?.root ?? path.join(homedir(), z),
      properties: ['openDirectory' as const],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.orgInspect, (_e, p: unknown, purpose: unknown, zone: unknown, editingId: unknown) =>
    orgSafe(
      () =>
        typeof p === 'string'
          ? org.inspect(p, purpose === 'ref' ? 'ref' : 'target', zone === 'personal' ? 'personal' : 'work', typeof editingId === 'string' ? editingId : undefined)
          : Promise.reject(new Error('경로가 없어요')),
      { path: String(p ?? ''), display: String(p ?? ''), ok: false, problems: ['폴더를 확인하지 못했어요'], warnings: [], isGitRepo: false, ruleFiles: [], secretCandidates: [], deploysOnPush: false, deployHints: [] },
    ),
  );
  ipcMain.handle(IPC.orgCreateMission, (_e, d: any) => orgSafe(() => org.createMission(d), fail('미션을 만들지 못했어요')));
  ipcMain.handle(IPC.orgUpdateMission, (_e, id: unknown, d: any) =>
    orgSafe(() => (typeof id === 'string' ? org.updateMission(id, d) : fail('미션을 찾지 못했어요')), fail('미션을 고치지 못했어요')),
  );
  ipcMain.handle(IPC.orgArchiveMission, (_e, id: unknown, archived: unknown) =>
    orgSafe(() => (typeof id === 'string' ? org.archiveMission(id, archived === true) : fail('미션을 찾지 못했어요')), fail('보관 상태를 바꾸지 못했어요')),
  );
  ipcMain.handle(IPC.orgRoles, () => orgSafe(() => org.roles(), []));
  ipcMain.handle(IPC.orgRole, (_e, name: unknown) => orgSafe(() => (typeof name === 'string' ? org.role(name) : null), null));
  ipcMain.handle(IPC.orgSaveRole, (_e, d: any, originalName: unknown) =>
    orgSafe(() => org.saveRole(d, typeof originalName === 'string' ? originalName : undefined), fail('역할을 저장하지 못했어요')),
  );
  const auth = createAuth(config);
  ipcMain.handle(IPC.authStatus, () => auth.status());
  ipcMain.handle(IPC.authStartLogin, (_e, kind: unknown) => auth.startLogin(kind === 'console' ? 'console' : 'claudeai'));
  ipcMain.handle(IPC.authSubmitCode, (_e, code: unknown) => auth.submitCode(String(code ?? '')));
  ipcMain.handle(IPC.authCancelLogin, () => auth.cancelLogin());
  ipcMain.handle(IPC.authLogout, () => auth.logout());
  ipcMain.handle(IPC.authSaveApiKey, (_e, key: unknown) => auth.saveApiKey(String(key ?? '')));
  ipcMain.handle(IPC.authUseMethod, (_e, m: unknown) => auth.useMethod(m === 'apiKey' ? 'apiKey' : 'max'));
  ipcMain.handle(IPC.authRemoveApiKey, () => auth.removeApiKey());
  ipcMain.handle(IPC.authOpenLoginPage, async (_e, url: unknown) => {
    // 로그인 주소만 연다 (claude.com · claude.ai · anthropic.com)
    try {
      const u = new URL(String(url ?? ''));
      if (u.protocol === 'https:' && /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/.test(u.hostname)) await shell.openExternal(u.toString());
    } catch {
      // 잘못된 주소는 무시
    }
  });
  app.on('before-quit', () => auth.cancelLogin());
  const setup = createSetup(config, memory);
  ipcMain.handle(IPC.setupStatus, () => setup.status());
  ipcMain.handle(IPC.missionDocs, (_e, id: unknown) => (typeof id === 'string' ? org.missionDocs(id) : []));
  ipcMain.handle(IPC.search, (_e, q: unknown) => searchAll(config, typeof q === 'string' ? q : ''));
  // 휴대폰(텔레그램): 맥이 텔레그램에 먼저 접속하는 방식(들어오는 포트 없음)
  mobile = new TelegramBridge({
    config,
    approvals,
    activity: (text) => emit({ kind: 'activity', text, at: new Date().toISOString() }),
    sendToRano: async (text, list) => {
      const saved = saveAttachments(config.runsDir, list);
      if (!saved.ok) return { ok: false, message: saved.message };
      void rano.send(text, saved.saved, 'mobile');
      return { ok: true };
    },
  });
  mobile.start();
  app.on('before-quit', () => mobile?.stop());
  ipcMain.handle(IPC.mobileStatus, () => mobile!.status());
  ipcMain.handle(IPC.mobileConnect, (_e, t: unknown) => mobile!.connect(String(t ?? '')));
  ipcMain.handle(IPC.mobileDisconnect, () => mobile!.disconnect());
  ipcMain.handle(IPC.mobileOptions, (_e, o: any) => mobile!.setOptions({ ...(typeof o?.allRano === 'boolean' ? { allRano: o.allRano } : {}), ...(typeof o?.approvals === 'boolean' ? { approvals: o.approvals } : {}), ...(typeof o?.keepAwake === 'boolean' ? { keepAwake: o.keepAwake } : {}) }));
  ipcMain.handle(IPC.mobileNewCode, () => mobile!.newPairCode());
  ipcMain.handle(IPC.usageSummary, () => usageSummary(Object.fromEntries(config.missions.map((m) => [m.id, m.name]))));
  ipcMain.handle(IPC.updateCheck, () => {
    if ((config.raw as any)?.updates?.check === false) return { current: app.getVersion(), newer: false, error: '새 버전 확인을 꺼 두었어요 (rano.json updates.check)' };
    return checkForUpdate(app.getAppPath(), app.getVersion());
  });
  ipcMain.handle(IPC.openReleasePage, async (_e, url: unknown) => {
    try {
      const u = new URL(String(url ?? ''));
      if (u.protocol === 'https:' && u.hostname === 'github.com') await shell.openExternal(u.toString());
    } catch {
      // 잘못된 주소는 무시
    }
  });
  ipcMain.handle(IPC.settingsSaveProfile, (_e, p: any) => setup.saveProfile(p ?? {}).catch(() => ({ ok: false, message: '저장하지 못했어요' })));
  ipcMain.handle(IPC.settingsSaveZones, (_e, z: any) => setup.saveZones({ work: String(z?.work ?? ''), personal: String(z?.personal ?? '') }).catch(() => ({ ok: false, message: '저장하지 못했어요', needsRestart: false })));
  ipcMain.handle(IPC.openDataFolder, async () => {
    await shell.openPath(config.rootDir);
  });
  ipcMain.handle(IPC.setupCheckFolder, (_e, zone: unknown, p: unknown) => setup.checkFolder(zone === 'personal' ? 'personal' : 'work', String(p ?? '')));
  ipcMain.handle(IPC.setupPickFolder, async (_e, zone: unknown, current: unknown) => {
    const z = zone === 'personal' ? 'personal' : 'work';
    const cur = typeof current === 'string' && current.trim() ? current.trim().replace(/^~(?=\/|$)/, homedir()) : homedir();
    const opts = {
      title: `${zoneText(config)[z].label} 구역 폴더 고르기`,
      defaultPath: existsSync(cur) ? cur : homedir(),
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.setupSave, async (_e, input: any) => {
    try {
      return await setup.save(input);
    } catch {
      return { ok: false, message: '설정을 저장하지 못했어요. 잠시 뒤 다시 해 주세요', needsRestart: false };
    }
  });
  ipcMain.handle(IPC.appSettings, () => {
    const raw = (config.raw ?? {}) as { roleLabels?: unknown };
    const roleLabels: Record<string, string> = {};
    if (raw.roleLabels && typeof raw.roleLabels === 'object')
      for (const [k, v] of Object.entries(raw.roleLabels as Record<string, unknown>)) if (typeof v === 'string' && v.trim()) roleLabels[k] = v.trim().slice(0, 30);
    return { roleLabels, zones: zoneText(config), version: app.getVersion() };
  });
  ipcMain.handle(IPC.orgRestart, () => {
    // 기다리던 과제는 대기열 기록으로 다음 실행 때 이어 간다 (before-quit 에서 정리)
    app.relaunch();
    app.quit();
  });

  ipcMain.handle(IPC.missionSend, async (_e, missionId: unknown, text: unknown, attachments: unknown) => {
    const t = typeof text === 'string' ? text.trim() : '';
    const list = Array.isArray(attachments) ? (attachments as NewAttachment[]) : [];
    if (typeof missionId !== 'string' || (!t && !list.length)) return { ok: false, message: '보낼 내용이 없어요' };
    const saved = saveAttachments(config.runsDir, list);
    if (!saved.ok) return { ok: false, message: saved.message };
    await dispatcher.userSend(missionId, t || '(그림만 보냈어요)', saved.saved);
    return { ok: true };
  });

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: '라노 OS',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: path.join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => (win = null));
  await win.loadFile(path.join(here, '..', 'renderer', 'index.html'));

  // 화면이 뜬 뒤에 지난번 기다리던 과제를 이어 간다 (현황판·할 일에 바로 보이도록)
  dispatcher.resumePending();
}

app.whenReady().then(boot);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  dispatcherForQuit?.shutdown();
  for (const l of leadersForQuit) l.close?.();
});
