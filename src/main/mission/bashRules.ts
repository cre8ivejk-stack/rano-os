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
}

export interface BashDecision {
  decision: 'allow' | 'ask' | 'deny';
  kind?: BashKind; // decision 'ask' 일 때 승인함 종류
  reasons: string[]; // 판단 근거(기록용)
  blockedPaths: string[]; // 차단 목록에 걸린 경로
  writePaths: string[]; // 바뀔 것으로 보이는 파일(절대 경로)
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
}

interface Tokenized {
  tokens: Token[];
  subs: string[]; // $(...) 와 `...` 안의 명령
  ok: boolean; // 따옴표가 닫히지 않는 등 해석 실패면 false
  heredoc: boolean;
}

const OPS = ['&&', '||', ';;', '>>', '&>', '2>>', '2>', '1>', '>|', '<<<', '<<', ';', '|', '&', '>', '<', '\n', '(', ')'];

/** 아주 단순한 셸 토큰 분리기. */
export function tokenize(cmd: string): Tokenized {
  const tokens: Token[] = [];
  const subs: string[] = [];
  let cur = '';
  let curQuoted = false;
  let has = false;
  let ok = true;
  let heredoc = false;
  const push = () => {
    if (has) tokens.push({ text: cur, quoted: curQuoted });
    cur = '';
    curQuoted = false;
    has = false;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      has = true;
      i += 2;
      continue;
    }
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
        if (cmd[j] === '\\' && j + 1 < cmd.length) {
          buf += cmd[j + 1];
          j += 2;
          continue;
        }
        if (cmd[j] === '$' && cmd[j + 1] === '(') {
          const end = matchParen(cmd, j + 1);
          if (end < 0) {
            ok = false;
            break;
          }
          subs.push(cmd.slice(j + 2, end));
          buf += cmd.slice(j, end + 1);
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
      has = true;
      i = end + 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      push();
      i++;
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
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'rev-list', 'describe', 'shortlog']);
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
const INFO_CMDS = new Set(['which', 'date', 'uname', 'lsof', 'ps', 'whereis', 'type', 'sleep']);
// find -exec 로 돌려도 내용을 드러내지 않는 명령(지문·크기·종류)
const FIND_SAFE_EXEC = new Set(['md5', 'shasum', 'wc', 'ls', 'stat', 'file', 'du']);
// 셸 문법 단어
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}']);
const SHELL_ENDS = new Set(['done', 'fi', 'esac', '}']);
const GLOB = /[*?[]/;

/** sed 스크립트가 출력만 하는지(파일 쓰기 w·명령 실행 e·파일 읽기 r 이 없는지) */
function sedScriptIsPure(script: string): boolean {
  let rest = script.replace(/s(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImM0-9]*/g, ' '); // s/../../ 바꾸기
  rest = rest.replace(/\\(.)(?:\\.|(?!\1)[^\\])*\1|\/(?:\\.|[^\/])*\//g, ' '); // /주소/ \#주소#
  rest = rest.replace(/y(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1/g, ' ');
  return /^[\s\d,$;!{}~+pdqnlPNgGhHxD=]*$/.test(rest);
}

// 확인 명령: 타입 검사·린트·시험. 프로젝트 코드를 돌리지만 파일을 고치지 않는 것만
const CHECK_SCRIPT = /^(test|tests|lint|typecheck|type-check|types|check|tsc|test:[\w-]+|lint:[\w-]+|typecheck:[\w-]+|check:[\w-]+)$/;
function isCheckCommand(name: string, args: string[]): boolean {
  const all = args.join(' ');
  if (/(^|\s)--?(fix|write|u|update|updateSnapshot|update-snapshots|watch|w)(\s|=|$)/.test(all)) return false;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    if (args[0] === 'test' || args[0] === 't') return true;
    const runIdx = args.findIndex((a) => a === 'run' || a === 'run-script');
    const script = runIdx >= 0 ? args[runIdx + 1] ?? '' : name === 'yarn' || name === 'pnpm' ? args[0] ?? '' : '';
    return CHECK_SCRIPT.test(script) && !/fix|format|write|update|deploy|release|publish|db|migrat|seed/.test(script);
  }
  let rest = args;
  if (name === 'npx' || name === 'pnpx' || (name === 'pnpm' && args[0] === 'exec')) {
    rest = args.filter((a) => a !== 'exec' && a !== '--no-install' && a !== '--no');
    name = rest[0] ?? '';
    rest = rest.slice(1);
  }
  const r = rest.join(' ');
  if (name === 'tsc') return /(^|\s)--noEmit(\s|$)/.test(r);
  if (name === 'eslint') return true;
  if (name === 'tsx' || name === 'node') return rest[0] === '--test';
  if (name === 'vitest') return rest[0] === 'run';
  if (name === 'jest') return !/--watch/.test(r);
  if (name === 'prettier') return rest.includes('--check') || rest.includes('-c');
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

// 비밀이 있을 법한 이름. 경로로 풀지 못해도(따옴표 속 글롭 등) 보이면 막는다.
const SECRET_NAME = /(^|[\/\s"'=])\.env(\.[^\s\/"']*)?($|[\s\/"'])|(^|\/)\.ssh(\/|$)|(^|\/)\.aws(\/|$)|Keychains|\.config\/gh(\/|$)|\.config\/gcloud(\/|$)/;

interface Segment {
  words: string[];
  quoted: boolean[]; // words 와 같은 순서. 따옴표로 감싼 단어인지(글롭이 풀리지 않음)
  redirOut: string[];
  redirIn: string[];
}

function splitSegments(tokens: Token[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment = { words: [], quoted: [], redirOut: [], redirIn: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op && SEPARATORS.has(t.op)) {
      if (cur.words.length || cur.redirOut.length || cur.redirIn.length) segs.push(cur);
      cur = { words: [], quoted: [], redirOut: [], redirIn: [] };
      continue;
    }
    if (t.op && REDIRECT_OUT.has(t.op)) {
      const target = tokens[i + 1];
      if (target && !target.op) {
        cur.redirOut.push(target.text);
        i++;
      }
      continue;
    }
    if (t.op && REDIRECT_IN.has(t.op)) {
      const target = tokens[i + 1];
      if (target && !target.op) {
        if (t.op === '<') cur.redirIn.push(target.text);
        i++;
      }
      continue;
    }
    if (t.op === '<<') {
      i++; // heredoc 구분자
      continue;
    }
    cur.words.push(t.text);
    cur.quoted.push(!!t.quoted);
  }
  if (cur.words.length || cur.redirOut.length || cur.redirIn.length) segs.push(cur);
  return segs;
}

function nonOptions(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'));
}

/** Bash 명령 하나(여러 개 이어 쓴 것 포함)를 분류한다. */
export function classifyBash(command: string, ctx: BashContext): BashDecision {
  const out: BashDecision = { decision: 'allow', reasons: [], blockedPaths: [], writePaths: [] };
  let level: BashKind | 'allow' = 'allow';
  let nonRead = false; // 읽기만 하는 명령이 아닌 것이 섞였는지
  const bump = (k: BashKind, why: string) => {
    level = stricter(level, k);
    out.reasons.push(why);
    nonRead = true;
  };

  const cmd = command.trim();
  if (!cmd) {
    return { decision: 'ask', kind: 'command', reasons: ['빈 명령'], blockedPaths: [], writePaths: [] };
  }
  if (SECRET_NAME.test(cmd)) {
    out.blockedPaths.push('(명령 안에 비밀 설정 파일·키 폴더 이름이 있음)');
  }

  const visit = (text: string, startCwd: string, depth: number) => {
    const tk = tokenize(text);
    if (!tk.ok) bump('command', '명령을 해석하지 못함');
    if (tk.heredoc) bump('command', 'heredoc 사용');
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
      bump(ctx.targets.some((t) => within(abs, t)) ? 'write' : 'outsideWrite', why);
    };

    for (const sub of tk.subs) {
      if (depth < 3) visit(sub, cwd, depth + 1);
      else bump('command', '명령 치환이 너무 깊음');
    }

    for (const seg of splitSegments(tk.tokens)) {
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
      if (words[0] === 'for' && words[2] === 'in') continue; // for 변수 in 값들 (값은 다음 명령에서 경로로 검사됨)
      if (words[0] === 'for' || words[0] === 'case') {
        bump('command', `${words[0]} 문법`);
        continue;
      }
      // 앞쪽 환경변수 지정(FOO=bar) 제거
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      if (!words.length) continue;
      if (WRAPPERS.has(path.basename(words[0]))) {
        bump('command', `${words[0]} 로 감싼 명령`);
        words = words.slice(1);
        quoted = quoted.slice(1);
        while (words.length && (words[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
          words.shift();
          quoted.shift();
        }
        if (!words.length) continue;
      }
      const name = path.basename(words[0]);
      const args = words.slice(1);
      const argQuoted = quoted.slice(1);
      const isReadable = (p: string) => ctx.readRoots.some((r) => within(resolve(p), r));
      /** 글롭·폴더 통째 읽기가 차단·비밀 파일을 건드릴 수 있는지 */
      const secretFiles = (dir: string): string[] => (ctx.secretsUnder ? ctx.secretsUnder(resolve(dir)) : ['*']);
      const touchesSecrets = (dir: string) => secretFiles(dir).length > 0;
      const globDirs = () =>
        args
          .map((a, idx) => (!argQuoted[idx] && !a.startsWith('-') && GLOB.test(a) ? a.slice(0, a.search(GLOB)) : null))
          .filter((d): d is string => d !== null)
          .map((d) => (d.endsWith('/') || d === '' ? d || '.' : path.dirname(d)));
      const lowerAll = words.join(' ').toLowerCase();

      if (name === 'cd') {
        const dest = args[0] ? resolve(args[0]) : homedir();
        cwd = dest;
        continue;
      }

      if (name === 'git') {
        // git -C <dir> 같은 앞 옵션 건너뛰기
        let k = 0;
        while (k < args.length && args[k].startsWith('-')) {
          if (args[k] === '-C' || args[k] === '-c') k++;
          k++;
        }
        const sub = args[k] ?? '';
        const rest = args.slice(k + 1);
        if (GIT_DELETE.has(sub)) bump('delete', `git ${sub}`);
        else if (GIT_COMMIT.has(sub)) bump('commit', `git ${sub}`);
        else if (GIT_READ.has(sub)) {
          if (sub === 'branch' && nonOptions(rest).length) bump('command', 'git branch 로 가지 만들기·지우기');
          else if (sub === 'branch' && rest.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force)/.test(a))) bump('command', 'git branch 변경');
        } else bump('command', `git ${sub || '(하위 명령 없음)'}`);
        continue;
      }

      if (DELETE_CMDS.has(name)) {
        bump('delete', `${name} 로 삭제`);
        for (const a of nonOptions(args)) out.writePaths.push(resolve(a));
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
        if (ctx.allowChecks && isCheckCommand(name, args)) {
          out.reasons.push(`확인 명령: ${name} ${args.slice(0, 2).join(' ')}`.trim());
          nonRead = true;
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
        if (['push', 'login'].includes(args[0] ?? '')) bump('deploy', `${name} ${args[0]}`);
        else bump('command', name);
        continue;
      }
      if (DEPLOY_CMDS.has(name) || /\bdeploy\b/.test(lowerAll)) {
        bump('deploy', `${name} (배포·운영)`);
        continue;
      }
      if (name === 'sed' || name === 'perl') {
        if (args.some((a) => /^-i/.test(a) || /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) {
          const files = nonOptions(args).slice(1);
          if (files.length) files.forEach((f) => markWrite(f, `${name} -i 로 파일 수정`));
          else bump('command', `${name} -i`);
        } else if (name === 'sed') {
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
            if (globDirs().some(touchesSecrets)) bump('command', '비밀 파일이 있는 폴더를 글롭으로 읽음');
          }
        } else bump('command', name);
        continue;
      }
      if (INFO_CMDS.has(name)) continue;
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
            } else if (isGrep && /^-[ABCm]$|^--(include|exclude|exclude-dir|max-count|context|glob|type)$/.test(a)) k++; // 값이 따로 오는 옵션
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
        if (name === 'jq') files.push(...nonOptions(args).slice(1));
        const outside = [...files, ...seg.redirIn].filter((p) => p && !/^\d+$/.test(p) && !isReadable(p));
        if (outside.length) bump('command', `작업 폴더 밖을 읽음: ${outside.map(resolve).join(', ')}`);
        const recursive = name === 'rg' || (isGrep && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || a === '--dereference-recursive'));
        if (recursive) {
          const dirs = files.length ? files : ['.'];
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
          const risky = dirs.flatMap(secretFiles).filter((f) => {
            if (f === '*') return true;
            const base = path.basename(f);
            if (includes.length && !includes.some((r) => r.test(base))) return false;
            return !excludes.some((r) => r.test(base));
          });
          if (risky.length) bump('command', '비밀·차단 파일이 있는 폴더를 통째로 검색');
        }
        if (!['file', 'stat', 'du', 'basename', 'dirname', 'realpath', 'readlink', 'tree'].includes(name) && globDirs().some(touchesSecrets))
          bump('command', '비밀 파일이 있는 폴더를 글롭으로 읽음');
        continue;
      }
      if (WRITE_CMDS.has(name)) {
        const files = nonOptions(args);
        if (!files.length) bump('command', name);
        else if (name === 'mv') files.forEach((f) => markWrite(f, `mv 로 파일 옮기기: ${f}`));
        else if (name === 'cp' || name === 'ln' || name === 'install') markWrite(files[files.length - 1], `${name} 로 파일 만들기`);
        else if (name === 'chmod' || name === 'chown') files.slice(1).forEach((f) => markWrite(f, `${name} 로 권한 바꾸기`));
        else if (name === 'dd') {
          const of = args.find((a) => a.startsWith('of='));
          if (of) markWrite(of.slice(3), 'dd 로 쓰기');
          else bump('command', 'dd');
        } else files.forEach((f) => markWrite(f, `${name} 로 파일 쓰기`));
        continue;
      }
      if (name === 'sort' && args.some((a) => a === '-o' || a.startsWith('-o') || a.startsWith('--output'))) {
        bump('command', 'sort -o 로 파일 쓰기');
        continue;
      }
      if (READ_ONLY_CMDS.has(name)) {
        const files = name === 'echo' || name === 'true' ? [] : nonOptions(args).filter((a) => !/^\d+$/.test(a));
        const outside = [...files, ...seg.redirIn].map(resolve).filter((p) => !ctx.readRoots.some((r) => within(p, r)));
        if (outside.length) bump('command', `작업 폴더 밖을 읽음: ${outside.join(', ')}`);
        if (['cat', 'head', 'tail', 'sort', 'uniq'].includes(name) && globDirs().some(touchesSecrets)) bump('command', '비밀 파일이 있는 폴더를 글롭으로 읽음');
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
  if (level === 'allow') {
    out.decision = 'allow';
    if (!out.reasons.length) out.reasons.push('작업 폴더 안 읽기 명령');
    return out;
  }
  out.decision = 'ask';
  out.kind = level;
  return out;
}
