// 미션 리포 리더 세션: 라노 배정이나 사용자 직접 지시를 받아 팀원(서브에이전트)과 일하고 보고한다.
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { claudeBinaryPath } from '../engine/claudeBinary.js';
import {
  LEADER_MCP_NAME,
  type ApprovalQueueApi,
  type ChatMessage,
  type ConversationStoreApi,
  type Emit,
  type MissionConfig,
  type MissionLeaderApi,
  type MissionTask,
  type MissionTrackerApi,
  type OutputsApi,
  type PermissionLogEntry,
  type RanoConfig,
  type RanoUiEvent,
  type ChatAttachment,
} from '../../shared/types.js';
import { appendJsonl, buildSdkEnv, friendlyError, looksLikeMissingSession } from '../engine/ranoSession.js';
import { LeaderGuard, SUBAGENT_TOOL } from './leaderPermissions.js';
import { createLeaderMcpServer } from './leaderTools.js';
import { buildLeaderSystemPrompt, readLeaderContext } from './leaderPrompt.js';
import { APPROVAL_STAGE_TOOLS, loadRoles, READ_ONLY_TOOLS } from './roles.js';
import { shareWithMission } from '../engine/attachments.js';
import { recordLimit, recordResult } from '../engine/usage.js';
import { roleSkills, skillCatalog } from '../skills/skills.js';

export interface MissionLeaderDeps {
  config: RanoConfig;
  mission: MissionConfig;
  tracker: MissionTrackerApi;
  store: ConversationStoreApi;
  emit: Emit;
  // 3단계
  approvals?: ApprovalQueueApi;
  outputs?: OutputsApi;
}

const MAX_TURNS = 60;
const MEMBER_ACTIVITY_GAP_MS = 30_000; // 같은 팀원의 같은 움직임은 30초에 한 번만 남긴다

interface AttemptResult {
  text: string;
  errorText: string | null;
  errorKind: string | null;
  gotInit: boolean;
}

// Agent tool_result 에서 글만 뽑는다
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

// 팀원 결과에 SDK 가 붙이는 앞뒤 안내(사용 도구, hand-back 안내, agentId, usage)를 걷어 내고 본문만 남긴다
export function cleanHandBack(text: string): string {
  let t = text.replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/g, '');
  const marker = t.indexOf('[Subagent hand-back]');
  if (marker >= 0) {
    const follows = t.indexOf('The report follows:', marker);
    t = follows >= 0 ? t.slice(t.indexOf('\n', follows) + 1) : t.slice(marker);
  }
  t = t.replace(/\n?agentId:\s*\S+\s*(<usage>[\s\S]*?<\/usage>)?\s*$/, '');
  t = t.replace(/<usage>[\s\S]*?<\/usage>\s*$/, '');
  const lines = t.split('\n');
  if (lines.filter((l) => l.trim()).every((l) => l.startsWith('  '))) t = lines.map((l) => l.slice(2)).join('\n');
  return t.trim();
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// 팀원 도구 사용을 쉬운 말로
function memberActionText(tool: string): string {
  switch (tool) {
    case 'Read':
      return '문서를 읽는 중';
    case 'Grep':
      return '내용을 찾아보는 중';
    case 'Glob':
      return '파일 목록을 살펴보는 중';
    default:
      return '작업하는 중';
  }
}

export class MissionLeader implements MissionLeaderApi {
  private readonly config: RanoConfig;
  private readonly mission: MissionConfig;
  private readonly tracker: MissionTrackerApi;
  private readonly store: ConversationStoreApi;
  private readonly uiEmit: Emit;
  private readonly eventsLog: string;
  private readonly permissionsLog: string;
  private readonly leaderLabel: string;
  private readonly approvals?: ApprovalQueueApi;
  private readonly outputs?: OutputsApi;
  private readonly guard: LeaderGuard;
  private currentTask: MissionTask | null = null;
  // 이번 과제에서 작업 담당·검수 담당이 마지막으로 끝난 순서 (최종본 재검수 확인용)
  private reviewSeq = { tick: 0, lastWork: 0, lastReview: 0 };
  private abort: AbortController | null = null;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0; // 진행 중 + 대기 중인 과제 수

  constructor(deps: MissionLeaderDeps) {
    this.config = deps.config;
    this.mission = deps.mission;
    this.tracker = deps.tracker;
    this.store = deps.store;
    this.uiEmit = deps.emit;
    this.eventsLog = path.join(deps.config.runsDir, 'events.jsonl');
    this.permissionsLog = path.join(deps.config.runsDir, 'permissions.jsonl');
    this.leaderLabel = `${deps.mission.name} 리더`;
    this.approvals = deps.approvals;
    this.outputs = deps.outputs;
    this.guard = new LeaderGuard({
      config: deps.config,
      mission: deps.mission,
      log: (line: PermissionLogEntry) => appendJsonl(this.permissionsLog, line),
      tracker: deps.tracker,
      approvals: deps.approvals,
      emitActivity: (text) => this.emitActivity(text),
    });
  }

  /** 앱이 꺼질 때 부른다: 진행 중인 과제와 승인 대기를 멈춘다. */
  close() {
    this.closed = true;
    this.abort?.abort();
  }

  private emitActivity(text: string) {
    this.emit({ kind: 'activity', text, at: new Date().toISOString(), missionId: this.mission.id });
  }

  busy(): boolean {
    return this.pending > 0;
  }

  run(task: { text: string; from: 'rano' | 'user'; onStart?: () => void; planFirst?: boolean; attachments?: ChatAttachment[] }): Promise<{ ok: boolean; report: string }> {
    this.pending++;
    const work = () => this.handle(task);
    const next = this.queue.then(work, work).finally(() => {
      this.pending--;
    });
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

  private async saveMessage(role: ChatMessage['role'], text: string, attachments?: ChatAttachment[]) {
    const message: ChatMessage = { id: randomUUID(), role, text, at: new Date().toISOString(), ...(attachments?.length ? { attachments } : {}) };
    try {
      await this.store.append(message);
    } catch {
      // 저장에 실패해도 화면에는 보여준다
    }
    this.emit({ kind: 'leaderMessage', missionId: this.mission.id, message });
  }

  private safe(fn: () => void) {
    try {
      fn();
    } catch {
      // 현황판 갱신 실패가 과제를 막지 않게 한다
    }
  }

  private async handle(task: { text: string; from: 'rano' | 'user'; onStart?: () => void; planFirst?: boolean; attachments?: ChatAttachment[] }): Promise<{ ok: boolean; report: string }> {
    // 앱이 꺼지는 중이면 줄 서 있던 과제는 시작하지 않는다 (대화·현황판에 흔적을 남기지 않고, 다음 실행 때 이어 간다)
    if (this.closed) return { ok: false, report: '앱이 종료되는 중이라 시작하지 않았어요' };
    this.safe(() => task.onStart?.());
    await this.saveMessage(task.from === 'rano' ? 'rano' : 'user', task.text, task.attachments);
    let started: MissionTask | null = null;
    this.safe(() => {
      started = this.tracker.taskStart({ title: clip(task.text, 60), from: task.from });
    });
    const mt: MissionTask = started ?? {
      id: randomUUID(),
      title: clip(task.text, 60),
      from: task.from,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.currentTask = mt;
    this.reviewSeq = { tick: 0, lastWork: 0, lastReview: 0 };
    this.guard.setTask({ id: mt.id, title: mt.title, planFirst: !!task.planFirst });
    // 이 과제의 시안 폴더: 작업 리포 밖이라 승인 없이 쓸 수 있다
    const drafts = this.guard.draftsDir(mt.id);
    if (drafts) await mkdir(drafts, { recursive: true }).catch(() => undefined);
    const appNote = [
      '',
      '---',
      '[앱 안내]',
      `- 이 과제의 시안 폴더: ${drafts} (작업 리포 밖, 승인 없이 쓸 수 있음). 안마다 비교용 시안(HTML 와이어프레임 등)이 필요하면 여기에 만들고, 결정 카드의 options[].preview 에 파일 이름을 넣으세요.`,
      task.planFirst
        ? '- 이 과제는 "기획 먼저"예요. 안 2~3개와 권장안을 request_approval(kind: decision, planGate: true, items …)로 올려 사용자가 고르기 전에는 작업 폴더를 고칠 수 없어요(앱이 막음). 고른 뒤 그 안대로 구현하세요.'
        : '- 기획 후 구현이 필요한 과제(화면·기능 개편 등)라고 판단되면, 구현 전에 request_approval(kind: decision, planGate: true)로 안을 먼저 고르게 하세요.',
    ].join('\n');
    // 사용자가 직접 붙인 그림: 이 미션 시안 폴더로 복사해 경로를 알려 준다(이 미션 리더·팀원만 읽기 가능)
    let pics = '';
    if (task.attachments?.length) {
      const shared = shareWithMission(this.config.runsDir, this.mission.id, task.attachments.map((a) => a.id));
      if (shared.paths.length)
        pics = `\n\n[첨부 그림] 사용자가 붙인 그림이에요. Read 도구로 열어 보세요(팀원에게도 이 경로를 넘기세요).${task.attachments.some((a) => a.marked) ? ' 그림 위의 펜·네모·화살표·번호는 사용자가 고치고 싶은 곳을 직접 표시한 거예요. 번호는 지시 글의 "1번 …"과 짝지으세요.' : ''}\n${shared.paths.map((p) => `- ${p}`).join('\n')}`;
    }
    const prompt = `${task.text}${pics}${appNote}`;
    if (this.outputs) await this.outputs.taskStarted(this.mission, mt).catch(() => undefined);

    let ok = false;
    let report = '';
    try {
      const { sessionId } = await this.store.load();
      let result = await this.attempt(prompt, sessionId ?? undefined);
      if (sessionId && result.errorText !== null && !result.text && (!result.gotInit || looksLikeMissingSession(result.errorText))) {
        result = await this.attempt(prompt, undefined);
      }
      if (result.errorText === null && result.text) {
        ok = true;
        report = result.text;
        const seq = this.reviewSeq;
        const note =
          seq.lastWork === 0
            ? ''
            : seq.lastReview === 0
              ? '검수 역할이 결과를 확인하지 않았어요'
              : seq.lastWork > seq.lastReview
                ? '마지막 수정 뒤에 검수를 다시 받지 않았어요'
                : '';
        if (note) {
          report += `\n\n(앱 확인: ${note}. 이 결과는 최종 검수 전 상태예요)`;
          this.safe(() => this.tracker.activity('앱', `확인 필요: ${note}`));
        }
      } else {
        const friendly =
          result.errorText !== null
            ? friendlyError(result.errorText, result.errorKind, this.leaderLabel)
            : `${this.leaderLabel}가 이번에는 보고를 만들지 못했어요. 다시 한 번 맡겨 주세요.`;
        report = result.text ? `${result.text}\n\n(중간에 멈췄어요: ${friendly})` : friendly;
      }
    } catch (err) {
      report = friendlyError(err instanceof Error ? err.message : String(err), null, this.leaderLabel);
    }
    // 중단 사유는 아래 리더 답(보고)으로 한 번만 보여 준다. 따로 오류 줄을 띄우면 같은 문구가 두 번 보인다.

    await this.saveMessage('leader', report);
    this.safe(() => this.tracker.taskEnd({ ok, report }));
    if (this.outputs) {
      const ended: MissionTask = { ...mt, status: ok ? 'done' : 'failed', endedAt: new Date().toISOString(), report };
      await this.outputs.taskEnded(this.mission, ended, report).catch(() => undefined);
    }
    this.currentTask = null;
    this.guard.setTask(null);
    return { ok, report };
  }

  private async attempt(prompt: string, resume: string | undefined): Promise<AttemptResult> {
    const { config, mission, tracker } = this;
    const roles = loadRoles(config, mission);
    const ctx = await readLeaderContext(
      mission,
      Object.entries(roles).map(([name, def]) => {
        const sk = mission.stagePolicy === 'approval' ? roleSkills()[name] ?? [] : [];
        return { name, description: `${def.description}${sk.length ? ` (스킬: ${sk.join(', ')} — 엑셀·워드·PPT·PDF 같은 파일 결과물은 이 역할에게)` : ''}` };
      }),
      config.memoryDir,
    );
    const systemPrompt = buildLeaderSystemPrompt(ctx) + (mission.stagePolicy === 'approval' ? skillCatalog([], true) : '');

    // 팀원도 같은 규칙을 따르도록 역할 프롬프트 끝에 규칙 파일을 붙인다(설정 파일은 불러오지 않으므로)
    const rulesBlock = ctx.rules.map((r) => `### ${r.file}\n${r.content.trim()}`).join('\n\n');
    for (const def of Object.values(roles)) {
      def.prompt = `${def.prompt}\n\n## 따라야 할 규칙 파일 (원문)\n${rulesBlock}`;
    }

    const approvalStage = mission.stagePolicy === 'approval';
    if (this.closed) return { text: '', errorText: '앱이 종료되는 중', errorKind: null, gotInit: false };
    const abort = new AbortController();
    this.abort = abort;
    const guard = this.guard;
    const leaderMcp = approvalStage
      ? createLeaderMcpServer({
          mission,
          approvals: this.approvals,
          tracker,
          guard,
          signal: abort.signal,
          emitActivity: (t) => this.emitActivity(t),
        })
      : null;
    const env = buildSdkEnv(config);
    delete env.MCP_TOOL_TIMEOUT; // 승인 대기(request_approval)가 도구 시간 제한에 걸리지 않게

    const options: Options = {
      model: config.models.repoLeader,
      cwd: mission.targets[0] ?? mission.home,
      additionalDirectories: [...mission.readonlyRefs, mission.home],
      systemPrompt,
      // 2단계(readOnly): 읽기 + 팀원 호출. 3단계(approval): 쓰기·명령도 열되 모두 문지기(훅·canUseTool)를 거친다
      tools: approvalStage ? [...APPROVAL_STAGE_TOOLS, SUBAGENT_TOOL] : [...READ_ONLY_TOOLS, SUBAGENT_TOOL],
      agents: roles,
      mcpServers: leaderMcp ? { [LEADER_MCP_NAME]: leaderMcp } : {},
      abortController: abort,
      strictMcpConfig: true,
      settingSources: [], // 작업 리포의 .claude 설정·hooks·CLAUDE.md 를 불러오지 않는다(규칙은 프롬프트에 직접 넣음)
      permissionMode: 'default',
      canUseTool: guard.canUseTool,
      hooks: guard.hooks(),
      maxTurns: MAX_TURNS,
      executable: 'node',
      ...(claudeBinaryPath() ? { pathToClaudeCodeExecutable: claudeBinaryPath() } : {}),
      env,
      ...(resume ? { resume } : {}),
    };

    const out: AttemptResult = { text: '', errorText: null, errorKind: null, gotInit: false };
    let segments: string[] = [];
    const allSegments: string[] = [];
    const memberCalls = new Map<string, string>(); // Agent tool_use_id → 역할
    const reviewerRoles = new Set(mission.reviewerRoles);
    const lastMemberActivity = new Map<string, { text: string; at: number }>();

    // 팀원 호출 id → 역할. 끝남 알림(task_notification)이 결과(tool_result)보다 먼저 올 수 있어서
    // 끝났다고 지우지 않고 '끝남' 표시만 따로 한다. 그래야 뒤에 온 검수 결과도 누구 것인지 알 수 있다.
    const memberRoles = new Map<string, string>();
    const endedMembers = new Set<string>();
    const endMember = (toolUseId: string, okFlag: boolean) => {
      const role = memberRoles.get(toolUseId);
      if (!role || endedMembers.has(toolUseId)) return;
      endedMembers.add(toolUseId);
      memberCalls.delete(toolUseId);
      if (okFlag) {
        const seq = this.reviewSeq;
        seq.tick += 1;
        if (reviewerRoles.has(role)) seq.lastReview = seq.tick;
        else seq.lastWork = seq.tick;
      }
      this.safe(() => tracker.memberEnd(role, okFlag));
    };

    try {
      for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
        if (msg.type === 'system') {
          if (msg.subtype === 'init') {
            out.gotInit = true;
            if (msg.session_id) await this.store.setSessionId(msg.session_id).catch(() => undefined);
          } else if (msg.subtype === 'task_notification' && msg.tool_use_id) {
            // 팀원이 백그라운드로 돌았을 때를 위한 예비 처리
            endMember(msg.tool_use_id, msg.status === 'completed');
          }
          continue;
        }

        if (msg.type === 'assistant') {
          const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];

          // 팀원(서브에이전트)의 움직임
          if (msg.parent_tool_use_id) {
            const role = memberRoles.get(msg.parent_tool_use_id) ?? msg.subagent_type ?? '팀원';
            if (msg.agent_id && role !== '팀원') guard.agents.set(msg.agent_id, role);
            const said = blocks
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => (b as { text: string }).text)
              .join('\n');
            if (said.trim()) guard.noteText(msg.agent_id ?? `role:${role}`, said, role);
            for (const b of blocks) {
              if (b.type !== 'tool_use') continue;
              const text = memberActionText(b.name);
              const last = lastMemberActivity.get(role);
              const now = Date.now();
              if (!last || last.text !== text || now - last.at > MEMBER_ACTIVITY_GAP_MS) {
                lastMemberActivity.set(role, { text, at: now });
                this.safe(() => tracker.activity(role, text));
              }
            }
            continue;
          }

          // 리포 리더 본인
          if (msg.error) {
            out.errorKind = msg.error;
            continue;
          }
          const texts: string[] = [];
          let hadToolUse = false;
          for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text.trim());
            if (b.type === 'tool_use') {
              hadToolUse = true;
              if (b.name === SUBAGENT_TOOL) {
                const input = (b.input ?? {}) as Record<string, unknown>;
                const role = typeof input.subagent_type === 'string' ? input.subagent_type : '팀원';
                const rawDesc = typeof input.description === 'string' ? input.description.trim() : '';
                // 현황판에 보일 작업 제목: 한국어가 아니면(예: "Review renewal doc updates") 지시문의 첫 한국어 줄로 대신한다
                const promptLine =
                  typeof input.prompt === 'string'
                    ? (input.prompt.split('\n').map((l) => l.replace(/^[#>*\-\s\d.]+/, '').trim()).find((l) => /[가-힣]/.test(l)) ?? '')
                    : '';
                const desc = /[가-힣]/.test(rawDesc) ? rawDesc : promptLine || rawDesc || '맡은 일';
                memberCalls.set(b.id, role);
                memberRoles.set(b.id, role);
                guard.noteMemberTask(role, desc);
                this.safe(() => tracker.memberStart(role, clip(desc, 60)));
              }
            }
          }
          if (texts.length) {
            const joined = texts.join('\n\n');
            guard.noteText('leader', joined);
            segments.push(joined);
            allSegments.push(joined);
          }
          if (hadToolUse) {
            // 도구 전에 한 말은 진행 중 한 줄로 남기고 최종 보고에서는 뺀다
            if (texts.length) {
              const line = clip(texts.join(' '), 80);
              this.safe(() => tracker.activity(this.leaderLabel, line));
            }
            segments = [];
          }
          continue;
        }

        if (msg.type === 'user' && !msg.parent_tool_use_id) {
          // 리더가 부른 팀원 일이 끝나면 tool_result 가 돌아온다 (tool_use_id 로 짝을 맞춘다)
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b && typeof b === 'object' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
                const role = memberRoles.get(b.tool_use_id);
                if (role && reviewerRoles.has(role) && !b.is_error && this.outputs && this.currentTask) {
                  const reviewText = cleanHandBack(toolResultText(b.content));
                  const taskId = this.currentTask.id;
                  if (reviewText) this.safe(() => this.outputs!.reviewReport(mission.id, taskId, role, reviewText));
                }
                endMember(b.tool_use_id, !b.is_error);
              }
            }
          }
          continue;
        }

        if ((msg as { type: string }).type === 'rate_limit_event') {
          recordLimit((msg as { rate_limit_info?: unknown }).rate_limit_info);
          continue;
        }
        if (msg.type === 'result') {
          recordResult(this.mission.id, msg, !!resume);
          if (msg.subtype === 'success') {
            if (msg.is_error) out.errorText = msg.result || 'error';
            else if (!segments.length && msg.result?.trim()) segments = [msg.result.trim()];
          } else {
            out.errorText = [msg.subtype, ...(msg.errors ?? [])].join(' ');
          }
        }
      }
    } catch (err) {
      out.errorText = abort.signal.aborted ? '앱이 종료되어 작업을 멈췄어요' : err instanceof Error ? err.message : String(err);
    } finally {
      if (this.abort === abort) this.abort = null;
    }

    // 짝이 맞지 않고 남은 팀원은 결과에 따라 정리한다
    for (const id of [...memberCalls.keys()]) endMember(id, out.errorText === null);

    out.text = (segments.length ? segments : allSegments).join('\n\n').trim();
    if (out.errorKind && out.errorText === null && !out.text) out.errorText = out.errorKind;
    return out;
  }
}
