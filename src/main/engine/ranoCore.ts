// 라노 세션의 몸통: 줄 세우기·차례 돌리기·답 흘려 보이기·저장. 엔진(query)·환경변수는 밖에서 넣어 준다(ranoSession.ts).
// Electron 을 불러오지 않으므로 시험에서 가짜 엔진을 넣어 그대로 돌릴 수 있다.
import type { McpServerConfig, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  MEMORY_MCP_NAME,
  MISSION_MCP_NAME,
  TODO_MCP_NAME,
  ORG_MCP_NAME,
  type ChatAttachment,
  type ChatMessage,
  type ConversationStoreApi,
  type Emit,
  type LiveStep,
  type MemoryServiceApi,
  type PermissionLogEntry,
  type RanoConfig,
  type RanoEffort,
  type RanoSessionApi,
  type RanoUiEvent,
} from '../../shared/types.js';
import { createPermissionGate } from './permissions.js';
import { buildRanoSystemPrompt, ranoMissionList, ranoPromptFrame } from './ranoPrompt.js';
import { zoneText } from '../admin/paths.js';
import { imageBlocks } from './attachments.js';
import { recordLimit, recordResult } from './usage.js';
import { findUnanswered, LANE_LIMITS, markPassed, noticePrompt, planNextTurn, toolLabel, userTurnPrompt, type LaneLimits, type LaneNotice, type LaneUser, type TurnPlan } from './ranoLanes.js';
import { contentKey, nextState, planPrompt, PromptStateFile, withNotice, type PromptPlan, type RanoPromptState } from './ranoPromptState.js';

export interface RanoSessionDeps {
  config: RanoConfig;
  memory: MemoryServiceApi;
  store: ConversationStoreApi;
  emit: Emit;
  memoryMcp: unknown;
  missionMcp?: unknown; // 2단계: 라노의 미션 도구 서버 (assign_to_mission, get_mission_status)
  todoMcp?: unknown; // 할 일 도구 서버 (todo_list, todo_add, todo_update, todo_remove)
  todoText?: () => string; // 프롬프트에 넣을 할 일 목록
  todoItems?: () => { id: string; title: string; status: string }[]; // 할 일 목록(라노 답과 할 일을 잇는 안전망·id 확인용)
  statusNote?: () => string; // 사용자 말 차례마다 앞에 붙일 "지금 현황"(미션 진행·승인 대기·터미널 세션). 실패하면 붙이지 않는다
  orgMcp?: unknown; // 조직 도구 서버 (org_overview, propose_mission, open_mission_proposal)
}

/** 엔진 부르기. 실제로는 SDK 의 query, 시험에서는 가짜 */
export type QueryFn = (args: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

export interface RanoCoreDeps extends RanoSessionDeps {
  queryFn: QueryFn;
  sdkEnv: () => Record<string, string | undefined>;
  claudePath?: () => string | undefined;
  afterResult?: (q: unknown) => void; // 결과가 온 뒤 할 일(사용 한도 받기). 기다리지 않는다
  now?: () => number;
  liveThrottleMs?: number; // 흘려 보이기 묶음 간격 (기본 80ms, 시험은 0)
  limits?: LaneLimits;
  engineDrainMs?: number; // 다음 엔진을 켜기 전 앞 엔진 끝나기를 기다리는 시간 (기본 2500ms). 넘으면 close() 로 끈다
}

import { fallbackChoices, hideMarkers, matchTodosByTitle, parseDirectNotice, parseReportNotice, splitMarkers, todoIdsFromTool } from './todoLink.js';
const MAX_TURNS = 20;
export const DEFAULT_RANO_EFFORT: RanoEffort = 'low';
const TOOL_BLOCKS = new Set(['tool_use', 'mcp_tool_use', 'server_tool_use']);
export const CUT_NOTE = '(답이 중간에 끊겼어요)';
const ENGINE_DRAIN_MS = 2500; // 다음 엔진을 켜기 전 앞 엔진이 끝나기를 기다리는 시간
const ENGINE_CLOSE_WAIT_MS = 500; // 앞 엔진을 끈(close) 뒤 정리가 끝나기를 조금 더 기다리는 시간

/** p 가 ms 안에 끝나면 true */
function within(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    void p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

// 한 번의 query 실행 결과
interface AttemptResult {
  text: string; // 라노 답 (비어 있을 수 있음)
  errorText: string | null; // 오류 판단용 원문 (화면에 그대로 보여주지 않음)
  errorKind: string | null; // SDK 가 알려준 오류 종류
  gotInit: boolean;
  ttftMs?: number; // 엔진이 알려 준 첫 글자까지 시간
  engineMs?: number; // 엔진이 알려 준 이번 일 시간
  plan?: PromptPlan; // 이번 시도에 넘긴 지침·안내와, 정상으로 끝나면 비교 기준이 될 판
  compacted?: boolean; // 이번 시도 중 엔진이 대화를 요약함(compact_boundary)
  todoIds?: string[]; // 이번 시도에서 도구로 다룬 할 일 id
  assigned?: string; // 이번 시도에서 리더에게 과제를 맡긴 미션 id
}

/** 한 줄 JSON 기록을 덧붙인다. 실패해도 조용히 넘어간다. 비밀 값은 넘기지 않는다. */
export function appendJsonl(file: string, obj: unknown) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(obj) + '\n', 'utf-8');
  } catch {
    // 기록 실패가 대화를 막지 않게 한다
  }
}

/** 오류 원문을 사용자가 이해할 수 있는 한국어 한 줄로 바꾼다. who 는 답을 만들던 쪽 (기본 '라노'). */
export function friendlyError(raw: string, kind: string | null, who = '라노'): string {
  const s = `${kind ?? ''} ${raw}`.toLowerCase();
  if (/rate_limit|rate limit|usage limit|limit reached|429|quota|billing/.test(s)) {
    return '지금은 Claude 사용 한도에 도달했어요. 한도가 풀린 뒤에 다시 말씀해 주세요.';
  }
  if (/authentication|oauth|login|log in|401|403|unauthorized|credential|expired|account_on_hold|verification/.test(s)) {
    return 'Claude 로그인이 만료되었거나 확인되지 않아요. 오른쪽 위 Claude 계정 버튼에서 다시 로그인한 뒤 말씀해 주세요.';
  }
  if (/overloaded|server_error|529|500|502|503/.test(s)) {
    return 'Claude 쪽이 지금 많이 바빠요. 잠시 뒤에 다시 말씀해 주세요.';
  }
  if (/econn|enotfound|etimedout|network|fetch failed|socket|timeout|offline|connection/.test(s)) {
    return '연결에 문제가 생겼어요. 인터넷 연결을 확인한 뒤 다시 말씀해 주세요.';
  }
  if (/error_max_turns|max_turns/.test(s)) {
    return '생각하는 단계가 너무 길어져서 중간에 멈췄어요. 요청을 조금 나눠서 다시 말씀해 주세요.';
  }
  if (/model_not_found/.test(s)) {
    return '설정된 모델을 찾지 못했어요. 앱 설정의 모델 이름을 확인해야 해요.';
  }
  return `${who}가 답을 마치지 못했어요. 잠시 뒤에 다시 말씀해 주세요.`;
}

export function looksLikeMissingSession(raw: string): boolean {
  return /no conversation found|session.*(not found|does not exist|missing)|could not (find|resume)|resume/i.test(raw);
}

function firstLine(text: string, max: number): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 한 차례의 "쓰는 중" 화면. 글자 조각은 이어 붙이고, 도구가 시작되면 그때까지 쓴 말을 회색 줄로 줄이고
 * "할 일에 넣는 중" 같은 진행 줄을 더한다. 화면에는 늘 지금 모습 전체(live 이벤트)를 보낸다(조각 순서가 섞여도 안전).
 * 이 이벤트는 화면 전용이라 events.jsonl 에 남기지 않는다.
 */
export class LiveView {
  private text = '';
  private steps: LiveStep[] = [];
  private gap = false; // 다음 글 앞에 빈 줄
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shown = false; // 화면에 무언가를 보냈는지 (지울 때만 빈 이벤트를 보냄)
  firstShownAt: number | undefined; // 처음 무언가(글자·진행 줄)를 보인 시각

  constructor(
    private readonly turn: number,
    private readonly label: string | undefined,
    private readonly send: (e: RanoUiEvent) => void,
    private readonly throttleMs: number,
    private readonly now: () => number,
  ) {}

  /** 새 글 덩어리가 시작됨 (다음 글 앞에 빈 줄) */
  newBlock(): void {
    if (this.text) this.gap = true;
  }

  append(t: string): void {
    if (!t) return;
    if (this.gap && this.text) this.text += '\n\n';
    this.gap = false;
    this.text += t;
    this.schedule();
  }

  /** 흘려 받기 조각이 없었던 글(완성 메시지만 온 경우)을 덩어리로 더한다 */
  appendBlock(t: string): void {
    this.newBlock();
    this.append(t);
  }

  tool(name: string): void {
    const said = this.text.trim();
    if (said) this.steps.push({ tone: 'said', text: firstLine(said.replace(/\s+/g, ' '), 90) });
    this.text = '';
    this.gap = false;
    for (const s of this.steps) if (s.tone === 'doing') s.tone = 'done';
    this.steps.push({ tone: 'doing', text: toolLabel(name) });
    if (this.steps.length > 6) this.steps = this.steps.slice(-6);
    this.flush();
  }

  /** 지금 쓰는 중인 글(마지막 도구 뒤) */
  partial(): string {
    return this.text.trim();
  }

  /** 다시 시도할 때: 쓰던 말풍선·회색 줄을 비운다 */
  reset(): void {
    this.text = '';
    this.steps = [];
    this.gap = false;
    this.flush();
  }

  /** 차례가 끝날 때: 화면에서 지운다(확정 메시지가 없어도 남지 않게) */
  clear(): void {
    this.text = '';
    this.steps = [];
    this.gap = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.shown) this.out();
  }

  private schedule(): void {
    if (this.throttleMs <= 0) return this.flush();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.throttleMs);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.text && !this.steps.length && !this.shown) return;
    this.out();
  }

  private out(): void {
    const text = hideMarkers(this.text);
    if ((text || this.steps.length) && this.firstShownAt === undefined) this.firstShownAt = this.now();
    this.shown = !!(text || this.steps.length);
    this.send({ kind: 'live', turn: this.turn, text, steps: this.steps.map((s) => ({ ...s })), ...(this.label ? { label: this.label } : {}) });
  }
}

/** rano.json 의 값을 라노 생각 깊이로. 잘못된 값이면 기본 'low' */
export function ranoEffortOf(config: RanoConfig): RanoEffort {
  return config.ranoEffort ?? DEFAULT_RANO_EFFORT;
}

export class RanoCore implements RanoSessionApi {
  protected readonly config: RanoConfig;
  private readonly memory: MemoryServiceApi;
  private readonly store: ConversationStoreApi;
  private readonly uiEmit: Emit;
  private readonly memoryMcp: McpServerConfig;
  private readonly missionMcp: McpServerConfig | undefined;
  private readonly todoMcp: McpServerConfig | undefined;
  private readonly orgMcp: McpServerConfig | undefined;
  private readonly todoText: (() => string) | undefined;
  private readonly statusNote: (() => string) | undefined;
  private readonly todoItems: (() => { id: string; title: string; status: string }[]) | undefined;
  private readonly eventsLog: string;
  private readonly permissionsLog: string;
  private readonly queryFn: QueryFn;
  private readonly sdkEnv: () => Record<string, string | undefined>;
  private readonly claudePath: () => string | undefined;
  private readonly afterResult: (q: unknown) => void;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly limits: LaneLimits;
  private readonly drainMs: number;
  // 앞 차례 엔진: 결과가 오면 답은 바로 확정하지만 엔진은 뒤에서 마저 끝난다(사용 한도 받기 등).
  // 라노 도구 서버(MCP)는 앱 전체에 하나뿐이라 앞 엔진이 붙어 있는 채로 새 엔진을 켜면 "Already connected" 로 빠진다
  private prevEngine: { finished: Promise<void>; close: () => void } | null = null;
  // 라노 지침 고정: 이 대화를 시작할 때 만든 지침과, 마지막으로 정상 끝난 차례에 라노가 본 기억·할 일 판(runs/rano/prompt-state.json)
  private readonly promptFile: PromptStateFile;
  private promptState: RanoPromptState | null | undefined; // undefined = 아직 읽지 않음

  // 두 칸 줄: 사용자 말(먼저) · 앱 알림(뒤)
  private users: LaneUser[] = [];
  private notices: LaneNotice[] = [];
  private noticeDone = new Map<string, () => void>();
  private running = false;
  private turnNo = 0;
  private currentLabel: string | undefined; // 지금 도는 차례 표시 (예: '보고 정리 중')
  private inTurn = new Set<string>(); // 지금 답하는 중인 내 말 id
  private idleWaiters: (() => void)[] = [];

  constructor(deps: RanoCoreDeps) {
    this.config = deps.config;
    this.memory = deps.memory;
    this.store = deps.store;
    this.uiEmit = deps.emit;
    this.memoryMcp = deps.memoryMcp as McpServerConfig;
    this.missionMcp = deps.missionMcp as McpServerConfig | undefined;
    this.todoMcp = deps.todoMcp as McpServerConfig | undefined;
    this.orgMcp = deps.orgMcp as McpServerConfig | undefined;
    this.todoText = deps.todoText;
    this.statusNote = deps.statusNote;
    this.todoItems = deps.todoItems;
    this.eventsLog = path.join(deps.config.runsDir, 'events.jsonl');
    this.permissionsLog = path.join(deps.config.runsDir, 'permissions.jsonl');
    this.queryFn = deps.queryFn;
    this.sdkEnv = deps.sdkEnv;
    this.claudePath = deps.claudePath ?? (() => undefined);
    this.afterResult = deps.afterResult ?? (() => undefined);
    this.now = deps.now ?? (() => Date.now());
    this.throttleMs = deps.liveThrottleMs ?? 80;
    this.limits = deps.limits ?? LANE_LIMITS;
    this.drainMs = deps.engineDrainMs ?? ENGINE_DRAIN_MS;
    this.promptFile = PromptStateFile.at(deps.config.runsDir);
  }

  private loadPromptState(): RanoPromptState | null {
    if (this.promptState === undefined) this.promptState = this.promptFile.load();
    return this.promptState;
  }

  /** 차례가 끝난 뒤: 정상으로 끝났을 때만 비교 기준을 이번 판으로 바꾼다(요약을 받았으면 다음에 새로 만들도록 표시) */
  private async settlePromptState(result: AttemptResult | undefined): Promise<void> {
    if (!result) return;
    let sessionId: string | null = null;
    try {
      sessionId = (await this.store.load()).sessionId;
    } catch {
      sessionId = null;
    }
    const prev = this.loadPromptState();
    const ok = result.errorText === null && !!result.text;
    const next = nextState(prev, result.plan, sessionId, ok, !!result.compacted);
    if (next && next !== prev) {
      this.promptState = next;
      this.promptFile.save(next);
    }
  }

  /** 앞 엔진이 끝나기를 기다린다. 제한 시간 안에 안 끝나면 close() 로 끄고(그 차례의 사용 한도 받기는 끊김) 조금 더 기다린 뒤 진행 */
  private async settlePrevEngine(): Promise<void> {
    const prev = this.prevEngine;
    if (!prev) return;
    this.prevEngine = null;
    if (await within(prev.finished, this.drainMs)) return;
    try {
      prev.close();
    } catch {
      // 무시
    }
    await within(prev.finished, ENGINE_CLOSE_WAIT_MS);
  }

  /** 내 말: 바로 저장·화면 표시하고 줄에 세운 뒤 돌아간다(답을 기다리지 않음) */
  async send(text: string, attachments: ChatAttachment[] = [], via?: 'mobile'): Promise<void> {
    const userMsg: ChatMessage = { id: randomUUID(), role: 'user', text, at: new Date().toISOString(), ...(attachments.length ? { attachments } : {}), ...(via ? { via } : {}) };
    try {
      await this.store.append(userMsg);
    } catch {
      this.emitError('대화를 저장하지 못했어요. 이번 말은 화면에만 남을 수 있어요.', { ...(via === 'mobile' ? { mobile: true } : {}) });
    }
    const waits = this.running;
    this.emit({ kind: 'message', message: userMsg, ...(waits ? { queued: true, ...(this.currentLabel ? { waitFor: this.currentLabel } : {}) } : {}) });
    this.users.push({ id: userMsg.id, text, attachments, ...(via ? { via } : {}), at: this.now() });
    this.pump();
  }

  // 앱이 라노에게 알린다(리포 리더 보고 등). 사용자 말풍선은 만들지 않고 대화 기록에도 사용자 말로 남기지 않는다.
  notify(text: string, kind: 'report' | 'direct' = 'report'): Promise<void> {
    const n: LaneNotice = { id: randomUUID(), text, kind, at: this.now(), passed: 0 };
    const done = new Promise<void>((resolve) => this.noticeDone.set(n.id, resolve));
    this.notices.push(n);
    this.pump();
    return done;
  }

  async unanswered(): Promise<string[]> {
    const { messages } = await this.store.load();
    const waiting = new Set(this.users.map((u) => u.id));
    return findUnanswered(messages).filter((id) => !waiting.has(id) && !this.inTurn.has(id));
  }

  async resend(messageId: string): Promise<{ ok: boolean; message?: string }> {
    if (this.users.some((u) => u.id === messageId) || this.inTurn.has(messageId)) return { ok: false, message: '이미 라노가 답하려고 기다리는 말이에요' };
    const { messages } = await this.store.load();
    const m = messages.find((x) => x.id === messageId && x.role === 'user');
    if (!m) return { ok: false, message: '그 말을 찾지 못했어요' };
    if (!findUnanswered(messages).includes(messageId)) return { ok: false, message: '이미 답한 말이에요' };
    this.emit({ kind: 'activity', text: `다시 보냈어요: ${firstLine(m.text, 40)}`, at: new Date().toISOString() });
    this.users.push({ id: m.id, text: m.text, attachments: m.attachments ?? [], ...(m.via ? { via: m.via } : {}), at: this.now() });
    this.pump();
    return { ok: true };
  }

  /** 줄이 빌 때까지 기다린다(시험용) */
  whenIdle(): Promise<void> {
    if (!this.running && !this.users.length && !this.notices.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private emit(e: RanoUiEvent) {
    appendJsonl(this.eventsLog, e);
    this.ui(e);
  }

  /** 화면에만 보낸다(기록하지 않음): 흘려 쓰는 답 */
  private ui(e: RanoUiEvent) {
    try {
      this.uiEmit(e);
    } catch {
      // 창이 닫혀 있어도 계속 진행
    }
  }

  private emitError(text: string, extra: { turn?: number; mobile?: boolean } = {}) {
    this.emit({ kind: 'error', text, at: new Date().toISOString(), ...extra });
  }

  private pump(): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      try {
        for (;;) {
          const plan = planNextTurn(this.users, this.notices, this.now(), this.limits);
          if (!plan) break;
          let handled: LaneNotice[];
          let passedOver: LaneNotice[] = [];
          if (plan.kind === 'user') {
            this.users = this.users.filter((u) => !plan.users.includes(u));
            this.notices = this.notices.filter((n) => !plan.notices.includes(n));
            passedOver = this.notices.slice(); // 이번 차례에 붙이지 못한 알림
            handled = plan.notices;
          } else {
            this.notices = this.notices.filter((n) => n !== plan.notice);
            handled = [plan.notice];
          }
          try {
            await this.runTurn(plan);
          } catch (e) {
            console.error('[rano] 차례 처리 실패:', e);
          }
          if (plan.kind === 'user') markPassed(passedOver.filter((n) => this.notices.includes(n)));
          for (const n of handled) {
            this.noticeDone.get(n.id)?.();
            this.noticeDone.delete(n.id);
          }
        }
      } finally {
        this.running = false;
        this.currentLabel = undefined;
        for (const w of this.idleWaiters.splice(0)) w();
      }
    })();
  }

  private async runTurn(plan: TurnPlan): Promise<void> {
    const turn = ++this.turnNo;
    const users = plan.kind === 'user' ? plan.users : [];
    const ids = users.map((u) => u.id);
    const mobile = users.some((u) => u.via === 'mobile');
    const label = plan.kind === 'notice' ? (plan.notice.kind === 'report' ? '보고 정리 중' : '알림 확인 중') : undefined;
    this.currentLabel = label;
    for (const id of ids) this.inTurn.add(id);
    const startedAt = this.now();
    const sentAt = plan.kind === 'user' ? Math.min(...users.map((u) => u.at)) : plan.notice.at;
    let statusNote = '';
    if (plan.kind === 'user') {
      try {
        statusNote = this.statusNote?.() ?? '';
      } catch {
        statusNote = '';
      }
    }
    const prompt = plan.kind === 'user' ? `${statusNote ? `${statusNote}\n\n[사용자 말]\n` : ''}${userTurnPrompt(users, plan.notices)}` : noticePrompt(plan.notice);
    const attachments = users.flatMap((u) => u.attachments);
    const extra = { turn, ...(mobile ? { mobile: true } : {}) };
    this.emit({ kind: 'status', status: 'thinking', turn, ...(label ? { label } : {}), ...(ids.length ? { users: ids } : {}), ...(mobile ? { mobile: true } : {}) });
    const live = new LiveView(turn, label, (e) => this.ui(e), this.throttleMs, this.now);
    let answeredAt: number | undefined;
    let result: AttemptResult | undefined;
    try {
      const { sessionId } = await this.store.load();
      result = await this.attempt(prompt, sessionId ?? undefined, attachments, live);

      // 이어가기에 실패하면(세션 기록이 없어졌을 때 등) 새 세션으로 한 번 다시 시도한다. 쓰던 말풍선은 비운다
      if (sessionId && result.errorText !== null && !result.text && (!result.gotInit || looksLikeMissingSession(result.errorText))) {
        live.reset();
        result = await this.attempt(prompt, undefined, attachments, live);
      }
      // 지침 판 저장(settlePromptState)은 답 저장 뒤 finally 에서 한다(그 안에서 오류가 나도 답 저장·표시가 막히지 않게)

      // 저장은 최종 답 하나. 글이 조금 나온 뒤 오류로 끝나면 그 글을 지우지 않되 "끊김" 표시를 붙이고,
      // 답한 말로 치지 않는다(replyTo: []) → 다시 켜면 [다시 보내기] 대상. 휴대폰에도 같은 글이 간다
      const cut = result.errorText !== null;
      // 답 끝의 할 일 표시(〔할일 id〕)는 떼어 내 연결 정보로만 쓴다
      const marked = splitMarkers(result.text || (cut ? live.partial() : ''));
      const raw = marked.text;
      let todoIds = [...new Set([...(result.todoIds ?? []), ...marked.ids])];
      try {
        const items = this.todoItems?.();
        if (items) {
          todoIds = todoIds.filter((id) => items.some((x) => x.id === id)); // 없는 id 는 버린다
          // 리더 보고 알림에는 앱이 연결된 할 일 id 를 적어 둔다
          const linked = plan.kind === 'notice' ? /연결된 할 일 id: ([0-9a-f]{8})/.exec(plan.notice.text.slice(0, 300))?.[1] : undefined;
          // 보고 답은 앱이 아는 연결을 맨 앞에 둔다(라노가 같은 차례에 다른 할 일을 고쳤어도 카드는 이 과제의 할 일을 가리킨다)
          if (linked && items.some((x) => x.id === linked)) todoIds = [linked, ...todoIds.filter((id) => id !== linked)];
          // 표시가 없으면 주고받은 글에 제목이 그대로 나온 할 일로 잇는다
          if (!todoIds.length) todoIds = matchTodosByTitle(items, [...users.map((u) => u.text), plan.kind === 'notice' ? plan.notice.text.slice(0, 400) : '', raw]);
        }
      } catch {
        // 연결 정보는 없어도 답은 그대로 보인다
      }
      todoIds = todoIds.slice(0, 6);
      const text = raw && cut ? `${raw}\n\n${CUT_NOTE}` : raw;
      if (text) {
        // replyTo 는 늘 둔다: 알림 차례 답은 [] (findUnanswered 가 기준에서 건너뜀), 칸이 없는 것은 예전 기록뿐
        const ranoMsg: ChatMessage = { id: randomUUID(), role: 'rano', text, at: new Date().toISOString(), replyTo: cut ? [] : ids, ...(todoIds.length ? { todoIds } : {}), ...this.shapeOf(plan, result, raw, cut, marked.choices) };
        try {
          await this.store.append(ranoMsg);
        } catch {
          this.emitError('라노의 답을 저장하지 못했어요. 이번 답은 화면에만 남을 수 있어요.', extra);
        }
        answeredAt = this.now();
        this.emit({ kind: 'message', message: ranoMsg, ...extra });
      }
      if (result.errorText !== null) {
        this.emitError(friendlyError(result.errorText, result.errorKind), extra);
      } else if (!text) {
        this.emitError('라노가 이번에는 답을 만들지 못했어요. 다시 한 번 말씀해 주세요.', extra);
      }
    } catch (err) {
      this.emitError(friendlyError(err instanceof Error ? err.message : String(err), null), extra);
    } finally {
      // 안전망: 확정 메시지가 없어도 쓰던 말풍선·회색 줄은 반드시 지운다
      live.clear();
      for (const id of ids) this.inTurn.delete(id);
      this.emit({ kind: 'status', status: 'idle', turn });
      // 응답 시간 비교용 한 줄(내용 없음): 보냄→차례 시작·첫 반응·답 확정
      appendJsonl(this.eventsLog, {
        kind: 'timing',
        at: new Date().toISOString(),
        turn,
        by: plan.kind === 'user' ? 'user' : plan.notice.kind,
        users: ids.length,
        notices: plan.kind === 'user' ? plan.notices.length : 1,
        waitMs: startedAt - sentAt,
        firstShownMs: live.firstShownAt !== undefined ? live.firstShownAt - sentAt : null,
        answeredMs: answeredAt !== undefined ? answeredAt - sentAt : null,
        ttft_ms: result?.ttftMs ?? null,
        engineMs: result?.engineMs ?? null,
        ok: !!result && result.errorText === null,
      });
      // 정상으로 끝난 차례만 비교 기준을 바꾼다. 다음 차례는 runTurn 이 끝난 뒤에 시작하므로 그 전에 저장된다
      try {
        await this.settlePromptState(result);
      } catch (e) {
        console.error('[rano] 지침 판 정리 실패:', e);
      }
    }
  }

  /**
   * 라노 답의 모양과 선택 단추를 정한다.
   * - 리더 보고를 전하는 답 → 보고 카드(report)
   * - 리더에게 맡겼다는 짧은 접수 말(맡기기 도구를 썼거나, 사용자가 리더에게 직접 지시한 알림에 대한 답) → 한 줄(ack). 길거나 고를 것이 있으면 보통 말풍선
   */
  private shapeOf(plan: TurnPlan, result: AttemptResult, text: string, cut: boolean, markerChoices: string[]): Partial<ChatMessage> {
    if (cut || !text) return {};
    const choices = (markerChoices.length ? markerChoices : fallbackChoices(text)).slice(0, 3);
    const withChoices = choices.length ? { choices } : {};
    if (plan.kind === 'notice' && plan.notice.kind === 'report') {
      const r = parseReportNotice(plan.notice.text);
      if (r) return { form: 'report', mission: r.mission, report: { title: r.title, ok: r.ok, ...(r.taskId ? { taskId: r.taskId } : {}) }, ...withChoices };
      return withChoices;
    }
    const direct = plan.kind === 'notice' && plan.notice.kind === 'direct' ? parseDirectNotice(plan.notice.text) : null;
    const assignedName = result.assigned ? (this.config.missions.find((m) => m.id === result.assigned)?.name ?? result.assigned) : null;
    const mission = direct ?? assignedName;
    if (mission && !choices.length && text.length <= 420) return { form: 'ack', mission };
    return withChoices;
  }

  private async attempt(prompt: string, resume: string | undefined, attachments: ChatAttachment[], live: LiveView): Promise<AttemptResult> {
    await this.settlePrevEngine(); // 다음 엔진은 앞 엔진 정리 뒤에 켠다
    const memoryFiles = await this.memory.readAll();
    let todoText: string | undefined;
    try {
      todoText = this.todoText?.();
    } catch {
      todoText = undefined;
    }
    // 지침은 대화 동안 처음 만든 판 그대로(앞부분이 바뀌지 않아 다시 읽기 할인이 유지된다). 기억·할 일이 바뀐 차례에만 내 말 앞에 안내를 붙인다
    // 지침 틀(미션 목록·구역·지침 문구)이 저장된 지문과 다르면 지침을 새로 만들고, 안내에 미션 목록도 넣는다
    const missions = this.config.missions ?? [];
    const zones = zoneText(this.config);
    const frame = { key: contentKey(ranoPromptFrame(memoryFiles, missions, zones)), missions: ranoMissionList(missions, zones) };
    const plan = planPrompt(this.loadPromptState(), resume, memoryFiles, todoText, () => buildRanoSystemPrompt(memoryFiles, missions, todoText, zones), frame);
    prompt = withNotice(prompt, plan.notice);
    const logPermission = (line: PermissionLogEntry) => appendJsonl(this.permissionsLog, line);
    const claudePath = this.claudePath();

    const options: Options = {
      model: this.config.models.rano,
      effort: ranoEffortOf(this.config), // 라노만: 생각 깊이 (기본 'low'). 리더·팀원 옵션에는 넣지 않는다
      includePartialMessages: true, // 답을 글자 조각으로도 받아 화면에 흘려 보인다
      cwd: this.config.rootDir,
      // 엔진의 지침 기록(snapshot)이 켜졌든 아니든 같은 지침을 넘긴다(기록은 덤)
      systemPrompt: { type: 'custom', prompt: plan.systemPrompt, snapshot: true },
      tools: [], // 내장 도구(파일·명령 실행 등) 전부 끔
      mcpServers: {
        [MEMORY_MCP_NAME]: this.memoryMcp,
        ...(this.missionMcp ? { [MISSION_MCP_NAME]: this.missionMcp } : {}),
        ...(this.todoMcp ? { [TODO_MCP_NAME]: this.todoMcp } : {}),
        ...(this.orgMcp ? { [ORG_MCP_NAME]: this.orgMcp } : {}),
      },
      strictMcpConfig: true, // 앱이 넘긴 기억·미션 도구 서버만 쓴다
      canUseTool: createPermissionGate(this.config, logPermission),
      permissionMode: 'default', // 모든 도구 사용을 canUseTool 로 확인
      settingSources: [], // 사용자 ~/.claude 설정·CLAUDE.md 를 불러오지 않음
      maxTurns: MAX_TURNS,
      executable: 'node', // Electron 안에서 도므로 명시
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      env: this.sdkEnv(),
      ...(resume ? { resume } : {}),
    };

    const out: AttemptResult = { text: '', errorText: null, errorKind: null, gotInit: false, plan };
    // 라노 답 조각: 도구 호출 뒤에 나온 글을 최종 답으로 본다
    let segments: string[] = [];
    const allSegments: string[] = [];
    const textById = new Map<string, number>(); // message.id → segments 위치
    const toolsShown = new Set<string>(); // 흘려 받기로 이미 진행 줄을 띄운 도구 id
    let streamedText = false; // 이번 assistant 메시지의 글이 조각으로 이미 보였는지

    // 그림이 있으면 그림 + 글을 한 메시지로 보낸다 (입력은 그 한 메시지로 끝)
    const images = attachments.length ? imageBlocks(this.config.runsDir, attachments) : [];
    const input: string | AsyncIterable<SDKUserMessage> = images.length
      ? (async function* () {
          yield { type: 'user', message: { role: 'user', content: [...images, { type: 'text', text: prompt }] }, parent_tool_use_id: null } as unknown as SDKUserMessage;
        })()
      : prompt;

    const finish = () => {
      const finalSegments = segments.length ? segments : allSegments;
      out.text = finalSegments.join('\n\n').trim();
      if (out.errorKind && out.errorText === null && !out.text) out.errorText = out.errorKind;
      return out;
    };

    return new Promise<AttemptResult>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(finish());
      };
      let q: AsyncIterable<SDKMessage> | undefined;
      let ended: () => void = () => {};
      const finished = new Promise<void>((r) => (ended = r));
      this.prevEngine = {
        finished,
        close: () => {
          const c = (q as { close?: () => void } | undefined)?.close;
          if (typeof c === 'function') c.call(q);
        },
      };
      void (async () => {
        try {
          const engine = this.queryFn({ prompt: input, options });
          q = engine;
          for await (const msg of engine) {
            const type = (msg as { type: string }).type;
            if (type === 'rate_limit_event') {
              recordLimit((msg as { rate_limit_info?: unknown }).rate_limit_info);
              continue;
            }
            if (settled) continue; // 결과가 온 뒤의 알림은 답에 넣지 않는다 (엔진은 뒤에서 마저 끝나고, 다음 엔진은 그 뒤에 켠다)
            if (msg.type === 'system' && msg.subtype === 'init') {
              out.gotInit = true;
              if (msg.session_id) await this.store.setSessionId(msg.session_id).catch(() => undefined);
              continue;
            }
            if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'compact_boundary') {
              out.compacted = true; // 대화가 요약됨 → 다음 차례에 지침을 새로 만들고 전체 안내
              continue;
            }
            if (msg.type === 'stream_event') {
              if (msg.parent_tool_use_id) continue;
              if (typeof msg.ttft_ms === 'number' && out.ttftMs === undefined) out.ttftMs = msg.ttft_ms;
              const ev = msg.event as unknown as { type?: string; content_block?: { type?: string; name?: string; id?: string }; delta?: { type?: string; text?: string } };
              if (ev?.type === 'content_block_start') {
                const b = ev.content_block;
                if (b?.type && TOOL_BLOCKS.has(b.type)) {
                  live.tool(b.name ?? '');
                  if (b.id) toolsShown.add(b.id);
                } else if (b?.type === 'text') live.newBlock();
              } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
                live.append(ev.delta.text);
                streamedText = true;
              }
              continue;
            }
            if (msg.type === 'assistant') {
              if (msg.parent_tool_use_id) continue;
              if (msg.error) {
                // 오류를 알리는 합성 메시지는 라노 답으로 저장하지 않는다
                out.errorKind = msg.error;
                continue;
              }
              const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
              let hadToolUse = false;
              const texts: string[] = [];
              const tools: { id?: string; name?: string }[] = [];
              for (const b of blocks) {
                if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text.trim());
                if (TOOL_BLOCKS.has(b.type)) {
                  const tb = b as unknown as { name?: string; input?: unknown };
                  for (const tid of todoIdsFromTool(tb.name ?? '', tb.input)) out.todoIds = [...new Set([...(out.todoIds ?? []), tid])];
                  if (/assign_to_mission$/.test(tb.name ?? '')) out.assigned = String((tb.input as { missionId?: unknown } | undefined)?.missionId ?? '');
                  hadToolUse = true;
                  tools.push(b as unknown as { id?: string; name?: string });
                }
              }
              if (texts.length) {
                const id = msg.message?.id ?? msg.uuid;
                const joined = texts.join('\n\n');
                const idx = textById.get(id);
                if (idx !== undefined && segments[idx] !== undefined) {
                  segments[idx] = `${segments[idx]}\n\n${joined}`;
                } else {
                  textById.set(id, segments.length);
                  segments.push(joined);
                }
                allSegments.push(joined);
                if (!streamedText) live.appendBlock(joined); // 조각이 안 왔으면 완성된 글로 보인다
              }
              streamedText = false;
              for (const t of tools) if (!t.id || !toolsShown.has(t.id)) live.tool(t.name ?? '');
              if (hadToolUse) {
                // 도구를 부르기 전 말("확인해 볼게요" 등)은 최종 답에서 뺀다 (화면에서는 회색 줄로 남아 있음)
                segments = [];
                textById.clear();
              }
              continue;
            }
            if (msg.type === 'result') {
              recordResult('rano', msg, !!resume);
              if (typeof msg.duration_ms === 'number') out.engineMs = msg.duration_ms;
              const rt = (msg as { ttft_ms?: number }).ttft_ms;
              if (out.ttftMs === undefined && typeof rt === 'number') out.ttftMs = rt;
              if (msg.subtype === 'success') {
                if (msg.is_error) out.errorText = msg.result || 'error';
                else if (!segments.length && msg.result?.trim()) segments = [msg.result.trim()];
              } else {
                out.errorText = [msg.subtype, ...(msg.errors ?? [])].join(' ');
              }
              // 답 확정은 여기서 바로 한다. 사용 한도 받기(엔진의 시험 기능)는 기다리지 않는다.
              // 엔진은 뒤에서 마저 끝나고, 다음 차례는 그 끝을 기다린다(settlePrevEngine)
              done();
              try {
                this.afterResult(engine);
              } catch {
                // 무시
              }
            }
          }
        } catch (err) {
          if (!settled) out.errorText = err instanceof Error ? err.message : String(err);
        } finally {
          done();
          ended(); // 엔진 반복이 끝남 → 다음 엔진을 켜도 된다
        }
      })();
    });
  }
}
