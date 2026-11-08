// Bash 명령 분류: 바로 허용 / 승인함(종류별) / 차단. 외부 패키지 없이 단순한 셸 문법만 해석한다.
// 원칙: 여러 명령을 이어 쓰면 가장 엄격한 것으로 판단하고, 해석이 애매하면 승인함('command')으로 보낸다.
import { homedir } from 'node:os';
import path from 'node:path';
import type { ApprovalKind } from '../../shared/types.js';

export type BashKind = Extract<ApprovalKind, 'commit' | 'delete' | 'db' | 'deploy' | 'write' | 'outsideWrite' | 'command'>;

export interface BashContext {
  cwd: string; // 명령이 실행될 폴더(절대 경로)
  targets: string[]; // 작업 대상 폴더(절대 경로)
  readRoots: string[]; // 읽어도 되는 폴더·파일(작업 대상 + 참고 + 미션 홈 등)
  isBlocked: (absPath: string) => boolean; // 차단 목록 검사
  secretsUnder?: (absDir: string) => string[]; // 폴더 아래 차단·비밀 파일 목록(통째 검색 판단용). 함수가 없으면 있다고 본다. '*' 는 너무 많아 다 못 본 것
  allowChecks?: boolean; // 타입 검사·린트·시험 같은 확인 명령을 바로 허용할지
  // 링크(바로가기)를 푼 실제 경로. 주면 읽는 파일은 원래 경로와 실제 경로가 "모두" 읽기 허용 폴더 안이어야 바로 허용한다
  // (읽기 허용 폴더 안의 바로가기로 밖을 읽는 우회 막기. Read 도구와 같은 기준)
  realPath?: (absPath: string) => string;
  // 이미 있는 폴더인지. cp·install 대상이 폴더면 그 안의 <대상>/<원본 이름> 도 바뀌는 파일로 본다
  isDir?: (absPath: string) => boolean;
  // 폴더 아래(자기 자신 포함)에 바로가기가 있는지. cp -R 대상 폴더에 바로가기가 있으면 그것을 따라 밖을 덮어쓸 수 있어 승인함으로 보낸다
  hasLinksUnder?: (absPath: string) => boolean;
}

export interface BashDecision {
  decision: 'allow' | 'ask' | 'deny';
  kind?: BashKind; // decision 'ask' 일 때 승인함 종류
  reasons: string[]; // 판단 근거(기록용)
  blockedPaths: string[]; // 차단 목록에 걸린 경로
  writePaths: string[]; // 바뀔 것으로 보이는 파일(절대 경로)
  fileOpsOnly?: boolean; // 판단 근거가 파일 쓰기·지우기(와 확인 명령)뿐인지. 시안·임시 폴더 허용 판단에 쓴다
  modeChange?: boolean; // 파일 권한(실행 권한 등)을 바꾸는 명령(chmod·chown·install)이 있는지. 시안·임시 폴더에서도 승인함으로 보낸다
  linkSources?: string[]; // 링크(ln, cp -l/-s)가 가리킬 수 있는 경로 후보(절대 경로). 시안·임시 폴더 바로 허용은 이것도 그 안일 때만
}

// 엄격한 순서 (뒤로 갈수록 엄격)
const SEVERITY: (BashKind | 'allow')[] = ['allow', 'command', 'write', 'outsideWrite', 'commit', 'delete', 'db', 'deploy'];

function stricter(a: BashKind | 'allow', b: BashKind | 'allow'): BashKind | 'allow' {
  return SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

function within(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

interface Token {
  text: string; // 따옴표를 푼 값
  op?: string; // 연산자 토큰이면 그 연산자
  quoted?: boolean;
  glob?: boolean; // 따옴표 밖에 * ? [ 가 있어 셸이 파일 이름으로 풀 수 있음
  expand?: boolean; // 셸이 값을 바꿔 넣는 부분이 있음(중괄호 펼치기, $'..', ~사용자, ${X:-..} 등). 경로를 알 수 없다
  vars?: string[]; // $X · ${X} 로 쓴 변수 이름
  subst?: boolean; // $(…)·`…` 결과가 들어감(값을 알 수 없음. echo·printf 로 보여 주기만 하면 괜찮다)
}

interface Tokenized {
  tokens: Token[];
  subs: string[]; // $(...) 와 `...` 안의 명령
  ok: boolean; // 따옴표가 닫히지 않는 등 해석 실패면 false
  heredoc: boolean;
}

const OPS = ['&&', '||', ';;', '>>', '&>', '2>>', '2>', '1>', '>|', '<<<', '<<', ';', '|', '&', '>', '<', '\n', '(', ')'];

/**
 * heredoc 본문(<<EOF … EOF 사이)은 명령이 아니라 데이터이므로 떼어 낸다.
 * 본문을 받는 명령이 cat·tee 면 파일 쓰기일 뿐이고, 그 밖(node·python·bash 등)이면 본문을 실행하는 것으로 본다.
 * 따옴표·주석 안의 << 는 heredoc 이 아니다. 끝 표시를 찾지 못하면 ok=false.
 * 끝 표시를 따옴표로 감싸지 않으면 셸이 본문 안의 $변수·$(명령)·`명령` 을 풀므로 expands=true.
 */
export function stripHeredocs(cmd: string): { text: string; ok: boolean; expands: boolean } {
  let out = '';
  let ok = true;
  let expands = false;
  let i = 0;
  let sq = false;
  let dq = false;
  const pending: { word: string; tabs: boolean; quoted: boolean }[] = [];
  while (i < cmd.length) {
    const c = cmd[i];
    if (sq) {
      out += c;
      if (c === "'") sq = false;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      out += c + cmd[i + 1];
      i += 2;
      continue;
    }
    if (dq) {
      out += c;
      if (c === '"') dq = false;
      i++;
      continue;
    }
    if (c === "'") sq = true;
    else if (c === '"') dq = true;
    else if (c === '#' && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]))) {
      // 주석: 줄 끝까지 그대로 둔다(토큰 분리기가 버린다)
      const nl = cmd.indexOf('\n', i);
      const stop = nl < 0 ? cmd.length : nl;
      out += cmd.slice(i, stop);
      i = stop;
      continue;
    } else if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<' && cmd[i - 1] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][\w-]*))/.exec(cmd.slice(i));
      if (m) {
        const word = m[2] ?? m[3] ?? m[4] ?? '';
        pending.push({ word, tabs: m[1] === '-', quoted: m[2] !== undefined || m[3] !== undefined || m[0].includes('\\') });
        out += m[0];
        i += m[0].length;
        continue;
      }
    } else if (c === '\n' && pending.length) {
      // 이 줄 다음부터 본문: 끝 표시 줄까지 건너뛴다
      out += c;
      i++;
      for (const h of pending) {
        let found = false;
        while (i <= cmd.length) {
          const nl = cmd.indexOf('\n', i);
          const lineEnd = nl < 0 ? cmd.length : nl;
          const line = cmd.slice(i, lineEnd);
          i = nl < 0 ? cmd.length + 1 : nl + 1;
          if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.word) {
            found = true;
            break;
          }
          if (!h.quoted && /[$`]/.test(line)) expands = true;
          if (nl < 0) break;
        }
        if (!found) ok = false;
      }
      pending.length = 0;
      if (i > cmd.length) break;
      continue;
    }
    out += c;
    i++;
  }
  if (pending.length) ok = false;
  return { text: out, ok, expands };
}

/** 아주 단순한 셸 토큰 분리기. */
export function tokenize(cmd: string): Tokenized {
  const tokens: Token[] = [];
  const subs: string[] = [];
  let cur = '';
  let curQuoted = false;
  let has = false;
  let ok = true;
  let heredoc = false;
  let curGlob = false;
  let curExpand = false;
  let curVars: string[] = [];
  let curSubst = false;
  const push = () => {
    if (has) tokens.push({ text: cur, quoted: curQuoted, glob: curGlob, expand: curExpand, vars: curVars, subst: curSubst });
    curSubst = false;
    cur = '';
    curQuoted = false;
    curGlob = false;
    curExpand = false;
    curVars = [];
    has = false;
  };
  /** $ 뒤를 읽어 변수 이름을 기록하고, 넘길 글자 수를 돌려준다. 해당 없으면 0 */
  const readVar = (at: number): number => {
    const rest = cmd.slice(at);
    let m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (m) {
      curVars.push(m[1]);
      cur += m[0];
      return m[0].length;
    }
    m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\}/.exec(rest);
    if (m) {
      curVars.push(m[2] ? `${m[1]}[]` : m[1]);
      cur += m[0];
      return m[0].length;
    }
    if (/^\$\{/.test(rest)) {
      curExpand = true; // ${X:-…} ${#X} 같은 꼴
      return 0;
    }
    if (/^\$'/.test(rest)) {
      curExpand = true;
      return 0;
    }
    return 0;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\' && cmd[i + 1] === '\n') {
      i += 2; // 줄 잇기: 셸은 둘 다 지운다
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (c === '#' && !has) {
      // 주석: 줄 끝까지 버린다
      const nl = cmd.indexOf('\n', i);
      i = nl < 0 ? cmd.length : nl;
      continue;
    }
    if (c === '$' && cmd[i + 1] !== '(') {
      const n = readVar(i);
      if (n) {
        has = true;
        i += n;
        continue;
      }
    }
    if ((c === '*' || c === '?' || c === '[') ) curGlob = true;
    if (c === '~' && !has && /^~[A-Za-z_]/.test(cmd.slice(i))) curExpand = true; // ~사용자
    if (c === '{' && /^\{[^}\s]*(,|\.\.)[^}\s]*\}/.test(cmd.slice(i))) curExpand = true; // {a,b} {1..3}
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) {
        ok = false;
        break;
      }
      cur += cmd.slice(i + 1, end);
      has = true;
      curQuoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && cmd[j + 1] === '\n') {
          j += 2;
          continue;
        }
        if (cmd[j] === '\\' && j + 1 < cmd.length) {
          buf += cmd[j + 1];
          j += 2;
          continue;
        }
        if (cmd[j] === '$' && cmd[j + 1] !== '(') {
          const save = cur;
          cur = '';
          const n = readVar(j);
          if (n) {
            buf += cur;
            cur = save;
            j += n;
            continue;
          }
          cur = save;
        }
        if (cmd[j] === '$' && cmd[j + 1] === '(') {
          const end = matchParen(cmd, j + 1);
          if (end < 0) {
            ok = false;
            break;
          }
          subs.push(cmd.slice(j + 2, end));
          buf += cmd.slice(j, end + 1);
          curSubst = true;
          j = end + 1;
          continue;
        }
        if (cmd[j] === '`') {
          const end = cmd.indexOf('`', j + 1);
          if (end < 0) {
            ok = false;
            break;
          }
          subs.push(cmd.slice(j + 1, end));
          curSubst = true;
          j = end + 1;
          continue;
        }
        buf += cmd[j];
        j++;
      }
      if (j >= cmd.length) ok = false;
      cur += buf;
      has = true;
      curQuoted = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const end = matchParen(cmd, i + 1);
      if (end < 0) {
        ok = false;
        break;
      }
      subs.push(cmd.slice(i + 2, end));
      cur += cmd.slice(i, end + 1);
      curSubst = true; // 명령 결과가 단어가 되므로 경로를 알 수 없다
      has = true;
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = cmd.indexOf('`', i + 1);
      if (end < 0) {
        ok = false;
        break;
      }
      subs.push(cmd.slice(i + 1, end));
      curSubst = true;
      has = true;
      i = end + 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      push();
      i++;
      continue;
    }
    // <(…) >(…) 프로세스 치환: 안의 명령은 따로 검사하고, 단어는 파이프라서 경로 검사에서 뺀다
    if ((c === '<' || c === '>') && cmd[i + 1] === '(' && !has) {
      const end = matchParen(cmd, i + 1);
      if (end < 0) {
        ok = false;
        break;
      }
      subs.push(cmd.slice(i + 2, end));
      if (c === '>') curExpand = true; // 출력을 다른 명령에 넘기는 쪽은 승인
      cur += '-';
      has = true;
      i = end + 1;
      continue;
    }
    // 2>&1, >&2 같은 출력 합치기는 파일을 쓰지 않으므로 통째로 건너뛴다
    const dup = /^(\d?)>&(\d|-)/.exec(cmd.slice(i));
    if (dup && (!has || !dup[1])) {
      push();
      i += dup[0].length;
      continue;
    }
    const op = OPS.find((o) => cmd.startsWith(o, i));
    if (op) {
      // 2> 처럼 숫자로 시작하는 연산자는 토큰 맨 앞에서만 인정
      if (/^\d/.test(op) && has) {
        cur += c;
        i++;
        continue;
      }
      push();
      if (op === '<<') heredoc = true;
      tokens.push({ text: op, op });
      i += op.length;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  push();
  return { tokens, subs, ok, heredoc };
}

function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '&', '\n', '(', ')']);
const REDIRECT_OUT = new Set(['>', '>>', '&>', '2>', '2>>', '1>', '>|']);
const REDIRECT_IN = new Set(['<', '<<<']);

const READ_ONLY_CMDS = new Set(['ls', 'pwd', 'wc', 'head', 'tail', 'cat', 'echo', 'true', 'md5', 'shasum', 'uniq', 'sort']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'rev-list', 'describe', 'shortlog', 'check-ignore', 'ls-tree', 'cat-file']);
const GIT_COMMIT = new Set([
  'commit', 'push', 'tag', 'reset', 'rebase', 'merge', 'checkout', 'switch', 'restore', 'pull',
  'cherry-pick', 'revert', 'am', 'apply', 'stash',
]);
const GIT_DELETE = new Set(['rm', 'clean']);
const DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash']);
const DB_CMDS = new Set(['psql', 'mysql', 'mariadb', 'mongosh', 'mongo', 'sqlite3', 'redis-cli', 'pg_restore', 'pg_dump']);
const DEPLOY_CMDS = new Set(['vercel', 'netlify', 'kubectl', 'helm', 'terraform', 'pulumi', 'flyctl', 'heroku', 'firebase', 'gcloud', 'aws', 'az', 'ssh', 'scp', 'rsync', 'eas']);
const WRITE_CMDS = new Set(['mv', 'cp', 'tee', 'touch', 'mkdir', 'ln', 'chmod', 'chown', 'truncate', 'dd', 'install']);
// 내용만 읽는 명령(파일 인자는 읽기 허용 폴더 안이어야 함)
const READ_CMDS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'tr', 'cut', 'diff', 'cmp', 'comm', 'file', 'stat', 'du', 'nl', 'column',
  'basename', 'dirname', 'realpath', 'readlink', 'jq', 'tree', 'xxd', 'od', 'printf', 'test', '[', 'rev', 'fold', 'expand',
]);
// 파일을 읽지 않고 상태만 보여 주는 명령(인자는 경로가 아님)
const INFO_CMDS = new Set(['which', 'date', 'uname', 'lsof', 'whereis', 'type', 'sleep']); // ps 는 다른 프로세스의 환경 변수를 보여 줄 수 있어 뺀다
// find -exec 로 돌려도 내용을 드러내지 않는 명령(지문·크기·종류)
const FIND_SAFE_EXEC = new Set(['md5', 'shasum', 'wc', 'ls', 'stat', 'file', 'du']);
// 셸 문법 단어
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}']);
const SHELL_ENDS = new Set(['done', 'fi', 'esac', '}']);
const GLOB = /[*?[]/;
// 값이 경로와 상관없는 셸 특수 변수(종료 코드 등)
const SAFE_VARS = new Set(['?', 'PIPESTATUS[]', '#', '!', '$']);

/** sed 스크립트가 출력만 하는지(파일 쓰기 w·명령 실행 e·파일 읽기 r 이 없는지) */
function sedScriptIsPure(script: string): boolean {
  let rest = script.replace(/s(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImM0-9]*/g, ' '); // s/../../ 바꾸기
  rest = rest.replace(/\\(.)(?:\\.|(?!\1)[^\\])*\1|\/(?:\\.|[^\/])*\//g, ' '); // /주소/ \#주소#
  rest = rest.replace(/y(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1/g, ' ');
  return /^[\s\d,$;!{}~+pdqnlPNgGhHxD=]*$/.test(rest);
}

// 확인 명령: 타입 검사·린트·시험. 작업 리포의 정해진 스크립트·도구만, 다른 설정·코드 파일을 끌어오는 옵션 없이
const CHECK_SCRIPT = /^(test|tests|lint|typecheck|type-check|types|check|tsc|test:[\w-]+|lint:[\w-]+|typecheck:[\w-]+|check:[\w-]+)$/;
// 파일을 고치거나 다른 코드·설정을 끌어오는 옵션
const CHECK_DANGER =
  /^--?(fix|fix-type|write|w|u|update|updateSnapshot|update-snapshots?|test-update-snapshots|watch|watchAll|prefix|C|cwd|dir|config|c|o|output.*|require|r|import|loader|experimental.*|env-file.*|rulesdir|resolve-plugins-relative-to|plugin|plugins|setupFiles.*|globalSetup|globalTeardown|testRunner|transform|preset|rootDir|roots|reporters?|test-reporter.*|outputFile|outDir|outFile|declaration.*|build|b|generateTrace|tsBuildInfoFile|workspace|filter|F|eval|e|print|cache|cache-location|coverage.*|inspect.*|ui|open|api|stdin.*)(=.*)?$/;

/** 확인 명령인지. inTargets: 경로가 작업 대상 폴더 안인지 */
function isCheckCommand(name: string, args: string[], inTargets: (p: string) => boolean): boolean {
  let tool = name;
  let rest = args;
  if (name === 'npx' || name === 'pnpx' || (name === 'pnpm' && args[0] === 'exec')) {
    rest = args.slice(name === 'pnpm' ? 1 : 0).filter((a) => a !== '--no-install' && a !== '--no');
    tool = rest[0] ?? '';
    rest = rest.slice(1);
  } else if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    // npm test / npm run <확인 스크립트> [-- 시험에 넘길 인자]
    const dash = args.indexOf('--');
    const head = dash < 0 ? args : args.slice(0, dash);
    const tail = dash < 0 ? [] : args.slice(dash + 1);
    const opts = head.filter((a) => a.startsWith('-'));
    if (opts.some((o) => !['--silent', '-s', '--if-present'].includes(o))) return false;
    const words = head.filter((a) => !a.startsWith('-'));
    let script = '';
    if (words.length === 1 && (words[0] === 'test' || words[0] === 't')) script = 'test';
    else if (words.length === 2 && (words[0] === 'run' || words[0] === 'run-script')) script = words[1];
    else if (words.length === 1 && (name === 'yarn' || name === 'pnpm' || name === 'bun') && name !== 'bun') script = words[0];
    if (!CHECK_SCRIPT.test(script) || /fix|format|write|update|deploy|release|publish|db|migrat|seed|watch|dev|serve|start/.test(script)) return false;
    return tail.every((a) => (a.startsWith('-') ? !CHECK_DANGER.test(a) : inTargets(a)));
  }
  if (rest.some((a) => a.startsWith('-') && CHECK_DANGER.test(a) && !(tool === 'prettier' && a === '-c'))) return false;
  const paths = (skip: (a: string, i: number) => boolean) => rest.filter((a, i) => !a.startsWith('-') && !skip(a, i)).every(inTargets);
  if (tool === 'tsc') return rest.includes('--noEmit') && paths(() => false);
  if (tool === 'eslint') return paths(() => false);
  if (tool === 'tsx' || tool === 'node') return rest[0] === '--test' && rest.slice(1).every((a) => !a.startsWith('-') || /^--test-(name-pattern|only|concurrency|timeout|skip-pattern)/.test(a)) && paths(() => false);
  if (tool === 'vitest') return rest[0] === 'run' && paths((_a, i) => i === 0);
  if (tool === 'jest') return paths(() => false);
  if (tool === 'prettier') return (rest.includes('--check') || rest.includes('-c')) && paths(() => false);
  return false;
}

/** 파일 이름 글롭(*.ts, {a,b}) → 정규식 */
function nameGlob(g: string): RegExp {
  const esc = g
    .replace(/[.+^$()|\\]/g, '\\$&')
    .replace(/\{([^}]*)\}/g, (_m, alts: string) => `(${alts.split(',').join('|')})`)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

function isVersionQuery(args: string[]): boolean {
  return args.length === 1 && (args[0] === '-v' || args[0] === '--version' || args[0] === '-V');
}

const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'xargs', 'nice']);
// xargs 옵션 중 값을 따로 받는 것 (-n 1, -I {}, -P 4 …)
const XARGS_VALUE_OPT = /^-[nILPdsEJRa]$/;

/** awk 프로그램이 출력만 하는지(명령 실행·파일 쓰기·다른 파일 읽기·환경 변수 보기가 없는지). '>' 는 비교일 수도 있지만 쓰기와 구분하지 않고 승인함으로 보낸다 */
function awkProgramIsPure(prog: string): boolean {
  return !/system|getline|ENVIRON|PROCINFO|close\s*\(|fflush|@include|@load|[|>]/.test(prog);
}

// 비밀이 있을 법한 이름. 경로로 풀지 못해도(따옴표 속 글롭 등) 보이면 막는다.
const SECRET_NAME = /(^|[\/\s"'=:])\.env(\.[^\s\/"']*)?($|[\s\/"'])|(^|\/)\.ssh(\/|$)|(^|\/)\.aws(\/|$)|Keychains|\.config\/gh(\/|$)|\.config\/gcloud(\/|$)/;

interface Segment {
  words: string[];
  quoted: boolean[]; // words 와 같은 순서. 따옴표로 감싼 단어인지
  flags: Token[]; // words 와 같은 순서. 글롭·확장·변수 정보
  redirOut: string[];
  redirIn: string[];
  redirFlags: Token[]; // 리다이렉션 대상 단어의 확장·변수 정보
  heredoc: boolean; // << 로 본문을 받는 명령
}

function splitSegments(tokens: Token[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment = { words: [], quoted: [], flags: [], redirOut: [], redirIn: [], redirFlags: [], heredoc: false };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op && SEPARATORS.has(t.op)) {
      if (cur.words.length || cur.redirOut.length || cur.redirIn.length) segs.push(cur);
      cur = { words: [], quoted: [], flags: [], redirOut: [], redirIn: [], redirFlags: [], heredoc: false };
      continue;
    }
    if (t.op && REDIRECT_OUT.has(t.op)) {
      const target = tokens[i + 1];
      if (target && !target.op) {
        cur.redirOut.push(target.text);
        cur.redirFlags.push(target);
        i++;
      }
      continue;
    }
    if (t.op && REDIRECT_IN.has(t.op)) {
      const target = tokens[i + 1];
      if (target && !target.op) {
        if (t.op === '<') cur.redirIn.push(target.text);
        cur.redirFlags.push(target);
        i++;
      }
      continue;
    }
    if (t.op === '<<') {
      cur.heredoc = true;
      i++; // heredoc 구분자
      continue;
    }
    cur.words.push(t.text);
    cur.quoted.push(!!t.quoted);
    cur.flags.push(t);
  }
  if (cur.words.length || cur.redirOut.length || cur.redirIn.length) segs.push(cur);
  return segs;
}

function nonOptions(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'));
}

/** Bash 명령 하나(여러 개 이어 쓴 것 포함)를 분류한다. */
export function classifyBash(command: string, ctx: BashContext): BashDecision {
  const out: BashDecision = { decision: 'allow', reasons: [], blockedPaths: [], writePaths: [], linkSources: [] };
  let level: BashKind | 'allow' = 'allow';
  // 읽어도 되는 위치인지: 원래 경로가 읽기 허용 폴더 안이고, realPath 가 있으면 링크를 푼 실제 경로도 읽기 허용 폴더(또는 그 실제 경로) 안
  const realRoots = ctx.realPath ? ctx.readRoots.map((r) => ctx.realPath!(r)) : [];
  const readableAbs = (abs: string): boolean => {
    if (!ctx.readRoots.some((r) => within(abs, r))) return false;
    if (!ctx.realPath) return true;
    const rp = ctx.realPath(abs);
    return ctx.readRoots.some((r) => within(rp, r)) || realRoots.some((r) => within(rp, r));
  };
  let nonRead = false; // 읽기만 하는 명령이 아닌 것이 섞였는지
  let otherBump = false; // 파일 쓰기·지우기 말고 다른 이유로 승인이 필요한지
  const bump = (k: BashKind, why: string, fileOp = false) => {
    level = stricter(level, k);
    out.reasons.push(why);
    nonRead = true;
    if (!fileOp) otherBump = true;
  };

  const cmd = command.trim();
  if (!cmd) {
    return { decision: 'ask', kind: 'command', reasons: ['빈 명령'], blockedPaths: [], writePaths: [] };
  }
  if (SECRET_NAME.test(cmd)) {
    out.blockedPaths.push('(명령 안에 비밀 설정 파일·키 폴더 이름이 있음)');
  }

  const visit = (text: string, startCwd: string, depth: number, inherited?: Map<string, string[] | null>) => {
    const hd = stripHeredocs(text);
    if (!hd.ok) bump('command', 'heredoc 끝 표시가 없음');
    if (hd.expands) bump('command', 'heredoc 본문에 변수·명령 치환이 있음');
    const tk = tokenize(hd.text);
    if (!tk.ok) bump('command', '명령을 해석하지 못함');
    let cwd = startCwd;
    const resolve = (p: string) => path.resolve(cwd, expandHome(p));
    const checkBlocked = (p: string) => {
      if (!p || p === '-' || /^[a-z]+:\/\//i.test(p)) return;
      const abs = resolve(p);
      if (ctx.isBlocked(abs)) out.blockedPaths.push(abs);
    };
    const markWrite = (p: string, why: string) => {
      if (p === '/dev/null' || p === '/dev/stdout' || p === '/dev/stderr' || /^&\d$/.test(p)) return;
      const abs = resolve(p);
      out.writePaths.push(abs);
      bump(ctx.targets.some((t) => within(abs, t)) ? 'write' : 'outsideWrite', why, true);
    };


    const known = new Map<string, string[] | null>(inherited ?? []); // 변수 → 값들(null 이면 알 수 없음)
    /** 단어 안의 변수를 알려진 값으로 바꾼 후보들. 알 수 없는 변수가 있으면 null */
    const expandWord = (w: string, f: Token): string[] | null => {
      if (f.expand) return null;
      let outs = [w];
      for (const v of f.vars ?? []) {
        if (SAFE_VARS.has(v)) continue;
        const vals = v === 'PWD' ? [cwd] : v === 'HOME' ? [homedir()] : known.get(v);
        if (!vals) return null;
        const re = new RegExp(`\\$\\{${v}\\}|\\$${v}(?![A-Za-z0-9_])`, 'g');
        outs = outs.flatMap((o) => vals.map((val) => o.replace(re, () => val))).slice(0, 50);
      }
      return outs;
    };

    // 먼저 for·변수 지정을 훑어 값을 알아 둔 뒤 $(…) 안의 명령을 검사한다
    for (const sg of splitSegments(tk.tokens)) {
      if (sg.words[0] === 'for' && sg.words[2] === 'in' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(sg.words[1]))
        known.set(sg.words[1], sg.flags.slice(3).some((f) => f.glob || f.expand || f.subst || f.vars?.length) ? null : sg.words.slice(3));
    }
    for (const sub of tk.subs) {
      if (depth < 3) visit(sub, cwd, depth + 1, known);
      else bump('command', '명령 치환이 너무 깊음');
    }

    for (const rawSeg of splitSegments(tk.tokens)) {
      // 변수 풀기: for 반복 변수·앞서 지정한 변수·PWD·HOME 은 값으로, 그 밖의 변수·확장은 승인함
      let unknownVar = false;
      const seg: Segment = { ...rawSeg, words: [], quoted: [], flags: [] };
      const head = rawSeg.words.find((w, idx) => !SHELL_KEYWORDS.has(w) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && idx >= 0);
      const showsOnly = head === 'echo' || head === 'printf';
      rawSeg.words.forEach((w, idx) => {
        const f = rawSeg.flags[idx] ?? { text: w };
        const vals = f.vars?.length || f.expand ? expandWord(w, f) : [w];
        if (!vals || (f.subst && !showsOnly && !(/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && idx === 0))) unknownVar = true;
        for (const v of vals ?? [w]) {
          seg.words.push(v);
          seg.quoted.push(rawSeg.quoted[idx]);
          seg.flags.push(f);
        }
      });
      const redirOut: string[] = [];
      const redirIn: string[] = [];
      rawSeg.redirOut.forEach((r, idx) => {
        const f = rawSeg.redirFlags.find((x) => x.text === r) ?? { text: r };
        const vals = f.vars?.length || f.expand ? expandWord(r, f) : [r];
        if (!vals || f.glob) unknownVar = true;
        redirOut.push(...(vals ?? [r]));
        void idx;
      });
      rawSeg.redirIn.forEach((r) => {
        const f = rawSeg.redirFlags.find((x) => x.text === r) ?? { text: r };
        const vals = f.vars?.length || f.expand ? expandWord(r, f) : [r];
        if (!vals || f.glob) unknownVar = true;
        redirIn.push(...(vals ?? [r]));
      });
      seg.redirOut = redirOut;
      seg.redirIn = redirIn;
      // for 변수 in 값들 / 변수=값 만 있는 줄: 값을 기억한다
      if (seg.words[0] === 'for' && seg.words[2] === 'in' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg.words[1])) {
        const vals = seg.words.slice(3);
        const bad = unknownVar || seg.flags.slice(3).some((f) => f.glob || f.expand);
        known.set(seg.words[1], bad ? null : vals);
        for (const v of vals) checkBlocked(v);
        continue;
      }
      if (seg.words.length && seg.words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) {
        seg.words.forEach((w, idx) => {
          const eq = w.indexOf('=');
          const f = seg.flags[idx];
          known.set(w.slice(0, eq), unknownVar || f?.glob || f?.expand || f?.subst ? null : [w.slice(eq + 1)]);
          checkBlocked(w.slice(eq + 1));
        });
        if (SECRET_NAME.test(seg.words.join(' '))) out.blockedPaths.push('(변수에 비밀 파일 이름)');
        continue;
      }
      if (unknownVar) bump('command', '변수·확장을 써서 경로를 알 수 없음');
      // 모든 단어·리다이렉션 대상의 차단 경로 검사
      for (const w of [...seg.words, ...seg.redirOut, ...seg.redirIn]) {
        const eq = w.indexOf('=');
        checkBlocked(w);
        if (eq > 0) checkBlocked(w.slice(eq + 1)); // --file=... 형태
      }
      for (const r of seg.redirOut) markWrite(r, `리다이렉션으로 파일 쓰기: ${r}`);
      if (seg.redirOut.some((r) => !/^\/dev\/(null|stdout|stderr)$/.test(r))) nonRead = true;

      let words = seg.words.slice();
      let quoted = seg.quoted.slice();
      // 셸 문법(for·if·do·done 등)
      while (words.length && SHELL_KEYWORDS.has(words[0])) {
        words.shift();
        quoted.shift();
      }
      if (words.length && SHELL_ENDS.has(words[0]) && words.length === 1) continue;
      if (words[0] === 'for' || words[0] === 'case') {
        bump('command', `${words[0]} 문법`);
        continue;
      }
      let flags = seg.flags.slice();
      // 셸 문법 단어를 지운 만큼 flags 도 맞춘다
      flags = flags.slice(seg.words.length - words.length);
      // 앞쪽 환경변수 지정(FOO=bar) 제거
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
        words.shift();
        quoted.shift();
        flags.shift();
      }
      if (!words.length) continue;
      if (WRAPPERS.has(path.basename(words[0]))) {
        const wrapper = path.basename(words[0]);
        if (wrapper === 'time' && words.length === 1) continue;
        words = words.slice(1);
        quoted = quoted.slice(1);
        flags = flags.slice(1);
        let argFile = false; // xargs -a 파일: 파일 내용이 인자가 되어 오류 문구로 드러날 수 있다
        while (words.length && (words[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
          const opt = words[0];
          words.shift();
          quoted.shift();
          flags.shift();
          if (wrapper !== 'xargs') continue;
          if (/^-a|^--arg-file/.test(opt)) argFile = true;
          if (XARGS_VALUE_OPT.test(opt) && words.length) {
            words.shift();
            quoted.shift();
            flags.shift();
          }
        }
        // xargs 로 지문·크기·종류만 보는 명령(find -exec 와 같은 기준)을 돌리는 것은 읽기로 본다
        const safeXargs = wrapper === 'xargs' && !argFile && words.length > 0 && FIND_SAFE_EXEC.has(path.basename(words[0]));
        if (wrapper !== 'time' && !safeXargs) bump('command', `${wrapper} 로 감싼 명령`);
        if (!words.length) continue;
      }
      const name = path.basename(words[0]);
      const args = words.slice(1);
      if (seg.heredoc && name !== 'cat' && name !== 'tee') bump('command', `heredoc 본문을 ${name} 로 실행`);
      const argFlags = flags.slice(1);
      const isReadable = (p: string) => readableAbs(resolve(p));
      /** 글롭·폴더 통째 읽기가 차단·비밀 파일을 건드릴 수 있는지 */
      const secretFiles = (dir: string): string[] => (ctx.secretsUnder ? ctx.secretsUnder(resolve(dir)) : ['*']);
      const touchesSecrets = (dir: string) => secretFiles(dir).length > 0;
      /** 글롭 인자가 비밀·차단 파일에 맞을 수 있는지 */
      const globRisk = (): boolean =>
        args.some((a, idx) => {
          if (!argFlags[idx]?.glob || a.startsWith('-')) return false;
          const at = a.search(GLOB);
          if (at < 0) return false;
          const slash = a.lastIndexOf('/', at);
          const dir = slash < 0 ? '.' : a.slice(0, slash) || '/';
          const pattern = a.slice(slash + 1);
          if (pattern.includes('/')) return touchesSecrets(dir); // 여러 단계 글롭: 폴더 전체로 판단
          const absDir = resolve(dir);
          const re = nameGlob(pattern);
          return secretFiles(dir).some((f) => {
            if (f === '*') return true;
            if (path.dirname(f) !== absDir) return false;
            const base = path.basename(f);
            if (base.startsWith('.') && !pattern.startsWith('.')) return false; // * 는 점 파일에 맞지 않는다
            return re.test(base);
          });
        });
      const lowerAll = words.join(' ').toLowerCase();

      if (name === 'cd') {
        const dest = args[0] ? resolve(args[0]) : homedir();
        cwd = dest;
        continue;
      }

      if (name === 'git') {
        // git -C <dir> 같은 앞 옵션: -C 는 읽기 허용 폴더만, -c(설정 바꾸기)·--git-dir 등은 승인
        let k = 0;
        let gitCwd = cwd;
        while (k < args.length && args[k].startsWith('-')) {
          const a = args[k];
          if (a === '-C') {
            gitCwd = path.resolve(gitCwd, expandHome(args[k + 1] ?? ''));
            if (!ctx.readRoots.some((r) => within(gitCwd, r))) bump('command', `git -C 작업 폴더 밖: ${gitCwd}`);
            k++;
          } else if (a === '-c' || a.startsWith('--config-env') || a.startsWith('--git-dir') || a.startsWith('--work-tree') || a.startsWith('--exec-path') || a.startsWith('--namespace')) {
            bump('command', `git ${a} 로 설정·위치 바꾸기`);
            if (a === '-c') k++;
          }
          k++;
        }
        const sub = args[k] ?? '';
        const rest = args.slice(k + 1);
        if (GIT_DELETE.has(sub)) bump('delete', `git ${sub}`);
        else if (GIT_COMMIT.has(sub)) bump('commit', `git ${sub}`);
        else if (GIT_READ.has(sub)) {
          const listing = rest.some((a) => /^(-a|-r|-l|-v|-vv|--list|--all|--remotes|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort.*|--format.*)$/.test(a));
          if (sub === 'branch' && nonOptions(rest).length && !listing) bump('command', 'git branch 로 가지 만들기·지우기');
          else if (sub === 'branch' && rest.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force)/.test(a))) bump('command', 'git branch 변경');
          if (rest.some((a) => /^--(output|ext-diff|textconv|no-index|exec|upload-pack|open-files-in-pager)/.test(a) || /^-O/.test(a))) bump('command', `git ${sub} 의 쓰기·실행 옵션`);
          // 리비전:경로 (git show HEAD:.env) 의 경로도 차단 목록 검사
          for (const a of rest) {
            const m = /^[^:\s]*:(.+)$/.exec(a);
            if (m && !/^[a-z]+:\/\//i.test(a)) {
              const abs = path.resolve(gitCwd, m[1]);
              if (ctx.isBlocked(abs) || /(^|\/)\.env(\.|$)/.test(m[1])) out.blockedPaths.push(abs);
            }
          }
        } else bump('command', `git ${sub || '(하위 명령 없음)'}`);
        continue;
      }

      if (DELETE_CMDS.has(name)) {
        // 지울 경로를 모두 알 수 있으면 파일 일로 본다(시안 폴더 정리·미리 승인된 삭제 판단에 씀). 경로가 없으면 다른 판단 근거로
        const targets = nonOptions(args);
        bump('delete', `${name} 로 삭제`, targets.length > 0);
        for (const a of targets) out.writePaths.push(resolve(a));
        continue;
      }
      if (name === 'find') {
        if (args.includes('-delete') || args.some((a, idx) => (a === '-exec' || a === '-execdir' || a === '-ok') && DELETE_CMDS.has(path.basename(args[idx + 1] ?? '')))) {
          bump('delete', 'find 로 삭제');
        } else if (
          args.some((a) => /^-(ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)) ||
          args.some((a, idx) => (a === '-exec' || a === '-execdir') && !FIND_SAFE_EXEC.has(path.basename(args[idx + 1] ?? '')))
        ) {
          bump('command', 'find 로 다른 명령 실행·파일 쓰기');
        } else {
          const firstExpr = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!');
          const roots = firstExpr < 0 ? args : args.slice(0, firstExpr);
          const outside = (roots.length ? roots : ['.']).filter((p) => !isReadable(p));
          if (outside.length) bump('command', `작업 폴더 밖을 찾음: ${outside.map(resolve).join(', ')}`);
        }
        continue;
      }
      if (DB_CMDS.has(name)) {
        bump('db', `${name} (데이터베이스)`);
        continue;
      }
      if (/(^|\s)prisma\s+(migrate|db\s+(push|execute|seed))/.test(lowerAll)) {
        bump('db', 'prisma 로 DB 변경');
        continue;
      }
      if (['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'node', 'tsc', 'eslint', 'tsx', 'vitest', 'jest', 'prettier'].includes(name)) {
        if (isVersionQuery(args)) continue;
        if (ctx.allowChecks && isCheckCommand(name, args, (p) => ctx.targets.some((t) => within(resolve(p), t)))) {
          out.reasons.push(`확인 명령: ${name} ${args.slice(0, 2).join(' ')}`.trim());
          nonRead = true; // 실행 폴더는 작업 대상 안이어야 한다
          continue;
        }
      }
      if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
        const runIdx = args.findIndex((a) => a === 'run' || a === 'run-script');
        const script = runIdx >= 0 ? args[runIdx + 1] ?? '' : name === 'yarn' || name === 'bun' ? args[0] ?? '' : '';
        if (args[0] === 'publish' || args.includes('publish')) bump('deploy', `${name} publish`);
        else if (/^db(:|$)/.test(script)) bump('db', `${name} run ${script}`);
        else if (/deploy|release/.test(script)) bump('deploy', `${name} run ${script}`);
        else bump('command', `${name} ${args.slice(0, 2).join(' ')}`.trim());
        continue;
      }
      if (name === 'docker' || name === 'podman') {
        if (['ps', 'images', 'version', 'info'].includes(args[0] ?? '') && !args.some((a) => /^--?(H|host|context|config)/.test(a))) continue; // 상태 보기
        if (['push', 'login'].includes(args[0] ?? '')) bump('deploy', `${name} ${args[0]}`);
        else bump('command', name);
        continue;
      }
      if (DEPLOY_CMDS.has(name) || /\bdeploy\b/.test(lowerAll)) {
        bump('deploy', `${name} (배포·운영)`);
        continue;
      }
      if (name === 'perl') {
        bump('command', 'perl (코드 실행)');
        continue;
      }
      if (name === 'sed') {
        if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
          // sed -i '' 's/a/b/' 파일 (맥) · sed -i 's/a/b/' 파일 · sed -i.bak -e 's/a/b/' 파일
          const scripts: string[] = [];
          const files: string[] = [];
          for (let k = 0; k < args.length; k++) {
            const a = args[k];
            if (a === '-i' && args[k + 1] === '') {
              k++;
              continue;
            }
            if (a === '-e' || a === '--expression') {
              scripts.push(args[++k] ?? '');
              continue;
            }
            if (a === '-f' || a === '--file') {
              scripts.push('w');
              k++;
              continue;
            }
            if (a.startsWith('-')) continue;
            if (!scripts.length) scripts.push(a);
            else files.push(a);
          }
          if (!scripts.every(sedScriptIsPure)) bump('command', 'sed (쓰기·실행이 섞였을 수 있음)');
          if (files.length) files.forEach((f) => markWrite(f, `sed -i 로 파일 수정`));
          else bump('command', 'sed -i');
        } else {
          // 읽기만 하는 sed: 스크립트(-e 값 또는 첫 인자)에 쓰기·실행이 없고 파일이 읽기 허용 폴더 안
          const scripts: string[] = [];
          const files: string[] = [];
          let hasE = false;
          for (let k = 0; k < args.length; k++) {
            const a = args[k];
            if (a === '-e' || a === '--expression') {
              scripts.push(args[++k] ?? '');
              hasE = true;
            } else if (a === '-f' || a === '--file' || a.startsWith('--file=')) {
              scripts.push('w'); // 스크립트 파일은 내용을 모르므로 승인
            } else if (a.startsWith('-')) continue;
            else if (!hasE && !scripts.length) scripts.push(a);
            else files.push(a);
          }
          if (!scripts.length || !scripts.every(sedScriptIsPure)) bump('command', 'sed (쓰기·실행이 섞였을 수 있음)');
          else {
            const outside = [...files, ...seg.redirIn].filter((p) => !isReadable(p));
            if (outside.length) bump('command', `작업 폴더 밖을 읽음: ${outside.map(resolve).join(', ')}`);
            if (globRisk()) bump('command', '비밀 파일이 있는 폴더를 글롭으로 읽음');
          }
        }
        continue;
      }
      if (INFO_CMDS.has(name)) continue;
      if (name === 'awk' || name === 'gawk' || name === 'nawk') {
        // awk '프로그램' [변수=값] [파일…]: 프로그램이 출력만 하고 파일이 읽기 허용 폴더 안이면 읽기
        let prog: string | undefined;
        let bad = false;
        const files: string[] = [];
        for (let k = 0; k < args.length; k++) {
          const a = args[k];
          if (prog === undefined) {
            if (a === '-F' || a === '-v') {
              k++;
              continue;
            }
            if (/^-[Fv]./.test(a)) continue;
            if (a.startsWith('-')) {
              bad = true; // -f 프로그램 파일, gawk -i/-e/-l 등
              break;
            }
            prog = a;
            continue;
          }
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
          files.push(a);
        }
        if (bad || prog === undefined || !awkProgramIsPure(prog)) bump('command', 'awk (쓰기·실행이 섞였을 수 있음)');
        else {
          const outside = [...files, ...seg.redirIn].filter((p) => !isReadable(p));
          if (outside.length) bump('command', `작업 폴더 밖을 읽음: ${outside.map(resolve).join(', ')}`);
          if (globRisk()) bump('command', '비밀 파일이 있는 폴더를 글롭으로 읽음');
        }
        continue;
      }
      if (name === 'unzip' || name === 'zipinfo') {
        // 압축 파일 안 목록만 보기(풀지 않음): unzip -l · unzip -Z1 · zipinfo -1 등
        const opts = args.filter((a) => a.startsWith('-'));
        const listOnly = name === 'unzip' ? opts.length === 1 && ['-l', '-Z1'].includes(opts[0]) : opts.every((a) => /^-[12lmsht]+$/.test(a));
        const archive = nonOptions(args)[0];
        if (!listOnly || !archive) bump('command', `${name} (압축 풀기일 수 있음)`);
        else if (!isReadable(archive)) bump('command', `작업 폴더 밖을 읽음: ${resolve(archive)}`);
        continue;
      }
      if (READ_CMDS.has(name)) {
        const isGrep = name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg';
        const files: string[] = [];
        let patternTaken = !isGrep;
        for (let k = 0; k < args.length; k++) {
          const a = args[k];
          if (a.startsWith('-')) {
            if (isGrep && (a === '-e' || a === '--regexp' || a === '-f' || a === '--file')) {
              if (a === '-f' || a === '--file') files.push(args[k + 1] ?? '');
              k++;
              patternTaken = true;
            } else if (isGrep && (/^--regexp=/.test(a) || /^-e./.test(a))) patternTaken = true;
            else if (isGrep && (/^--file=/.test(a) || /^-f./.test(a))) {
              files.push(a.replace(/^--file=|^-f/, ''));
              patternTaken = true;
            } else if (isGrep && a === '-d') k++;
            else if (isGrep && /^-[ABCm]$|^--(include|exclude|exclude-dir|max-count|context|glob|type)$/.test(a)) k++; // 값이 따로 오는 옵션
            else if (name === 'rg' && /^-[gtT]$/.test(a)) k++;
            else if ((name === 'cut' || name === 'du') && /^-[dfbcd]$/.test(a)) k++;
            continue;
          }
          if (!patternTaken) {
            patternTaken = true;
            continue;
          }
          if (name === 'tr' || name === 'printf' || name === 'test' || name === '[' || name === 'jq') continue; // 인자가 경로가 아님(jq 는 첫 인자가 식)
          files.push(a);
        }
        if (name === 'jq') {
          files.push(...nonOptions(args).slice(1));
          if (args.some((a) => /\benv\b|\$ENV|\binputs?\b|\$__loc__|\bimport\b|\binclude\b/.test(a) || /^(-f|--from-file|--rawfile|--slurpfile|--args|--jsonargs|-L)$/.test(a)))
            bump('command', 'jq 로 환경 변수·다른 파일 읽기');
        }
        if (name === 'tree' && args.some((a) => a === '-o' || a.startsWith('--output'))) bump('command', 'tree -o 로 파일 쓰기');
        if (name === 'file' && args.some((a) => /^-[a-zA-Z]*C/.test(a) || a === '--compile')) bump('command', 'file -C 로 파일 쓰기');
        if (name === 'xxd' && nonOptions(args).length > 1) markWrite(nonOptions(args)[1], 'xxd 로 파일 쓰기');
        const outside = [...files, ...seg.redirIn].filter((p) => p && !/^\d+$/.test(p) && !isReadable(p));
        if (outside.length) bump('command', `작업 폴더 밖을 읽음: ${outside.map(resolve).join(', ')}`);
        const recursive =
          name === 'rg' ||
          (isGrep && args.some((a, idx) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || a === '--dereference-recursive' || /^--directories=recurse$|^-drecurse$/.test(a) || (a === '-d' && args[idx + 1] === 'recurse'))) ||
          (name === 'diff' && args.some((a) => /^-[a-zA-Z]*r/.test(a) || a === '--recursive'));
        // rg 는 기본으로 숨김 파일(.env 등)을 건너뛴다
        const rgHidden = name === 'rg' && args.some((a) => /^--(hidden|no-ignore.*|unrestricted)$|^-[a-zA-Z]*[u.]/.test(a));
        if (recursive) {
          const dirs = files.length ? files.filter((f) => !/^\d+$/.test(f)) : ['.'];
          // --include 로 좁힌 검색이면 그 모양에 맞는 비밀 파일만 문제
          const includes: RegExp[] = [];
          const excludes: RegExp[] = [];
          for (let k = 0; k < args.length; k++) {
            const m = /^--(include|exclude)(?:=(.*))?$/.exec(args[k]);
            if (m) (m[1] === 'include' ? includes : excludes).push(nameGlob(m[2] ?? args[++k] ?? ''));
            if (name === 'rg' && (args[k] === '-g' || args[k] === '--glob')) {
              const g = args[++k] ?? '';
              (g.startsWith('!') ? excludes : includes).push(nameGlob(g.replace(/^!/, '')));
            }
          }
          const risky = dirs.flatMap((d) => secretFiles(d).map((f) => ({ f, d: resolve(d) }))).filter(({ f, d }) => {
            if (f === '*') return true;
            const base = path.basename(f);
            if (name === 'rg' && !rgHidden && path.relative(d, f).split(path.sep).some((part) => part.startsWith('.'))) return false;
            if (includes.length && !includes.some((r) => r.test(base))) return false;
            return !excludes.some((r) => r.test(base));
          });
          if (risky.length) bump('command', '비밀·차단 파일이 있는 폴더를 통째로 검색');
        }
        if (!['file', 'stat', 'du', 'basename', 'dirname', 'realpath', 'readlink', 'tree'].includes(name) && globRisk())
          bump('command', '비밀 파일이 있는 폴더를 글롭으로 읽음');
        continue;
      }
      if (WRITE_CMDS.has(name)) {
        const files = nonOptions(args);
        if (!files.length) bump('command', name);
        else if (name === 'mv') {
          files.slice(0, -1).filter((f) => !ctx.targets.some((t) => within(resolve(f), t)) && !isReadable(f)).forEach((f) => bump('command', `작업 폴더 밖 파일을 옮김: ${resolve(f)}`));
          files.forEach((f) => markWrite(f, `mv 로 파일 옮기기: ${f}`));
        }
        else if (name === 'cp' || name === 'ln' || name === 'install') {
          let sources = files.slice(0, -1);
          let dest = files[files.length - 1];
          // ln 대상 하나만 주면(ln -s /a/b) 지금 폴더에 같은 이름의 링크를 만든다
          if (name === 'ln' && files.length === 1) {
            sources = [files[0]];
            dest = path.join(cwd, path.basename(files[0]));
          }
          const outside = sources.filter((f) => !isReadable(f));
          if (outside.length) bump('command', `작업 폴더 밖 파일을 복사: ${outside.map(resolve).join(', ')}`);
          if (name === 'cp' && args.some((a) => /^-[a-zA-Z]*[rRa]/.test(a)) && sources.some(touchesSecrets)) bump('command', '비밀 파일이 있는 폴더를 통째로 복사');
          if (globRisk()) bump('command', '비밀 파일을 글롭으로 복사할 수 있음');
          // 링크 만들기(ln, cp -l/-s): 링크가 가리킬 곳을 남긴다. 상대 경로 링크는 링크가 놓인 폴더 기준이라 후보를 모두 넣는다
          if (name === 'ln' || (name === 'cp' && args.some((a) => /^-[a-zA-Z]*[ls]/.test(a)))) {
            const d = resolve(dest);
            for (const s of sources) {
              const e = expandHome(s);
              out.linkSources!.push(...new Set([resolve(s), path.resolve(d, e), path.resolve(path.dirname(d), e)]));
            }
          }
          // install 은 따로 정하지 않으면 실행 권한(755)을 붙여 복사한다
          if (name === 'install') out.modeChange = true;
          markWrite(dest, `${name} 로 파일 만들기`);
          if (name === 'cp' || name === 'install') {
            const d = resolve(dest);
            // 대상이 폴더면(이미 있는 폴더, '/' 로 끝남, 원본이 여러 개) 실제로 쓰이는 곳은 <대상>/<원본 이름>.
            // 그 자리에 바로가기가 있으면 cp 는 그것을 따라가 덮어쓰므로, 그 경로도 바뀌는 파일에 넣어 실제 경로를 보게 한다
            const intoDir = dest.endsWith('/') || sources.length > 1 || !!ctx.isDir?.(d);
            if (intoDir) for (const s of sources) markWrite(path.join(d, path.basename(expandHome(s))), `${name} 로 폴더 안에 파일 만들기`);
            // cp -R: 받는 폴더 아래 아무 곳의 바로가기든 따라 덮어쓸 수 있어, 바로가기가 있으면 승인함으로
            const recursive = name === 'cp' && args.some((a) => /^-[a-zA-Z]*[rRa]/.test(a) || a === '--recursive' || a === '--archive');
            if (recursive && ctx.hasLinksUnder?.(d)) bump('command', `복사 받는 폴더 안에 바로가기가 있음: ${d}`);
          }
        }
        else if (name === 'chmod' || name === 'chown') {
          out.modeChange = true;
          // chmod -x 처럼 '-' 로 시작하는 권한 값도 있으므로 chmod 는 알려진 옵션만 뺀다
          const words2 = name === 'chmod' ? args.filter((a) => !/^-[RfvhHLPEC]+$/.test(a)) : files;
          const targets2 = words2.slice(1);
          if (!targets2.length) bump('command', `${name} (바꿀 파일을 알 수 없음)`);
          targets2.forEach((f) => markWrite(f, `${name} 로 권한 바꾸기`));
        }
        else if (name === 'dd') {
          const of = args.find((a) => a.startsWith('of='));
          if (of) markWrite(of.slice(3), 'dd 로 쓰기');
          else bump('command', 'dd');
        } else files.forEach((f) => markWrite(f, `${name} 로 파일 쓰기`));
        continue;
      }
      if (name === 'sort' && args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith('--output'))) {
        bump('command', 'sort -o 로 파일 쓰기');
        continue;
      }
      if (READ_ONLY_CMDS.has(name)) {
        const files = name === 'echo' || name === 'true' ? [] : nonOptions(args).filter((a) => !/^\d+$/.test(a));
        // ls 는 이름만 보여 주므로 작업 폴더 밖도 허용(차단 목록은 위에서 이미 막음)
        const outside = (name === 'ls' ? seg.redirIn : [...files, ...seg.redirIn]).map(resolve).filter((p) => !readableAbs(p));
        if (outside.length) bump('command', `작업 폴더 밖을 읽음: ${outside.join(', ')}`);
        if (name === 'uniq' && files.length > 1) markWrite(files[1], 'uniq 로 파일 쓰기');
        if (['cat', 'head', 'tail', 'sort', 'uniq'].includes(name) && globRisk()) bump('command', '비밀 파일이 있는 폴더를 글롭으로 읽음');
        continue;
      }
      bump('command', `${name} (판단이 필요한 명령)`);
    }

    // 바로 허용은 실행 폴더가 작업 대상 안일 때만
    // 바꾸거나 실행하는 명령은 작업 대상 폴더 안에서만, 읽기만 하는 명령은 읽기 허용 폴더 안에서만 바로 허용
    const roots = nonRead ? ctx.targets : ctx.readRoots;
    if (!roots.some((t) => within(cwd, t)) || !roots.some((t) => within(startCwd, t))) {
      bump('command', '작업 대상 폴더 밖에서 실행');
    }
  };

  visit(cmd, path.resolve(ctx.cwd), 0);

  if (out.blockedPaths.length) {
    out.decision = 'deny';
    out.reasons.unshift('차단 목록에 걸린 경로');
    return out;
  }
  out.fileOpsOnly = !otherBump;
  if (level === 'allow') {
    out.decision = 'allow';
    if (!out.reasons.length) out.reasons.push('작업 폴더 안 읽기 명령');
    return out;
  }
  out.decision = 'ask';
  out.kind = level;
  return out;
}
