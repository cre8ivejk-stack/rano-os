// 라노 지침(system prompt)을 대화 동안 고정하고, 기억·할 일이 바뀐 차례에만 "[앱 안내] 바뀐 내용"을 내 말 앞에 붙인다.
// 판단은 순수 함수(planPrompt·nextState), 저장은 runs/rano/prompt-state.json 하나(PromptStateFile). 엔진·화면은 건드리지 않는다.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MemoryFile } from '../../shared/types.js';

/** 저장 형식 판. 바꾸면 다음 차례에 지침을 새로 만들고 전체 안내를 한 번 붙인다 */
export const PROMPT_STATE_VERSION = 1;
export const NOTICE_HEAD = '[앱 안내] 바뀐 내용';

/** 라노가 마지막으로 정상 끝난 차례에 본 판의 지문(내용 기준) */
export interface PromptSeen {
  memory: Record<string, string>; // 기억 파일 이름 → 지문
  todo: string; // 할 일 목록 지문
}

export interface RanoPromptState {
  version: number;
  sessionId: string; // 이 지침을 쓰는 라노 대화
  systemPrompt: string; // 이 대화를 시작할 때 만든 지침(그대로 다시 넘김)
  seen: PromptSeen;
  frame?: string; // 기억·할 일을 뺀 지침 틀(미션 목록·구역·지침 문구)의 지문. 다르면 저장된 지침이 낡은 것
  rebuild?: boolean; // 요약(compact_boundary)을 받음 → 다음 차례에 지침을 새로 만들고 전체 안내
}

export type PlanReason = 'new' | 'same' | 'changed' | 'first' | 'rebuild';

/** 지금 설정으로 만든 지침 틀의 지문과, 틀이 바뀐 차례에 안내로 함께 넘길 미션 목록 */
export interface PromptFrame {
  key: string;
  missions: string;
}

export interface PromptPlan {
  systemPrompt: string;
  notice: string; // 내 말 앞에 붙일 안내(없으면 빈 글)
  seen: PromptSeen; // 이번 차례가 정상으로 끝나면 비교 기준이 될 판
  frame?: string; // 이번 차례가 정상으로 끝나면 저장할 지침 틀 지문
  reason: PlanReason;
}

// 할 일 목록(todoStore.describe)의 줄 끝에 앱이 붙이는 메모의 시각만 비교에서 뺀다(dispatcher.ts todoAfterRun 의 문구).
// 예: "- [확인 요청] 메뉴 (id: t1) — 리더 보고 도착 11-08 14:20". 제목이나 사용자가 쓴 메모 안의 날짜·시각은 내용으로 본다
export const APP_TODO_NOTE_TIME = /( — (?:리더 보고 도착|리더 작업이 중단됨)) \d{2}-\d{2} \d{2}:\d{2}[ \t]*$/gm;

/** 할 일 목록 글에서 앱 메모의 시각만 "(시각)"으로 바꾼다 */
export function withoutAppNoteTimes(todo: string | undefined): string {
  return String(todo ?? '').replace(APP_TODO_NOTE_TIME, '$1 (시각)');
}

/** 내용 지문: 줄 앞뒤 공백 차이는 같은 것으로 본다. appNoteTimes 면 할 일 줄 끝 앱 메모의 시각만 뺀다 */
export function contentKey(text: string | undefined, appNoteTimes = false): string {
  let t = String(text ?? '');
  if (appNoteTimes) t = withoutAppNoteTimes(t);
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
  return createHash('sha256').update(t).digest('hex').slice(0, 24);
}

export function seenOf(memory: MemoryFile[], todo: string | undefined): PromptSeen {
  const m: Record<string, string> = {};
  for (const f of memory) m[f.name] = contentKey(f.content);
  return { memory: m, todo: contentKey(todo, true) };
}

/** 앞 판과 비교해 바뀐 기억 파일 이름(사라진 파일 포함)과 할 일 변경 여부 */
export function changedOf(prev: PromptSeen, cur: PromptSeen): { memory: string[]; todo: boolean } {
  const names = new Set([...Object.keys(prev.memory ?? {}), ...Object.keys(cur.memory)]);
  const memory = [...names].filter((n) => (prev.memory ?? {})[n] !== cur.memory[n]);
  return { memory, todo: prev.todo !== cur.todo };
}

function body(text: string | undefined): string {
  const t = String(text ?? '').trim();
  return t || '(비어 있음)';
}

/**
 * 내 말 앞에 붙일 안내. full 이면 기억 파일 전부와 할 일 목록 전체, 아니면 바뀐 것만(각각 최신 전체 내용).
 */
export function changeNotice(memory: MemoryFile[], todo: string | undefined, changed: { memory: string[]; todo: boolean }, full: boolean, missions?: string): string {
  const names = full ? memory.map((f) => f.name) : changed.memory;
  const parts: string[] = [
    full
      ? `${NOTICE_HEAD}(전체) — 기억과 할 일 목록${missions !== undefined ? '·미션 목록' : ''}의 최신 전체 내용이에요. 지침의 "현재 기억"·"현재 할 일 목록"${missions !== undefined ? '·"미션 목록"' : ''}보다 이 판이 최신이니 이 판을 근거로 답하세요. 기억을 고칠 때는 read_memory 로 지금 내용을 먼저 읽고 고치세요. 이 안내는 앱이 붙인 것이라 사용자에게 따로 말하지 않아요.`
      : `${NOTICE_HEAD} — 지난 차례 뒤에 바뀐 기억·할 일의 최신 전체 내용이에요. 여기 실린 파일은 지침이나 앞 안내보다 이 판이 최신이니 이 판을 근거로 답하고, 여기 없는 것은 앞 안내나 지침의 판 그대로예요. 기억을 고칠 때는 read_memory 로 지금 내용을 먼저 읽고 고치세요. 이 안내는 앱이 붙인 것이라 사용자에게 따로 말하지 않아요.`,
  ];
  if (missions !== undefined) parts.push(`### 미션 목록 (최신 전체)\n${body(missions)}`);
  for (const n of names) {
    const f = memory.find((x) => x.name === n);
    parts.push(`### 기억 ${n} (최신 전체)\n${f ? body(f.content) : '(파일 없음)'}`);
  }
  if (full || changed.todo) parts.push(`### 할 일 목록 (최신 전체)\n${todo ?? '(할 일 목록을 불러오지 못함)'}`);
  return parts.join('\n\n');
}

/**
 * 이번 시도에 넘길 지침과 안내를 정한다.
 * - 새 대화(resume 없음: 새 세션·이어가기 실패 재시도): 지침을 새로 만들고 안내 없음
 * - 저장된 판이 이 대화 것이 아님(이 기능을 처음 적용한 뒤 첫 차례, 저장 형식이 바뀜 등): 지침을 새로 만들고 전체 안내 한 번
 * - 요약을 받은 대화, 또는 지침 틀(미션 목록·구역·지침 문구)이 저장된 지문과 다름: 지침을 새로 만들고 전체 안내 한 번
 *   (엔진의 지침 기록(snapshot)이 켜진 계정에서는 새 지침을 넘겨도 앞 지침이 쓰일 수 있어, 안내에 미션 목록도 넣는다)
 * - 그 밖: 저장된 지침 그대로. 기억·할 일이 지난 판과 (내용 기준으로) 다를 때만 바뀐 것 안내
 */
export function planPrompt(
  state: RanoPromptState | null,
  resume: string | undefined,
  memory: MemoryFile[],
  todo: string | undefined,
  build: () => string,
  frame?: PromptFrame,
): PromptPlan {
  const seen = seenOf(memory, todo);
  const fk = frame ? { frame: frame.key } : {};
  if (!resume) return { systemPrompt: build(), notice: '', seen, ...fk, reason: 'new' };
  const none = { memory: [], todo: false };
  const full = () => changeNotice(memory, todo, none, true, frame?.missions);
  if (!state || state.version !== PROMPT_STATE_VERSION || state.sessionId !== resume || !state.systemPrompt) {
    return { systemPrompt: build(), notice: full(), seen, ...fk, reason: 'first' };
  }
  if (state.rebuild || (frame && state.frame !== frame.key)) return { systemPrompt: build(), notice: full(), seen, ...fk, reason: 'rebuild' };
  const ch = changedOf(state.seen, seen);
  if (!ch.memory.length && !ch.todo) return { systemPrompt: state.systemPrompt, notice: '', seen, ...fk, reason: 'same' };
  return { systemPrompt: state.systemPrompt, notice: changeNotice(memory, todo, ch, false), seen, ...fk, reason: 'changed' };
}

/** 안내를 붙인 프롬프트 */
export function withNotice(prompt: string, notice: string): string {
  return notice ? `${notice}\n\n---\n\n${prompt}` : prompt;
}

/**
 * 차례가 끝난 뒤 저장할 판. 정상으로 끝난 차례(ok)만 비교 기준을 바꾼다.
 * 끊긴 차례면 앞 판을 그대로 두되, 요약을 받았으면 다음에 새로 만들도록 표시만 한다. 바꿀 것이 없으면 prev 그대로.
 */
export function nextState(prev: RanoPromptState | null, plan: PromptPlan | undefined, sessionId: string | null, ok: boolean, compacted: boolean): RanoPromptState | null {
  if (ok && plan && sessionId) {
    return {
      version: PROMPT_STATE_VERSION,
      sessionId,
      systemPrompt: plan.systemPrompt,
      seen: plan.seen,
      ...(plan.frame !== undefined ? { frame: plan.frame } : {}),
      ...(compacted ? { rebuild: true } : {}),
    };
  }
  if (compacted && prev && !prev.rebuild && (!sessionId || prev.sessionId === sessionId)) return { ...prev, rebuild: true };
  return prev;
}

/** runs/rano/prompt-state.json 읽기·쓰기 (깨졌거나 없으면 null) */
export class PromptStateFile {
  constructor(private readonly file: string) {}

  static at(runsDir: string): PromptStateFile {
    return new PromptStateFile(path.join(runsDir, 'rano', 'prompt-state.json'));
  }

  load(): RanoPromptState | null {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<RanoPromptState>;
      if (!raw || typeof raw !== 'object' || typeof raw.sessionId !== 'string' || typeof raw.systemPrompt !== 'string' || !raw.seen) return null;
      return {
        version: typeof raw.version === 'number' ? raw.version : 0,
        sessionId: raw.sessionId,
        systemPrompt: raw.systemPrompt,
        seen: { memory: { ...(raw.seen.memory ?? {}) }, todo: String(raw.seen.todo ?? '') },
        ...(typeof raw.frame === 'string' ? { frame: raw.frame } : {}),
        ...(raw.rebuild ? { rebuild: true } : {}),
      };
    } catch {
      return null;
    }
  }

  save(state: RanoPromptState): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
        renameSync(tmp, this.file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } catch (e) {
      console.error('[rano] 지침 판 저장 실패:', e);
    }
  }
}
