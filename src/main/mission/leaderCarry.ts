// 리더 과제마다 새 대화로 시작할 때 앱이 붙이는 "직전 과제" 묶음과, 마지막 검수 뒤 리더가 직접 고친 횟수 안내.
// 파일·엔진·화면을 건드리지 않는 순수 함수만 둔다(시험에서 그대로 부른다). leaderSession.ts 가 기록을 모아 넘긴다.
import path from 'node:path';
import type { ApprovalRequest, ChatMessage, TaskOutput } from '../../shared/types.js';
import { APP_WRITTEN_NOTES } from '../approvals/approvalQueue.js';
import { redactCommand } from './leaderPermissions.js';

/** 묶음 전체 상한(글자) */
export const CARRY_MAX = 3000;
const ORDER_MAX = 300; // 직전 지시 앞부분
const REPORT_MAX = 1500; // 직전 보고에서 뽑은 절
const REPORT_MIN = 300;
const NOTE_MAX = 200; // 사용자 메모 하나
const NOTES_MAX = 5; // 사용자 메모 건수
const PAIR_SIDE_MAX = 250; // 직접 대화 한 쪽
const PAIRS = 3; // 직접 대화 쌍 수
const STOP_MAX = 200; // 중단된 과제의 멈춘 사유

// 개인 키 묶음(BEGIN … PRIVATE KEY ~ END …)은 통째로 가린다
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
// 이름이 비밀스러운 "이름=값"·"이름: 값"의 값만 가린다(redactCommand 가 못 보는 이름: private_key·aws_access…·비밀번호 등)
const SECRET_VALUE =
  /((?:private[_-]?key|aws_access[A-Za-z0-9_-]*|aws_secret[A-Za-z0-9_-]*|client[_-]?secret|credential[A-Za-z0-9_-]*|비밀번호|암호|비밀\s*키|인증\s*키)\s*[=:：]\s*)(?!\(가림\))("[^"]*"|'[^']*'|[^\s'"]+)/gi;

/** 한 줄 가리기: 경로는 마디 단위(32자 넘는 무작위 마디만)·UUID 는 남기고, 비밀스러운 이름의 값·토큰 모양 글만 가린다 */
function maskLine(line: string): string {
  return redactCommand(line.replace(SECRET_VALUE, '$1(가림)'));
}

/** 원래 줄마다 가린다(한 줄로 합치기 전에). 줄 통째로 지우지 않아 경로·지시는 남는다 */
function maskText(text: string): string {
  return String(text ?? '')
    .replace(PEM_BLOCK, '(비밀로 보여 가림)')
    .split('\n')
    .map(maskLine)
    .join('\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
}

function cut(t: string, max: number): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 비밀로 보이는 값을 가리고 줄바꿈을 줄여 max 글자까지 */
export function hideSecrets(text: string, max: number): string {
  return cut(maskText(text).replace(/\n{3,}/g, '\n\n').trim(), max);
}

/** 원래 줄마다 가린 뒤 한 줄로 합쳐 max 글자까지 */
function oneLine(text: string, max: number): string {
  return cut(maskText(text).replace(/\s+/g, ' ').trim(), max);
}

// 보고 형식의 절 제목: "4. 결과", "## 4) 결과", "**4. 결과**:" 등. "결과물 대조표"(2번)와 헷갈리지 않게 번호로 본다
const SECTION_START = /^[\s>*#_-]*(?:\*\*)?\s*([456])\s*[.)]\s*(?:\*\*)?\s*(결과(?!물)|결정이\s*필요한|승인이\s*필요한)/m;

/**
 * 직전 보고에서 "4. 결과 · 5. 결정이 필요한 사항 · 6. 승인이 필요한 일" 절을 뽑는다(4~6 중 처음 나온 절부터 끝까지).
 * 형식이 다르면(절 제목이 없으면) 앞부분. 비밀은 가린다.
 */
export function reportSections(report: string, max = REPORT_MAX): string {
  const text = String(report ?? '');
  const m = SECTION_START.exec(text);
  const lineStart = m ? text.lastIndexOf('\n', m.index + m[0].search(/\S/)) + 1 : 0;
  return hideSecrets(m ? text.slice(lineStart) : text, max);
}

/** 앱이 쓴 메모가 아닌, 사용자가 승인 카드에서 "수정 요청·반려"로 남긴 말. 최신 것부터 max 건 */
export function userDecisionNotes(
  items: Pick<ApprovalRequest, 'missionId' | 'taskId' | 'status' | 'decisionNote' | 'title'>[],
  missionId: string,
  taskIds: string[],
  max = NOTES_MAX,
  noteMax = NOTE_MAX,
): { status: 'revise' | 'rejected'; title: string; note: string }[] {
  const ids = new Set(taskIds.filter(Boolean));
  const out: { status: 'revise' | 'rejected'; title: string; note: string }[] = [];
  for (const r of items) {
    if (out.length >= max) break;
    if (r.missionId !== missionId || !r.taskId || !ids.has(r.taskId)) continue;
    if (r.status !== 'revise' && r.status !== 'rejected') continue;
    const note = String(r.decisionNote ?? '').trim();
    if (!note || APP_WRITTEN_NOTES.has(note)) continue;
    out.push({ status: r.status, title: oneLine(r.title, 60), note: oneLine(note, noteMax) });
  }
  return out;
}

/** 리더 대화의 (지시 → 리더 답) 쌍. 저장 순서 = 줄 선 순서(과제는 하나씩 돌고, 지시는 시작할 때 저장된다). 마지막 n쌍 */
export function lastPairs(messages: ChatMessage[], n = PAIRS): { from: 'user' | 'rano'; ask: string; answer: string }[] {
  const pairs: { from: 'user' | 'rano'; ask: string; answer: string }[] = [];
  let pending: ChatMessage | null = null;
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'rano') pending = m;
    else if (m.role === 'leader' && pending) {
      pairs.push({ from: pending.role === 'user' ? 'user' : 'rano', ask: pending.text, answer: m.text });
      pending = null;
    }
  }
  return pairs.slice(-n);
}

type TaskLike = Pick<TaskOutput, 'taskId' | 'title' | 'status' | 'startedAt' | 'endedAt' | 'leaderReport'>;

export interface CarryInput {
  missionId: string;
  from: 'rano' | 'user'; // 이번 과제를 준 쪽. 'user'(리더 대화창 직접 지시)면 직전 대화 3쌍을 붙인다
  currentTaskId?: string; // 이번 과제(목록에 있어도 뺀다)
  tasks: TaskLike[]; // 결과물함 기록(outputs.json), 최신 먼저
  messages: ChatMessage[]; // 리더 대화 기록(이번 지시를 저장하기 전)
  approvals: Pick<ApprovalRequest, 'missionId' | 'taskId' | 'status' | 'decisionNote' | 'title'>[];
  draftsDir: (taskId: string) => string | undefined;
  handoffFile: string; // 인수 메모 파일 이름
  max?: number;
}

/** 그 과제의 지시 원문: 과제 시작 직전(startedAt 이하)에 저장된 마지막 지시. 없으면 제목 */
function orderOf(t: TaskLike, messages: ChatMessage[]): string {
  let found: ChatMessage | undefined;
  for (const m of messages) {
    if ((m.role === 'user' || m.role === 'rano') && m.at <= t.startedAt) found = m;
  }
  return found?.text ?? t.title;
}

function pathsLine(t: TaskLike, input: CarryInput): string {
  const d = input.draftsDir(t.taskId);
  return d ? `  - 시안 폴더: ${d}\n  - 인수 메모: ${path.join(d, input.handoffFile)}` : '';
}

const KOR_STATUS: Record<string, string> = { revise: '수정 요청', rejected: '반려' };

/**
 * 과제 지시 뒤 [앱 안내]에 붙일 "직전 과제" 묶음. 직전 과제가 없으면 빈 글.
 * 직전 과제가 중단·실패면 "중단됨"과 그 과제 시안 폴더·인수 메모 경로, 그 전에 성공한 과제의 보고도 함께.
 * 전체 약 3,000자 상한, 비밀은 줄마다 값만 가림(redactCommand + 이름=값 꼴, 경로·UUID 는 남김).
 */
export function buildCarryBlock(input: CarryInput): string {
  const max = input.max ?? CARRY_MAX;
  const tasks = input.tasks.filter((t) => t.taskId !== input.currentTaskId);
  const pairs = input.from === 'user' ? lastPairs(input.messages) : [];
  const prev = tasks[0];
  if (!prev && !pairs.length) return '';

  const head = '[앱 안내] 직전 과제 (리더는 과제마다 새 대화로 시작해요. 앞 과제는 이 묶음·진행업무·결정 기록·코드 지도로 이어 가고, 더 필요하면 아래 인수 메모를 읽으세요)';
  const fixed: string[] = [];
  let reportTask: TaskLike | undefined;
  if (prev) {
    const stopped = prev.status !== 'done';
    fixed.push(`- 직전 과제: ${oneLine(prev.title, 80)} (결과: ${stopped ? '중단됨' : '완료'}${prev.endedAt ? `, ${prev.endedAt.slice(0, 16).replace('T', ' ')} UTC` : ''})`);
    fixed.push(`  - 직전 지시(앞부분): ${oneLine(orderOf(prev, input.messages), ORDER_MAX)}`);
    const p = pathsLine(prev, input);
    if (p) fixed.push(p);
    if (stopped) {
      if (prev.leaderReport) fixed.push(`  - 멈춘 모습: ${oneLine(prev.leaderReport, STOP_MAX)}`);
      reportTask = tasks.slice(1).find((t) => t.status === 'done' && t.leaderReport);
    } else reportTask = prev;
  }
  const noteIds = [prev?.taskId, prev && prev !== reportTask ? reportTask?.taskId : undefined].filter((x): x is string => !!x);
  const rawNotes = userDecisionNotes(input.approvals, input.missionId, noteIds, NOTES_MAX, 2000);
  // 메모·대화 쌍은 길면 단계적으로 줄인다(맨 끝에서 잘라 가장 최근 대화를 잃지 않게)
  const tailOf = (noteMax: number, pairMax: number): string[] => {
    const tail: string[] = [];
    if (rawNotes.length) {
      tail.push('- 사용자가 승인 카드에 남긴 말(수정 요청·반려):');
      for (const n of rawNotes) tail.push(`  - [${KOR_STATUS[n.status]}] ${n.title}: ${oneLine(n.note, noteMax)}`);
    }
    if (pairs.length) {
      tail.push(`- 직전 대화 ${pairs.length}쌍 (이 대화창, 오래된 것부터. 이번 지시가 "방금 그거"처럼 앞 말을 가리키면 여기서 찾으세요):`);
      pairs.forEach((x, i) => {
        tail.push(`  ${i + 1}) ${x.from === 'user' ? '사용자' : '라노'}: ${oneLine(x.ask, pairMax)}`);
        tail.push(`     리더: ${oneLine(x.answer, pairMax)}`);
      });
    }
    return tail;
  };
  const label = !reportTask?.leaderReport
    ? ''
    : reportTask === prev
      ? '- 직전 보고(결과·결정이 필요한 사항·승인이 필요한 일):'
      : [`- 그 전에 끝난 과제: ${oneLine(reportTask.title, 80)}`, pathsLine(reportTask, input), '  - 그 보고(결과·결정이 필요한 사항·승인이 필요한 일):'].filter(Boolean).join('\n');

  let out = '';
  for (const [noteMax, pairMax] of [
    [NOTE_MAX, PAIR_SIDE_MAX],
    [140, 160],
    [80, 100],
  ]) {
    const tail = tailOf(noteMax, pairMax);
    let reportPart = '';
    if (label && reportTask?.leaderReport) {
      const used = [head, ...fixed, ...tail, label].join('\n').length + 20;
      const budget = Math.min(REPORT_MAX, Math.max(REPORT_MIN, max - used));
      reportPart = `${label}\n${reportSections(reportTask.leaderReport, budget)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')}`;
    }
    out = [head, ...fixed, ...(reportPart ? [reportPart] : []), ...tail].join('\n');
    if (out.length <= max) return out;
  }
  return `${out.slice(0, max - 12)}\n…(길어서 줄임)`;
}

/** 리더가 직접 고친 것으로 셀 파일인지: 이 과제 시안 폴더나 작업 폴더 안. 시안 폴더 바로 아래 인수 메모는 빼고 센다 */
export function isLeaderEditTarget(file: string, draftsDir: string | undefined, targets: string[], handoffFile: string): boolean {
  if (!file) return false;
  const abs = path.resolve(file);
  const inside = (root: string) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  };
  if (draftsDir && inside(draftsDir)) return abs !== path.join(path.resolve(draftsDir), handoffFile);
  return targets.some(inside);
}

/**
 * 보고 끝 안내: 마지막 검수가 끝난 뒤(같은 순서 번호 이상) 리더가 직접 Write/Edit 한 횟수와 파일 이름.
 * edits[].tick 은 고쳤을 때의 팀원 끝남 순서 번호, lastReview 는 마지막 검수가 끝난 순서 번호(없으면 0).
 */
export function leaderEditNote(edits: { tick: number; file: string }[], lastReview: number): string {
  const after = edits.filter((e) => e.tick >= lastReview);
  if (!after.length) return '';
  const names = [...new Set(after.map((e) => path.basename(e.file)).filter(Boolean))];
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` 외 ${names.length - 5}개` : '');
  return `${lastReview > 0 ? '마지막 검수 뒤 ' : ''}리더가 직접 ${after.length}건 고침: ${shown}`;
}

/**
 * 과제 한 번의 엔진 시도. 과제마다 새 대화라 resume 은 보통 undefined(과제 시작 때 저장된 리더 대화로 이어 쓰지 않는다).
 * 과제 안에서 그 과제의 대화로 이어 쓸 때만 resume 을 넘기고, 이어가기에 실패하면(대화 기록 없음 등) 새 대화로 한 번 다시 시도한다.
 */
export async function runTaskAttempts<R extends { errorText: string | null; text: string; gotInit: boolean }>(
  attempt: (resume: string | undefined) => Promise<R>,
  resume: string | undefined,
  missingSession: (raw: string) => boolean,
): Promise<R> {
  let r = await attempt(resume);
  if (resume && r.errorText !== null && !r.text && (!r.gotInit || missingSession(r.errorText))) r = await attempt(undefined);
  return r;
}
