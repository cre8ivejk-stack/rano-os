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
import { createHash } from 'node:crypto';
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
import { classifyBash, type BashDecision, type BashKind, type BashRisk, type BashRun } from './bashRules.js';
import { CODE_MAP_FILE } from './leaderPrompt.js';
import { fileKey } from '../approvals/approvalQueue.js';
import { isConnectorReadTool } from '../connectors/readTools.js';
import { trustedDbRead } from './dbRead.js';
import { missionTmpDir } from './missionTmp.js';

export const SUBAGENT_TOOL = 'Agent'; // sdk.d.ts BUILTIN_TOOL_NAMES 기준 서브에이전트 호출 도구 이름
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const LEADER_TOOL_PREFIX = `mcp__${LEADER_MCP_NAME}__`;
/** 실행 목록 한 번에 승인 도구(리더·팀원 모두 쓸 수 있음) */
export const PROPOSE_COMMANDS_TOOL = `${LEADER_TOOL_PREFIX}propose_commands`;
/** 실행 목록으로 미리 승인할 수 있는 명령 종류. 커밋·삭제·DB·배포·작업 폴더 쓰기는 하나씩 묻는다 */
export const RUN_PLAN_KINDS = new Set(['command', 'outsideWrite']);
/** 릴리즈 목록(propose_release, 리더만)으로 한 장에 승인할 수 있는 명령 종류: 일반 명령·커밋(push 포함)·배포. 지우기·DB·파일 쓰기는 안 된다 (0.9.11) */
export const RELEASE_PLAN_KINDS = new Set(['command', 'commit', 'deploy']);
/** 릴리즈 목록에 넣을 수 없는 이유(쉬운 말). 넣어도 되면 null */
export function releaseCommandProblem(command: string, kind: string | undefined, gitWide?: string[]): string | null {
  if (!kind || !RELEASE_PLAN_KINDS.has(kind)) return '지우기·DB·파일 쓰기·작업 폴더 밖 쓰기는 릴리즈 목록에 넣을 수 없어요';
  if (gitWide?.length) return `폴더 전체를 바꾸는 git 명령(${gitWide.join('·')})은 릴리즈 목록에 넣을 수 없어요`;
  if (/\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(\s-[A-Za-z]*f[A-Za-z]*\b|\s--force|\s--mirror|\s--delete|\s-d\b|\s\+|\s:[^\s])/.test(command)) return '강제 push·원격 가지 지우기는 릴리즈 목록에 넣을 수 없어요';
  if (/\bgit\b[^;&|\n]*\b(add)\b[^;&|\n]*(\s-A\b|\s--all\b|\s\.(\s|$))/.test(command)) return 'git add -A · git add . 은 넣을 수 없어요(고친 파일 이름을 적어 주세요. 다른 과제의 변경이 섞일 수 있어요)';
  if (/\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*(\s--amend\b|\s-[A-Za-z]*a[A-Za-z]*\b)/.test(command)) return 'git commit --amend · -a 는 넣을 수 없어요(고친 파일만 git add 로 담아 주세요)';
  return null;
}

/** 실행 목록 승인에서 내용까지 묶어 둘 스크립트 파일 */
const SCRIPT_EXT = /\.(m?js|cjs|ts|mts|cts|tsx|jsx|py|sh|bash|zsh|rb|pl|php|sql|json|ya?ml|toml)$/i;
/** 자료·설정 파일(.json·.yaml·.toml): 내용은 묶지만 폴더 목록 지문에는 넣지 않는다 — 스크립트가 옆에 결과 파일(result.json 등)을 새로 써도 승인이 풀리지 않게 (0.9.10) */
const DATA_EXT = /\.(json|ya?ml|toml)$/i;

/** 명령에 들어 있는 스크립트 파일(있는 보통 파일)의 절대 경로. 내용이 바뀌면 다시 묻도록 지문을 묶는다 */
export function scriptFilesIn(command: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const raw of command.split(/[\s;&|()<>]+/)) {
    const w = raw.replace(/^['"]|['"]$/g, '');
    if (!w || w.startsWith('-') || !SCRIPT_EXT.test(w)) continue;
    const abs = path.resolve(cwd, expandHome(w));
    try {
      if (statSync(abs).isFile()) out.add(abs);
    } catch {
      // 없는 파일은 묶지 않는다(나중에 생기면 지문이 달라 다시 묻는다)
      out.add(abs);
    }
  }
  return [...out];
}

// ---- 실행 목록 지문 넓히기 (H3-A, 2026-11-15) ----
// 명령에 적힌 스크립트만 묶으면, 그 스크립트가 불러 쓰는 옆 파일(같은 폴더의 모듈·설정)이 승인 뒤 바뀌어도 다시 묻지 않았다.
// 스크립트가 있는 폴더 아래 2단계까지의 스크립트·설정 파일, 그 폴더의 파일 목록, npm 류·node 명령이면 package.json 도 함께 묶는다.
// 느려지지 않게 파일 수·크기에 상한을 둔다(넘는 것은 묶지 않음)
export const RELATED_MAX_FILES = 200;
const RELATED_MAX_DEPTH = 2;
const RELATED_MAX_FILE_BYTES = 1024 * 1024; // 한 파일 1MB 넘으면 묶지 않음
const RELATED_MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 모두 8MB 까지
const RELATED_SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.cache']);
/** npm 류·node 명령(실행 위치의 package.json 이 무엇을 실행할지 정함) */
const PKG_RUNNERS = /(^|[\s;&|(])(npm|npx|pnpm|pnpx|yarn|bun|bunx|node|tsx|ts-node|deno)(?=\s|$)/;
/** make 명령(실행 위치의 Makefile 이 무엇을 실행할지 정함) */
const MAKE_RUNNER = /(^|[\s;&|(])(make|gmake)(?=\s|$)/;
/** 폴더 목록 지문 표시(경로 끝의 /). 이 폴더에 묶을 파일이 새로 생기거나 없어지면 지문이 달라진다 */
const DIR_MARK = path.sep;

/**
 * 폴더 아래(2단계까지)의 스크립트·설정 파일.
 * names: 이름 전부(상한 없음, 크기를 재지 않는 가벼운 목록. 폴더 목록 지문에 쓴다 — 새 파일·없어진 파일은 몇 개든 알아챈다)
 * files: 내용 지문까지 묶을 파일(이름순, 200개·한 파일 1MB·모두 8MB 상한까지)
 * unbound: 상한에 걸려 내용까지 묶지 못한 파일 수(이름 목록에는 들어 있음)
 */
function relatedWalk(dir: string): { names: string[]; files: string[]; over: string[] } {
  const names: string[] = [];
  const files: string[] = [];
  const over: string[] = []; // 상한에 걸려 내용까지 묶지 못한 파일
  let total = 0;
  let level = [dir];
  // 리포 맨 위 폴더(.git 이 있는 곳)는 그 폴더에 바로 있는 파일만 본다: 두 단계 아래까지 묶으면 리더가 src 파일 하나만 고쳐도 승인이 풀린다 (0.9.10)
  const maxDepth = existsSync(path.join(dir, '.git')) ? 0 : RELATED_MAX_DEPTH;
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const d of level) {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!RELATED_SKIP_DIRS.has(e.name)) next.push(full); // 바로가기 폴더는 따라가지 않는다(isDirectory 가 false)
          continue;
        }
        if (!e.isFile() || !SCRIPT_EXT.test(e.name)) continue;
        if (!DATA_EXT.test(e.name)) names.push(full);
        if (files.length >= RELATED_MAX_FILES) {
          over.push(full);
          continue;
        }
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          over.push(full);
          continue;
        }
        if (size > RELATED_MAX_FILE_BYTES || total + size > RELATED_MAX_TOTAL_BYTES) {
          over.push(full);
          continue;
        }
        total += size;
        files.push(full);
      }
    }
    level = next;
  }
  return { names, files, over };
}

/** 글롭이 든 경로(dist/main/x/y.test.js 의 *)는 글롭 앞의 고정된 폴더 */
function fixedDir(abs: string): string {
  const at = abs.search(/[*?[{]/);
  if (at < 0) return path.dirname(abs);
  const slash = abs.lastIndexOf(path.sep, at);
  return slash <= 0 ? path.sep : abs.slice(0, slash);
}

/** 가장 가까운 package.json (실행 위치부터 위로). 없으면 실행 위치의 package.json(나중에 생기면 다시 묻도록) */
function nearestPackageJson(cwd: string): string {
  let cur = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    const p = path.join(cur, 'package.json');
    if (existsSync(p)) return p;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(path.resolve(cwd), 'package.json');
}

/**
 * 실행 목록 승인에 함께 묶을 파일(명령에 적힌 스크립트 말고). 폴더 목록 지문은 경로 끝에 / 를 붙여 넣는다.
 * primary: scriptFilesIn 결과
 */
export function relatedFilesFor(command: string, cwd: string, primary: string[] = scriptFilesIn(command, cwd)): string[] {
  return relatedInfoFor(command, cwd, primary).files;
}

/** relatedFilesFor 와 같고, 상한에 걸려 내용까지 묶지 못한 파일 수(unbound)도 함께. 이 파일들은 폴더 목록(이름)으로만 본다 */
export function relatedInfoFor(command: string, cwd: string, primary: string[] = scriptFilesIn(command, cwd)): { files: string[]; unbound: number } {
  const out = new Set<string>();
  let unbound = 0;
  // 맨 위 폴더(/ · /Users · 홈 폴더 자체)는 너무 넓어 훑지 않는다
  const dirs = [...new Set(primary.map(fixedDir))].filter((d) => d !== homedir() && d.split(path.sep).filter(Boolean).length >= 3);
  for (const d of dirs) {
    out.add(d.endsWith(DIR_MARK) ? d : d + DIR_MARK);
    const w = relatedWalk(d);
    for (const f of w.files) if (!primary.includes(f)) out.add(f);
    // 명령에 적힌 스크립트는 상한과 상관없이 내용을 따로 묶으므로 빼고 센다
    unbound += w.over.filter((f) => !primary.includes(f)).length;
  }
  if (PKG_RUNNERS.test(command)) out.add(nearestPackageJson(cwd));
  if (MAKE_RUNNER.test(command)) for (const n of ['GNUmakefile', 'makefile', 'Makefile']) out.add(path.join(path.resolve(cwd), n));
  for (const p of primary) out.delete(p);
  return { files: [...out], unbound };
}

/** 파일 지문(없으면 '-'). 경로 끝이 / 이면 그 폴더(2단계까지)의 스크립트·설정 파일 이름 전체 목록의 지문(상한 없음) */
export function fileFingerprint(abs: string): string {
  if (abs.endsWith(DIR_MARK) && abs.length > 1) {
    const dir = abs.slice(0, -1);
    try {
      if (!statSync(dir).isDirectory()) return '-';
    } catch {
      return '-';
    }
    return `dir:${createHash('sha256').update(relatedWalk(dir).names.map((f) => path.relative(dir, f)).join('\n')).digest('hex')}`;
  }
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return '-';
  }
}

export interface CommandGrant {
  command: string; // 글자 그대로
  cwd: string; // 실행 위치
  files: { path: string; hash: string; related?: boolean }[]; // 묶어 둔 스크립트 지문(related: 옆 파일·폴더 목록·package.json)
  release?: boolean; // 릴리즈 목록 승인(커밋·push·포장·배포 명령). 한 번 실행하면 없어진다
}

/** 실행 목록 승인에 묶을 지문 전체: 명령에 적힌 스크립트 + 옆 파일 (H3-A) */
export function grantFilesFor(command: string, cwd: string): CommandGrant['files'] {
  return grantInfoFor(command, cwd).files;
}

/** grantFilesFor 와 같고, 상한에 걸려 내용까지 묶지 못한 옆 파일 수(unbound)도 함께. 승인 카드에 사실대로 적는다 */
export function grantInfoFor(command: string, cwd: string): { files: CommandGrant['files']; unbound: number } {
  const primary = scriptFilesIn(command, cwd);
  const rel = relatedInfoFor(command, cwd, primary);
  return {
    files: [...primary.map((p) => ({ path: p, hash: fileFingerprint(p) })), ...rel.files.map((p) => ({ path: p, hash: fileFingerprint(p), related: true }))],
    unbound: rel.unbound,
  };
}

/** Grep 에 glob 이 없을 때 강제로 넣는 제외 패턴(.env, .env.local 등 이름이 .env 로 시작하는 파일) */
export const GREP_EXCLUDE_GLOB = '!.env*';
/** 검색 조건이 비밀 파일을 겨누는지 (.env 계열, 키 파일, 인증 폴더) */
const SECRET_AIM = /(^|[\/{,*])\.env|id_rsa|id_ed25519|\.ssh|\.aws|credentials/i;

const MSG_READ_ONLY = '이 미션은 읽기 전용이라 쓰기·실행을 할 수 없어요. 필요한 변경은 보고에 "승인이 필요한 일"로 적어 주세요.';
const MSG_BLOCKED = '이 위치는 비밀 정보가 있거나 다른 구역(회사·개인) 폴더라서 열 수 없어요. 우회하지 말고 필요하면 보고에 적어 주세요.';
const MSG_OUTSIDE = '이 미션의 작업 폴더와 참고 폴더 밖이라 열 수 없어요.';
const MSG_ROLE = '이 미션 팀에 없는 역할이라 부를 수 없어요. 팀 편성에 있는 역할만 불러 주세요.';
/** 검수 역할 하나를 한 과제에서 부를 수 있는 횟수(첫 검수 + 고친 부분 재검수) */
export const MAX_REVIEWS = 2;
/** 평소 검수 횟수: 한 번(사용자가 지시에 재검수·꼼꼼히 라고 하면 MAX_REVIEWS 번까지). 0.9.11 속도 개선 */
export const DEFAULT_REVIEWS = 1;
/** 지시에 이 말이 있으면 재검수까지(2번) */
export const MORE_REVIEW_RE = /재검수|꼼꼼|검수\S{0,6}\s?(두|2)\s?번|(두|2)\s?번\s?검수/;
const MSG_REVIEW_CAP = (n: number) => `이 검수 역할은 이번 과제에서 이미 ${n}번 확인했어요. 더 부르지 말고, 남은 지적은 직접 고치고 고친 곳을 직접 확인한 뒤 보고 "3. 검수"에 남은 지적과 처리한 내용을 적어 마무리하세요.`;
const MSG_TEAM = '먼저 request_approval 도구로 팀 구성안(누구에게 무엇을 맡길지)을 올려 승인받으세요.';
const MSG_PLAN = '이 과제는 기획 먼저예요. 안 2~3개와 권장안을 request_approval(kind: decision, planGate: true)로 올려 사용자가 고른 뒤에 작업 폴더를 고칠 수 있어요. 시안은 시안 폴더에 만들어 주세요.';
const MSG_REFS = '참고 폴더는 읽기만 할 수 있어요. 바꿀 내용은 보고에 적어 주세요.';
const MSG_UNKNOWN = '이 도구는 이 미션에서 쓸 수 없어요.';
const MSG_READ_TASK =
  '이 과제는 "읽고 정리만" 하기로 하고 시작했어요. 작업 폴더를 바꾸거나 지우거나 커밋하는 일은 할 수 없어요. 꼭 필요하면 리더가 팀 구성안을 readOnly 없이 다시 올려 승인받아야 해요.';

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
/**
 * 읽기만 하는 과제가 바로 읽을 수 있는 앱 기록 (S5-A, 2026-11-15).
 * 이 미션의 기록(runs/missions/<미션>/ 의 outputs·queue·state)과, 모든 미션이 같은 구역일 때만 앱 전체 기록(권한·승인함·사용량·사건).
 * 앱 전체 기록에는 다른 미션의 명령·파일 미리보기가 들어 있어, 다른 구역(회사↔개인) 미션이 있으면 넣지 않는다.
 * 비밀(runs/secrets)·대화 기록(conversation.json)·다른 미션 기록은 넣지 않는다. 파일 하나하나만 넣는다(폴더 통째 아님)
 */
export const APP_LOG_FILES = ['permissions.jsonl', 'approvals.json', 'usage.jsonl', 'events.jsonl'];
/** 모든 미션의 구역: 켜진 미션(config.missions) + rano.json 원본의 미션 전부(보관 포함). 원본의 구역 읽기는 config.ts 와 같게(personal 이 아니면 work) */
export function allMissionZones(config: RanoConfig): string[] {
  const raw = (config.raw as { missions?: unknown } | null | undefined)?.missions;
  const fromRaw = Array.isArray(raw) ? raw.filter((m) => m && typeof m === 'object').map((m) => ((m as { zone?: unknown }).zone === 'personal' ? 'personal' : 'work')) : [];
  return [...(config.missions ?? []).map((m) => m.zone), ...fromRaw];
}
export const MISSION_LOG_FILES = ['outputs.json', 'queue.json', 'state.json'];
export function appLogRoots(config: RanoConfig, mission: MissionConfig): string[] {
  const own = MISSION_LOG_FILES.map((f) => path.join(config.runsDir, 'missions', mission.id, f));
  // 보관한 미션(archived)도 앱 전체 기록에 그 미션의 명령·파일이 남아 있으므로 함께 본다(config.missions 는 보관 미션을 뺀 목록)
  const oneZone = allMissionZones(config).every((z) => z === mission.zone);
  return oneZone ? [...APP_LOG_FILES.map((f) => path.join(config.runsDir, f)), ...own] : own;
}

function checkReadPath(config: RanoConfig, mission: MissionConfig, raw: string, cwd: string, extraRoots: string[] = []): (LeaderDecision & { blocked?: string }) | null {
  const resolved = absPath(raw, cwd);
  const hit = blockedHit(config, resolved);
  if (hit) return { allow: false, reason: `차단 목록에 걸림: ${hit}`, message: MSG_BLOCKED, blocked: hit };
  const roots = [...allowedRoots(mission), path.join(config.runsDir, 'drafts', mission.id), path.join(config.rootDir, 'skills'), missionTmpDir(config, mission.id), ...extraRoots]; // 시안 폴더·스킬 보관함·이 미션 임시 폴더도 읽기 허용
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
  extraReadRoots: string[] = [], // 읽기만 과제의 앱 기록 파일(appLogRoots)
): LeaderDecision & { blocked?: string } {
  if (READ_TOOLS.has(toolName)) {
    const paths = readToolPaths(toolName, input, cwd);
    if (!paths) return { allow: false, reason: 'Read 경로 없음', message: '읽을 파일 위치가 비어 있어요.' };
    for (const p of paths) {
      const bad = checkReadPath(config, mission, p, cwd, extraReadRoots);
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
    if (isSubagent) return { allow: false, reason: '팀원이 다른 팀원을 부르려 함', message: '팀원 호출은 리더만 할 수 있어요.' };
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
  syncOnly?: boolean; // Bash 명령의 기록 바꾸기가 원격 최신 받아오기·보관/되살리기뿐인지
  netHosts?: string[]; // Bash 명령이 curl 로 여는 사이트(호스트). 승인되면 이 과제 동안 같은 사이트 읽기(GET)는 다시 묻지 않는다
  logTarget?: string; // Bash 기록용: 프로그램 끄기·지우기·인터넷 전송의 대상(끌 이름·지울 경로·보낼 호스트). 비밀 가림
  gitWide?: string[]; // Bash 명령에 든 작업 폴더 전체를 바꾸는 git 명령(stash·pull·checkout 등). 다른 과제가 돌 때 경고 카드로 (H4-A)
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
  commit: (m) => `${m.name} 변경 내용 기록(커밋)`,
  delete: () => '파일·폴더 지우기',
  db: () => '데이터베이스 바꾸기',
  deploy: () => '배포·운영 설정 바꾸기',
  write: (m) => `${m.name} 파일을 명령으로 바꾸기`,
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
export function bashTitle(mission: MissionConfig, kind: BashKind, b: Pick<BashDecision, 'risks' | 'programs' | 'writePaths' | 'syncOnly'>): string {
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
  if (kind === 'commit') cats.push([b.syncOnly ? `${mission.name} 원격 최신 받아오기(보관·되살리기 포함, 커밋 아님)` : BASH_TITLES.commit(mission), true]);
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
  commit: (m) => `${m.name} 작업 폴더에서 지금까지 바뀐 내용을 기록(커밋)하거나 올리거나 되돌리려고 해요`,
  delete: () => '파일이나 폴더를 지우려고 해요',
  db: () => '데이터베이스에 연결해 내용을 바꾸거나 구조를 바꾸려고 해요',
  deploy: () => '배포하거나 운영 설정을 바꾸려고 해요',
  write: (m) => `${m.name} 작업 폴더의 파일을 명령으로 바꾸려고 해요`,
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

// ------------------------------------------------------------------
// 믿는 미션 (2026-11-10 사용자 결정)
// 작업 리포 안 고치기·시험·아는 명령·폴더 안 스크립트 파일 실행은 승인 없이(모르는 프로그램·명령 글 속 코드·설치는 묻기). 커밋·push·삭제·DB·배포·리포 밖·인터넷 전송·프로그램 끄기·권한 바꾸기는 그대로 승인함
// ------------------------------------------------------------------

/** 믿는 미션이라도 승인함으로 보내는 판단 근거(리포 밖, 비밀, git 바꾸기, 관리자 권한, 경로를 알 수 없음, 실행 환경 바꾸기 등) */
const TRUST_ASK_REASON = /밖|비밀|차단|git|sudo|권한|바로가기|알 수 없|해석하지|너무 깊|압축|\bPATH\b|GIT_|NODE_OPTIONS|LD_|DYLD_|BASH_ENV|\bENV\b|IFS|npm_config|NPM_CONFIG|PYTHONSTARTUP|PYTHONPATH|RUBYOPT|RUBYLIB|PERL5|\bSHELL\b|\bEDITOR\b|\bPAGER\b|\bCC\b|\bCXX\b|RUSTC|CARGO_|GOFLAGS/;
/** 믿는 미션이라도 승인함으로 보내는 위험 표시 */
const TRUST_ASK_RISKS = new Set(['kill', 'network', 'mode', 'delete']);
/** 리포 안이라도 승인함으로 보내는 곳: git 내부(.git: 훅·설정), 에이전트 설정(.claude) */
const TRUST_ASK_PATH = /(^|\/)\.(git|claude)(\/|$)/;

/** 믿는 미션에서 이 경로 쓰기를 바로 허용하는지: 원래·실제 경로 모두 작업 리포 안이고 .git·.claude 밖 */
export function trustedRepoPath(mission: MissionConfig, abs: string): boolean {
  const cands = [...new Set([abs, real(abs)])];
  return cands.every((c) => mission.targets.some((t) => inAny(c, [t]) && !TRUST_ASK_PATH.test(path.relative(path.resolve(t), c))));
}

/** 믿는 미션에서 이 명령을 바로 허용하는지 (classifyBash 결과로 판단). scratch: 리포 말고 바로 쓸 수 있는 라노 공간(이 미션 임시 폴더·이 과제 시안 폴더) */
/** 믿는 미션에서 끌 수 있는 프로그램: 작업 폴더의 개발 서버(next dev·vite·npm run dev 등)만 */
const TRUST_DEV_SERVER = /^(npx\s+)?(next|vite|nuxt|astro|remix)\s+dev\b|^(npm|pnpm|yarn)\s+(run\s+)?dev\b/;
/** 믿는 미션에서 열어 볼 수 있는 주소: 이 맥 안(개발 서버 화면·API 확인) */
const TRUST_LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/;
/** 이 맥 안 주소라도 데이터를 보내거나 바꾸는 요청은 승인함으로(개발 서버가 운영 DB 에 붙어 있을 수 있음) */
const CURL_SENDS = /\bcurl\b[^;&|\n]*\s(-[a-zA-Z]*[dFT]\b|--data\S*|--form\S*|--upload-file|--json|-X\s*(?!GET\b|HEAD\b)\S+|--request\s*(?!GET\b|HEAD\b)\S+|-[a-zA-Z]*K\b|--config)/;

/** curl 이 받은 것을 파일로 남기는 옵션(-o /dev/null 은 빼고 본다) */
const CURL_WRITES = /\bcurl\b[^;&|\n]*\s(-[a-zA-Z]*[oODc]\b|--output\b|--remote-name\S*|--dump-header|--cookie-jar|--trace\S*|--stderr|--libcurl|--create-dirs)/;
/** -o·--output 말고 다른 파일을 남기는 옵션(쿠키·추적·설정 등) */
const CURL_NON_OUTPUT_WRITES = /\bcurl\b[^;&|\n]*\s(-[a-zA-Z]*[ODc]\b|--remote-name\S*|--dump-header|--cookie-jar|--trace\S*|--stderr|--libcurl|--output-dir|-[a-zA-Z]*o\S)/;
/** 받은 것을 실행 프로그램으로 넘기기 */
const PIPE_TO_CODE = /\|\s*(sudo\s+)?(env\s+)?(sh|bash|zsh|dash|ksh|fish|python\d*(\.\d+)?|node|deno|bun|perl|ruby|php|osascript|eval|source|xargs|tee)\b/;

/** 믿는 미션에서 그 위험 표시를 넘어갈 수 있는지: 개발 서버 끄기(pkill -f 패턴), 이 맥 안 주소 읽기(curl GET) */
function trustedRisk(r: { kind: string; program: string; targets: string[] }, command: string, okHosts?: ReadonlySet<string>): boolean {
  if (r.kind === 'kill') return r.program === 'pkill' && r.targets.length > 0 && r.targets.every((t) => TRUST_DEV_SERVER.test(t)) && /\bpkill\s+-f\s/.test(command);
  if (r.kind === 'network')
    return (
      r.program === 'curl' &&
      r.targets.length > 0 &&
      !CURL_SENDS.test(command) &&
      !PIPE_TO_CODE.test(command) &&
      // 이 맥 안 주소: 읽기만(파일로 남기지 않음). 이 과제에서 사용자가 승인한 사이트: 읽어서 파일로 받기(-o)까지(받는 곳은 쓰기 경로 판단을 그대로 거친다)
      (r.targets.every((t) => TRUST_LOCAL_HOST.test(t))
        ? !CURL_WRITES.test(command.replace(/\s(-o|--output)\s+\/dev\/null\b/g, ' '))
        : !!okHosts && r.targets.every((t) => okHosts.has(t) || TRUST_LOCAL_HOST.test(t)) && !CURL_NON_OUTPUT_WRITES.test(command))
    );
  return false;
}

/** 믿는 미션에서 넘어갈 수 있는 판단 근거: 원격 최신 이력 받기(git fetch. 작업 파일은 안 바뀜), 개발 서버 끄기·이 맥 안 주소 확인 */
const TRUST_OK_REASON = /^(git fetch \(받아오기\)|pkill \(판단이 필요한 명령\)|curl \(판단이 필요한 명령\))$/;

// ---- 믿는 미션의 "아는 명령"만 바로 (H1-A, 2026-11-15 사용자 결정) ----
// 믿는 미션이라도 ① 앱이 모르는 프로그램 ② 명령 글에 코드를 넣어 돌리기(node -e, python -c, sh -c, osascript, 파이프로 셸에 넘기기)
// ③ 인터넷에서 받아 설치·실행(npm install, npx 새 패키지, pip install, brew)은 승인함으로.
// 작업 폴더·시안·임시 폴더 안의 스크립트 파일 실행(node scripts/x.js, npm run 이름, make)과 시험·확인 명령은 그대로 바로.

/** 믿는 미션에서 바로 하는 아는 프로그램(빌드·시험·검사 도구, 셸 기본 명령). 앱이 따로 분류하는 명령(git·cat·rm 등)은 여기 없어도 된다 */
const TRUST_KNOWN_PROGRAMS = new Set([
  'make', 'gmake', 'cmake', 'ninja', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'esbuild', 'vite', 'next', 'nuxt', 'astro', 'webpack', 'rollup',
  'turbo', 'nx', 'electron', 'electron-builder', 'playwright', 'cargo', 'rustc', 'go', 'gcc', 'g++', 'clang', 'clang++', 'cc', 'swiftc', 'xcodebuild', 'gradle',
  'mvn', 'pytest', 'mypy', 'ruff', 'black', 'flake8', 'pylint', 'pyright',
  'set', 'wait', 'exit', 'false', ':', 'seq', 'expr', 'yes', 'tput', 'clear', 'nproc', 'whoami', 'id', 'hostname', 'sw_vers', 'arch', 'getconf',
  // 위험 표시로 따로 판단하는 것(개발 서버 끄기 pkill -f, 이 맥 안 주소 curl): trustedRisk 가 본다
  'pkill', 'curl',
]);
/** 아는 프로그램이라도 이 하위 명령은 설치·받기라 승인함으로 */
const TRUST_INSTALL_SUBS: Record<string, Set<string>> = {
  cargo: new Set(['install', 'add', 'login', 'publish']),
  go: new Set(['install', 'get']),
  playwright: new Set(['install', 'install-deps']),
};
/** 해석기: 글로 넘긴 코드 옵션(inline)·값을 따로 받는 옵션(value). 스크립트 파일이 없으면(입력으로 받은 코드) 승인함으로 */
interface InterpSpec {
  inline: RegExp;
  value?: RegExp; // 값을 따로 받는 긴 옵션(--require x · --require=x 둘 다)
  scriptFlag?: string; // 이 옵션 뒤가 스크립트 파일(php -f)
  noScriptOk?: (args: string[]) => boolean; // 스크립트 없이 돌아도 되는 꼴(node --test)
  // ---- 짧은 옵션 묶음(-Bc, -we, -Ic)을 글자 하나씩 본다 (검수 지적 H1, 2026-11-15) ----
  code?: string; // 이 글자가 묶음 안에 있으면 글로 넘긴 코드(python -c, ruby -e)
  valueChars?: string; // 이 글자 뒤(묶음의 나머지, 없으면 다음 낱말)가 값(python -m 모듈, node -r 모듈)
  attached?: string; // 이 글자 뒤 묶음의 나머지가 그 옵션의 값(perl -i.bak, ruby -0777). 다음 낱말은 안 먹는다
  askChars?: string; // 이 글자가 있으면 묻기(ruby·perl -S: PATH 에서 찾은 스크립트 실행)
}
/** 옵션 값이 코드·주소인지(data: · file: · http: 처럼 '글자:' 로 시작). 윈도 드라이브(C:\)는 아님 */
const codeLike = (v: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(v) && !/^[A-Za-z]:[\\/]/.test(v);
/** 값이 코드·주소가 아닌 옵션(시험 이름 찾기 글·제목) */
const PLAIN_VALUE_OPTS = new Set(['--test-name-pattern', '--test-skip-pattern', '--title', '--inspect-port', '--test-reporter-destination']);
const NODE_SPEC: InterpSpec = {
  inline: /^(-e|--eval|-p|--print|-i|--interactive|-pe|-ep)$|^--(eval|print)=/,
  value: /^(-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--input-type|--env-file|--title|--inspect-port|--test-reporter|--test-reporter-destination|--watch-path|--test-name-pattern|--test-skip-pattern|--test-concurrency|--test-timeout)$/,
  noScriptOk: (a) => a.includes('--test'),
  code: 'epi',
  valueChars: 'rC',
};
const SHELL_SPEC: InterpSpec = { inline: /^-[a-zA-Z]*[cis][a-zA-Z]*$/, value: /^[-+][oO]$/, code: 'cis', valueChars: 'oO' };
const INTERP: Record<string, InterpSpec> = {
  node: NODE_SPEC,
  nodejs: NODE_SPEC,
  tsx: NODE_SPEC,
  'ts-node': NODE_SPEC,
  sh: SHELL_SPEC,
  bash: SHELL_SPEC,
  zsh: SHELL_SPEC,
  dash: SHELL_SPEC,
  ksh: SHELL_SPEC,
  fish: { inline: /^(-c|--command|-i|--interactive)$|^--command=/, code: 'ci' },
  python: { inline: /^-c|^-i$/, value: /^-[WX]$/, code: 'ci', valueChars: 'mWX' },
  ruby: { inline: /^-e|^--eval/, value: /^-[rICEF]$/, code: 'e', valueChars: 'rICEF', attached: '0ixKTW', askChars: 'S' },
  perl: { inline: /^-[eE]/, value: /^-[IMm]$/, code: 'eE', valueChars: 'IMm', attached: '0CdDilxF', askChars: 'S' },
  php: { inline: /^-[raRBEF]$/, value: /^-[cdzSt]$/, scriptFlag: '-f', noScriptOk: (a) => a.includes('-S'), code: 'raRBEF', valueChars: 'cdzSt' },
  lua: { inline: /^-[ei]$/, value: /^-l$/, code: 'ei', valueChars: 'l' },
  Rscript: { inline: /^(-e|--expr)/, code: 'e' },
  expect: { inline: /^-[ci]$/, code: 'ci' },
  tclsh: { inline: /^$/ },
  swift: { inline: /^-e$/, noScriptOk: (a) => ['build', 'test', 'run', 'package'].includes(a[0] ?? ''), code: 'e' },
};
/** 이름에 맞는 해석기 규칙(python3.12 · ruby3 포함). Object 기본 이름(constructor 등)에는 맞지 않게 */
function interpSpec(name: string): InterpSpec | undefined {
  if (Object.prototype.hasOwnProperty.call(INTERP, name)) return INTERP[name];
  if (/^python\d+(\.\d+)?$/.test(name)) return INTERP.python;
  if (/^ruby\d/.test(name)) return INTERP.ruby;
  return undefined;
}
/** python -m 으로 바로 돌려도 되는 모듈(시험·검사) */
const PY_MODULES_OK = new Set(['venv', 'pytest', 'unittest', 'mypy', 'ruff', 'black', 'flake8', 'pylint', 'pyflakes', 'py_compile', 'compileall', 'doctest', 'json.tool', 'tabnanny']);
/** 늘 승인함: 글로 넘긴 코드를 그대로 실행하거나 다른 앱을 조종 */
const TRUST_ALWAYS_ASK = new Set(['eval', 'osascript', 'pipx', 'brew', 'pip', 'pip3', 'gem', 'uv', 'poetry', 'conda']);
/** 넘겨받은 글을 명령으로 돌려 주는 도구(설치돼 있어도 묻는다): 안쪽 명령(push·rm·curl)을 앱이 보지 못한다 (0.9.10) */
const TRUST_RUNNER_TOOLS = new Set([
  'concurrently', 'conc', 'nodemon', 'cross-env', 'cross-env-shell', 'dotenv', 'dotenv-cli', 'env-cmd', 'npm-run-all', 'npm-run-all2', 'run-s', 'run-p', 'wait-on',
  'start-server-and-test', 'server-test', 'start-test', 'onchange', 'chokidar', 'watch', 'zx', 'shx', 'execa', 'pm2', 'forever', 'husky', 'lint-staged', 'lerna', 'wireit',
  'if-env', 'run-script-os', 'cross-var', 'npx', 'node-gyp',
]);
/** 설치된 도구에 넘긴 인자가 명령 글처럼 보이는지: 빈칸·셸 기호가 든 낱말(따옴표로 묶어 넘긴 명령), 명령을 받는 옵션 */
function looksLikeCommandArg(args: string[]): string | null {
  for (const a of args) {
    if (/^(--exec|--command|--cmd|--shell|--on-success|--on-failure|--onSuccess|--onFailure|--onFirstSuccess|-x)(=|$)/.test(a)) return a.replace(/=.*$/, '');
    if (/[\s;&|`$<>]/.test(a)) return clip(a, 40);
  }
  return null;
}
/** pnpm·yarn·bun 에서 하위 명령 앞에 올 수 있는 값 없는 옵션(이 밖의 옵션이 앞에 오면 하위 명령을 잘못 읽을 수 있어 묻는다) */
const PM_FLAGS = new Set(['-r', '--recursive', '-s', '--silent', '--parallel', '--stream', '--if-present', '--aggregate-output', '--no-bail', '--bail', '-A', '--all', '-p', '-t', '--topological', '-v', '--verbose', '-i', '--interlaced', '-R', '-W', '--worktree', '-w', '--workspace-root', '--color', '--no-color']);
/** 값을 따로 받는 옵션(--filter 이름 · -F 이름) */
const PM_VALUE_OPTS = new Set(['--filter', '-F', '--filter-prod', '--include', '--exclude', '--from', '--since', '-j', '--jobs', '--workspace-concurrency', '--reporter', '--loglevel']);

/** npm 류에서 바로 되는 하위 명령(패키지 스크립트 실행·목록 보기) */
const NPM_OK_SUBS = new Set(['run', 'run-script', 'test', 't', 'start', 'ls', 'list', 'why', 'explain', 'help']);
/** pnpm·yarn 에서 설치·설정·받기 하위 명령(그 밖의 낱말은 패키지 스크립트 이름으로 본다) */
const PM_RISKY_SUBS = new Set([
  'add', 'install', 'i', 'ci', 'up', 'update', 'upgrade', 'remove', 'rm', 'uninstall', 'link', 'unlink', 'dlx', 'global', 'config', 'set', 'plugin', 'npm',
  'policies', 'import', 'unplug', 'patch', 'patch-commit', 'version', 'init', 'create', 'cache', 'dedupe', 'rebuild', 'setup', 'env', 'self-update', 'store',
  'fetch', 'prune', 'publish', 'pm', 'x',
]);
/** npm 류 옵션 중 다른 폴더·전역·설정을 쓰게 하는 것 */
const PM_RISKY_OPTS = /^(--prefix|-C|--dir|--cwd|-g|--global|--location|--userconfig|--globalconfig|--script-shell|--node-options|--registry)(=|$)/;

/** 실행 위치·스크립트가 작업 폴더·시안·임시 폴더 안인지(원래·실제 경로 모두) */
function insideRoots(abs: string, roots: string[]): boolean {
  return roots.some((r) => insideBoth(abs, r));
}

/** 경로가 아니라 코드·파일 주소로 읽히는 인자 머리(data:text/javascript,… · file:///… · javascript:…) */
const CODE_URL = /^(data|file|javascript|blob|jar|vbscript):/i;
/** 인터넷 주소 머리(http:// 등). curl 말고 다른 프로그램에 넘기면 받아 실행할 수 있어 묻는다 */
const NET_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 경로처럼 보이는 인자(/·~·.. 로 시작하거나 / 가 든 것)가 모두 읽기·쓰기 허용 폴더 안인지. 밖이면 쉬운 말 이유.
 * --옵션=값 · 이름=값(php -d auto_prepend_file=…, make X=…) 은 = 뒤 값도 본다.
 * data: · file: 같은 코드·파일 주소는 경로가 아니라 코드로 보고 묻는다. 인터넷 주소는 curl(위험 표시로 따로 판단)만 넘어간다
 */
function outsidePathArg(args: string[], cwd: string, allowed: string[], program = ''): string | null {
  for (const a of args) {
    const vals: string[] = [];
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (eq < 0) {
        // 짧은 옵션에 붙여 쓴 경로(-o/tmp/x · -I../밖 · -C~/x)도 본다
        const att = /^-[A-Za-z]((?:\/|~|\.\.?\/).*)$/.exec(a)?.[1];
        if (att) vals.push(att);
        else continue;
      } else vals.push(a.slice(eq + 1));
    } else {
      vals.push(a);
      const eq = a.indexOf('=');
      if (eq > 0 && /^[A-Za-z_.][A-Za-z0-9_.-]*$/.test(a.slice(0, eq))) vals.push(a.slice(eq + 1));
    }
    for (const v of vals) {
      if (!v || v.startsWith('@') || v === '/dev/null') continue;
      if (CODE_URL.test(v)) return `코드·파일 주소를 인자로 넘김: ${clip(v, 40)}`;
      if (NET_URL.test(v)) {
        // curl 은 위험 표시(trustedRisk)로 따로 판단, 이 맥 안 주소(개발 서버 화면 확인 등)는 경로가 아니라 넘어간다
        if (program === 'curl' || TRUST_LOCAL_HOST.test(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@\/\s]*@)?(\[[^\]]*\]|[^\/:\s?#]+)/i.exec(v)?.[1] ?? '')) continue;
        return `인터넷 주소를 인자로 넘김: ${clip(v, 60)}`;
      }
      if (!(v.startsWith('/') || v.startsWith('~') || v.includes('/') || v === '..')) continue;
      const abs = path.resolve(cwd, expandHome(v));
      if (!insideRoots(abs, allowed)) return `작업 폴더 밖 경로를 넘김: ${displayPath(abs)}`;
    }
  }
  return null;
}

/** 이름으로 따로 보는 프로그램인지(해석기·npm 류·감싸는 명령·아는 프로그램). 경로를 붙여 불러도 이 검사를 그대로 한다 */
function namedRunRule(name: string): boolean {
  return (
    !!interpSpec(name) ||
    TRUST_ALWAYS_ASK.has(name) ||
    TRUST_KNOWN_PROGRAMS.has(name) ||
    ['source', '.', 'timeout', 'gtimeout', 'npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'command', 'ps'].includes(name)
  );
}

/** ps 가 환경 변수까지 보이는지(맥 ps -e · BSD 꼴 e · -E). 값을 받는 옵션(-o 형식 · -p 번호 · -U 사용자 등) 뒤 낱말은 건너뛴다 */
function psShowsEnv(args: string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!/^-?[A-Za-z]+$/.test(a)) continue;
    // 맥 ps 에서 -e 는 "모든 프로세스"(-A), 환경 변수가 보이는 것은 대시 없는 e 와 -E
    if (a.startsWith('-') ? /E/.test(a) : /[eE]/.test(a)) return true;
    if (/^-[A-Za-z]*[oOpUuGgt]$/.test(a)) k++;
  }
  return false;
}

/** 실제로 있는 보통 파일인지(바로가기는 따라간 곳 기준) */
function isRegularFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** 지금 폴더부터 위로(허용 폴더 안에서만) node_modules/.bin/<이름> 이 있는지: 이미 설치된 도구인지 */
function localBin(bin: string, cwd: string, roots: string[]): boolean {
  if (!/^[A-Za-z0-9._@-][A-Za-z0-9._\/@-]*$/.test(bin)) return false;
  const name = bin.startsWith('@') ? bin.split('/')[1] ?? '' : bin.split('@')[0];
  if (!name || name.includes('/')) return false;
  let cur = path.resolve(cwd);
  for (let i = 0; i < 12 && insideRoots(cur, roots); i++) {
    if (existsSync(path.join(cur, 'node_modules', '.bin', name))) return true;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return false;
}

/**
 * 믿는 미션에서 이 프로그램 실행을 바로 해도 되는지. 괜찮으면 null, 아니면 쉬운 말 이유.
 * roots: 작업 폴더 + 시안·임시 폴더(스크립트·실행 위치가 있어도 되는 곳), allowed: roots + 읽기 허용 폴더(경로 인자가 가리켜도 되는 곳)
 * localTool: npx·pnpm exec 로 이미 설치된 도구를 부른 것(모르는 이름이어도 설치된 개발 도구로 본다)
 */
export function trustedRunProblem(run: BashRun, roots: string[], allowed: string[] = roots, depth = 0, localTool = false): string | null {
  if (depth > 3) return '명령을 너무 여러 겹 감쌈';
  const { name, args, cwd } = run;
  const outside = () => outsidePathArg(args, cwd, allowed, name);
  // 경로를 붙여 부른 프로그램(./scripts/x.sh, tools/run): 작업 폴더·시안·임시 폴더 안의 스크립트 파일이면 실행, 밖이면 묻는다.
  // 이름이 해석기·npm 류·아는 프로그램이면(.venv/bin/python, node_modules/.bin/tsx) 아래에서 이름으로 같은 검사(코드 옵션 등)를 한 번 더 한다
  if (run.word.includes('/')) {
    if (!insideRoots(path.resolve(cwd, expandHome(run.word)), roots)) return `작업 폴더 밖 프로그램 실행: ${displayPath(path.resolve(cwd, expandHome(run.word)))}`;
    if (run.viaXargs) return 'xargs 로 받은 인자로 스크립트 실행';
    if (!namedRunRule(name)) return outside();
  }
  // 읽기만 하는 아는 명령: 프로그램 위치 보기(command -v 이름), 프로세스 목록(ps. 환경 변수까지 보이는 e·E 옵션만 묻기)
  if (name === 'command') return /^-[vV]$/.test(args[0] ?? '') && args.length >= 2 ? null : 'command 로 감싼 명령';
  if (name === 'ps') return psShowsEnv(args) ? 'ps 로 환경 변수 보기(비밀이 보일 수 있음)' : null;
  if (TRUST_ALWAYS_ASK.has(name)) return name === 'eval' || name === 'osascript' ? `명령 글에 코드를 넣어 실행(${name})` : `설치 도구(${name})`;
  // 감싸는 명령: timeout 60 npm test → 안쪽 명령으로 판단
  if (name === 'timeout' || name === 'gtimeout') {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k += /^-(s|k)$|^--(signal|kill-after)$/.test(args[k]) ? 2 : 1;
    const inner = args.slice(k + 1);
    if (!inner.length) return null;
    return trustedRunProblem({ ...run, name: path.basename(inner[0]), word: inner[0], args: inner.slice(1) }, roots, allowed, depth + 1);
  }
  // 이미 설치된 도구를 부르는 npx·pnpx·bunx·pnpm exec·yarn exec·npm exec
  const npxLike = (rest: string[], who: string): string | null => {
    let k = 0;
    for (; k < rest.length && rest[k].startsWith('-'); k++) {
      if (/^(-y|--yes|-p|--package|-c|--call|--shell)(=|$)/.test(rest[k])) return `${who} 로 설치되지 않은 패키지를 받아 실행하거나 글로 넘긴 명령 실행`;
      if (rest[k] === '--') {
        k++;
        break;
      }
    }
    const pkg = rest[k];
    if (!pkg) return `${who} 로 실행할 것이 없음`;
    if (pkg.includes('/') && !pkg.startsWith('@')) return trustedRunProblem({ ...run, name: path.basename(pkg), word: pkg, args: rest.slice(k + 1) }, roots, allowed, depth + 1);
    if (run.viaXargs) return `xargs 로 받은 인자로 ${who} 실행`;
    // 이름@버전(tsx@4 · @scope/x@1): 설치된 것과 버전이 다르면 인터넷에서 받아 실행한다
    if ((pkg.startsWith('@') ? pkg.indexOf('@', 1) : pkg.indexOf('@')) > 0) return `${who} 로 버전을 붙인 패키지를 인터넷에서 받아 실행할 수 있음: ${pkg}`;
    if (!localBin(pkg, cwd, roots)) return `${who} 로 설치되지 않은 패키지를 인터넷에서 받아 실행: ${pkg}`;
    const bin = pkg.startsWith('@') ? pkg.split('/')[1] ?? pkg : pkg.split('@')[0];
    return trustedRunProblem({ ...run, name: bin, word: bin, args: rest.slice(k + 1) }, roots, allowed, depth + 1, true);
  };
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') return npxLike(args, name);
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    if (args.some((a) => PM_RISKY_OPTS.test(a))) return `${name} 에 다른 폴더·전역·설정을 쓰는 옵션`;
    if (name === 'bun' && args.some((a) => /^(-e|--eval|-p|--print)(=|$)/.test(a))) return '명령 글에 코드를 넣어 실행(bun -e)';
    let words = args.filter((a) => !a.startsWith('-'));
    let sub = words[0] ?? '';
    if (name !== 'npm') {
      // 하위 명령 앞 옵션: 값 없는 아는 옵션과 값을 받는 옵션(--filter 이름)만. 모르는 옵션이 앞에 오면 그 값이 하위 명령으로 읽힐 수 있어 묻는다 (0.9.10)
      let k = 0;
      for (; k < args.length && args[k].startsWith('-'); k++) {
        const key = args[k].replace(/=.*$/, '');
        if (PM_VALUE_OPTS.has(key)) {
          if (!args[k].includes('=')) k++;
        } else if (!PM_FLAGS.has(key)) return `${name} 하위 명령 앞에 앱이 모르는 옵션: ${clip(args[k], 30)}`;
      }
      const tail = args.slice(k);
      // 하위 명령 뒤의 옵션 값도 낱말에서 뺀다(pnpm run --filter 이름 build)
      words = tail.filter((a, j) => !a.startsWith('-') && !(j > 0 && PM_VALUE_OPTS.has(tail[j - 1])));
      sub = words[0] ?? '';
      // yarn workspace 이름 명령… · yarn workspaces foreach 명령…: 안쪽 명령으로 다시 본다
      if (name === 'yarn' && (sub === 'workspace' || sub === 'workspaces')) {
        const at = args.indexOf(sub);
        const inner = sub === 'workspace' ? args.slice(args.indexOf(words[1] ?? '', at + 1) + 1) : args.slice(at + 2);
        if (sub === 'workspaces' && words[1] !== 'foreach') return words[1] === 'list' ? null : `yarn workspaces ${words[1] ?? ''} (앱이 모르는 하위 명령)`;
        if (sub === 'workspace' && !words[1]) return 'yarn workspace 이름 없음';
        return trustedRunProblem({ ...run, args: inner }, roots, allowed, depth + 1);
      }
    }
    if (name === 'npm') {
      if (sub === 'exec' || sub === 'x') return npxLike(args.slice(args.indexOf(sub) + 1), 'npm exec');
      if (!NPM_OK_SUBS.has(sub)) return sub ? `npm ${sub} (설치·설정·바꾸기일 수 있음)` : 'npm 하위 명령 없음';
      return outside();
    }
    if (!sub) return name === 'yarn' ? 'yarn (패키지 설치)' : `${name} 하위 명령 없음`;
    if (sub === 'exec' || (name === 'bun' && sub === 'x')) return npxLike(args.slice(args.indexOf(sub) + 1), `${name} ${sub}`);
    if (PM_RISKY_SUBS.has(sub)) return `${name} ${sub} (설치·설정·받기일 수 있음)`;
    const target = sub === 'run' || sub === 'run-script' ? words[1] ?? '' : sub;
    // bun <파일> · bun run <파일>: 스크립트 파일이면 위치와 실제로 있는 파일인지 본다
    if (name === 'bun' && target && /\.[cm]?[jt]sx?$/.test(target)) {
      const f = path.resolve(cwd, expandHome(target));
      if (!insideRoots(f, roots)) return `작업 폴더 밖 스크립트 실행: ${target}`;
      if (!isRegularFile(f)) return `스크립트 파일이 없음: ${target}`;
    }
    // yarn node -e … · pnpm tsx -e … · yarn run tsx …: 스크립트 이름이 아니라 해석기·설치된 도구를 부르는 꼴은 그 프로그램으로 다시 본다
    if (target) {
      const after = args.slice(args.indexOf(target) + 1);
      if (interpSpec(target) || target === 'deno') return trustedRunProblem({ ...run, name: target, word: target, args: after }, roots, allowed, depth + 1);
      if (localBin(target, cwd, roots)) return trustedRunProblem({ ...run, name: target, word: target, args: after }, roots, allowed, depth + 1, true);
    }
    return outside();
  }
  if (name === 'deno') {
    const sub = args[0] ?? '';
    if (['eval', 'repl', ''].includes(sub)) return '명령 글에 코드를 넣어 실행(deno)';
    if (!['run', 'test', 'check', 'lint', 'fmt', 'task', 'bench'].includes(sub)) return `deno ${sub} (설치·받기일 수 있음)`;
    if (sub === 'run') {
      const script = args.slice(1).find((a) => !a.startsWith('-'));
      if (!script || script === '-') return '입력으로 받은 코드를 실행(deno run)';
      if (/^[a-z]+:/i.test(script)) return `인터넷 주소의 코드를 받아 실행(deno run ${script})`;
      const f = path.resolve(cwd, expandHome(script));
      if (!insideRoots(f, roots)) return `작업 폴더 밖 스크립트 실행: ${script}`;
      if (!isRegularFile(f)) return `스크립트 파일이 없음: ${script}`;
    }
    return outside();
  }
  // 해석기: 스크립트 파일이 작업 폴더·시안·임시 폴더 안에 실제로 있어야 하고, 글로 넘긴 코드·입력으로 받은 코드는 묻는다
  const spec = interpSpec(name);
  if (spec || name === 'source' || name === '.') {
    if (run.viaXargs) return `xargs 로 받은 인자로 코드 실행(${name})`;
    const codeMsg = (x: string) => `명령 글에 코드를 넣어 실행(${name} ${x.slice(0, 12)})`;
    const valueMsg = (x: string, v: string) => `명령 글에 코드·주소를 넣어 실행(${name} ${x.slice(0, 12)} ${clip(v, 40)})`;
    /** python -m 모듈: 시험·검사 모듈만 */
    const pyModule = (mod: string) =>
      !PY_MODULES_OK.has(mod) ? (mod === 'pip' || mod === 'ensurepip' ? `설치 도구(${name} -m ${mod})` : `${name} -m ${mod || '(모듈 없음)'} (앱이 모르는 모듈)`) : outside();
    // 버전·도움말만 보기(python3 --version · bash --version): 코드를 실행하지 않는다. -v 는 해석기마다 뜻이 달라 넣지 않는다
    if (spec && args.length === 1 && /^(--version|-V|--help)$/.test(args[0])) return null;
    let k = 0;
    if (spec) {
      if ((name === 'tsx' && args[0] === 'watch') || (name === 'swift' && spec.noScriptOk?.(args))) k = 1;
      for (; k < args.length; k++) {
        const x = args[k];
        if (x === '--') {
          k++;
          break;
        }
        if (!x.startsWith('-') || x === '-') break;
        if (spec.inline.test(x)) return codeMsg(x);
        if (spec.scriptFlag && x === spec.scriptFlag) continue;
        // perl -M모듈 · -m모듈: 모듈 이름(과 =불러올 이름)만. 그 밖의 글자(; 공백 괄호 등)는 코드로 읽힌다(-M'strict;system(…)')
        if (spec === INTERP.perl && /^-[Mm]/.test(x)) {
          const mod = x.length > 2 ? x.slice(2) : args[++k] ?? '';
          if (!/^-?[A-Za-z_][A-Za-z0-9_:]*(=[A-Za-z0-9_:,]+)?$/.test(mod)) return codeMsg(x);
          continue;
        }
        // 짧은 옵션 묶음(-Bc · -Ic · -we · -m · -r): 글자 하나씩. 코드 글자가 있으면 묻고, 값 글자면 값(나머지 또는 다음 낱말)을 본다
        const cluster = /^-([A-Za-z0-9]+)$/.exec(x)?.[1];
        if (cluster && (spec.code || spec.valueChars || spec.askChars)) {
          let valueChar = '';
          let value = '';
          for (let j = 0; j < cluster.length; j++) {
            const ch = cluster[j];
            if (spec.code?.includes(ch)) return codeMsg(x);
            if (spec.askChars?.includes(ch)) return `${name} -${ch} (PATH 에서 찾은 스크립트 실행)`;
            if (spec.valueChars?.includes(ch)) {
              valueChar = ch;
              value = cluster.slice(j + 1);
              if (!value) value = args[++k] ?? '';
              break;
            }
            if (spec.attached?.includes(ch)) break;
          }
          if (valueChar === 'm' && spec === INTERP.python) return pyModule(value);
          if (valueChar && codeLike(value) && !(spec === INTERP.php && valueChar === 'S')) return valueMsg(x, value); // php -S localhost:8000 은 주소가 아니라 듣는 자리
          continue;
        }
        // 긴 옵션: --require x · --require=x
        const eq = x.indexOf('=');
        const key = eq < 0 ? x : x.slice(0, eq);
        if (spec.value?.test(key)) {
          const value = eq < 0 ? args[++k] ?? '' : x.slice(eq + 1);
          if (!PLAIN_VALUE_OPTS.has(key) && codeLike(value)) return valueMsg(key, value);
        }
      }
    }
    const script = args[k];
    if (!script || script === '-') return spec?.noScriptOk?.(args) ? outside() : `입력으로 받은 코드를 실행(${name})`;
    const scriptAbs = path.resolve(cwd, expandHome(script));
    if (!insideRoots(scriptAbs, roots)) return `작업 폴더 밖 스크립트 실행: ${displayPath(scriptAbs)}`;
    // 스크립트 자리 낱말은 실제로 있는 보통 파일만(없는 이름은 해석기에 따라 코드·PATH 의 프로그램으로 읽힐 수 있음).
    // node --test·swift build 처럼 스크립트 없이 도는 꼴은 낱말이 시험 파일 글롭·하위 명령이라 위치만 본다
    if (!spec?.noScriptOk?.(args) && !isRegularFile(scriptAbs)) return `스크립트 파일이 없음(있는 파일만 바로 실행): ${clip(script, 60)}`;
    return outside();
  }
  if (TRUST_KNOWN_PROGRAMS.has(name) || localTool) {
    // 설치된 도구(npx 이름 · pnpm 이름)라도 넘긴 글을 명령으로 돌려 주는 도구, 명령 글처럼 보이는 인자는 묻는다 (0.9.10)
    if (localTool && !TRUST_KNOWN_PROGRAMS.has(name)) {
      if (TRUST_RUNNER_TOOLS.has(name)) return `넘긴 명령을 대신 돌려 주는 도구(${name}): 안쪽 명령을 앱이 보지 못함`;
      const c = looksLikeCommandArg(args);
      if (c) return `설치된 도구(${name})에 명령 글처럼 보이는 인자를 넘김: ${c}`;
    }
    // electron -e 코드 · -r 모듈 · -i: node 와 같은 글 속 코드
    if (name === 'electron' && args.some((a) => /^(-e|--eval|-p|--print|-i|--interactive|-r|--require)(=|$)/.test(a))) return '명령 글에 코드를 넣어 실행(electron)';
    // mvn exec:exec · -Dexec.executable=프로그램: 다른 프로그램 실행
    if ((name === 'mvn' || name === 'gradle') && args.some((a) => /^exec:|^-Dexec\.|^--init-script|^-I$/.test(a))) return `${name} 로 다른 프로그램 실행(exec)`;
    const subs = Object.prototype.hasOwnProperty.call(TRUST_INSTALL_SUBS, name) ? TRUST_INSTALL_SUBS[name] : undefined;
    const sub = args.find((a) => !a.startsWith('-'));
    if (subs && sub && subs.has(sub)) return `${name} ${sub} (설치·받기)`;
    // go run 모듈@버전: 인터넷에서 받아 실행
    if (name === 'go' && sub === 'run' && args.some((a) => !a.startsWith('-') && a.includes('@'))) return `go run 으로 버전을 붙인 원격 모듈을 받아 실행: ${clip(args.find((a) => !a.startsWith('-') && a.includes('@')) ?? '', 60)}`;
    // make --eval '규칙' · make -E '규칙': 명령 글에 규칙(셸 명령)을 넣어 실행
    if ((name === 'make' || name === 'gmake') && args.some((a) => /^--eval(=|$)/.test(a) || /^-[A-Za-z]*E/.test(a))) return `명령 글에 코드를 넣어 실행(${name} --eval)`;
    // make 이름=값: Makefile 설정값(CC·SHELL 등)을 덮어써 다른 명령을 돌릴 수 있어 값과 상관없이 묻는다
    if (name === 'make' || name === 'gmake') {
      const over = args.find((a) => !a.startsWith('-') && a.includes('='));
      if (over) return `${name} 설정값 덮어쓰기(다른 명령을 돌릴 수 있음): ${clip(over, 60)}`;
    }
    // go -exec · -toolexec · -vettool (=값 꼴 포함): 빌드·시험·검사 중에 다른 프로그램을 돌린다
    if (name === 'go') {
      const ex = args.find((a) => /^--?(exec|toolexec|vettool)(=|$)/.test(a));
      if (ex) return `go ${ex.replace(/=.*$/, '')} 로 다른 프로그램 실행`;
      // go env -w/-u: 사용자 전체 go 설정(작업 폴더 밖)을 영구로 바꿔 뒤의 go test 등에 -toolexec 같은 값을 심을 수 있다
      if (sub === 'env' && args.some((a) => /^--?[wu]$/.test(a))) return 'go env 로 사용자 전체 go 설정 바꾸기';
      if (sub === 'clean' && args.some((a) => /^--?modcache$/.test(a))) return 'go clean -modcache (작업 폴더 밖 모듈 저장소 지우기)';
    }
    // make -f - : 명령 글(입력)로 넘긴 규칙을 실행 — --eval 과 같은 종류
    if ((name === 'make' || name === 'gmake') && args.some((a, k) => /^--(file|makefile)=-$/.test(a) || /^-[A-Za-z]*f-$/.test(a) || ((/^-[A-Za-z]*f$/.test(a) || a === '--file' || a === '--makefile') && args[k + 1] === '-'))) return `명령 글에 규칙을 넣어 실행(${name} -f -)`;
    // cmake -E(명령 대신 실행)·-D(컴파일러 등 설정 덮어쓰기), cargo --config(runner·wrapper 바꾸기), nx exec(넘긴 명령 실행)
    if (name === 'cmake' && args.some((a) => a === '-E' || a.startsWith('-D'))) return 'cmake -E·-D 로 다른 명령을 돌릴 수 있음';
    if (name === 'cargo' && args.some((a) => /^--config(=|$)/.test(a))) return 'cargo --config 로 실행 도구를 바꿀 수 있음';
    if (name === 'nx' && sub === 'exec') return 'nx exec 로 넘긴 명령 실행';
    return outside();
  }
  return `앱이 모르는 프로그램: ${name}`;
}

/** 믿는 미션이라도 승인함으로 보내는 판단 근거 중 "명령 글에 코드를 넣어 돌리기"에 해당하는 것(sed e·awk system·find -exec·heredoc 속 명령 치환 등) */
const TRUST_INLINE_REASON = /^(sed|awk) \(쓰기·실행이 섞였을 수 있음\)$|^find 로 다른 명령 실행|^명령 이름에 '=' 또는 '\['|^heredoc 본문에 변수·명령 치환|^heredoc 끝 표시가 없음/;

/**
 * 감싸는 명령(env·nice·exec·command) 판단 근거. 안쪽 명령이 확인 명령이면 실행 기록(runs)이 남지 않아 따로 본다.
 * nohup 은 끊김 신호만 막아 개발 서버 다시 켜기(nohup npm run dev &)에 쓰므로 뺀다. 다만 nohup·time 뒤에 설정값을 붙이면 묻는다
 */
const TRUST_WRAP_REASON = /^(env|nice|exec|command) 로 감싼 명령$|^(env|nice|nohup|exec|command|time) 뒤에 설정값을 붙여 실행$/;

/** 믿는 미션에서 이 명령을 바로 하지 않는 이유. 바로 해도 되면 null */
export function trustedBashProblem(
  mission: MissionConfig,
  kind: BashKind,
  b: Pick<BashDecision, 'reasons' | 'writePaths' | 'risks' | 'linkSources' | 'modeChange' | 'runs'>,
  scratch: string[] = [],
  command = '',
  okHosts?: ReadonlySet<string>,
  readRoots: string[] = [],
): string | null {
  if (kind !== 'write' && kind !== 'command') return '커밋·삭제·DB·배포·작업 폴더 밖 쓰기'; // 그대로 승인함
  if (b.modeChange || (b.linkSources ?? []).length) return '권한 바꾸기·바로가기 만들기';
  const r1 = (b.risks ?? []).find((r) => TRUST_ASK_RISKS.has(r.kind) && !trustedRisk(r, command, okHosts));
  if (r1) return r1.kind === 'network' ? '인터넷으로 보내기·받기' : r1.kind === 'kill' ? '프로그램 끄기' : r1.kind === 'delete' ? '지우기' : '권한 바꾸기';
  const r2 = b.reasons.find((r) => TRUST_ASK_REASON.test(r) && !TRUST_OK_REASON.test(r));
  if (r2) return r2;
  if (b.reasons.some((r) => /^(pkill|curl) \(판단이 필요한 명령\)$/.test(r)) && !(b.risks ?? []).length) return '프로그램 끄기·인터넷 대상을 알 수 없음';
  const r3 = b.reasons.find((r) => TRUST_INLINE_REASON.test(r));
  if (r3) return `명령 글에 코드를 넣어 실행: ${r3}`;
  // env·nice·exec·command 로 감싼 명령: 설정값(NODE_OPTIONS 등)·실행 방식을 바꿔 안쪽 명령 판단을 비켜 갈 수 있어 묻는다 (command -v 는 따로 읽기로 봄)
  const r4 = b.reasons.find((r) => TRUST_WRAP_REASON.test(r));
  if (r4) return `감싸는 명령으로 실행 방식을 바꿀 수 있음: ${r4}`;
  const roots = [...mission.targets.map((t) => path.resolve(t)), ...scratch];
  for (const run of b.runs ?? []) {
    const p = trustedRunProblem(run, roots, [...roots, ...readRoots]);
    if (p) return p;
  }
  if (!b.writePaths.every((p) => trustedRepoPath(mission, p) || scratch.some((s) => insideBoth(p, s)))) return '작업 폴더 밖 쓰기';
  return null;
}

export function trustedBash(
  mission: MissionConfig,
  kind: BashKind,
  b: Pick<BashDecision, 'reasons' | 'writePaths' | 'risks' | 'linkSources' | 'modeChange' | 'runs'>,
  scratch: string[] = [],
  command = '',
  okHosts?: ReadonlySet<string>,
  readRoots: string[] = [],
): boolean {
  return trustedBashProblem(mission, kind, b, scratch, command, okHosts, readRoots) === null;
}

/** 판단용으로만 {a,b} 꼴을 펼친다(따옴표·$ 가 없는 단순 낱말 묶음). 실제 실행하는 명령은 그대로 */
export function expandSimpleBraces(command: string): string {
  let out = command;
  for (let n = 0; n < 20; n++) {
    const next = out.replace(/(^|[\s=])([^\s'"{}$`\\;&|<>()]*)\{([\w.@+-]+(?:,[\w.@+-]+)+)\}([^\s'"{}$`\\;&|<>()]*)/, (_m, lead: string, pre: string, list: string, post: string) =>
      lead + list.split(',').map((x) => `${pre}${x}${post}`).join(' '),
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 명령의 인터넷 위험이 모두 curl 이고 주소(호스트)를 다 알 때 그 호스트들. 하나라도 모르면 빈 목록 */
function curlHosts(b: Pick<BashDecision, 'risks'>): string[] {
  const net = (b.risks ?? []).filter((r) => r.kind === 'network');
  if (!net.length || net.some((r) => r.program !== 'curl' || !r.targets.length || r.targets.some((t) => !t))) return [];
  return [...new Set(net.flatMap((r) => r.targets))];
}

/** 3단계 판단. 승인함을 기다리는 일은 하지 않는다(type 'ask' 로 돌려줌). */
export function decideApprovalStage(
  config: RanoConfig,
  mission: MissionConfig,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  actor: { isSubagent: boolean; teamApproved: boolean; draftsDir?: string; planBlocked?: boolean; memberModels?: Record<string, 'opus' | 'sonnet'>; trustRepo?: boolean; netHosts?: ReadonlySet<string>; appLogs?: boolean },
  mcpServer?: { name: string; source: string },
): StageDecision {
  // 믿는 미션 규칙은 미션이 믿는 미션이고, 기획 결정 전·읽기만 하는 과제가 아닐 때만(부르는 쪽이 actor.trustRepo 로 알려 줌)
  const trust = !!(actor.trustRepo && mission.trustRepo && !actor.planBlocked);
  // 읽기만 하는 과제: 정해 둔 앱 기록 파일도 바로 읽기(S5-A). 비밀·대화 기록은 넣지 않는다
  const logRoots = actor.appLogs ? appLogRoots(config, mission) : [];
  // 읽기·검색: 2단계와 같음
  if (READ_TOOLS.has(toolName)) {
    const d = decideLeaderTool(config, mission, toolName, input, cwd, actor.isSubagent, undefined, logRoots);
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
    if (actor.isSubagent && toolName !== PROPOSE_COMMANDS_TOOL) return { type: 'deny', reason: '팀원이 리더 도구를 쓰려 함', message: '승인 요청은 리더가 올려요. 필요한 내용을 결과 보고에 적어 주세요.' };
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
    if (trust && trustedRepoPath(mission, abs)) return { type: 'allow', reason: `믿는 미션, 작업 리포 안 쓰기(${toolName}): ${abs}` };
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
          title: `${mission.name} 파일 ${toolName === 'Write' && !exists ? '만들기' : '고치기'}: ${path.basename(abs)}`,
          what: `${mission.name} 작업 폴더의 ${rel} 문서를 ${verb} 해요`,
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
    const roots = [...allowedRoots(mission), path.join(config.runsDir, 'drafts', mission.id), path.join(config.rootDir, 'skills'), tmpDir, ...logRoots]; // 시안 폴더·스킬 보관함·이 미션 임시 폴더도 읽기 허용(/tmp 는 아님). 읽기만 과제는 정한 앱 기록 파일도
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
    // 인수 메모·코드 지도 덧붙이기처럼 시안 폴더·임시 폴더·코드 지도 파일에만 쓰는 파일 명령(여러 곳이 섞여도)은 바로
    const codeMap = path.join(mission.home, 'memory', CODE_MAP_FILE);
    const ownSpot = (p: string) =>
      (!!actor.draftsDir && insideBoth(p, actor.draftsDir)) || insideBoth(p, tmpDir) || ((p === codeMap || p === `${codeMap}.tmp`) && real(path.dirname(p)) === real(path.dirname(codeMap)) && (!existsSync(p) || real(p) === path.join(real(path.dirname(codeMap)), path.basename(p))));
    if ((kind === 'write' || kind === 'outsideWrite') && b.fileOpsOnly === true && !b.modeChange && !(b.linkSources ?? []).length && b.writePaths.length > 0 && b.writePaths.every(ownSpot))
      return { type: 'allow', reason: `시안·임시 폴더·코드 지도에 쓰기(${kind}): ${b.writePaths.map(displayPath).join(', ')}` };
    let trustNote = '';
    if (trust) {
      // 믿는 미션: 이 미션 임시 폴더·이 과제 시안 폴더도 작업 폴더처럼 보고 다시 판단한다(결과 담기·시안 코드 실행)
      const scratch = [tmpDir, ...(actor.draftsDir ? [actor.draftsDir] : [])];
      const judged = expandSimpleBraces(command);
      const bt = classifyBash(judged, {
        cwd,
        targets: [...mission.targets.map((t) => path.resolve(t)), ...scratch],
        readRoots: roots,
        isBlocked: (p) => !!blockedHit(config, p),
        secretsUnder: (dir) => secretsUnderDir(config, dir),
        allowChecks: true,
        realPath: (p) => real(p),
        isDir: isDirPath,
        hasLinksUnder,
      });
      if (bt.decision === 'allow') return { type: 'allow', reason: `믿는 미션, 읽기·확인 명령: ${bt.reasons.join('; ')}` };
      const why = bt.decision === 'ask' ? trustedBashProblem(mission, bt.kind ?? 'command', bt, scratch, judged, actor.netHosts, roots) : null;
      if (bt.decision === 'ask' && why === null)
        return { type: 'allow', reason: `믿는 미션, 작업 폴더 안 명령(${bt.kind ?? 'command'}): ${bt.reasons.join('; ')}` };
      if (why) trustNote = `\n믿는 미션이지만 묻는 이유: ${redactCommand(why)}`;
    }
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
        detail: `명령: ${redactCommand(command)}\n실행 위치: ${displayPath(cwd)}${files}${modeNote}${linkNote}\n판단 근거: ${redactCommand(b.reasons.join('; '))}${trustNote}`,
        filePath: b.writePaths.length === 1 ? b.writePaths[0] : undefined,
        bash: true,
        paths: b.writePaths,
        fileOpsOnly: !!b.fileOpsOnly,
        ...(b.syncOnly ? { syncOnly: true } : {}),
        ...(b.gitWide?.length ? { gitWide: [...b.gitWide] } : {}),
        ...(bashLogTarget(b) ? { logTarget: bashLogTarget(b) } : {}),
        ...(curlHosts(b).length ? { netHosts: curlHosts(b) } : {}),
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
  /** 현황판·승인함에 보일 리더 이름 (같은 미션 동시 작업이면 "… 리더 2") */
  label?: string;
  /** 리더 대화 패널에 한 줄 보여 주기 (missionId 를 붙여 emit) */
  emitActivity?: (text: string) => void;
  /** 같은 작업 폴더에서 지금 다른 리더가 하고 있는 과제(이 리더 것 빼고). 폴더 전체 git 명령을 경고 카드로 보낼 때 본다 (H4-A) */
  others?: () => { id: string; title: string }[];
}

/** 다른 과제가 진행 중일 때 폴더 전체 git 명령 카드에 붙이는 경고 */
export const OTHER_TASK_TITLE = '다른 과제 진행 중';

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
  private readonly commandGrants = new Map<string, CommandGrant[]>(); // 과제 → 실행 목록 승인
  private readonly soloTasks = new Set<string>(); // 빠른 모드(리더 혼자) 과제
  private readonly netGrants = new Map<string, Set<string>>(); // 과제 → 사용자가 승인한 사이트(호스트). 믿는 미션에서 같은 사이트 읽기는 다시 묻지 않는다
  private readonly reviewCalls = new Map<string, number>(); // 과제 → 검수 역할을 부른 횟수
  private readonly deleteGrants = new Map<string, string[]>(); // 과제 → 리더 확인 승인으로 지워도 되는 위치(실제 경로)
  private task:{ id: string; title: string; planFirst?: boolean; preSync?: boolean; moreReview?: boolean } | null = null;

  private readonly deps: LeaderGuardDeps;

  constructor(deps: LeaderGuardDeps) {
    // 다른 구역 폴더(회사 미션에게는 ~/personal, 개인 미션에게는 ~/work)는 차단 목록처럼 막는다
    this.deps = { ...deps, config: withZoneBlocks(deps.config, deps.mission) };
  }

  get leaderLabel(): string {
    return this.deps.label ?? `${this.deps.mission.name} 리더`;
  }

  private get logAgent(): string {
    return `${this.deps.mission.id}-leader`;
  }

  setTask(task: { id: string; title: string; planFirst?: boolean; preSync?: boolean; moreReview?: boolean } | null) {
    this.task = task;
    this.memberTask.clear();
    this.lastText.clear();
  }

  currentTask() {
    return this.task;
  }

  /** 같은 작업 폴더에서 지금 다른 리더가 하고 있는 과제(이 과제 빼고) */
  otherTasks(): { id: string; title: string }[] {
    try {
      return (this.deps.others?.() ?? []).filter((t) => t && t.id !== this.task?.id);
    } catch {
      return [];
    }
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

  /** 검수 역할이 한 번 끝날 때마다 센다(역할별) */
  countReview(role: string, taskId?: string) {
    const id = taskId ?? this.task?.id;
    if (!id) return;
    const key = `${id}:${role}`;
    this.reviewCalls.set(key, (this.reviewCalls.get(key) ?? 0) + 1);
  }

  reviewCount(role: string, taskId?: string): number {
    const id = taskId ?? this.task?.id;
    return id ? this.reviewCalls.get(`${id}:${role}`) ?? 0 : 0;
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

  /** 빠른 모드: 리더가 팀 없이 혼자 하는 과제 */
  markSolo(taskId: string, on: boolean) {
    if (on) this.soloTasks.add(taskId);
    else this.soloTasks.delete(taskId);
  }

  isSolo(taskId?: string): boolean {
    const id = taskId ?? this.task?.id;
    return !!id && this.soloTasks.has(id);
  }

  /** 실행 목록 승인: 이번 과제 동안 이 명령들은 글자·실행 위치·스크립트 내용이 같을 때만 다시 묻지 않는다 */
  grantCommands(taskId: string, grants: CommandGrant[]) {
    const list = this.commandGrants.get(taskId) ?? [];
    this.commandGrants.set(taskId, [...list, ...grants]);
  }

  /** 실행 목록 승인에 맞는 명령인지(글자·위치·스크립트 지문이 모두 같아야 함) */
  private commandGranted(command: string, cwd: string, releaseOnly = false): CommandGrant | null {
    const id = this.task?.id;
    const list = id ? this.commandGrants.get(id) : undefined;
    if (!id || !list?.length) return null;
    const cmd = command.trim();
    const here = path.resolve(cwd);
    for (const g of list) {
      if (g.command !== cmd || path.resolve(g.cwd) !== here) continue;
      if (releaseOnly && !g.release) continue; // 커밋·push·배포는 릴리즈 목록으로 승인받은 것만
      if (!g.files.every((f) => fileFingerprint(f.path) === f.hash)) continue;
      // 릴리즈 목록의 명령은 한 번 쓰면 없앤다(같은 커밋·push 를 다시 하려면 다시 묻는다)
      if (g.release) this.commandGrants.set(id, list.filter((x) => x !== g));
      return g;
    }
    return null;
  }

  /** 실행 목록에 넣을 명령을 미리 판단한다(실제 실행 위치·팀원 여부 기준) */
  previewCommand(command: string, cwd: string, isSub: boolean): StageDecision {
    return this.decide('Bash', { command }, cwd, isSub, undefined, false);
  }

  /** 마지막으로 실행 목록 도구를 부른 사람(승인 카드의 "누가") */
  lastProposer: { label: string; isSub: boolean } | null = null;

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

  private decide(toolName: string, input: Record<string, unknown>, cwd: string, isSub: boolean, mcpServer?: { name: string; source: string }, useGrants = true): StageDecision {
    const { config, mission } = this.deps;
    const ext = decideConnectorTool(config, mission, toolName, input, mcpServer);
    if (ext) {
      // 믿는 미션: 정해진 꼴의 운영 DB 읽기 조회는 바로 (기획 결정 전에도 읽기는 됨)
      if (ext.type === 'ask' && trustedDbRead(mission, toolName, input)) return { type: 'allow', reason: '믿는 미션, 운영 DB 읽기 조회' };
      if (ext.type === 'ask' && (mission.stagePolicy === 'readOnly' || this.planBlocked()))
        return { type: 'deny', reason: `${mission.stagePolicy === 'readOnly' ? '읽기 전용 미션' : '기획 결정 전'} 외부 쓰기: ${toolName}`, message: mission.stagePolicy === 'readOnly' ? '이 미션은 읽기만 해요. 외부 서비스에 쓰는 일은 보고에 적어 주세요.' : MSG_PLAN };
      if (ext.type === 'ask' && this.isReadOnlyTask()) return { type: 'deny', reason: `읽기만 하는 과제에서 외부 쓰기: ${toolName}`, message: MSG_READ_TASK };
      return ext;
    }
    // 검수는 역할마다 과제당 MAX_REVIEWS 번까지(첫 검수 + 재검수). 그 뒤 남은 지적은 리더가 직접 고치고 확인해 보고한다
    if (toolName === SUBAGENT_TOOL && !isSub) {
      const role = str(input.subagent_type);
      const cap = this.task?.moreReview ? MAX_REVIEWS : DEFAULT_REVIEWS;
      if (role && mission.reviewerRoles.includes(role) && this.reviewCount(role) >= cap)
        return { type: 'deny', reason: `검수 ${cap}번을 넘김: ${role}`, message: MSG_REVIEW_CAP(cap) };
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
      {
        isSubagent: isSub,
        teamApproved: this.isTeamApproved(),
        draftsDir: this.draftsDir(),
        planBlocked: this.planBlocked(),
        memberModels: this.memberModels(),
        trustRepo: !this.isReadOnlyTask(),
        netHosts: this.task ? this.netGrants.get(this.task.id) : undefined,
        appLogs: this.isReadOnlyTask(), // 읽기만 과제: 정한 앱 기록 파일 바로 읽기 (S5-A)
      },
      mcpServer,
    );
    // 기획 결정 전에는 작업 폴더를 바꾸는 명령(커밋·삭제·쓰기 명령 등)도 승인함에 올리지 않고 막는다
    if (d.type === 'ask' && this.planBlocked() && d.ask?.kind !== 'decision' && d.ask?.kind !== 'teamPlan') {
      return { type: 'deny', reason: `기획 결정 전 ${d.ask?.kind ?? '변경'}`, message: MSG_PLAN };
    }
    // 읽고 정리만 하기로 한 과제(팀 구성안 자동 승인): 바꾸는 일은 승인함에 올리지 않고 막는다. 판단이 필요한 일반 명령만 평소처럼 승인함으로.
    // 기록·안내에 원래 판단 근거를 붙인다(무엇 때문에 막혔는지 보고에 적을 수 있게, S5-A)
    if (d.type === 'ask' && this.isReadOnlyTask() && d.ask?.kind !== 'command') {
      return { type: 'deny', reason: `읽기만 하는 과제에서 ${d.ask?.kind ?? '변경'}: ${redactCommand(d.reason)}`, message: `${MSG_READ_TASK} (막힌 이유: ${clip(redactCommand(d.ask?.title ?? d.reason), 120)})` };
    }
    // 리더가 확인 카드(deletePaths)로 미리 승인받은 위치만 지우는 명령은 다시 묻지 않는다
    if (d.type === 'ask' && d.ask?.kind === 'delete' && d.ask.bash && d.ask.fileOpsOnly && d.ask.paths?.length) {
      const g = this.deleteGranted(d.ask.paths);
      if (g) return { type: 'allow', reason: `리더 확인 승인으로 미리 허락된 삭제: ${g.map(displayPath).join(', ')}` };
    }
    // 같은 작업 폴더에서 다른 과제가 진행 중이면, 폴더 전체를 바꾸는 git 명령(stash·pull·checkout·reset 등)은
    // 받아오기 지시(preSync)·실행 목록 승인이 있어도 바로 하지 않고 경고 카드로 (H4-A, 2026-11-15)
    if (d.type === 'ask' && d.ask?.bash && d.ask.gitWide?.length) {
      const others = this.otherTasks();
      if (others.length) {
        const names = others.map((t) => `「${clip(t.title, 40)}」`).join(', ');
        return {
          ...d,
          reason: `${d.reason}; ${OTHER_TASK_TITLE}이라 바로 허용하지 않음`,
          ask: {
            ...d.ask,
            title: `${OTHER_TASK_TITLE}: ${d.ask.title}`,
            // 경고는 자세히 글 끝에 붙인다: 승인함 앞면·대화 "지금" 줄·휴대폰 글이 맨 앞 "명령: …" 줄을 읽기 때문(검수 지적 H4)
            detail: `${d.ask.detail ? `${d.ask.detail}\n\n` : ''}주의: 같은 작업 폴더에서 다른 과제 ${names} 가 진행 중이에요. 이 명령(git ${d.ask.gitWide.join('·')})은 폴더 전체를 바꿔서, 그 과제가 고치던 파일까지 보관되거나 되돌려질 수 있어요. 그 과제가 끝난 뒤에 하는 게 안전해요.`,
          },
        };
      }
    }
    // 사용자가 직접 받아오기를 시킨 과제: 받아오기만 하는 명령은 승인 없이(지시가 곧 승인). 다른 명령이 섞이면 평소대로
    if (d.type === 'ask' && d.ask?.bash && d.ask.syncOnly && this.task?.preSync) {
      return { type: 'allow', reason: '사용자가 직접 시킨 원격 최신 받아오기' };
    }
    // 실행 목록으로 미리 승인받은 명령: 글자·실행 위치·스크립트 내용이 모두 같을 때만(실제 실행 위치를 아는 훅에서만 본다)
    if (useGrants && d.type === 'ask' && d.ask?.bash && typeof input.command === 'string') {
      // 실행 목록은 일반 명령·폴더 밖 쓰기·받아오기만. 커밋·push·배포는 릴리즈 목록 승인(propose_release)으로만, 한 번씩 (0.9.11)
      const plain = RUN_PLAN_KINDS.has(d.ask.kind) || (d.ask.kind === 'commit' && !!d.ask.syncOnly);
      const g = plain || RELEASE_PLAN_KINDS.has(d.ask.kind) ? this.commandGranted(input.command, cwd, !plain) : null;
      if (g?.release) return { type: 'allow', reason: `릴리즈 목록 승인으로 미리 허락된 명령(${d.ask.kind}, 한 번)` };
      if (g) return { type: 'allow', reason: `실행 목록 승인으로 미리 허락된 명령${g.files.length ? ` (스크립트 ${g.files.length}개 내용 같음)` : ''}` };
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
      if (isBash && taskId && ask.netHosts?.length) {
        const set = this.netGrants.get(taskId) ?? new Set<string>();
        for (const h of ask.netHosts) set.add(h);
        this.netGrants.set(taskId, set);
      }
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
    // 실행 목록 승인은 실제 실행 위치를 아는 훅(PreToolUse)에서만 맞춰 본다. 여기서는 위치를 몰라 쓰지 않는다
    const d = this.decide(toolName, input, cwd, whoInfo.isSub, options.mcpServer, false);
    if (d.type === 'allow' && toolName === PROPOSE_COMMANDS_TOOL) this.lastProposer = { label: whoInfo.label, isSub: whoInfo.isSub };
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
              if (d.type === 'allow' && input.tool_name === PROPOSE_COMMANDS_TOOL) this.lastProposer = { label: whoInfo.label, isSub };
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
