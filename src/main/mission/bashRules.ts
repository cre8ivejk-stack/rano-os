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
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse']);
const GIT_COMMIT = new Set([
  'commit', 'push', 'tag', 'reset', 'rebase', 'merge', 'checkout', 'switch', 'restore', 'pull',
  'cherry-pick', 'revert', 'am', 'apply', 'stash',
]);
const GIT_DELETE = new Set(['rm', 'clean']);
const DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash']);
const DB_CMDS = new Set(['psql', 'mysql', 'mariadb', 'mongosh', 'mongo', 'sqlite3', 'redis-cli', 'pg_restore', 'pg_dump']);
const DEPLOY_CMDS = new Set(['vercel', 'netlify', 'kubectl', 'helm', 'terraform', 'pulumi', 'flyctl', 'heroku', 'firebase', 'gcloud', 'aws', 'az', 'ssh', 'scp', 'rsync', 'eas']);
const WRITE_CMDS = new Set(['mv', 'cp', 'tee', 'touch', 'mkdir', 'ln', 'chmod', 'chown', 'truncate', 'dd', 'install']);
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'xargs', 'nice']);

// 비밀이 있을 법한 이름. 경로로 풀지 못해도(따옴표 속 글롭 등) 보이면 막는다.
const SECRET_NAME = /(^|[\/\s"'=])\.env(\.[^\s\/"']*)?($|[\s\/"'])|(^|\/)\.ssh(\/|$)|(^|\/)\.aws(\/|$)|Keychains|\.config\/gh(\/|$)|\.config\/gcloud(\/|$)/;

interface Segment {
  words: string[];
  redirOut: string[];
  redirIn: string[];
}

function splitSegments(tokens: Token[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment = { words: [], redirOut: [], redirIn: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op && SEPARATORS.has(t.op)) {
      if (cur.words.length || cur.redirOut.length || cur.redirIn.length) segs.push(cur);
      cur = { words: [], redirOut: [], redirIn: [] };
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
  const bump = (k: BashKind, why: string) => {
    level = stricter(level, k);
    out.reasons.push(why);
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

      let words = seg.words.slice();
      // 앞쪽 환경변수 지정(FOO=bar) 제거
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      if (!words.length) continue;
      if (WRAPPERS.has(path.basename(words[0]))) {
        bump('command', `${words[0]} 로 감싼 명령`);
        words = words.slice(1);
        while (words.length && (words[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
        if (!words.length) continue;
      }
      const name = path.basename(words[0]);
      const args = words.slice(1);
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
        } else bump('command', 'find');
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
        } else bump('command', name);
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
        continue;
      }
      bump('command', `${name} (판단이 필요한 명령)`);
    }

    // 바로 허용은 실행 폴더가 작업 대상 안일 때만
    if (!ctx.targets.some((t) => within(cwd, t)) || !ctx.targets.some((t) => within(startCwd, t))) {
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
