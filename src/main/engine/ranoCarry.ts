// 라노 대화 줄이기 (0.9.12).
// 라노는 한 대화를 계속 이어 써서, 말할 때마다 지난 대화 전체를 다시 읽는다(수십만 토큰).
// 대화가 커졌거나 오래 쉬어서 엔진의 임시 저장(캐시)이 식었으면, 새 대화로 시작하면서 최근에 주고받은 말만 넘긴다.
// 오래 둘 내용은 기억 파일·할 일·미션 기록에 이미 있다. 판단·글 만들기는 순수 함수, 저장은 runs/rano/context.json 하나.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../../shared/types.js';
import { attachLabel } from './attachments.js';

/** 마지막 차례에 엔진이 읽은 대화 크기 */
export interface RanoContextInfo {
  sessionId: string;
  tokens: number; // 마지막 호출의 입력 크기(지침 + 지난 대화)
  at: number; // 그 차례가 끝난 시각(ms)
}

/**
 * 계속 쓰는 중이어도 이보다 크면 새 대화로.
 * 0.9.21: 150,000 → 195,000. 지침·기억·도구만으로 새 대화가 6만쯤에서 시작해, 15만 기준이면 일하는 날 45~60분마다 갈아탔다(2026-11-24 하루 7번).
 * 갈아탈 때마다 지난 맥락이 줄고 첫 차례에 전체를 새로 읽는다. 20만을 넘기지는 않는다(긴 대화 요금 구간을 피한다)
 */
export const ROTATE_TOKENS = 195_000;
/** 이만큼 쉬면 엔진의 임시 저장이 식어, 다음 말에서 지난 대화 전체를 제값으로 다시 읽는다 */
export const COLD_MS = 60 * 60_000;
/** 식었을 때는 이보다 크면 새 대화로 */
export const COLD_TOKENS = 40_000;
/** 크기 기록이 없을 때 대신 보는 기준: 주고받은 말이 이만큼 넘으면 큰 대화로 본다 */
export const COLD_MESSAGES = 40;

export const CARRY_HEAD = '[앱 안내] 이어 가는 대화';
const CARRY_MESSAGES = 24; // 넘길 최근 말 수
const CARRY_CHARS = 24_000; // 넘길 글 전체 상한
const USER_MAX = 1_500;
const RANO_MAX = 900;

/** 이번 차례를 새 대화로 시작할지 */
export function shouldRotate(info: RanoContextInfo | null, sessionId: string | undefined, now: number, past?: { lastAt?: string; count: number }): boolean {
  if (!sessionId) return false;
  if (!info || info.sessionId !== sessionId || !(info.tokens > 0)) {
    // 크기 기록이 없거나 다른 대화 것일 때(새 판을 처음 켠 날 등): 주고받은 말이 많고 1시간 넘게 쉬었으면 새 대화로 (0.9.14)
    const last = past?.lastAt ? Date.parse(past.lastAt) : NaN;
    return !!past && past.count >= COLD_MESSAGES && Number.isFinite(last) && now - last >= COLD_MS;
  }
  if (info.tokens >= ROTATE_TOKENS) return true;
  return now - info.at >= COLD_MS && info.tokens >= COLD_TOKENS;
}

function stamp(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clip(text: string, max: number): string {
  const t = String(text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}… (뒤 ${t.length - max}자 생략)` : t;
}

/**
 * 새 대화의 첫 말 앞에 붙일 글: 직전까지 주고받은 말(최근 것만, 길면 줄여서).
 * exclude: 이번 차례에 답할 사용자 말 id(뒤에 원문이 따로 붙으므로 뺀다). 넘길 말이 없으면 빈 글
 */
export function carryText(messages: ChatMessage[], exclude: readonly string[] = []): string {
  const skip = new Set(exclude);
  const recent = messages.filter((m) => !skip.has(m.id) && (m.role === 'user' || m.role === 'rano') && m.text?.trim()).slice(-CARRY_MESSAGES);
  const lines: string[] = [];
  let total = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const who =
      m.role === 'user'
        ? m.toMission
          ? `사용자 → ${m.toMission} 리더에게 직접`
          : '사용자'
        : m.form === 'report'
          ? `라노(${m.mission ?? '미션'} 리더 보고 전달${m.report ? `: ${m.report.title}${m.report.ok ? '' : ' · 중단'}` : ''})`
          : m.form === 'ack'
            ? `라노(${m.mission ?? '미션'} 리더에게 맡김)`
            : '라노';
    const pics = m.attachments?.length ? ` (${attachLabel(m.attachments)} 첨부: 지금은 다시 볼 수 없음. 첨부 id: ${m.attachments.map((a) => a.id).join(', ')})` : '';
    const line = `[${stamp(m.at)} ${who}]${pics}\n${clip(m.text, m.role === 'user' ? USER_MAX : RANO_MAX)}`;
    if (total + line.length > CARRY_CHARS && lines.length) break;
    total += line.length;
    lines.unshift(line);
  }
  if (!lines.length) return '';
  return [
    `${CARRY_HEAD} — 대화가 길어져 앱이 새 대화로 이어 붙였어요(사용량을 줄이려는 것이라 사용자에게 알릴 필요 없어요. 평소처럼 이어서 답하세요).`,
    '아래는 직전까지 주고받은 말이에요(최근 것만, 긴 말은 줄였어요). 이보다 앞의 일은 기억 파일, 할 일 목록, 미션 현황(get_mission_status)에서 확인하세요. 여기 없는 내용은 지어내지 말고 "기록을 확인해 볼게요"라고 하거나 사용자에게 물어보세요.',
    '',
    lines.join('\n\n'),
    '',
    '[이어 가는 대화 끝]',
  ].join('\n');
}

/** runs/rano/context.json */
export class RanoContextFile {
  constructor(private readonly file: string) {}

  static at(runsDir: string): RanoContextFile {
    return new RanoContextFile(path.join(runsDir, 'rano', 'context.json'));
  }

  load(): RanoContextInfo | null {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<RanoContextInfo>;
      if (!raw || typeof raw.sessionId !== 'string' || typeof raw.tokens !== 'number' || typeof raw.at !== 'number') return null;
      return { sessionId: raw.sessionId, tokens: raw.tokens, at: raw.at };
    } catch {
      return null;
    }
  }

  save(info: RanoContextInfo): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(info), 'utf-8');
        renameSync(tmp, this.file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } catch {
      // 저장하지 못해도 대화는 그대로 된다(다음 차례에 예전 대화를 그대로 이어 쓸 뿐)
    }
  }
}
