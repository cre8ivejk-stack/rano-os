// 믿는 미션 기록 (2026-11-15 사용자 결정 T3-B)
// - 조직 화면에서 쓰기 방식을 바꾸면 그 미션 결정로그(memory/결정로그.md)에 한 줄 남긴다(orgAdmin.ts).
// - 앱이 켜질 때 지난번 믿는 미션 목록(runs/trusted-missions.json)과 설정 파일(rano.json)을 비교해,
//   앱 밖에서(손으로 고쳐) 새로 믿는 미션이 된 것을 찾아 결정로그에 남기고 라노에게 알린다(main.ts).
// - 처음 켤 때(목록 파일이 없을 때)는 지금 상태를 기준으로 저장만 하고 알리지 않는다(언제 바뀌었는지 알 수 없음).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WriteMode } from '../../shared/types.js';
import { resolveIn } from './paths.js';

/** 지난번 믿는 미션 목록을 두는 앱 파일(runs 아래) */
export const TRUST_STATE_FILE = 'trusted-missions.json';

export const WRITE_LABEL: Readonly<Record<WriteMode, string>> = {
  readOnly: '읽기만',
  approval: '승인함을 거쳐 쓰기',
  trusted: '믿는 미션(리포 안 고치기는 묻지 않기)',
};

/** rano.json 미션 한 줄이 믿는 미션인지: config.ts 와 같은 기준(stagePolicy approval + trustRepo true) */
export function isTrustedRaw(m: unknown): boolean {
  const x = m as { stagePolicy?: unknown; trustRepo?: unknown } | null;
  return !!x && x.stagePolicy === 'approval' && x.trustRepo === true;
}

export interface TrustedMission {
  id: string;
  name: string;
  home: string; // rano.json 에 적힌 그대로(상대 경로·~ 가능)
}

/** rano.json 원본에서 믿는 미션 목록(보관한 미션 포함: 보관했다 다시 꺼내도 새로 믿게 된 것으로 보지 않게) */
export function trustedFromRaw(raw: unknown): TrustedMission[] {
  const list = (raw as { missions?: unknown })?.missions;
  if (!Array.isArray(list)) return [];
  const out: TrustedMission[] = [];
  for (const m of list) {
    if (!isTrustedRaw(m) || typeof m.id !== 'string' || !m.id) continue;
    out.push({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id, home: typeof m.home === 'string' ? m.home : '' });
  }
  return out;
}

/** 지난번 목록(prev)에 없던 믿는 미션. prev 가 null(처음)이면 아무것도 새로 보지 않는다 */
export function findNewlyTrusted(prev: readonly string[] | null, now: readonly TrustedMission[]): TrustedMission[] {
  if (!prev) return [];
  const had = new Set(prev);
  return now.filter((m) => !had.has(m.id));
}

/** 지난번 믿는 미션 id 목록. 파일이 없거나 읽을 수 없으면 null */
export function readTrustState(runsDir: string): string[] | null {
  try {
    const j = JSON.parse(readFileSync(path.join(runsDir, TRUST_STATE_FILE), 'utf-8'));
    return Array.isArray(j?.trusted) ? j.trusted.filter((x: unknown): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

export function writeTrustState(runsDir: string, ids: readonly string[]): void {
  mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, TRUST_STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = { version: 1, updatedAt: new Date().toISOString(), trusted: [...new Set(ids)].sort() };
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

/**
 * 조직 화면(앱)이 믿는 미션을 켜거나 끈 뒤 부른다: 목록 파일을 맞춰 두어 다음에 켤 때 "앱 밖에서 바뀜"으로 보지 않게 한다.
 * 목록 파일이 아직 없으면(앱이 켜질 때 만들기 전) 건드리지 않는다.
 */
export function noteTrustChange(runsDir: string, missionId: string, trusted: boolean): void {
  const prev = readTrustState(runsDir);
  if (!prev) return;
  const next = new Set(prev);
  if (trusted) next.add(missionId);
  else next.delete(missionId);
  writeTrustState(runsDir, [...next]);
}

/** 조직 화면에서 쓰기 방식을 바꿨을 때 결정로그에 남길 글(날짜·"- " 빼고). 같으면 null */
export function writeModeDecision(before: WriteMode, after: WriteMode): string | null {
  if (before === after) return null;
  if (after === 'trusted') return `사용자가 앱에서 믿는 미션(작업 폴더 안 고치기는 묻지 않기)을 허용 (이전: ${WRITE_LABEL[before]})`;
  if (before === 'trusted') return `사용자가 앱에서 믿는 미션을 풀고 ${WRITE_LABEL[after]}(으)로 바꿈`;
  if (after === 'approval') return '사용자가 앱에서 승인함을 거친 쓰기를 허용';
  return `사용자가 앱에서 ${WRITE_LABEL[after]}(으)로 바꿈 (이전: ${WRITE_LABEL[before]})`;
}

/** 미션 홈의 memory/결정로그.md 끝에 "- 날짜 글" 한 줄을 더한다(없으면 만든다) */
export function appendDecisionLog(home: string, date: string, text: string): void {
  const dir = path.join(home, 'memory');
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, '결정로그.md');
  let cur = '# 결정로그\n\n';
  if (existsSync(log)) cur = readFileSync(log, 'utf-8');
  const sep = cur && !cur.endsWith('\n') ? '\n' : '';
  writeFileSync(log, `${cur}${sep}- ${date} ${text}\n`, 'utf-8');
}

export const OUTSIDE_TRUST_NOTE = '앱 밖에서 설정 파일(rano.json)이 바뀌어 믿는 미션(작업 폴더 안 고치기는 묻지 않기)이 됨 — 앱이 켜질 때 찾음, 조직 화면에서 허용한 기록 없음';

/**
 * 앱이 켜질 때 한 번: 새로 믿는 미션이 된 것을 찾아 결정로그에 남기고, 지금 목록을 저장한다. 찾은 미션을 돌려준다.
 * 실패해도 앱 시작을 막지 않도록 부르는 쪽에서 감싼다.
 */
export function checkTrustAtStart(opts: { raw: unknown; rootDir: string; runsDir: string; date: string }): { found: TrustedMission[]; first: boolean; logFailed: string[] } {
  const now = trustedFromRaw(opts.raw);
  const prev = readTrustState(opts.runsDir);
  const found = findNewlyTrusted(prev, now);
  const logFailed: string[] = [];
  for (const m of found) {
    try {
      if (!m.home) throw new Error('no home');
      appendDecisionLog(resolveIn(opts.rootDir, m.home), opts.date, OUTSIDE_TRUST_NOTE);
    } catch {
      logFailed.push(m.id);
    }
  }
  writeTrustState(opts.runsDir, now.map((m) => m.id));
  return { found, first: prev === null, logFailed };
}

/** 라노에게 보낼 알림 한 줄 */
export function trustNoticeText(found: readonly TrustedMission[]): string {
  const names = found.map((m) => `「${m.name}」`).join(', ');
  return `[앱 알림] 앱이 켜질 때 보니 설정 파일(rano.json)이 앱 밖에서 바뀌어 ${names}이(가) 믿는 미션(작업 폴더 안 고치기·시험은 묻지 않음)이 됐어요. 조직 화면에서 허용한 기록이 없어 그 미션 결정로그에 남겼어요. 사용자에게 한 줄로 알리고, 의도한 변경이 아니면 조직 화면에서 쓰기 방식을 바꾸라고 안내해 주세요.`;
}
