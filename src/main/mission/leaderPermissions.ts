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
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
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
import { classifyBash, type BashDecision, type BashKind, type BashRisk } from './bashRules.js';
import { CODE_MAP_FILE } from './leaderPrompt.js';
import { fileKey } from '../approvals/approvalQueue.js';
import { isConnectorReadTool } from '../connectors/readTools.js';
import { missionTmpDir } from './missionTmp.js';

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
const MSG_READ_TASK =
  '이 과제는 "읽고 정리만" 하기로 하고 시작했어요. 작업 폴더를 바꾸거나 지우거나 커밋하는 일은 할 수 없어요. 꼭 필요하면 리포 리더가 팀 구성안을 readOnly 없이 다시 올려 승인받아야 해요.';

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
// 끊긴 바로가기(가리키는 곳이 없는 링크)면 링크를 읽어 가리키는 곳으로 판단한다(그 부모 폴더의 실제 경로 + 이름).
// 끊긴 바로가기에 쓰면 가리키는 곳에 새 파일이 생기기 때문이다
export function real(p: string, depth = 0): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(realpathSync.native(cur), ...tail);
    } catch {
      let link: string | null = null;
      try {
        if (lstatSync(cur).isSymbolicLink()) link = readlinkSync(cur);
      } catch {
        // 없는 경로: 부모로 올라간다
      }
      if (link !== null) {
        if (depth >= 32) return p; // 링크가 돌고 돌면(ELOOP) 더 풀지 않는다. 그런 경로에는 쓸 수도 없다
        // 상대 경로 링크는 링크가 놓인 폴더의 실제 위치 기준
        const base = real(path.dirname(cur), depth + 1);
        return real(path.join(path.resolve(base, link), ...tail), depth + 1);
      }
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/** 이미 있는 폴더인지(바로가기면 따라가서 본다) */
function isDirPath(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 폴더 아래(자기 자신 포함)에 바로가기가 있는지. 너무 크거나 깊어 다 못 보면 있다고 본다 */
function hasLinksUnder(p: string): boolean {
  let seen = 0;
  const walk = (dir: string, depth: number): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (++seen > 5000 || depth > 16) return true;
      if (e.isSymbolicLink()) return true;
      if (e.isDirectory() && walk(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return true;
    if (!st.isDirectory()) return false;
  } catch {
    return false; // 아직 없는 폴더
  }
  return walk(p, 0);
}

/** 승인 카드에 덧붙일 말: 바로가기라서 실제로 바뀌는 곳이 다르면 그 위치, 작업 폴더 안이면 경고 */
function realPathNote(mission: MissionConfig, paths: string[]): string {
  const lines: string[] = [];
  for (const p of [...new Set(paths)]) {
    const rp = real(p);
    if (rp === p) continue;
    lines.push(`실제로 바뀌는 곳: ${displayPath(rp)} (${displayPath(p)} 경로에 바로가기가 있어 따라간 위치예요)`);
    if (inAny(rp, mission.targets)) lines.push(`주의: 실제로는 ${mission.name} 작업 폴더(리포) 안의 파일이 바뀌어요`);
  }
  return lines.length ? `\n${lines.join('\n')}` : '';
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

/** 원래 경로와 링크를 푼 실제 경로가 "모두" root 안인지. 폴더 안의 바로가기로 밖(작업 리포·다른 미션 폴더)을 건드리는 우회를 막는다 */
export function insideBoth(p: string, root: string): boolean {
  return inAny(p, [root]) && inAny(real(p), [root]);
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

// 임시 폴더: 명령 결과를 잠깐 담아 두는 곳. 미션마다 따로(~/rano/runs/tmp/<미션>, missionTmp.ts) 두고, 그 미션의 Bash 만 승인 없이 읽고 결과를 담는다.
// /tmp(/private/tmp)는 모든 미션이 같이 쓰는 곳이라 바로 허용하지 않는다(읽기·쓰기 모두 승인함).
// 맥의 사용자별 임시 폴더(/var/folders/…)는 다른 앱 파일이 많아 넣지 않는다

// 폴더 아래 비밀·차단 파일 유무 (통째 검색을 바로 허용해도 되는지). 2분 동안 기억한다
const SECRET_SCAN_TTL = 30_000;
const SECRET_SCAN_LIMIT = 30_000;
// 너무 커서 다 보지 않는 폴더. 안에 비밀 파일이 있을 수 있다고 보고 '.env' 가 있는 것처럼 기록한다
const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv']);
const secretScanCache = new Map<string, { at: number; hits: string[] }>();

/** 폴더 아래 차단·비밀 파일 목록. 너무 커서 다 못 보면 ['*'] */
export function secretsUnderDir(config: RanoConfig, absDir: string): string[] {
  const key = `${absDir}\n${config.blocked.join('\n')}`;
  const cached = secretScanCache.get(key);
  if (cached && Date.now() - cached.at < SECRET_SCAN_TTL) return cached.hits;
  let seen = 0;
  const hits: string[] = [];
  let full_ = false;
  const walk = (dir: string, depth: number) => {
    if (full_) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (full_) return;
      if (++seen > SECRET_SCAN_LIMIT || depth > 12 || hits.length > 200) {
        full_ = true; // 너무 커서 다 못 보면 있다고 본다
        return;
      }
      const full = path.join(dir, e.name);
      if (/^\.env(\.|$)/.test(e.name) || /^\.git-credentials$|^\.netrc$|^\.npmrc$|^\.pypirc$/.test(e.name) || isBlockedPath(config, full)) {
        hits.push(full);
        continue;
      }
      if (e.isDirectory() && e.name === '.git') {
        hits.push(path.join(full, 'config')); // 원격 주소에 토큰이 들어 있을 수 있다
        continue;
      }
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) {
        hits.push(path.join(full, '.env'));
        continue;
      }
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  try {
    if (blockedHit(config, absDir) || /(^|\/)\.env(\.|$)/.test(absDir)) hits.push(absDir);
    else if (statSync(absDir).isDirectory()) walk(absDir, 0);
  } catch {
    // 없는 경로는 읽을 것도 없다
  }
  const result = full_ ? ['*'] : hits;
  secretScanCache.set(key, { at: Date.now(), hits: result });
  return result;
}

/** 차단 목록 검사(원래 경로와 링크를 푼 경로 모두). 걸린 경로를 돌려준다. */
function blockedHit(config: RanoConfig, abs: string): string | null {
  for (const c of new Set([abs, real(abs)])) if (isBlockedPath(config, c)) return c;
  return null;
}

/** 미션 구역의 denyRead(다른 구역 폴더)와 다른 구역 미션들의 임시 폴더를 차단 목록에 더한 설정 */
export function withZoneBlocks(config: RanoConfig, mission: MissionConfig): RanoConfig {
  const deny = config.zones?.[mission.zone]?.denyRead ?? [];
  // 다른 구역(회사↔개인) 미션의 임시 폴더는 거절. 설정 파일(rano.json)은 이미 있는 사용자 설정을 덮어쓰지 않으므로 코드에서 더한다
  const otherZoneTmp = (config.missions ?? []).filter((m) => m.zone !== mission.zone).map((m) => missionTmpDir(config, m.id));
  const extra = [...deny, ...otherZoneTmp];
  return extra.length ? { ...config, blocked: [...config.blocked, ...extra] } : config;
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

function agentCallInput(input: Record<string, unknown>, role: string, model?: 'opus' | 'sonnet'): Record<string, unknown> {
  // 위험한 선택지(권한 모드·격리·모델 바꾸기·백그라운드)는 지우고 필요한 값만 남긴다.
  // 모델은 리더가 고를 수 없고, 팀 구성안에서 사용자가 승인한 모델만 앱이 넣는다(없으면 역할 파일·라노 설정).
  // 백그라운드를 끄면 팀원이 끝날 때 도구 결과가 돌아와서 진행 상황을 짝지어 추적할 수 있다.
  return {
    description: str(input.description) ?? role,
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    subagent_type: role,
    run_in_background: false,
    ...(model ? { model } : {}),
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
  memberModels?: Record<string, 'opus' | 'sonnet'>,
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
    const model = memberModels?.[role];
    return { allow: true, reason: `팀원 호출 허용: ${role}${model ? ` (${model})` : ''}`, updatedInput: agentCallInput(input, role, model) };
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
  bash?: boolean; // Bash 명령으로 생긴 요청
  paths?: string[]; // Bash 명령이 바꾸거나 지울 수 있는 경로(절대 경로)
  fileOpsOnly?: boolean; // Bash 명령이 파일 일(쓰기·지우기)만 하는지
  logTarget?: string; // Bash 기록용: 프로그램 끄기·지우기·인터넷 전송의 대상(끌 이름·지울 경로·보낼 호스트). 비밀 가림
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 이름만 봐도 토큰인 글(GitHub·GitLab·Slack·OpenAI/Anthropic·Stripe·AWS·Google·npm·Hugging Face)
const TOKEN_PREFIX = /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abposr]-|sk-(?:ant-|proj-|live-)?|sk_(?:live|test)_|rk_(?:live|test)_|AKIA|ASIA|AIza|npm_|hf_|ya29\.)[A-Za-z0-9_\-.]{8,}/g;
const LONG_RUN = /[A-Za-z0-9+/_\-]{32,}/g;

/**
 * 명령 글에서 비밀로 보이는 값을 가린다(승인 카드 자세히·권한 기록·제목에 쓴다).
 * 머리글(Authorization·Cookie), Bearer 뒤 토큰, 아이디:비번(-u·--user·주소 안), 이름이 비밀스러운 설정값·옵션,
 * --password=·-p<비번>, 이름만 봐도 토큰인 글, 32자 넘는 무작위 글('/' 가 든 경로는 32자 넘는 마디만, UUID 는 남김)
 */
export function redactCommand(cmd: string): string {
  return String(cmd ?? '')
    .replace(/((?:proxy-)?authorization\s*:\s*)(?:(bearer|basic|token|digest|negotiate)\s+)?("[^"]*"|'[^']*'|[^\s'"]+)/gi, (_m, h: string, s?: string) => `${h}${s ? `${s} ` : ''}(가림)`)
    .replace(/(\bcookie\s*:\s*)[^'"\n]+/gi, '$1(가림)')
    .replace(/\b(bearer)\s+(?!\(가림\))[A-Za-z0-9._~+\/=-]{4,}/gi, '$1 (가림)')
    .replace(/(^|\s)(-u\s*|--user[= ]\s*|--proxy-user[= ]\s*|-U\s*)("[^"]*:[^"]*"|'[^']*:[^']*'|[^\s'"]*:[^\s'"]*)/g, '$1$2(가림)') // curl -u 아이디:비번
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\/\s@'"]+@/gi, '$1(가림)@') // https://아이디:비번@호스트
    .replace(/((?:secret|token|passw(?:or)?d|api[_-]?key|auth)[A-Za-z0-9_-]*\s*[=:]\s*)(?!\(가림\)|(?:bearer|basic|token|digest|negotiate)\s)("[^"]*"|'[^']*'|[^\s'"]+)/gi, '$1(가림)')
    .replace(/(--(?:token|api[-_]?key|secret|client[-_]?secret|access[-_]?token|auth[-_]?token|password|passwd|pass)[ =])(?!\(가림\))("[^"]*"|'[^']*'|\S+)/gi, '$1(가림)')
    .replace(/(^|\s)(--password[= ]|-p(?=[^\s-]))(?!\(가림\))\S+/g, '$1$2(가림)') // mysql -pXXXX, --password=XXXX 만 가린다 (--porcelain 같은 옵션은 그대로)
    .replace(TOKEN_PREFIX, '(가림)')
    .replace(LONG_RUN, (m: string, at: number, all: string) => {
      if (UUID.test(m)) return m;
      if (m.includes('/')) {
        // 무작위 같은 마디가 둘 이상이면 '/' 로 시작해도 통째로 가린다(/abcDEF…/XYZabc… 같은 토큰).
        // '/', '~', '.' 으로 시작하지 않는데 '+' 가 들었거나 바로 뒤가 '=' 이어도 통째로 가린다
        const prev = at > 0 ? all[at - 1] : '';
        const pathLike = m[0] === '/' || prev === '~' || prev === '.';
        if (m.split('/').filter(randomLooking).length >= 2) return '(가림)';
        if (!pathLike && (m.includes('+') || all[at + m.length] === '=')) return '(가림)';
        // 경로처럼 보이는 글(절대·상대 경로 모두): 마디마다 나눠 32자 넘는 마디만 가린다
        return m.split('/').map((s) => (s.length >= 32 && !UUID.test(s) ? '(가림)' : s)).join('/');
      }
      return '(가림)';
    });
}

/** 경로 마디가 무작위 글처럼 보이는지: 6자 이상이고 대·소문자·숫자가 모두 들었거나, 대문자와 숫자가 붙어 있거나, 대·소문자가 섞였는데 대문자가 30% 이상 */
function randomLooking(s: string): boolean {
  if (s.length < 6) return false;
  const up = /[A-Z]/.test(s);
  const lo = /[a-z]/.test(s);
  const dg = /\d/.test(s);
  if (up && lo && dg) return true;
  if (/[A-Z]\d|\d[A-Z]/.test(s)) return true;
  if (up && lo) {
    const letters = s.replace(/[^A-Za-z]/g, '');
    const ups = s.replace(/[^A-Z]/g, '').length;
    return ups / letters.length >= 0.3;
  }
  return false;
}

/** 권한 기록(permissions.jsonl)용 명령 글: 비밀을 가리고 500자까지 */
export function commandForLog(cmd: string, max = 500): string {
  const t = redactCommand(cmd);
  return t.length > max ? `${t.slice(0, max)}…(줄임)` : t;
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

/** 제목에 넣을 짧은 이름(비밀 가림, 줄바꿈 없음, 40자까지) */
function shortLabel(s: string, max = 40): string {
  const t = redactCommand(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 파일 이름만(경로 없이). 여러 개면 "a.txt 외 2개" */
function fileNames(paths: string[]): string {
  const names = [...new Set(paths.map((p) => path.basename(p)).filter(Boolean))];
  if (!names.length) return '';
  return names.length === 1 ? shortLabel(names[0]) : `${shortLabel(names[0])} 외 ${names.length - 1}개`;
}

const KILL_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,23}$/;
const KILL_PID = /^\d{1,10}$/;

/**
 * 프로그램 끄기 제목에 붙일 대상: 끌 대상이 (프로그램과 함께 따져) 하나뿐이고, 공백 없는 한 단어 24자 이하
 * (영문으로 시작하는 이름 또는 숫자만인 번호)이며 비밀처럼 보이지 않을 때만. 그 밖(공백 든 -f 패턴·경로·한글·따옴표 등)은 빈 글.
 */
export function killTitleTarget(kill: Pick<BashRisk, 'program' | 'targets'>[]): string {
  const pairs = new Set(kill.flatMap((r) => r.targets.map((t) => `${r.program}\u0000${t}`)));
  if (pairs.size !== 1) return '';
  const [program, t] = [...pairs][0].split('\u0000');
  if (program !== kill[0].program) return '';
  if (!KILL_NAME.test(t) && !KILL_PID.test(t)) return '';
  if (randomLooking(t) || redactCommand(t) !== t) return '';
  return t;
}

/**
 * 명령 승인 카드 제목: "쉬운 말 종류: 대상 이름".
 * 제목은 화면·맥 알림·휴대폰·events.jsonl·활동 기록으로 그대로 가므로 명령 인자 원문을 넣지 않는다
 * (프로그램 이름, 파일은 이름만, 주소는 호스트만). 여러 종류가 섞이면 가장 위험한 것 하나 + "(그 밖에 N가지)".
 * 승인 종류(kind)와 판단은 바꾸지 않는다.
 */
export function bashTitle(mission: MissionConfig, kind: BashKind, b: Pick<BashDecision, 'risks' | 'programs' | 'writePaths'>): string {
  const risks = b.risks ?? [];
  const of = (k: string) => risks.filter((r) => r.kind === k);
  const prog = (b.programs ?? [])[0];
  // [제목, 따로 세는 일인지] — 공용 임시 폴더·파일 쓰기는 "어디에"라서 다른 일이 있으면 세지 않는다
  const cats: [string, boolean][] = [];
  const kill = of('kill');
  if (kill.length) {
    const target = killTitleTarget(kill);
    cats.push([`프로그램 끄기: ${kill[0].program}${target ? ` ${target}` : ''}`, true]);
  }
  const net = of('network');
  if (net.length) cats.push([`인터넷으로 보내기·받기: ${net.flatMap((r) => r.targets)[0] ?? net[0].program}`, true]);
  const del = of('delete');
  if (kind === 'delete' || del.length) {
    const files = fileNames(del.filter((r) => r.program !== 'find').flatMap((r) => r.targets)); // find 의 대상은 찾을 폴더라 이름을 쓰지 않는다
    const who = files || del[0]?.program || '';
    cats.push([`${BASH_TITLES.delete(mission)}${who ? `: ${who}` : ''}`, true]);
  }
  const mode = of('mode');
  if (mode.length) {
    const files = fileNames(mode.flatMap((r) => r.targets));
    cats.push([`${mode.some((r) => r.addsExec) ? '실행 권한 붙이기' : '파일 권한 바꾸기'}${files ? `: ${files}` : ''}`, true]);
  }
  const tmp = of('tmp');
  if (tmp.length) cats.push([`공용 임시 폴더에 쓰기: ${fileNames(tmp.flatMap((r) => r.targets))}`, false]);
  if (kind === 'commit') cats.push([BASH_TITLES.commit(mission), true]);
  if (kind === 'deploy') cats.push([`${BASH_TITLES.deploy(mission)}${prog ? `: ${prog}` : ''}`, true]);
  if (kind === 'db') cats.push([`${BASH_TITLES.db(mission)}${prog ? `: ${prog}` : ''}`, true]);
  const files = fileNames(b.writePaths ?? []);
  if (kind === 'write' || kind === 'outsideWrite') cats.push([`${BASH_TITLES[kind](mission)}${files ? `: ${files}` : ''}`, false]);
  // 코드 실행: 이미 프로그램 끄기·인터넷 전송으로 잡힌 같은 프로그램(osascript 의 quit 등)은 따로 세지 않는다
  const shown = new Set([...kill, ...net].map((r) => r.program));
  const code = of('code').filter((r) => !shown.has(r.program));
  if (code.length) cats.push([`${BASH_TITLES.command(mission)}: ${code[0].program}`, true]);
  if (!cats.length) cats.push([`${BASH_TITLES.command(mission)}${prog ? `: ${prog}` : ''}`, false]);
  const [main] = cats[0];
  const extra = cats.slice(1).filter(([, counts]) => counts).length;
  return extra ? `${main} (그 밖에 ${extra}가지)` : main;
}

/** 권한 기록용 대상 칸: 프로그램 끄기(끌 이름·패턴), 지우기(지울 경로), 인터넷 전송(보낼 호스트). 없으면 undefined */
export function bashLogTarget(b: Pick<BashDecision, 'risks'>): string | undefined {
  const parts: string[] = [];
  for (const r of b.risks ?? []) {
    if (r.kind === 'kill') parts.push(`프로그램 끄기(${r.program}): ${r.targets.join(', ') || '(대상을 알 수 없음)'}`);
    else if (r.kind === 'delete') parts.push(`지우기(${r.program}): ${r.targets.map(displayPath).join(', ') || '(경로를 알 수 없음)'}`);
    else if (r.kind === 'network') parts.push(`인터넷 전송(${r.program}): ${r.targets.join(', ') || '(주소를 알 수 없음)'}`);
  }
  if (!parts.length) return undefined;
  return commandForLog(parts.join(' / '));
}

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
  actor: { isSubagent: boolean; teamApproved: boolean; draftsDir?: string; planBlocked?: boolean; memberModels?: Record<string, 'opus' | 'sonnet'> },
  mcpServer?: { name: string; source: string },
): StageDecision {
  // 읽기·검색: 2단계와 같음
  if (READ_TOOLS.has(toolName)) {
    const d = decideLeaderTool(config, mission, toolName, input, cwd, actor.isSubagent);
    return { type: d.allow ? 'allow' : 'deny', reason: d.reason, message: d.message, updatedInput: d.updatedInput, blocked: d.blocked };
  }

  // 팀원 호출: 팀 구성안 승인 뒤에만
  if (toolName === SUBAGENT_TOOL) {
    const d = decideLeaderTool(config, mission, toolName, input, cwd, actor.isSubagent, actor.memberModels);
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
    // 미션 코드 지도(라노 데이터 폴더 안, 작업 리포 밖): 다시 읽기를 줄이려고 리더가 과제 끝에 갱신. 앱이 미션 기억으로 자동 커밋한다
    if (toolName !== 'NotebookEdit' && candidates.every((c) => c === path.join(mission.home, 'memory', CODE_MAP_FILE)))
      return { type: 'allow', reason: `코드 지도 갱신: ${abs}` };
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
    const realNote = realPathNote(mission, [abs]); // 바로가기라 실제로 바뀌는 곳이 다르면 알린다
    if (insideAll(mission.targets)) {
      const rel = relToTarget(mission, abs);
      return {
        type: 'ask',
        reason: `작업 대상 폴더 쓰기(${toolName}): ${abs}`,
        ask: {
          kind: 'write',
          title: `${mission.name} 리포 파일 ${toolName === 'Write' && !exists ? '만들기' : '고치기'}: ${path.basename(abs)}`,
          what: `${mission.name} 리포의 ${rel} 문서를 ${verb} 해요`,
          detail: `파일: ${displayPath(abs)}${realNote}\n도구: ${toolName}${input.replace_all ? ' (모두 바꾸기)' : ''}\n\n${preview}`,
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
        detail: `파일: ${displayPath(abs)}${realNote}\n도구: ${toolName}\n\n${preview}`,
        filePath: abs,
        change: fileChangeFor(toolName, input, abs),
      },
    };
  }

  // 명령 실행
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const tmpDir = missionTmpDir(config, mission.id);
    const roots = [...allowedRoots(mission), path.join(config.runsDir, 'drafts', mission.id), path.join(config.rootDir, 'skills'), tmpDir]; // 시안 폴더·스킬 보관함·이 미션 임시 폴더도 읽기 허용(/tmp 는 아님)
    const b = classifyBash(command, {
      cwd,
      targets: mission.targets.map((t) => path.resolve(t)),
      readRoots: roots,
      isBlocked: (p) => !!blockedHit(config, p),
      secretsUnder: (dir) => secretsUnderDir(config, dir),
      allowChecks: true,
      realPath: (p) => real(p), // 읽는 파일은 링크를 푼 실제 경로도 읽기 허용 폴더 안이어야 바로 허용
      isDir: isDirPath, // cp·install 대상이 폴더면 <대상>/<원본 이름> 도 바뀌는 파일로 본다
      hasLinksUnder, // cp -R 받는 폴더 안에 바로가기가 있으면 승인함
    });
    if (b.decision === 'deny') {
      return { type: 'deny', reason: `명령에 차단 경로: ${b.blockedPaths.join(', ')}`, message: MSG_BLOCKED, blocked: b.blockedPaths[0] ?? '(명령)' };
    }
    if (b.decision === 'allow') return { type: 'allow', reason: `읽기 명령 허용: ${b.reasons.join('; ')}` };
    const kind = b.kind ?? 'command';
    // 참고 폴더를 바꾸는 명령은 승인 없이 거절
    if ((kind === 'write' || kind === 'outsideWrite') && b.writePaths.some((p) => inAny(p, mission.readonlyRefs) || inAny(real(p), mission.readonlyRefs))) {
      return { type: 'deny', reason: '명령으로 참고 폴더 쓰기', message: MSG_REFS };
    }
    // 바로 허용할 수 있는 폴더(시안·임시) 안만 건드리는지: 바꿀 경로가 원래 경로·실제 경로 "모두" 그 안이고,
    // 새로 만드는 링크가 가리킬 곳도 그 안이며, 권한(실행 권한 등)을 바꾸지 않을 때만. 바로가기로 작업 리포·밖을 건드리는 우회를 막는다
    const onlyIn = (root: string) =>
      b.fileOpsOnly === true &&
      !b.modeChange &&
      b.writePaths.length > 0 &&
      b.writePaths.every((p) => insideBoth(p, root)) &&
      (b.linkSources ?? []).every((s) => insideBoth(s, root));
    // 이 과제의 시안 폴더 안만 지우거나 쓰는 명령(rm·mv·cp 등)은 승인 없이 허용 (작업 리포가 아닌 라노의 임시 공간)
    if ((kind === 'delete' || kind === 'write' || kind === 'outsideWrite') && actor.draftsDir && onlyIn(actor.draftsDir))
      return { type: 'allow', reason: `시안 폴더 안 정리(${kind}): ${b.writePaths.map(displayPath).join(', ')}` };
    // 명령 결과를 이 미션 임시 폴더에 담기만 하는 명령(예: npm test > ~/rano/runs/tmp/<미션>/x.txt)은 허용. 쓰기 말고 다른 판단 근거가 있으면 승인함으로
    if (kind === 'outsideWrite' && onlyIn(tmpDir))
      return { type: 'allow', reason: `미션 임시 폴더에 결과 담기: ${b.writePaths.map(displayPath).join(', ')}` };
    const files = b.writePaths.length ? `\n바뀔 수 있는 파일: ${b.writePaths.map(displayPath).join(', ')}${realPathNote(mission, b.writePaths)}` : '';
    const modeNote = b.modeChange ? '\n주의: 파일 권한(실행 권한 등)을 바꾸는 명령이에요. 시안 폴더 안이라도 확인을 받아요' : '';
    const linkNote = b.linkSources?.length ? `\n주의: 바로가기(링크)를 만드는 명령이에요. 가리키는 곳: ${[...new Set(b.linkSources)].map(displayPath).join(', ')}` : '';
    return {
      type: 'ask',
      reason: `명령 승인 필요(${kind}): ${b.reasons.join('; ')}`,
      ask: {
        kind,
        title: bashTitle(mission, kind, b),
        what: BASH_WHAT[kind](mission),
        detail: `명령: ${redactCommand(command)}\n실행 위치: ${displayPath(cwd)}${files}${modeNote}${linkNote}\n판단 근거: ${redactCommand(b.reasons.join('; '))}`,
        filePath: b.writePaths.length === 1 ? b.writePaths[0] : undefined,
        bash: true,
        paths: b.writePaths,
        fileOpsOnly: !!b.fileOpsOnly,
        ...(bashLogTarget(b) ? { logTarget: bashLogTarget(b) } : {}),
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
  private readonly readOnlyTasks = new Set<string>(); // 읽고 정리만 하기로 한 과제(팀 구성안 자동 승인)
  private readonly reviewSkippedTasks = new Set<string>(); // 팀 구성안에서 검수 생략으로 정한 과제
  private readonly taskModels = new Map<string, Record<string, 'opus' | 'sonnet'>>(); // 과제 → 역할별로 승인된 모델
  private readonly deleteGrants = new Map<string, string[]>(); // 과제 → 리더 확인 승인으로 지워도 되는 위치(실제 경로)
  private task:{ id: string; title: string; planFirst?: boolean } | null = null;

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

  /** 팀 구성안에서 검수를 생략하기로 했는지(승인된 결정) */
  setReviewSkipped(taskId: string, skip: boolean) {
    if (skip) this.reviewSkippedTasks.add(taskId);
    else this.reviewSkippedTasks.delete(taskId);
  }

  isReviewSkipped(taskId?: string): boolean {
    const id = taskId ?? this.task?.id;
    return !!id && this.reviewSkippedTasks.has(id);
  }

  /** 팀 구성안에서 승인된 역할별 모델(이 과제 동안 팀원을 부를 때 앱이 넣는다) */
  setMemberModels(taskId: string, models: Record<string, 'opus' | 'sonnet'>) {
    this.taskModels.set(taskId, { ...models });
  }

  memberModels(taskId?: string): Record<string, 'opus' | 'sonnet'> | undefined {
    const id = taskId ?? this.task?.id;
    return id ? this.taskModels.get(id) : undefined;
  }

  /** 읽고 정리만 하는 과제로 표시(켜기) 또는 해제 */
  markReadOnly(taskId: string, on: boolean) {
    if (on) this.readOnlyTasks.add(taskId);
    else this.readOnlyTasks.delete(taskId);
  }

  isReadOnlyTask(taskId?: string): boolean {
    const id = taskId ?? this.task?.id;
    return !!id && this.readOnlyTasks.has(id);
  }

  /** 리더가 미리 확인받을 삭제 위치가 괜찮은지. 문제가 있으면 쉬운 말로. 작업 폴더 안의 하위 파일·폴더만 된다(작업 폴더 자체는 안 됨) */
  deleteTargetProblem(abs: string): string | null {
    const { config, mission } = this.deps;
    if (blockedHit(config, abs)) return '차단 목록에 걸린 위치예요';
    const candidates = [...new Set([abs, real(abs)])];
    if (candidates.some((c) => inAny(c, mission.readonlyRefs))) return '참고(읽기 전용) 폴더예요';
    if (!candidates.every((c) => inAny(c, mission.targets))) return '작업 폴더 밖이에요';
    const roots = mission.targets.flatMap((t) => {
      const abs2 = path.resolve(expandHome(t));
      return [abs2, real(abs2)];
    });
    if (candidates.some((c) => roots.includes(c))) return '작업 폴더 전체는 미리 승인할 수 없어요';
    return null;
  }

  /** 리더의 확인 승인으로 이번 과제 동안 이 위치들을 지우는 명령은 다시 묻지 않는다 */
  grantDeletes(taskId: string, absPaths: string[]) {
    const list = this.deleteGrants.get(taskId) ?? [];
    for (const p of absPaths) list.push(path.resolve(p), real(p));
    this.deleteGrants.set(taskId, [...new Set(list)]);
  }

  /** 삭제 명령이 지울 경로가 모두 미리 승인된 위치 안이면 그 위치들을, 아니면 null */
  private deleteGranted(paths: string[]): string[] | null {
    const id = this.task?.id;
    const granted = id ? this.deleteGrants.get(id) : undefined;
    if (!granted?.length || !paths.length) return null;
    const hits = new Set<string>();
    // 원래 경로와 실제 경로가 "모두" 승인된 위치 안이어야 한다(바로가기로 승인 밖을 지우는 우회 막기)
    for (const p of paths) {
      const rp = real(p);
      const g = granted.find((x) => within(p, x));
      if (!g || !granted.some((x) => within(rp, x))) return null;
      hits.add(g);
    }
    return [...hits];
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

  private record(agent: string, tool: string, decision: 'allow' | 'deny', reason: string, extra?: Pick<PermissionLogEntry, 'command' | 'target'>) {
    this.deps.log({ at: new Date().toISOString(), agent, tool, decision, reason, ...(extra?.command ? { command: extra.command } : {}), ...(extra?.target ? { target: extra.target } : {}) });
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
      if (ext.type === 'ask' && this.isReadOnlyTask()) return { type: 'deny', reason: `읽기만 하는 과제에서 외부 쓰기: ${toolName}`, message: MSG_READ_TASK };
      return ext;
    }
    if (mission.stagePolicy === 'readOnly') {
      const d = decideLeaderTool(config, mission, toolName, input, cwd, isSub, this.memberModels());
      return { type: d.allow ? 'allow' : 'deny', reason: d.reason, message: d.message, updatedInput: d.updatedInput, blocked: d.blocked };
    }
    const d = decideApprovalStage(
      config,
      mission,
      toolName,
      input,
      cwd,
      { isSubagent: isSub, teamApproved: this.isTeamApproved(), draftsDir: this.draftsDir(), planBlocked: this.planBlocked(), memberModels: this.memberModels() },
      mcpServer,
    );
    // 기획 결정 전에는 작업 폴더를 바꾸는 명령(커밋·삭제·쓰기 명령 등)도 승인함에 올리지 않고 막는다
    if (d.type === 'ask' && this.planBlocked() && d.ask?.kind !== 'decision' && d.ask?.kind !== 'teamPlan') {
      return { type: 'deny', reason: `기획 결정 전 ${d.ask?.kind ?? '변경'}`, message: MSG_PLAN };
    }
    // 읽고 정리만 하기로 한 과제(팀 구성안 자동 승인): 바꾸는 일은 승인함에 올리지 않고 막는다. 판단이 필요한 일반 명령만 평소처럼 승인함으로
    if (d.type === 'ask' && this.isReadOnlyTask() && d.ask?.kind !== 'command') {
      return { type: 'deny', reason: `읽기만 하는 과제에서 ${d.ask?.kind ?? '변경'}`, message: MSG_READ_TASK };
    }
    // 리더가 확인 카드(deletePaths)로 미리 승인받은 위치만 지우는 명령은 다시 묻지 않는다
    if (d.type === 'ask' && d.ask?.kind === 'delete' && d.ask.bash && d.ask.fileOpsOnly && d.ask.paths?.length) {
      const g = this.deleteGranted(d.ask.paths);
      if (g) return { type: 'allow', reason: `리더 확인 승인으로 미리 허락된 삭제: ${g.map(displayPath).join(', ')}` };
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
    // 명령(Bash) 요청은 "다시 묻지 않기"를 보지도 만들지도 않는다: 파일 기억이 있어도 그 파일로 출력하는 명령은 다시 묻는다
    const isBash = toolName === 'Bash' || !!ask.bash;
    const scope = isBash ? null : rememberScope(ask, toolName, whoInfo);
    if (scope && taskId && approvals?.isGranted(taskId, scope.key)) {
      this.record(whoInfo.logName, toolName, 'allow', `이번 과제 동안 다시 묻지 않기로 승인된 범위: ${scope.key}`);
      return { behavior: 'allow', updatedInput: input };
    }
    // 카드가 뜨는 명령은 기록에 비밀을 가린 명령 글과 대상(끌 프로그램·지울 경로·보낼 호스트)을 남긴다
    const extra = isBash
      ? { command: commandForLog(typeof input.command === 'string' ? input.command : ''), ...(ask.logTarget ? { target: ask.logTarget } : {}) }
      : undefined;
    const rec = (decision: 'allow' | 'deny', reason: string) => this.record(whoInfo.logName, toolName, decision, reason, extra);
    if (!approvals) {
      rec('deny', '승인함이 연결되지 않음');
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
          ...(scope ? { rememberKey: scope.key, rememberLabel: scope.label } : {}),
          tool: isBash ? 'Bash' : toolName, // 승인함·화면이 Bash 요청이면 체크 칸·기억을 만들지 않게 (Bash 판단이면 도구 이름과 관계없이 'Bash')
        },
        signal,
      );
    } catch {
      rec('deny', '승인 대기가 취소됨(앱 종료·작업 중단)');
      return { behavior: 'deny', message: '승인을 기다리던 중에 작업이 멈췄어요. 이 일은 하지 않았어요.', interrupt: true };
    }
    if (d.decision === 'approve') {
      rec('allow', `사용자 승인(${d.id})${d.rememberFile && !isBash ? ', 이번 과제 동안 다시 묻지 않기' : ''}`);
      this.activity(whoInfo.label, `승인됨: ${ask.title}`);
      return { behavior: 'allow', updatedInput: input };
    }
    const note = d.note?.trim() || '사유 없음';
    if (d.decision === 'revise') {
      rec('deny', `사용자 수정 요청(${d.id})`);
      this.activity(whoInfo.label, `수정 요청: ${ask.title}`);
      return { behavior: 'deny', message: `사용자가 수정을 요청했어요: ${note}. 반영해서 다시 시도하세요.` };
    }
    rec('deny', `사용자 반려(${d.id})`);
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

/**
 * "이번 과제 동안 다시 묻지 않기" 범위.
 * - 파일 쓰기(Write·Edit·NotebookEdit 도구): 그 파일
 * - 명령(Bash): 어떤 종류든(command·write·outsideWrite 등) 범위를 만들지 않는다. 명령은 매번 묻는다
 * - 외부 연결 쓰기(kind external): 같은 도구
 * 결정·팀 구성·묶음·수치 등 나머지는 매번 묻는다.
 */
export function rememberScope(ask: ApprovalAsk, toolName: string, _who?: { label: string; logName: string }): { key: string; label: string } | null {
  if (toolName === 'Bash' || ask.bash) return null;
  if ((ask.kind === 'write' || ask.kind === 'outsideWrite') && ask.filePath && WRITE_TOOLS.has(toolName)) {
    return { key: fileKey(ask.filePath), label: '이번 과제 동안 이 파일은 다시 묻지 않기' };
  }
  if (ask.kind === 'external' && toolName.startsWith('mcp__')) {
    const tool = toolName.split('__').slice(2).join('__');
    return { key: `ext:${toolName}`, label: `이번 과제 동안 이 연결의 ${tool} 도구는 다시 묻지 않기` };
  }
  return null;
}

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
