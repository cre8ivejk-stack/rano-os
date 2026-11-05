// 라노 세션: 사용자 말을 받아 Claude Agent SDK 로 라노 답을 만들고, 저장·화면 전송·기록을 맡는다.
import { query, type McpServerConfig, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { claudeBinaryPath } from './claudeBinary.js';
import {
  MEMORY_MCP_NAME,
  MISSION_MCP_NAME,
  TODO_MCP_NAME,
  ORG_MCP_NAME,
  type ChatAttachment,
  type ChatMessage,
  type ConversationStoreApi,
  type Emit,
  type MemoryServiceApi,
  type PermissionLogEntry,
  type RanoConfig,
  type RanoSessionApi,
  type RanoUiEvent,
} from '../../shared/types.js';
import { createPermissionGate } from './permissions.js';
import { buildRanoSystemPrompt } from './ranoPrompt.js';
import { zoneText } from '../admin/paths.js';
import { storedApiKey } from './auth.js';
import { imageBlocks } from './attachments.js';

export interface RanoSessionDeps {
  config: RanoConfig;
  memory: MemoryServiceApi;
  store: ConversationStoreApi;
  emit: Emit;
  memoryMcp: unknown;
  missionMcp?: unknown; // 2단계: 라노의 미션 도구 서버 (assign_to_mission, get_mission_status)
  todoMcp?: unknown; // 할 일 도구 서버 (todo_list, todo_add, todo_update, todo_remove)
  todoText?: () => string; // 프롬프트에 넣을 할 일 목록
  orgMcp?: unknown; // 조직 도구 서버 (org_overview, propose_mission, open_mission_proposal)
}

const MAX_TURNS = 20;

// 한 번의 query 실행 결과
interface AttemptResult {
  text: string; // 라노 답 (비어 있을 수 있음)
  errorText: string | null; // 오류 판단용 원문 (화면에 그대로 보여주지 않음)
  errorKind: string | null; // SDK 가 알려준 오류 종류
  gotInit: boolean;
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

/** SDK 에 넘길 환경변수. Max 모드면 API 키·토큰을 빼서 본인 로그인을 쓰게 한다. 라노와 리포 리더가 함께 쓴다. */
export function buildSdkEnv(config: RanoConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (config.authMethod === 'max') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  } else {
    // API 키 모드: 앱에 저장한 키(키체인 암호화)가 있으면 그것을 쓴다
    const key = storedApiKey(config);
    if (key) env.ANTHROPIC_API_KEY = key;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'rano-os/0.3.0';
  return env;
}

function firstLine(text: string, max: number): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export class RanoSession implements RanoSessionApi {
  private readonly config: RanoConfig;
  private readonly memory: MemoryServiceApi;
  private readonly store: ConversationStoreApi;
  private readonly uiEmit: Emit;
  private readonly memoryMcp: McpServerConfig;
  private readonly missionMcp: McpServerConfig | undefined;
  private readonly todoMcp: McpServerConfig | undefined;
  private readonly orgMcp: McpServerConfig | undefined;
  private readonly todoText: (() => string) | undefined;
  private readonly eventsLog: string;
  private readonly permissionsLog: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: RanoSessionDeps) {
    this.config = deps.config;
    this.memory = deps.memory;
    this.store = deps.store;
    this.uiEmit = deps.emit;
    this.memoryMcp = deps.memoryMcp as McpServerConfig;
    this.missionMcp = deps.missionMcp as McpServerConfig | undefined;
    this.todoMcp = deps.todoMcp as McpServerConfig | undefined;
    this.orgMcp = deps.orgMcp as McpServerConfig | undefined;
    this.todoText = deps.todoText;
    this.eventsLog = path.join(deps.config.runsDir, 'events.jsonl');
    this.permissionsLog = path.join(deps.config.runsDir, 'permissions.jsonl');
  }

  send(text: string, attachments: ChatAttachment[] = []): Promise<void> {
    return this.enqueue(() => this.handle(text, false, attachments));
  }

  // 앱이 라노에게 알린다(리포 리더 보고 등). 사용자 말풍선은 만들지 않고 대화 기록에도 사용자 말로 남기지 않는다.
  notify(text: string): Promise<void> {
    return this.enqueue(() => this.handle(text, true));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private emit(e: RanoUiEvent) {
    appendJsonl(this.eventsLog, e);
    try {
      this.uiEmit(e);
    } catch {
      // 창이 닫혀 있어도 계속 진행
    }
  }

  private emitError(text: string) {
    this.emit({ kind: 'error', text, at: new Date().toISOString() });
  }

  private async handle(text: string, fromApp: boolean, attachments: ChatAttachment[] = []): Promise<void> {
    if (fromApp) {
      this.emit({ kind: 'activity', text: `앱 알림이 도착했어요: ${firstLine(text.replace(/^\[앱 알림\]\s*/, ''), 60)}`, at: new Date().toISOString() });
    } else {
      const userMsg: ChatMessage = { id: randomUUID(), role: 'user', text, at: new Date().toISOString(), ...(attachments.length ? { attachments } : {}) };
      try {
        await this.store.append(userMsg);
      } catch {
        this.emitError('대화를 저장하지 못했어요. 이번 말은 화면에만 남을 수 있어요.');
      }
      this.emit({ kind: 'message', message: userMsg });
    }
    this.emit({ kind: 'status', status: 'thinking' });
    let prompt = fromApp ? `[앱 알림] ${text}` : text;
    if (attachments.length) {
      const marked = attachments.filter((a) => a.marked).length;
      prompt += `\n\n[앱 안내] 사용자가 그림 ${attachments.length}개를 붙였어요 (위 그림, 순서대로 id: ${attachments.map((a) => `${a.id}(${a.name}${a.marked ? ', 표시함' : ''})`).join(', ')}). 리더에게 일을 맡길 때 이 그림이 필요하면 assign_to_mission 의 attachments 에 id 를 넣으세요.`;
      if (marked)
        prompt += ' "표시함" 그림에는 사용자가 펜·네모·화살표·번호(①②③)로 고치고 싶은 곳을 직접 표시했어요. 표시한 곳이 무엇인지 그림에서 정확히 짚고, 번호가 있으면 사용자 글의 "1번 …" 설명과 짝지으세요. 리더에게 넘길 때도 표시의 뜻을 task 에 적으세요.';
    }

    try {
      const { sessionId } = await this.store.load();
      let result = await this.attempt(prompt, sessionId ?? undefined, attachments);

      // 이어가기에 실패하면(세션 기록이 없어졌을 때 등) 새 세션으로 한 번 다시 시도한다
      if (sessionId && result.errorText !== null && !result.text && (!result.gotInit || looksLikeMissingSession(result.errorText))) {
        result = await this.attempt(prompt, undefined, attachments);
      }

      if (result.text) {
        const ranoMsg: ChatMessage = { id: randomUUID(), role: 'rano', text: result.text, at: new Date().toISOString() };
        try {
          await this.store.append(ranoMsg);
        } catch {
          this.emitError('라노의 답을 저장하지 못했어요. 이번 답은 화면에만 남을 수 있어요.');
        }
        this.emit({ kind: 'message', message: ranoMsg });
      }
      if (result.errorText !== null) {
        this.emitError(friendlyError(result.errorText, result.errorKind));
      } else if (!result.text) {
        this.emitError('라노가 이번에는 답을 만들지 못했어요. 다시 한 번 말씀해 주세요.');
      }
    } catch (err) {
      this.emitError(friendlyError(err instanceof Error ? err.message : String(err), null));
    } finally {
      this.emit({ kind: 'status', status: 'idle' });
    }
  }

  private async attempt(prompt: string, resume: string | undefined, attachments: ChatAttachment[] = []): Promise<AttemptResult> {
    const memoryFiles = await this.memory.readAll();
    let todoText: string | undefined;
    try {
      todoText = this.todoText?.();
    } catch {
      todoText = undefined;
    }
    const systemPrompt = buildRanoSystemPrompt(memoryFiles, this.config.missions ?? [], todoText, zoneText(this.config));
    const logPermission = (line: PermissionLogEntry) => appendJsonl(this.permissionsLog, line);

    const options: Options = {
      model: this.config.models.rano,
      cwd: this.config.rootDir,
      systemPrompt,
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
      ...(claudeBinaryPath() ? { pathToClaudeCodeExecutable: claudeBinaryPath() } : {}),
      env: buildSdkEnv(this.config),
      ...(resume ? { resume } : {}),
    };

    const out: AttemptResult = { text: '', errorText: null, errorKind: null, gotInit: false };
    // 라노 답 조각: 도구 호출 뒤에 나온 글을 최종 답으로 본다
    let segments: string[] = [];
    let allSegments: string[] = [];
    const textById = new Map<string, number>(); // message.id → segments 위치

    try {
      // 그림이 있으면 그림 + 글을 한 메시지로 보낸다 (입력은 그 한 메시지로 끝)
      const images = attachments.length ? imageBlocks(this.config.runsDir, attachments) : [];
      const input: string | AsyncIterable<SDKUserMessage> = images.length
        ? (async function* () {
            yield { type: 'user', message: { role: 'user', content: [...images, { type: 'text', text: prompt }] }, parent_tool_use_id: null } as unknown as SDKUserMessage;
          })()
        : prompt;
      for await (const msg of query({ prompt: input, options }) as AsyncIterable<SDKMessage>) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          out.gotInit = true;
          if (msg.session_id) await this.store.setSessionId(msg.session_id).catch(() => undefined);
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
          for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text.trim());
            if (b.type === 'tool_use' || b.type === 'mcp_tool_use' || b.type === 'server_tool_use') hadToolUse = true;
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
          }
          if (hadToolUse) {
            // 도구를 부르기 전 말("확인해 볼게요" 등)은 최종 답에서 뺀다
            segments = [];
            textById.clear();
          }
          continue;
        }
        if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            if (msg.is_error) out.errorText = msg.result || 'error';
            else if (!segments.length && msg.result?.trim()) segments = [msg.result.trim()];
          } else {
            out.errorText = [msg.subtype, ...(msg.errors ?? [])].join(' ');
          }
        }
      }
    } catch (err) {
      out.errorText = err instanceof Error ? err.message : String(err);
    }

    const finalSegments = segments.length ? segments : allSegments;
    out.text = finalSegments.join('\n\n').trim();
    if (out.errorKind && out.errorText === null && !out.text) out.errorText = out.errorKind;
    return out;
  }
}
