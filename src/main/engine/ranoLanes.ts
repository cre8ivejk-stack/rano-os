// 라노 차례 줄: 사용자 말 칸(먼저)과 앱 알림 칸(뒤) 두 칸으로 줄을 세우고, 다음 차례에 무엇을 할지 정한다.
// 이 파일은 순수 함수만 둔다(파일·엔진·화면을 건드리지 않음) — 시험에서 그대로 부른다.
import type { ChatAttachment, ChatMessage } from '../../shared/types.js';

/** 기다리는 사용자 말 하나 (이미 저장·화면 표시를 마친 말) */
export interface LaneUser {
  id: string; // 대화 기록의 말 id (답의 replyTo 로 쓴다)
  text: string;
  attachments: ChatAttachment[];
  via?: 'mobile';
  at: number; // 줄에 선 시각(ms)
}

/** 기다리는 앱 알림 하나 (리더 보고·직접 지시 알림) */
export interface LaneNotice {
  id: string;
  text: string; // 알림 원문 (보고 원문 포함)
  kind: 'report' | 'direct';
  at: number; // 도착 시각(ms)
  passed: number; // 이 알림을 붙이지 못한 채 지나간 사용자 말 차례 수
}

export interface LaneLimits {
  maxBatch: number; // 한 번에 묶는 사용자 말 최대 개수
  maxImages: number; // 한 차례에 넣는 그림 최대 장수 (넘으면 다음 차례로)
  noticeMaxPassed: number; // 알림이 사용자 말 차례에 밀릴 수 있는 최대 횟수
  noticeMaxWaitMs: number; // 알림이 기다릴 수 있는 최대 시간
}

export const LANE_LIMITS: LaneLimits = { maxBatch: 5, maxImages: 6, noticeMaxPassed: 2, noticeMaxWaitMs: 60_000 };

export type TurnPlan =
  | { kind: 'user'; users: LaneUser[]; notices: LaneNotice[] } // 사용자 말(묶음) 차례. notices = 같은 프롬프트 앞에 붙일 알림
  | { kind: 'notice'; notice: LaneNotice }; // 알림 하나만 따로 처리하는 차례

/** 사용자 말을 앞에서부터 묶는다. 개수 상한·그림 상한을 넘기 전까지. 첫 말은 그림이 많아도 늘 넣는다 */
export function takeBatch(users: LaneUser[], limits: LaneLimits = LANE_LIMITS): LaneUser[] {
  const out: LaneUser[] = [];
  let images = 0;
  for (const u of users) {
    if (out.length >= limits.maxBatch) break;
    const n = u.attachments.length;
    if (out.length && images + n > limits.maxImages) break;
    out.push(u);
    images += n;
  }
  return out;
}

function overdue(n: LaneNotice, now: number, limits: LaneLimits): boolean {
  return n.passed >= limits.noticeMaxPassed || now - n.at >= limits.noticeMaxWaitMs;
}

/**
 * 다음 차례를 정한다(줄은 바꾸지 않음).
 * 1) 사용자 말이 있으면 사용자 말 묶음이 먼저. 묶은 말 가운데 마지막 말보다 먼저 도착한 알림은 같은 프롬프트 앞에 붙인다.
 * 2) 다만 붙일 수 없는 알림(사용자 말보다 늦게 옴)이 너무 오래 기다렸으면(차례 N번 또는 M초) 그 알림을 먼저 따로 한 차례.
 * 3) 사용자 말이 없으면 알림을 하나씩.
 */
export function planNextTurn(users: LaneUser[], notices: LaneNotice[], now: number, limits: LaneLimits = LANE_LIMITS): TurnPlan | null {
  if (users.length) {
    const batch = takeBatch(users, limits);
    const lastAt = batch[batch.length - 1].at;
    const attach = notices.filter((n) => n.at <= lastAt);
    const late = notices.find((n) => n.at > lastAt && overdue(n, now, limits));
    if (late) return { kind: 'notice', notice: late };
    return { kind: 'user', users: batch, notices: attach };
  }
  if (notices.length) return { kind: 'notice', notice: notices[0] };
  return null;
}

/** 사용자 말 차례가 끝난 뒤: 붙이지 못한 알림은 한 번 더 밀린 것으로 센다 */
export function markPassed(notices: LaneNotice[]): void {
  for (const n of notices) n.passed += 1;
}

/** 그림 안내 한 줄(기존 문구 그대로). 그림이 없으면 빈 글 */
export function imageNote(attachments: ChatAttachment[]): string {
  if (!attachments.length) return '';
  const marked = attachments.filter((a) => a.marked).length;
  let s = `\n\n[앱 안내] 사용자가 그림 ${attachments.length}개를 붙였어요 (위 그림, 순서대로 id: ${attachments.map((a) => `${a.id}(${a.name}${a.marked ? ', 표시함' : ''})`).join(', ')}). 리더에게 일을 맡길 때 이 그림이 필요하면 assign_to_mission 의 attachments 에 id 를 넣으세요.`;
  if (marked)
    s += ' "표시함" 그림에는 사용자가 펜·네모·화살표·번호(①②③)로 고치고 싶은 곳을 직접 표시했어요. 표시한 곳이 무엇인지 그림에서 정확히 짚고, 번호가 있으면 사용자 글의 "1번 …" 설명과 짝지으세요. 리더에게 넘길 때도 표시의 뜻을 task 에 적으세요.';
  return s;
}

export const BATCH_RULE = '번호마다 빠짐없이 답하고, 뒤 말이 앞 말을 고치거나 취소하면 뒤 말을 따르세요.';

/** 알림만 따로 처리하는 차례의 프롬프트 (지금까지와 같은 모양) */
export function noticePrompt(n: LaneNotice): string {
  return `[앱 알림] ${n.text}`;
}

/** 사용자 말 차례의 프롬프트: (그 사이 도착한 알림) + 사용자 말(하나 또는 번호 붙인 묶음) + 그림 안내 */
export function userTurnPrompt(users: LaneUser[], notices: LaneNotice[]): string {
  const parts: string[] = [];
  if (notices.length) {
    const lines = notices.map((n, i) => `(${i + 1}) ${n.text}`);
    parts.push(
      `[앱 알림 — 그 사이 도착한 보고·알림 ${notices.length}건] 사용자의 말보다 먼저 도착했어요. 사용자 말에 답하면서 이 내용도 짧게 함께 전해 주세요(따로 다시 요약하지 않아요).\n${lines.join('\n\n')}`,
    );
    parts.push('[사용자 말]');
  }
  if (users.length === 1) {
    const u = users[0];
    parts.push(u.text + (u.via === 'mobile' ? '\n\n(휴대폰에서 보냄)' : ''));
  } else {
    const lines = users.map((u, i) => {
      const pics = u.attachments.length ? ` [그림 ${u.attachments.length}개: ${u.attachments.map((a) => a.id).join(', ')}]` : '';
      return `${i + 1}) ${u.via === 'mobile' ? '(휴대폰에서 보냄) ' : ''}${u.text}${pics}`;
    });
    parts.push(`사용자가 연달아 보낸 말 ${users.length}개예요. ${BATCH_RULE}\n\n${lines.join('\n\n')}`);
  }
  const all = users.flatMap((u) => u.attachments);
  return parts.join('\n\n') + imageNote(all);
}

/**
 * 앱을 다시 켰을 때 답을 받지 못한 내 말을 찾는다(자동으로 다시 실행하지 않음, 화면에 [다시 보내기]만).
 * 기준: 마지막 "기준 답"의 차례 안(그 답이 답한 말 중 가장 이른 말) 이후의 내 말 가운데, 어떤 라노 답의 replyTo 에도 없는 말.
 * 기준 답 = replyTo 칸이 없는 예전 답(그 앞의 말을 모두 답한 것으로 봄) 또는 replyTo 가 비어 있지 않은 답.
 * replyTo: [] 인 새 형식 답(알림 차례 답·중간에 끊긴 답)은 내 말에 답한 것이 아니므로 기준에서 건너뛴다.
 */
export function findUnanswered(messages: ChatMessage[]): string[] {
  const answered = new Set<string>();
  for (const m of messages) if (m.role === 'rano' && Array.isArray(m.replyTo)) for (const id of m.replyTo) answered.add(id);
  let base = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'rano') continue;
    if (Array.isArray(m.replyTo) && !m.replyTo.length) continue; // 새 형식 빈 목록: 기준 아님
    base = i;
    break;
  }
  let start = base; // 이 위치보다 뒤만 본다
  if (base >= 0) {
    const r = messages[base];
    if (Array.isArray(r.replyTo) && r.replyTo.length) {
      const first = messages.findIndex((m) => r.replyTo!.includes(m.id));
      if (first >= 0) start = first;
    }
  }
  const out: string[] = [];
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && !m.toMission && !answered.has(m.id)) out.push(m.id); // 리더에게 직접 보낸 말은 라노 답을 기다리지 않는다
  }
  return out;
}

/** 라노 도구 이름 → 진행 한 줄 문구 (기획안 표). mcp__서버__도구 모양도 받는다 */
const TOOL_LABELS: Record<string, string> = {
  read_memory: '기억 확인 중',
  update_memory: '기억에 적는 중',
  todo_list: '할 일 목록 보는 중',
  todo_add: '할 일에 넣는 중',
  todo_update: '할 일 고치는 중',
  todo_remove: '할 일에서 빼는 중',
  assign_to_mission: '미션에 맡기는 중',
  get_mission_status: '미션 상황 보는 중',
  get_terminal_sessions: '터미널 세션 보는 중',
  org_overview: '조직 살펴보는 중',
  propose_mission: '미션 구성안 만드는 중',
  open_mission_proposal: '구성안 여는 중',
  recommend_skills: '스킬 찾아보는 중',
};

export function toolLabel(name: string): string {
  const short = String(name ?? '').split('__').pop() ?? '';
  return TOOL_LABELS[short] ?? '일하는 중';
}
