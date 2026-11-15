// 작업 폴더가 원격(GitHub 등)보다 뒤처졌는지 과제 시작 안내에 알리기 (S6-A, 2026-11-15 사용자 결정)
// 인터넷은 쓰지 않는다: 이 컴퓨터에 마지막으로 받아 둔 원격 기록(origin/main 등)과 지금 작업 폴더를 git 으로 비교하고,
// 마지막으로 받아온 시각(.git/FETCH_HEAD 수정 시각)을 함께 적는다. 오래 안 받아왔으면 실제보다 덜 뒤처져 보일 수 있어 시각을 같이 보인다.
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export interface BehindInfo {
  repo: string; // 작업 폴더
  upstream: string; // 비교한 원격 기록 이름(origin/main 등)
  behind: number; // 원격 기록에만 있는 커밋 수
  ahead: number; // 작업 폴더에만 있는 커밋 수
  fetchedAt: Date | null; // 마지막으로 받아온 시각(모르면 null)
}

/** 한 번에 기다리는 시간(밀리초). 과제 시작이 늦어지지 않게 짧게 */
export const BEHIND_TIMEOUT_MS = 1200;

function git(dir: string, args: string[], timeoutMs = BEHIND_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', dir, ...args],
        // 묻는 창·잠금 파일을 만들지 않는다(읽기만)
        { timeout: timeoutMs, encoding: 'utf-8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
        (err, stdout) => resolve(err ? null : String(stdout ?? '').trim()),
      );
    } catch {
      resolve(null);
    }
  });
}

/** 작업 폴더 하나를 비교한다. git 폴더가 아니거나 따라가는 원격 가지가 없으면 null */
export async function gitBehind(dir: string, timeoutMs = BEHIND_TIMEOUT_MS): Promise<BehindInfo | null> {
  const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], timeoutMs);
  if (!upstream) return null;
  const counts = await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], timeoutMs);
  const m = counts ? /^(\d+)\s+(\d+)$/.exec(counts) : null;
  if (!m) return null;
  let fetchedAt: Date | null = null;
  const gitDir = await git(dir, ['rev-parse', '--absolute-git-dir'], timeoutMs);
  if (gitDir) {
    try {
      fetchedAt = (await stat(path.join(gitDir, 'FETCH_HEAD'))).mtime;
    } catch {
      fetchedAt = null; // 한 번도 받아온 적이 없음(clone 만 함)
    }
  }
  return { repo: dir, upstream, ahead: Number(m[1]), behind: Number(m[2]), fetchedAt };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 사람이 읽는 시각(이 컴퓨터 시간대)과 얼마 전인지 */
export function whenText(at: Date, now: Date = new Date()): string {
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const min = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60000));
  const ago = min < 60 ? `${min}분 전` : min < 60 * 48 ? `${Math.floor(min / 60)}시간 전` : `${Math.floor(min / 1440)}일 전`;
  return `${stamp}, ${ago}`;
}

/** 안내 한 줄. 뒤처지지 않았으면 null */
export function formatBehind(info: BehindInfo, now: Date = new Date()): string | null {
  if (info.behind <= 0) return null;
  const when = info.fetchedAt ? `마지막으로 받아온 때: ${whenText(info.fetchedAt, now)}` : '받아온 기록이 없어 clone 한 때 기준';
  const diverged = info.ahead > 0 ? ` 작업 폴더에만 있는 커밋도 ${info.ahead}개 있어요(갈래가 갈라짐).` : '';
  return (
    `작업 폴더 ${path.basename(info.repo)} 가 이 컴퓨터에 받아 둔 원격 기록(${info.upstream})보다 ${info.behind}커밋 뒤처져 있어요(${when}. 인터넷으로 다시 확인하지 않았으니 실제로는 더 뒤처졌을 수 있어요).${diverged}` +
    ' 판정·보고 전에 이 사실을 보고 첫머리에 적고, 최신 코드 기준이 필요한 일이면 사용자에게 받아오기(pull)를 권하세요.'
  );
}

/** 과제 시작 안내에 넣을 줄들(작업 폴더마다). 모두 합쳐 오래 걸리면 빈 목록 */
export async function behindNotes(targets: string[], timeoutMs = BEHIND_TIMEOUT_MS, now: Date = new Date()): Promise<string[]> {
  const work = Promise.all(targets.map((t) => gitBehind(t, timeoutMs).catch(() => null))).then((list) =>
    list.map((i) => (i ? formatBehind(i, now) : null)).filter((s): s is string => !!s),
  );
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs + 300);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
