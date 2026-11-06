// 리포 리더와 팀원(서브에이전트)의 도구 사용을 검사하는 문지기.
//
// 역할 분담 (sdk.d.ts 확인 결과):
// - PreToolUse 훅: 모든 도구 호출(서브에이전트 포함, 자동 허용되는 읽기 도구 포함)이 지난다. 시간 제한이 있으므로
//   여기서는 바로 판단만 한다 → allow / deny / ask. 승인이 필요한 일은 'ask' 로 넘겨 canUseTool 로 보낸다.
// - canUseTool: 시간 제한 없이 기다릴 수 있고 options.signal 이 온다. 승인함(approvals.request)을 await 해서
//   요청한 에이전트를 멈춰 두고, 사용자의 결정대로 allow / deny 한다.
// - PostToolUse 훅: Grep/Glob 결과에 차단 목록(.env 등) 경로가 섞이면 그 줄을 지운다(updatedToolOutput).
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  PermissionResult,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  LEADER_MCP_NAME,
  type ApprovalKind,
  type ApprovalQueueApi,
  type FileChange,
  type MissionConfig,
  type MissionTrackerApi,
  type PermissionLogEntry,
  type RanoConfig,
} from '../../shared/types.js';
import { isBlockedPath } from '../engine/permissions.js';
import { classifyBash } from './bashRules.js';
import { isConnectorReadTool } from '../connectors/readTools.js';

export const SUBAGENT_TOOL = 'Agent'; // sdk.d.ts BUILTIN_TOOL_NAMES 기준 서브에이전트 호출 도구 이름
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const LEADER_TOOL_PREFIX = `mcp__${LEADER_MCP_NAME}__`;

/** Grep 에 glob 이 없을 때 강제로 넣는 제외 패턴(.env, .env.local 등 이름이 .env 로 시작하는 파일) */
export const GREP_EXCLUDE_GLOB = '!.env*';
/** 검색 조건이 비밀 파일을 겨누는지 (.env 계열, 키 파일, 인증 폴더) */
const SECRET_AIM = /(^|[\/{,*])\.env|id_rsa|id_ed25519|\.ssh|\.aws|credentials/i;

const MSG_READ_ONLY = '이 미션은 읽기 전용이라 쓰기·실행을 할 수 없어요. 필요한 변경은 보고에 "승인이 필요한 일"로 적어 주세요.';
const MSG_BLOCKED = '이 위치는 비밀 정보가 있거나 다른 구역(회사·개인) 폴더라서 열 수 없어요. 우회하지 말고 필요하면 보고에 적어 주세요.';
const MSG_OUTSIDE = '이 미션의 작업 폴더와 참고 폴더 밖이라 열 수 없어요.';
const MSG_ROLE = '이 미션 팀에 없는 역할이라 부를 수 없어요. 팀 편성에 있는 역할만 불러 주세요.';
const MSG_TEAM = '먼저 request_approval 도구로 팀 구성안(누구에게 무엇을 맡길지)을 올려 승인받으세요.';
const MSG_PLAN = '이 과제는 기획 먼저예요. 안 2~3개와 권장안을 request_approval(kind: decision, planGate: true)로 올려 사용자가 고른 뒤에 작업 폴더를 고칠 수 있어요. 시안은 시안 폴더에 만들어 주세요.';
const MSG_REFS = '참고 폴더는 읽기만 할 수 있어요. 바꿀 내용은 보고에 적어 주세요.';
const MSG_UNKNOWN = '이 도구는 이 미션에서 쓸 수 없어요.';

export interface LeaderDecision {
  allow: boolean;
  reason: string; // 기록용
  message?: string; // 거절할 때 모델에게 주는 쉬운 문구
  updatedInput?: Record<string, unknown>;
}

/** agentID → 역할 이름. 훅에서 채우고 canUseTool 에서 기록용 이름을 찾는 데 쓴다. */
export type AgentRegistry = Map<string, string>;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

export function within(target: string, root: string): boolean {
  if (target === root) return true;
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(base);
}

// 실제 경로(심볼릭 링크 풀기). 없는 파일이면 있는 부모까지 풀고 나머지를 붙인다.
function real(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

function absPath(raw: string, cwd: string): string {
  return path.resolve(cwd, expandHome(raw));
}

function allowedRoots(mission: MissionConfig): string[] {
  return [...mission.targets, ...mission.readonlyRefs, mission.home, mission.rolesDir, ...(mission.roleDirs ?? []), ...mission.rulesFiles]
    .filter(Boolean)
    .map((r) => path.resolve(expandHome(r)));
}

function inAny(p: string, roots: string[]): boolean {
  return roots.some((r) => within(p, r) || within(p, real(r)));
}

// glob 패턴에서 글롭 문자가 나오기 전까지의 고정된 앞부분
function staticPrefix(pattern: string): string {
  const parts = pattern.split('/');
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?[\]{}]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join('/') || (pattern.startsWith('/') ? '/' : '.');
}

/** 차단 목록 검사(원래 경로와 링크를 푼 경로 모두). 걸린 경로를 돌려준다. */
function blockedHit(config: RanoConfig, abs: string): string | null {
  for (const c of new Set([abs, real(abs)])) if (isBlockedPath(config, c)) return c;
  return null;
}

/** 미션 구역의 denyRead(다른 구역 폴더)를 차단 목록에 더한 설정 */
export function withZoneBlocks(config: RanoConfig, mission: MissionConfig): RanoConfig {
  const deny = config.zones?.[mission.zone]?.denyRead ?? [];
  return deny.length ? { ...config, blocked: [...config.blocked, ...deny] } : config;
}

/** 차단된 위치를 쉬운 말로 */
export function sensitiveLabel(p: string): string {
  if (/(^|\/)\.env(\.|$)|\.env\b/.test(p)) return '비밀 설정 파일';
  if (/(^|\/)\.(ssh|aws)(\/|$)|Keychains/.test(p)) return '비밀 키 폴더';
  if (/credentials|\.config\/(gh|gcloud)/.test(p)) return '인증 정보 파일';
  if (/Library\/(Safari|Messages|Mail|Containers|Application Support)/.test(p)) return '브라우저·메신저·메일 데이터';
  return '민감한 위치';
}

/** 경로 하나를 읽기 기준으로 검사한다. 통과하면 null. */
function checkReadPath(config: RanoConfig, mission: MissionConfig, raw: string, cwd: string): (LeaderDecision & { blocked?: string }) | null {
  const resolved = absPath(raw, cwd);
  const hit = blockedHit(config, resolved);
  if (hit) return { allow: false, reason: `차단 목록에 걸림: ${hit}`, message: MSG_BLOCKED, blocked: hit };
  const roots = [...allowedRoots(mission), path.join(config.runsDir, 'drafts', mission.id), path.join(config.rootDir, 'skills')]; // 시안 폴더·스킬 보관함도 읽기 허용
  for (const c of new Set([resolved, real(resolved)])) {
    if (!inAny(c, roots)) return { allow: false, reason: `작업 폴더 밖: ${c}`, message: MSG_OUTSIDE };
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function readToolPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] | null {
  if (toolName === 'Read') {
    const fp = str(input.file_path);
    return fp ? [fp] : null;
  }
  const base = str(input.path) ?? cwd; // 비어 있으면 작업 폴더로 본다
  const paths = [base];
  if (toolName === 'Glob') {
    const pattern = str(input.pattern);
    if (pattern) paths.push(path.resolve(absPath(base, cwd), expandHome(staticPrefix(pattern))));
  }
  return paths;
}

function agentCallInput(input: Record<string, unknown>, role: string): Record<string, unknown> {
  // 위험한 선택지(권한 모드·격리·모델 바꾸기·백그라운드)는 지우고 필요한 값만 남긴다.
  // 백그라운드를 끄면 팀원이 끝날 때 도구 결과가 돌아와서 진행 상황을 짝지어 추적할 수 있다.
  return {
    description: str(input.description) ?? role,
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    subagent_type: role,
    run_in_background: false,
  };
}

/** 2단계(readOnly) 판단. 리더·팀원 공통. */
export function decideLeaderTool(
  config: RanoConfig,
  mission: MissionConfig,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string = mission.targets[0] ?? mission.home,
  isSubagent = false,
): LeaderDecision & { blocked?: string } {
  if (READ_TOOLS.has(toolName)) {
    const paths = readToolPaths(toolName, input, cwd);
    if (!paths) return { allow: false, reason: 'Read 경로 없음', message: '읽을 파일 위치가 비어 있어요.' };
    for (const p of paths) {
      const bad = checkReadPath(config, mission, p, cwd);
      if (bad) return bad;
    }
    // 검색 조건 자체가 비밀 파일을 겨누면(.env*, id_rsa 등) 결과를 거르기 전에 막는다. '!' 로 시작하는 제외 조건은 괜찮다.
    const aim = toolName === 'Grep' ? str(input.glob) : toolName === 'Glob' ? str(input.pattern) : '';
    if (aim && !aim.trim().startsWith('!') && SECRET_AIM.test(aim)) {
      return { allow: false, reason: `검색 조건이 비밀 파일을 겨눔: ${aim}`, message: MSG_BLOCKED, blocked: aim };
    }
    if (toolName === 'Grep' && !str(input.glob)) {
      return { allow: true, reason: 'Grep 허용 (작업·참고 폴더 안, .env 제외 패턴 추가)', updatedInput: { ...input, glob: GREP_EXCLUDE_GLOB } };
    }
    return { allow: true, reason: `${toolName} 허용 (작업·참고 폴더 안)` };
  }

  if (toolName === SUBAGENT_TOOL) {
    if (isSubagent) return { allow: false, reason: '팀원이 다른 팀원을 부르려 함', message: '팀원 호출은 리포 리더만 할 수 있어요.' };
    const role = str(input.subagent_type);
    if (!role || !mission.roles.includes(role)) {
      return { allow: false, reason: `팀에 없는 역할: ${role ?? '(지정 안 함)'}`, message: MSG_ROLE };
    }
    return { allow: true, reason: `팀원 호출 허용: ${role}`, updatedInput: agentCallInput(input, role) };
  }

  return { allow: false, reason: `읽기 전용 단계라 ${toolName} 거절`, message: MSG_READ_ONLY };
}

// ------------------------------------------------------------------
// 3단계(approval) 판단
// ------------------------------------------------------------------

export interface ApprovalAsk {
  kind: ApprovalKind;
  title: string;
  what: string;
  detail?: string;
  filePath?: string;
  change?: FileChange;
}

export interface StageDecision {
  type: 'allow' | 'deny' | 'ask';
  reason: string;
  message?: string;
  updatedInput?: Record<string, unknown>;
  blocked?: string; // 차단 목록에 걸린 경로(기록용)
  ask?: ApprovalAsk;
}

const SECRET_LINE = /(secret|token|passw(or)?d|api[_-]?key|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY|authorization|bearer\s|aws_access|client_secret)/i;
const LONG_RANDOM = /[A-Za-z0-9+/_\-]{32,}/;

const CHANGE_MAX_CHARS = 200_000; // 승인함에 담을 전·후 내용 한도(각각)

function maskSecrets(text: string): string {
  return text
    .split('\n')
    .map((l) => (SECRET_LINE.test(l) || LONG_RANDOM.test(l) ? '(비밀로 보여 가림)' : l))
    .join('\n');
}

/** Write·Edit 가 파일을 어떻게 바꾸는지 전·후 내용을 만든다. 알 수 없으면 undefined */
export function fileChangeFor(toolName: string, input: Record<string, unknown>, abs: string): FileChange | undefined {
  if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
  let before = '';
  const exists = existsSync(abs);
  try {
    if (exists) {
      if (statSync(abs).size > CHANGE_MAX_CHARS * 2) return undefined;
      before = readFileSync(abs, 'utf-8');
    }
  } catch {
    return undefined;
  }
  if (before.includes('\u0000')) return undefined; // 글이 아닌 파일
  let after: string;
  if (toolName === 'Write') after = String(input.content ?? '');
  else {
    const oldS = String(input.old_string ?? '');
    const newS = String(input.new_string ?? '');
    if (!oldS || !before.includes(oldS)) return undefined;
    after = input.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
  }
  const truncated = before.length > CHANGE_MAX_CHARS || after.length > CHANGE_MAX_CHARS;
  return {
    before: maskSecrets(before.slice(0, CHANGE_MAX_CHARS)),
    after: maskSecrets(after.slice(0, CHANGE_MAX_CHARS)),
    isNew: !exists,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** 미리보기용: 비밀로 보이는 줄은 가리고 앞부분만 남긴다. */
export function redactPreview(text: string, maxLines = 30, maxChars = 1500): string {
  const lines = String(text ?? '').split('\n').slice(0, maxLines);
  const masked = lines.map((l) => (SECRET_LINE.test(l) || LONG_RANDOM.test(l) ? '(비밀로 보여 가림)' : l));
  let out = masked.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  const total = String(text ?? '').split('\n').length;
  if (total > maxLines) out += `\n… (모두 ${total}줄 중 앞 ${maxLines}줄)`;
  return out;
}

export function redactCommand(cmd: string): string {
  return cmd
    .replace(/((?:secret|token|passw(?:or)?d|api[_-]?key|auth)[A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1(가림)')
    .replace(/(^|\s)(--password[= ]|-p(?=[^\s-]))\S+/g, '$1$2(가림)') // mysql -pXXXX, --password=XXXX 만 가린다 (--porcelain 같은 옵션은 그대로)
    .replace(LONG_RANDOM, '(가림)');
}

function displayPath(abs: string): string {
  const home = homedir();
  return abs.startsWith(home + path.sep) ? `~${abs.slice(home.length)}` : abs;
}

function relToTarget(mission: MissionConfig, abs: string): string {
  const root = mission.targets.find((t) => within(abs, t));
  return root ? path.relative(root, abs) || path.basename(abs) : displayPath(abs);
}

const BASH_TITLES: Record<string, (m: MissionConfig) => string> = {
  commit: (m) => `${m.name} 리포에 변경 내용 기록(커밋)`,
  delete: () => '파일·폴더 지우기',
  db: () => '데이터베이스 바꾸기',
  deploy: () => '배포·운영 설정 바꾸기',
  write: (m) => `${m.name} 리포 파일을 명령으로 바꾸기`,
  outsideWrite: () => '작업 폴더 밖 파일을 명령으로 바꾸기',
  command: () => '명령 실행',
};

const BASH_WHAT: Record<string, (m: MissionConfig) => string> = {
  commit: (m) => `${m.name} 리포에 지금까지 바뀐 내용을 기록(커밋)하거나 올리거나 되돌리려고 해요`,
  delete: () => '파일이나 폴더를 지우려고 해요',
  db: () => '데이터베이스에 연결해 내용을 바꾸거나 구조를 바꾸려고 해요',
  deploy: () => '배포하거나 운영 설정을 바꾸려고 해요',
  write: (m) => `${m.name} 리포의 파일을 명령으로 바꾸려고 해요`,
  outsideWrite: () => '작업 폴더 밖의 파일을 명령으로 바꾸려고 해요',
  command: () => '작업에 필요한 명령을 실행하려고 해요',
};

/**
 * 외부 연결(MCP) 도구 판단. 연결 도구가 아니면 null.
 * - 이 미션에 켜진 연결만 쓴다. 읽기(검색·조회)는 바로, 그 밖은 승인함(external)
 */
export function decideConnectorTool(
  config: RanoConfig,
  mission: MissionConfig,
  toolName: string,
  input: Record<string, unknown>,
  mcpServer?: { name: string; source: string },
): StageDecision | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  if (!m || m[1] === LEADER_MCP_NAME) return null;
  const [, server, tool] = m;
  const conn = config.connectors?.[server];
  if (!conn || !(mission.connectors ?? []).includes(server)) {
    return { type: 'deny', reason: `이 미션에 켜지지 않은 외부 연결: ${server}`, message: `이 미션은 '${server}' 연결을 쓸 수 없어요. 필요하면 보고에 적어 주세요(사용자가 조직 탭에서 켤 수 있어요).` };
  }
  if (mcpServer && mcpServer.name !== server) return { type: 'deny', reason: '도구 서버 이름이 맞지 않음', message: MSG_UNKNOWN };
  if (isConnectorReadTool(tool)) return { type: 'allow', reason: `${conn.label} 읽기: ${tool}` };
  let shown = '';
  try {
    shown = JSON.stringify(input, null, 2);
  } catch {
    shown = String(input);
  }
  return {
    type: 'ask',
    reason: `${conn.label} 쓰기 승인 필요: ${tool}`,
    ask: {
      kind: 'external',
      title: `${conn.label}에 쓰기: ${tool.replace(/_/g, ' ')}`,
      what: `${conn.label}에서 '${tool}' 작업을 하려고 해요 (다른 사람도 보는 곳이 바뀔 수 있어요)`,
      detail: `연결: ${conn.label} (${server})\n작업: ${tool}\n\n보낼 내용(앞부분):\n${redactPreview(shown, 40, 3000)}`,
    },
  };
}

/** 3단계 판단. 승인함을 기다리는 일은 하지 않는다(type 'ask' 로 돌려줌). */
export function decideApprovalStage(
  config: RanoConfig,
  mission: MissionConfig,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  actor: { isSubagent: boolean; teamApproved: boolean; draftsDir?: string; planBlocked?: boolean },
  mcpServer?: { name: string; source: string },
): StageDecision {
  // 읽기·검색: 2단계와 같음
  if (READ_TOOLS.has(toolName)) {
    const d = decideLeaderTool(config, mission, toolName, input, cwd, actor.isSubagent);
    return { type: d.allow ? 'allow' : 'deny', reason: d.reason, message: d.message, updatedInput: d.updatedInput, blocked: d.blocked };
  }

  // 팀원 호출: 팀 구성안 승인 뒤에만
  if (toolName === SUBAGENT_TOOL) {
    const d = decideLeaderTool(config, mission, toolName, input, cwd, actor.isSubagent);
    if (!d.allow) return { type: 'deny', reason: d.reason, message: d.message };
    if (!actor.teamApproved) return { type: 'deny', reason: '팀 구성안 승인 전 팀원 호출', message: MSG_TEAM };
    return { type: 'allow', reason: d.reason, updatedInput: d.updatedInput };
  }

  // 리더 전용 도구(request_approval)
  if (toolName.startsWith(LEADER_TOOL_PREFIX)) {
    if (actor.isSubagent) return { type: 'deny', reason: '팀원이 리더 도구를 쓰려 함', message: '승인 요청은 리포 리더가 올려요. 필요한 내용을 결과 보고에 적어 주세요.' };
    if (mcpServer && !(mcpServer.source === 'sdk' && mcpServer.name === LEADER_MCP_NAME)) {
      return { type: 'deny', reason: '앱이 등록하지 않은 도구 서버', message: MSG_UNKNOWN };
    }
    return { type: 'allow', reason: '리더 승인 요청 도구 허용' };
  }

  // 파일 쓰기
  if (WRITE_TOOLS.has(toolName)) {
    const raw = str(toolName === 'NotebookEdit' ? input.notebook_path : input.file_path);
    if (!raw) return { type: 'deny', reason: `${toolName} 경로 없음`, message: '바꿀 파일 위치가 비어 있어요.' };
    const abs = absPath(raw, cwd);
    const hit = blockedHit(config, abs);
    if (hit) return { type: 'deny', reason: `차단 목록에 걸림: ${hit}`, message: MSG_BLOCKED, blocked: hit };
    const candidates = [...new Set([abs, real(abs)])];
    const insideAll = (roots: string[]) => candidates.every((c) => inAny(c, roots));
    const insideSome = (roots: string[]) => candidates.some((c) => inAny(c, roots));
    // 이 과제의 시안 폴더(~/rano/runs/drafts/…): 작업 리포가 아니므로 승인 없이 쓴다
    if (actor.draftsDir && insideAll([actor.draftsDir])) return { type: 'allow', reason: `시안 폴더 안: ${abs}` };
    if (insideSome(mission.readonlyRefs)) return { type: 'deny', reason: `참고 폴더 쓰기: ${abs}`, message: MSG_REFS };
    if (actor.planBlocked) return { type: 'deny', reason: `기획 결정 전 쓰기: ${abs}`, message: MSG_PLAN };
    if (mission.directWriteDirs.length && insideAll(mission.directWriteDirs)) {
      return { type: 'allow', reason: `바로 쓰기 폴더 안: ${abs}` };
    }
    const preview =
      toolName === 'Edit'
        ? `바꾸기 전(앞부분):\n${redactPreview(String(input.old_string ?? ''), 15, 700)}\n\n바꾼 뒤(앞부분):\n${redactPreview(String(input.new_string ?? ''), 15, 700)}`
        : toolName === 'Write'
          ? `새 내용(앞부분):\n${redactPreview(String(input.content ?? ''))}`
          : `노트북 셀 새 내용(앞부분):\n${redactPreview(String(input.new_source ?? ''))}`;
    const exists = existsSync(abs);
    const verb = toolName === 'Write' ? (exists ? '새 내용으로 다시 쓰려고' : '새로 만들려고') : '고치려고';
    if (insideAll(mission.targets)) {
      const rel = relToTarget(mission, abs);
      return {
        type: 'ask',
        reason: `작업 대상 폴더 쓰기(${toolName}): ${abs}`,
        ask: {
          kind: 'write',
          title: `${mission.name} 리포 파일 ${toolName === 'Write' && !exists ? '만들기' : '고치기'}: ${path.basename(abs)}`,
          what: `${mission.name} 리포의 ${rel} 문서를 ${verb} 해요`,
          detail: `파일: ${displayPath(abs)}\n도구: ${toolName}${input.replace_all ? ' (모두 바꾸기)' : ''}\n\n${preview}`,
          filePath: abs,
          change: fileChangeFor(toolName, input, abs),
        },
      };
    }
    return {
      type: 'ask',
      reason: `작업 폴더 밖 쓰기(${toolName}): ${abs}`,
      ask: {
        kind: 'outsideWrite',
        title: `작업 폴더 밖 파일 쓰기: ${path.basename(abs)}`,
        what: `${mission.name} 작업 폴더 밖에 있는 ${displayPath(abs)} 파일을 ${verb} 해요`,
        detail: `파일: ${displayPath(abs)}\n도구: ${toolName}\n\n${preview}`,
        filePath: abs,
        change: fileChangeFor(toolName, input, abs),
      },
    };
  }

  // 명령 실행
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const roots = [...allowedRoots(mission), path.join(config.runsDir, 'drafts', mission.id), path.join(config.rootDir, 'skills')]; // 시안 폴더·스킬 보관함도 읽기 허용
    const b = classifyBash(command, {
      cwd,
      targets: mission.targets.map((t) => path.resolve(t)),
      readRoots: roots,
      isBlocked: (p) => !!blockedHit(config, p),
    });
    if (b.decision === 'deny') {
      return { type: 'deny', reason: `명령에 차단 경로: ${b.blockedPaths.join(', ')}`, message: MSG_BLOCKED, blocked: b.blockedPaths[0] ?? '(명령)' };
    }
    if (b.decision === 'allow') return { type: 'allow', reason: `읽기 명령 허용: ${b.reasons.join('; ')}` };
    const kind = b.kind ?? 'command';
    // 참고 폴더를 바꾸는 명령은 승인 없이 거절
    if ((kind === 'write' || kind === 'outsideWrite') && b.writePaths.some((p) => inAny(p, mission.readonlyRefs))) {
      return { type: 'deny', reason: '명령으로 참고 폴더 쓰기', message: MSG_REFS };
    }
    // 이 과제의 시안 폴더 안만 지우거나 쓰는 명령(rm·mv·cp 등)은 승인 없이 허용 (작업 리포가 아닌 라노의 임시 공간)
    if ((kind === 'delete' || kind === 'write' || kind === 'outsideWrite') && actor.draftsDir && b.writePaths.length && b.writePaths.every((p) => within(p, actor.draftsDir!) || within(real(p), actor.draftsDir!)))
      return { type: 'allow', reason: `시안 폴더 안 정리(${kind}): ${b.writePaths.map(displayPath).join(', ')}` };
    const files = b.writePaths.length ? `\n바뀔 수 있는 파일: ${b.writePaths.map(displayPath).join(', ')}` : '';
    return {
      type: 'ask',
      reason: `명령 승인 필요(${kind}): ${b.reasons.join('; ')}`,
      ask: {
        kind,
        title: BASH_TITLES[kind](mission),
        what: BASH_WHAT[kind](mission),
        detail: `명령: ${redactCommand(command)}\n실행 위치: ${displayPath(cwd)}${files}\n판단 근거: ${b.reasons.join('; ')}`,
        filePath: b.writePaths.length === 1 ? b.writePaths[0] : undefined,
      },
    };
  }

  return { type: 'deny', reason: `허용 목록에 없는 도구: ${toolName}`, message: MSG_UNKNOWN };
}

// ------------------------------------------------------------------
// 검색 결과 거르기 (PostToolUse)
// ------------------------------------------------------------------

const ENV_PREFIX = /^(?:[^\n:]*\/)?\.env(?:\.[^\/\n:]*)?[:\-]/;

/** Grep/Glob 결과에서 차단 목록 경로의 줄을 지운다. 바뀐 것이 없으면 changed=false. */
export function filterSearchOutput(
  output: unknown,
  baseDir: string,
  isBlocked: (abs: string) => boolean,
): { changed: boolean; removed: number; output: unknown } {
  let removed = 0;
  const bad = (p: string) => {
    const abs = path.resolve(baseDir, p);
    return isBlocked(abs) || /(^|\/)\.env(\.|$)/.test(p);
  };
  const filterContent = (text: string): string =>
    text
      .split('\n')
      .filter((line) => {
        if (!line) return true;
        if (ENV_PREFIX.test(line)) {
          removed++;
          return false;
        }
        // path:line:text / path-line-text / path:text 형태의 앞부분 후보를 모두 검사
        let idx = -1;
        for (let n = 0; n < 6; n++) {
          const next = line.slice(idx + 1).search(/[:\-]/);
          if (next < 0) break;
          idx = idx + 1 + next;
          if (bad(line.slice(0, idx))) {
            removed++;
            return false;
          }
        }
        if (bad(line.trim())) {
          removed++;
          return false;
        }
        return true;
      })
      .join('\n');

  if (typeof output === 'string') {
    const next = filterContent(output);
    return { changed: removed > 0, removed, output: next };
  }
  if (output && typeof output === 'object') {
    const o = { ...(output as Record<string, unknown>) };
    if (Array.isArray(o.filenames)) {
      const before = o.filenames.length;
      o.filenames = (o.filenames as unknown[]).filter((f) => !(typeof f === 'string' && bad(f)));
      const diff = before - (o.filenames as unknown[]).length;
      if (diff) {
        removed += diff;
        if (typeof o.numFiles === 'number') o.numFiles = Math.max(0, o.numFiles - diff);
      }
    }
    if (typeof o.content === 'string') o.content = filterContent(o.content);
    return { changed: removed > 0, removed, output: o };
  }
  return { changed: false, removed: 0, output };
}

// ------------------------------------------------------------------
// 문지기 본체
// ------------------------------------------------------------------

export interface LeaderGuardDeps {
  config: RanoConfig;
  mission: MissionConfig;
  log: (line: PermissionLogEntry) => void;
  tracker?: MissionTrackerApi;
  approvals?: ApprovalQueueApi;
  /** 리더 대화 패널에 한 줄 보여 주기 (missionId 를 붙여 emit) */
  emitActivity?: (text: string) => void;
}

/**
 * 리포 리더 한 명의 권한 상태(현재 과제, 팀 구성안 승인 여부, 에이전트별 마지막 말)를 들고
 * canUseTool 과 훅을 만들어 준다.
 */
export class LeaderGuard {
  readonly agents: AgentRegistry = new Map(); // agentID → 역할 이름
  private readonly lastText = new Map<string, string>(); // 'leader' | agentID | 'role:<역할>' → 마지막 말
  private readonly memberTask = new Map<string, string>(); // 역할 → 맡은 일 한 줄
  private readonly teamApprovedTasks = new Set<string>();
  private readonly planDecidedTasks = new Set<string>();
  private task: { id: string; title: string; planFirst?: boolean } | null = null;

  private readonly deps: LeaderGuardDeps;

  constructor(deps: LeaderGuardDeps) {
    // 다른 구역 폴더(회사 미션에게는 ~/personal, 개인 미션에게는 ~/work)는 차단 목록처럼 막는다
    this.deps = { ...deps, config: withZoneBlocks(deps.config, deps.mission) };
  }

  get leaderLabel(): string {
    return `${this.deps.mission.name} 리더`;
  }

  private get logAgent(): string {
    return `${this.deps.mission.id}-leader`;
  }

  setTask(task: { id: string; title: string; planFirst?: boolean } | null) {
    this.task = task;
    this.memberTask.clear();
    this.lastText.clear();
  }

  currentTask() {
    return this.task;
  }

  /** 묶음 승인으로 반영할 파일 위치가 괜찮은지. 문제가 있으면 쉬운 말로 */
  bundleTargetProblem(abs: string): string | null {
    const { config, mission } = this.deps;
    if (blockedHit(config, abs)) return '차단 목록에 걸린 위치예요';
    const candidates = [...new Set([abs, real(abs)])];
    if (candidates.some((c) => inAny(c, mission.readonlyRefs))) return '참고(읽기 전용) 폴더예요';
    if (!candidates.every((c) => inAny(c, mission.targets))) return '작업 폴더 밖이에요';
    return null;
  }

  /** 이 과제의 시안 폴더 (작업 리포 밖, 승인 없이 쓰기) */
  draftsDir(taskId?: string): string | undefined {
    const id = taskId ?? this.task?.id;
    return id ? path.join(this.deps.config.runsDir, 'drafts', this.deps.mission.id, id) : undefined;
  }

  /** 기획 먼저인 과제에서 안 선택(planGate 결정)을 받았다 */
  markPlanDecided(taskId: string) {
    this.planDecidedTasks.add(taskId);
  }

  /** 기획 먼저인데 아직 안을 고르지 않아 작업 폴더 쓰기를 막아야 하는지 */
  planBlocked(): boolean {
    return !!this.task?.planFirst && !this.planDecidedTasks.has(this.task.id);
  }

  markTeamApproved(taskId: string) {
    this.teamApprovedTasks.add(taskId);
  }

  isTeamApproved(taskId?: string): boolean {
    const id = taskId ?? this.task?.id;
    return !!id && this.teamApprovedTasks.has(id);
  }

  /** 에이전트가 한 말을 적어 둔다(승인함의 "왜"로 쓰임). key: 'leader' 또는 agentID */
  noteText(key: string, text: string, role?: string) {
    const t = text.trim();
    if (!t) return;
    this.lastText.set(key, t);
    if (role) this.lastText.set(`role:${role}`, t);
  }

  noteMemberTask(role: string, task: string) {
    this.memberTask.set(role, task);
  }

  private who(agentID: string | undefined): { label: string; logName: string; role?: string; isSub: boolean } {
    if (!agentID) return { label: this.leaderLabel, logName: this.logAgent, isSub: false };
    const role = this.agents.get(agentID);
    return { label: role ?? '팀원', logName: role ?? `${this.deps.mission.id}-member`, role, isSub: true };
  }

  // 그 에이전트가 이 도구 직전에 한 말을 꺼내고 지운다. 다음 승인 요청이 지난 말을 다시 쓰지 않게 하려는 것.
  private takeSaid(agentID: string | undefined, role?: string): string {
    const keys = agentID ? [agentID, ...(role ? [`role:${role}`] : [])] : ['leader'];
    let said = '';
    for (const k of keys) {
      if (!said && this.lastText.get(k)) said = this.lastText.get(k)!;
    }
    for (const k of keys) this.lastText.delete(k);
    return said;
  }

  // "…합니다. 권장: …" 처럼 권장안이 줄 중간에 있어도 나눈다
  private splitSaid(said: string): { why: string; rec: string } {
    const m = said.match(/(?:^|\n|[.。!?]\s*|\s)[-*]?\s*(?:권장|추천)(?:안)?\s*[:：]\s*([^\n]+)/);
    if (!m || m.index === undefined) return { why: said.trim(), rec: '' };
    const why = (said.slice(0, m.index) + said.slice(m.index + m[0].length)).trim();
    return { why, rec: m[1].trim() };
  }

  private whyAndRec(agentID: string | undefined, role?: string): { why: string; rec: string } {
    const said = this.takeSaid(agentID, role);
    const { why, rec } = this.splitSaid(said);
    let w = why;
    if (!w.trim()) {
      if (role && this.memberTask.get(role)) w = this.memberTask.get(role)!;
      else w = this.task ? `맡은 일: ${this.task.title}` : '';
    }
    return { why: clip(w, 200), rec: clip(rec, 200) };
  }

  private record(agent: string, tool: string, decision: 'allow' | 'deny', reason: string) {
    this.deps.log({ at: new Date().toISOString(), agent, tool, decision, reason });
  }

  private activity(who: string, text: string) {
    try {
      this.deps.tracker?.activity(who, text);
    } catch {
      // 현황판 갱신 실패는 무시
    }
    try {
      this.deps.emitActivity?.(`${who}: ${text}`);
    } catch {
      // 무시
    }
  }

  private noticeBlocked(whoLabel: string, hit: string) {
    const label = sensitiveLabel(hit);
    const where = label === '민감한 위치' ? '비밀로 지정된 위치' : label;
    this.activity('앱', `차단: ${whoLabel}가 ${where}를 열려다 막혔어요`);
  }

  private decide(toolName: string, input: Record<string, unknown>, cwd: string, isSub: boolean, mcpServer?: { name: string; source: string }): StageDecision {
    const { config, mission } = this.deps;
    const ext = decideConnectorTool(config, mission, toolName, input, mcpServer);
    if (ext) {
      if (ext.type === 'ask' && (mission.stagePolicy === 'readOnly' || this.planBlocked()))
        return { type: 'deny', reason: `${mission.stagePolicy === 'readOnly' ? '읽기 전용 미션' : '기획 결정 전'} 외부 쓰기: ${toolName}`, message: mission.stagePolicy === 'readOnly' ? '이 미션은 읽기만 해요. 외부 서비스에 쓰는 일은 보고에 적어 주세요.' : MSG_PLAN };
      return ext;
    }
    if (mission.stagePolicy === 'readOnly') {
      const d = decideLeaderTool(config, mission, toolName, input, cwd, isSub);
      return { type: d.allow ? 'allow' : 'deny', reason: d.reason, message: d.message, updatedInput: d.updatedInput, blocked: d.blocked };
    }
    const d = decideApprovalStage(
      config,
      mission,
      toolName,
      input,
      cwd,
      { isSubagent: isSub, teamApproved: this.isTeamApproved(), draftsDir: this.draftsDir(), planBlocked: this.planBlocked() },
      mcpServer,
    );
    // 기획 결정 전에는 작업 폴더를 바꾸는 명령(커밋·삭제·쓰기 명령 등)도 승인함에 올리지 않고 막는다
    if (d.type === 'ask' && this.planBlocked() && d.ask?.kind !== 'decision' && d.ask?.kind !== 'teamPlan') {
      return { type: 'deny', reason: `기획 결정 전 ${d.ask?.kind ?? '변경'}`, message: MSG_PLAN };
    }
    return d;
  }

  /** 승인함에 올리고 결정을 기다린다. */
  private async waitApproval(
    ask: ApprovalAsk,
    input: Record<string, unknown>,
    whoInfo: { label: string; logName: string; role?: string },
    agentID: string | undefined,
    toolName: string,
    signal: AbortSignal | undefined,
  ): Promise<PermissionResult> {
    const { approvals, mission } = this.deps;
    const taskId = this.task?.id;
    if ((ask.kind === 'write' || ask.kind === 'outsideWrite') && ask.filePath && taskId && approvals?.isFileGranted(taskId, ask.filePath)) {
      this.record(whoInfo.logName, toolName, 'allow', `이번 과제 동안 다시 묻지 않기로 승인된 파일: ${ask.filePath}`);
      return { behavior: 'allow', updatedInput: input };
    }
    if (!approvals) {
      this.record(whoInfo.logName, toolName, 'deny', '승인함이 연결되지 않음');
      return { behavior: 'deny', message: '지금은 승인함이 연결되지 않아 이 일을 할 수 없어요. 보고에 "승인이 필요한 일"로 적어 주세요.' };
    }
    this.activity(whoInfo.label, `승인을 기다리는 중: ${ask.title}`);
    const said = this.whyAndRec(agentID, whoInfo.role);
    let d;
    try {
      d = await approvals.request(
        {
          missionId: mission.id,
          taskId,
          who: whoInfo.label,
          kind: ask.kind,
          title: ask.title,
          what: ask.what,
          why: said.why,
          recommendation: said.rec,
          detail: ask.detail,
          filePath: ask.filePath,
          ...(ask.change ? { change: ask.change } : {}),
        },
        signal,
      );
    } catch {
      this.record(whoInfo.logName, toolName, 'deny', '승인 대기가 취소됨(앱 종료·작업 중단)');
      return { behavior: 'deny', message: '승인을 기다리던 중에 작업이 멈췄어요. 이 일은 하지 않았어요.', interrupt: true };
    }
    if (d.decision === 'approve') {
      this.record(whoInfo.logName, toolName, 'allow', `사용자 승인(${d.id})${d.rememberFile ? ', 이번 과제 동안 다시 묻지 않기' : ''}`);
      this.activity(whoInfo.label, `승인됨: ${ask.title}`);
      return { behavior: 'allow', updatedInput: input };
    }
    const note = d.note?.trim() || '사유 없음';
    if (d.decision === 'revise') {
      this.record(whoInfo.logName, toolName, 'deny', `사용자 수정 요청(${d.id})`);
      this.activity(whoInfo.label, `수정 요청: ${ask.title}`);
      return { behavior: 'deny', message: `사용자가 수정을 요청했어요: ${note}. 반영해서 다시 시도하세요.` };
    }
    this.record(whoInfo.logName, toolName, 'deny', `사용자 반려(${d.id})`);
    this.activity(whoInfo.label, `반려됨: ${ask.title}`);
    return { behavior: 'deny', message: `사용자가 반려했어요: ${note}. 다른 방법을 찾거나 보고에 적으세요.` };
  }

  /** canUseTool: 훅이 'ask' 로 넘긴 일(또는 SDK 가 묻는 일)을 처리한다. 여기서는 오래 기다려도 된다. */
  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const whoInfo = this.who(options.agentID);
    const cwd = this.deps.mission.targets[0] ?? this.deps.mission.home;
    const d = this.decide(toolName, input, cwd, whoInfo.isSub, options.mcpServer);
    if (d.type === 'allow') {
      this.record(whoInfo.logName, toolName, 'allow', d.reason);
      return { behavior: 'allow', updatedInput: d.updatedInput ?? input };
    }
    if (d.type === 'deny') {
      this.record(whoInfo.logName, toolName, 'deny', d.reason);
      if (d.blocked) this.noticeBlocked(whoInfo.label, d.blocked);
      return { behavior: 'deny', message: d.message ?? MSG_UNKNOWN };
    }
    return this.waitApproval(d.ask!, input, whoInfo, options.agentID, toolName, options.signal);
  };

  /** 훅: PreToolUse(빠른 판단) + PostToolUse(검색 결과 거르기). 훅 안에서는 기다리지 않는다. */
  hooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const { config, mission } = this.deps;
    return {
      PreToolUse: [
        {
          onFailure: 'block', // 훅이 실패하면 도구를 막는다
          hooks: [
            async (raw) => {
              const input = raw as PreToolUseHookInput;
              if (input.hook_event_name !== 'PreToolUse') return {};
              const isSub = !!input.agent_id;
              if (isSub && input.agent_type) this.agents.set(input.agent_id!, input.agent_type);
              const whoInfo = this.who(input.agent_id);
              const toolInput = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
              const cwd = input.cwd || mission.targets[0] || mission.home;
              const d = this.decide(input.tool_name, toolInput, cwd, isSub, input.mcp_server);
              // 스킬을 꺼내 쓰는지: 스킬 보관함의 SKILL.md 를 읽으면 대화창에 알린다
              if (d.type === 'allow' && input.tool_name === 'Read' && typeof toolInput.file_path === 'string') {
                const sk = /\/skills\/([a-z0-9][a-z0-9-]{1,60})\/SKILL\.md$/.exec(toolInput.file_path);
                if (sk && toolInput.file_path.startsWith(path.join(this.deps.config.rootDir, 'skills'))) this.activity(whoInfo.label, `스킬을 꺼내 씀: ${sk[1]}`);
              }
              if (d.type === 'allow' && /^mcp__/.test(input.tool_name) && !input.tool_name.startsWith(LEADER_TOOL_PREFIX)) {
                const [, srv, tl] = input.tool_name.split('__');
                this.activity(whoInfo.label, `${config.connectors?.[srv]?.label ?? srv}에서 읽음: ${tl}`);
              }
              if (d.type === 'ask') {
                // 승인함은 canUseTool 에서 기다린다(훅에는 시간 제한이 있음)
                return {
                  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: d.ask?.title ?? d.reason },
                };
              }
              this.record(whoInfo.logName, input.tool_name, d.type, d.reason);
              if (d.type === 'deny' && d.blocked) this.noticeBlocked(whoInfo.label, d.blocked);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: d.type,
                  permissionDecisionReason: d.type === 'allow' ? d.reason : d.message ?? MSG_UNKNOWN,
                  ...(d.updatedInput ? { updatedInput: d.updatedInput } : {}),
                },
              };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Grep|Glob',
          hooks: [
            async (raw) => {
              const input = raw as PostToolUseHookInput;
              if (input.hook_event_name !== 'PostToolUse') return {};
              if (input.tool_name !== 'Grep' && input.tool_name !== 'Glob') return {};
              const ti = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
              const cwd = input.cwd || mission.targets[0] || mission.home;
              const base = path.resolve(cwd, expandHome(str(ti.path) ?? cwd));
              const r = filterSearchOutput(input.tool_response, base, (p) => !!blockedHit(config, p));
              if (!r.changed) return {};
              const whoInfo = this.who(input.agent_id);
              this.record(whoInfo.logName, input.tool_name, 'deny', `검색 결과에서 차단 목록 경로 ${r.removed}건을 지움`);
              this.activity('앱', `차단: ${whoInfo.label}의 검색 결과에서 민감한 위치(비밀 설정 파일 등)의 내용 ${r.removed}줄을 가렸어요`);
              return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: r.output } };
            },
          ],
        },
      ],
    };
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ---- 2단계 호환 함수 (기존 시험·호출용) ----

/** canUseTool 형태의 문지기. stagePolicy 에 맞춰 판단한다. 승인 대기가 필요하면 deps.approvals 를 쓴다. */
export function createLeaderGate(
  config: RanoConfig,
  mission: MissionConfig,
  log: (line: PermissionLogEntry) => void,
  agents: AgentRegistry = new Map(),
): CanUseTool {
  const guard = new LeaderGuard({ config, mission, log });
  for (const [k, v] of agents) guard.agents.set(k, v);
  return guard.canUseTool;
}

/** PreToolUse/PostToolUse 훅 (2단계 호환). */
export function createLeaderHooks(
  config: RanoConfig,
  mission: MissionConfig,
  log: (line: PermissionLogEntry) => void,
  agents: AgentRegistry = new Map(),
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guard = new LeaderGuard({ config, mission, log });
  for (const [k, v] of agents) guard.agents.set(k, v);
  return guard.hooks();
}
