// 휴대폰(텔레그램)으로 무엇을 보낼지 정하는 규칙. 순수 판단만 한다(보내기는 telegram.ts).
// - 흘려 쓰는 답(live)·진행 줄은 보내지 않는다(알림이 여러 번 울림). 마지막 답만.
// - 묶음에 휴대폰 말이 하나라도 있으면 그 답·오류는 휴대폰으로. 맥 말만이면 "라노 답 모두 받기" 설정을 따른다.
// - 휴대폰 말이 답을 기다리는 동안(줄에 서 있을 때 포함) "입력 중" 표시를 이어 간다.
import type { RanoUiEvent } from '../../shared/types.js';
import { redactCommand } from '../mission/leaderPermissions.js';

/** 휴대폰에 보낼 보고 카드 한 줄: 비밀처럼 보이는 글은 가린다 */
export function reportCardText(e: { missionName: string; ok: boolean; firstLine: string }): string {
  return `📋 ${e.missionName} 리더 보고 · ${e.ok ? '완료' : '중단'}\n${redactCommand(e.firstLine)}\n(라노가 정리해서 곧 알려 드려요)`;
}

export class MobileReplyTracker {
  private waiting = new Set<string>(); // 휴대폰에서 온 말 가운데 아직 답이 없는 것
  private turnUsers = new Map<number, string[]>(); // 차례 번호 → 그 차례가 답하는 말 id
  private mobileTurns = new Set<number>(); // 휴대폰 말이 든 차례
  private turnEnds = 0; // 끝난 차례 수

  /** 이 이벤트에 대해 휴대폰으로 보낼 글(없으면 null) */
  decide(e: RanoUiEvent, allRano: boolean): string | null {
    if (e.kind === 'message' && e.message.role === 'user') {
      if (e.message.via === 'mobile') {
        this.waiting.add(e.message.id);
        return null;
      }
      // 맥에서 한 말도 함께 보낸다 (라노 답을 모두 받는 설정일 때). 예전 글 모양의 휴대폰 말은 건너뛴다
      const t = e.message.text ?? '';
      if (allRano && !/\(휴대폰에서 (보냄|사진만 보냄)\)\s*$/.test(t)) {
        const pics = e.message.attachments?.length ? ` (그림 ${e.message.attachments.length}개)` : '';
        return `💻 ${t}${pics}`;
      }
      return null;
    }
    if (e.kind === 'status' && e.status === 'thinking' && typeof e.turn === 'number') {
      if (e.users?.length) this.turnUsers.set(e.turn, e.users);
      if (e.mobile || e.users?.some((id) => this.waiting.has(id))) this.mobileTurns.add(e.turn);
      return null;
    }
    if (e.kind === 'message' && e.message.role === 'rano') {
      const ids = e.message.replyTo ?? [];
      const forPhone = !!e.mobile || (typeof e.turn === 'number' && this.mobileTurns.has(e.turn)) || ids.some((id) => this.waiting.has(id));
      for (const id of ids) this.waiting.delete(id);
      return forPhone || allRano ? e.message.text : null;
    }
    if (e.kind === 'error' && !e.missionId) {
      const forPhone = !!e.mobile || (typeof e.turn === 'number' && this.mobileTurns.has(e.turn));
      return forPhone ? `(오류) ${e.text}` : null;
    }
    if (e.kind === 'status' && e.status === 'idle') {
      this.turnEnds += 1; // 차례가 끝남 → "입력 중" 상한 표시를 풀 수 있다 (typingKey 가 바뀜)
      if (typeof e.turn === 'number') {
        for (const id of this.turnUsers.get(e.turn) ?? []) this.waiting.delete(id);
        this.turnUsers.delete(e.turn);
        this.mobileTurns.delete(e.turn);
      }
      return null;
    }
    if (e.kind === 'report') return allRano ? reportCardText(e) : null;
    return null;
  }

  /** 휴대폰 말이 답을 기다리는 중인지 ("입력 중" 표시를 이어 갈지) */
  get typing(): boolean {
    return this.waiting.size > 0 || this.mobileTurns.size > 0;
  }

  /** 기다리는 휴대폰 말 목록·휴대폰 차례·끝난 차례 수. 이것이 바뀔 때만 "입력 중" 상한을 푼다 */
  get typingKey(): string {
    return `${[...this.waiting].sort().join(',')}|${[...this.mobileTurns].sort((a, b) => a - b).join(',')}|${this.turnEnds}`;
  }
}

/**
 * "입력 중" 상한(기본 10분). 상한에 닿으면 표시를 두고(capped), 기다리는 말 목록이 바뀌거나 차례가 끝날 때(key 가 바뀔 때)만 푼다.
 * 그 밖의 화면 이벤트(보고 카드·다른 미션 소식 등)로는 다시 켜지지 않는다.
 */
export class TypingGate {
  private key: string | null = null;
  private since = 0;
  private capped = false;

  constructor(private readonly maxMs: number) {}

  /** 지금 "입력 중"을 보낼지. want = 휴대폰 말이 답을 기다림, key = MobileReplyTracker.typingKey */
  shouldType(want: boolean, key: string, now: number): boolean {
    if (!want) {
      this.key = null;
      this.capped = false;
      return false;
    }
    if (key !== this.key) {
      this.key = key;
      this.since = now;
      this.capped = false;
    }
    if (this.capped) return false;
    if (now - this.since > this.maxMs) {
      this.capped = true;
      return false;
    }
    return true;
  }
}
