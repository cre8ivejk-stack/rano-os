// 터미널(Claude Code)에서 따로 진행한 세션 읽기: 미션 작업 폴더(와 바로 위 폴더)에서 연 세션의 제목·마지막 시각·사용자가 친 말 몇 줄만 읽는다.
// 라노가 "앱 밖에서 하던 일"을 알게 하려는 것. 도구 결과·코드·답변은 읽지 않고, 비밀처럼 보이는 글은 가린다. 읽기만 한다.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface TerminalSession {
  id: string;
  title: string; // 세션 이름(사용자가 붙인 이름 → 자동 제목 → 첫 말)
  lastAt: string; // 마지막으로 바뀐 시각(ISO)
  where: string; // 세션을 연 폴더
  prompts: string[]; // 사용자가 친 말 가운데 마지막 몇 개(짧게)
}

const TAIL_BYTES = 1_500_000;
const HEAD_BYTES = 200_000;
const SECRET = /(secret|token|passw(or)?d|api[_-]?key|private[_-]?key|authorization|bearer\s|client_secret)/i;
const LONG_RANDOM = /[A-Za-z0-9+/_\-]{32,}/g;

/** Claude Code 가 대화 기록을 두는 폴더 이름: 경로의 글자·숫자 말고는 '-' 로 바꾼다 */
export function projectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function readPart(file: string, size: number, fromEnd: boolean): string {
  const fd = openSync(file, 'r');
  try {
    const total = statSync(file).size;
    const len = Math.min(size, total);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromEnd ? total - len : 0);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function clean(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim().replace(LONG_RANDOM, '…');
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 사용자가 직접 친 말인지(앱·도구가 넣은 글, 명령 표시는 뺀다) */
function typedText(x: any): string | null {
  if (x?.type !== 'user' || x.isMeta || x.isSidechain) return null;
  const c = x.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) && c.every((b: any) => b?.type === 'text') ? c.map((b: any) => b.text).join('\n') : null;
  if (!text || !text.trim() || /^\s*[<\[]/.test(text) || SECRET.test(text)) return null;
  return text;
}

function readSession(file: string, where: string): TerminalSession | null {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const lines = (st.size > TAIL_BYTES + HEAD_BYTES ? `${readPart(file, HEAD_BYTES, false)}\n${readPart(file, TAIL_BYTES, true)}` : readPart(file, st.size, false)).split('\n');
  let cli = false;
  let sdk = false;
  let custom = '';
  let ai = '';
  const typed: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let x: any;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    if (x.entrypoint === 'cli') cli = true;
    else if (typeof x.entrypoint === 'string' && x.entrypoint.startsWith('sdk')) sdk = true;
    if (x.type === 'custom-title' && typeof x.customTitle === 'string') custom = x.customTitle;
    else if (x.type === 'ai-title' && typeof x.aiTitle === 'string') ai = x.aiTitle;
    const t = typedText(x);
    if (t) typed.push(t);
  }
  if (!cli || sdk) return null; // 터미널에서 연 세션만(앱·SDK 가 돌린 세션은 뺀다)
  if (!typed.length && !custom && !ai) return null;
  return {
    id: path.basename(file, '.jsonl'),
    title: clean(custom || ai || typed[0] || '(제목 없음)', 60),
    lastAt: st.mtime.toISOString(),
    where,
    prompts: typed.slice(-3).map((t) => clean(t, 140)),
  };
}

/**
 * 작업 폴더들(과 바로 위 폴더)에서 터미널로 연 세션을 최근 것부터 돌려준다.
 * @param sinceMs 이 시각 뒤에 바뀐 세션만
 */
export function listTerminalSessions(targets: string[], sinceMs: number, max = 8, projectsRoot = path.join(homedir(), '.claude', 'projects')): TerminalSession[] {
  const home = path.resolve(homedir());
  const dirs = new Set<string>();
  for (const t of targets) {
    const abs = path.resolve(t);
    dirs.add(abs);
    const up = path.dirname(abs);
    if (up !== home && up !== path.dirname(up)) dirs.add(up);
  }
  const found: { file: string; where: string; mtime: number }[] = [];
  for (const d of dirs) {
    const dir = path.join(projectsRoot, projectDirName(d));
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const m = statSync(path.join(dir, n)).mtimeMs;
        if (m >= sinceMs) found.push({ file: path.join(dir, n), where: d, mtime: m });
      } catch {
        // 건너뜀
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const out: TerminalSession[] = [];
  for (const f of found.slice(0, max * 4)) {
    let s: TerminalSession | null = null;
    try {
      s = readSession(f.file, f.where);
    } catch {
      s = null;
    }
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** 라노에게 줄 글 */
export function describeTerminalSessions(list: TerminalSession[], detail = false): string {
  if (!list.length) return '(최근 터미널 세션 없음)';
  return list
    .map((s) => {
      const at = new Date(s.lastAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      const head = `- 「${s.title}」 (마지막 ${at})`;
      return detail && s.prompts.length ? `${head}\n${s.prompts.map((p) => `    · ${p}`).join('\n')}` : head;
    })
    .join('\n');
}
