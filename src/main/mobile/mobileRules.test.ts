// 휴대폰으로 보낼지 판단 시험 + 리더 보고 첫 줄 카드(자르기·가리기). 텔레그램에는 아무것도 보내지 않는다(판단만).
// 실행: 빌드 후 `node --test dist/main/mobile/mobileRules.test.js`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, RanoUiEvent } from '../../shared/types.js';
import { MobileReplyTracker, reportCardText, TypingGate } from './mobileRules.js';
import { reportFirstLine } from '../mission/dispatcher.js';

const at = '2026-11-08T00:00:00Z';
const userMsg = (id: string, via?: 'mobile'): RanoUiEvent => ({ kind: 'message', message: { id, role: 'user', text: `말 ${id}`, at, ...(via ? { via } : {}) } });
const ranoMsg = (replyTo: string[], turn: number, mobile?: boolean): RanoUiEvent => ({ kind: 'message', message: { id: `r-${turn}`, role: 'rano', text: `답 ${turn}`, at, replyTo } as ChatMessage, turn, ...(mobile ? { mobile } : {}) });
const thinking = (turn: number, users: string[], mobile?: boolean): RanoUiEvent => ({ kind: 'status', status: 'thinking', turn, users, ...(mobile ? { mobile } : {}) });
const idle = (turn: number): RanoUiEvent => ({ kind: 'status', status: 'idle', turn });

test('맥 말만인 차례: "라노 답 모두 받기" 설정을 따른다', () => {
  const t = new MobileReplyTracker();
  assert.equal(t.decide(userMsg('m1'), false), null, '꺼져 있으면 맥 말도 안 보냄');
  t.decide(thinking(1, ['m1']), false);
  assert.equal(t.decide(ranoMsg(['m1'], 1), false), null);
  t.decide(idle(1), false);
  const on = new MobileReplyTracker();
  assert.equal(on.decide(userMsg('m1'), true), '💻 말 m1');
  on.decide(thinking(1, ['m1']), true);
  assert.equal(on.decide(ranoMsg(['m1'], 1), true), '답 1');
});

test('묶음에 휴대폰 말이 하나라도 있으면 답·오류를 휴대폰으로 (설정이 꺼져 있어도)', () => {
  const t = new MobileReplyTracker();
  t.decide(userMsg('m1'), false);
  t.decide(userMsg('p1', 'mobile'), false);
  t.decide(thinking(1, ['m1', 'p1'], true), false);
  assert.equal(t.decide({ kind: 'error', text: '바빠요', at, turn: 1, mobile: true }, false), '(오류) 바빠요');
  assert.equal(t.decide(ranoMsg(['m1', 'p1'], 1, true), false), '답 1');
});

test('지난 빈틈: 맥 차례가 도는 사이 줄 선 휴대폰 말 — 앞 차례 idle 뒤에도 그 답은 휴대폰으로 간다', () => {
  const t = new MobileReplyTracker();
  t.decide(userMsg('m1'), false);
  t.decide(thinking(1, ['m1']), false);
  t.decide(userMsg('p1', 'mobile'), false); // 앞 차례 도중 휴대폰 말 저장
  assert.equal(t.typing, true, '기다리는 동안 입력 중 표시');
  assert.equal(t.decide(ranoMsg(['m1'], 1), false), null, '맥 말 답은 안 보냄');
  t.decide(idle(1), false);
  assert.equal(t.typing, true, '앞 차례가 끝나도 휴대폰 말은 아직 기다림');
  t.decide(thinking(2, ['p1']), false); // mobile 칸이 없어도 기다리던 휴대폰 말로 판단
  assert.equal(t.decide(ranoMsg(['p1'], 2), false), '답 2');
  t.decide(idle(2), false);
  assert.equal(t.typing, false, '답이 가고 차례가 끝나면 입력 중 멈춤');
});

test('답 없이 오류로 끝난 휴대폰 차례도 idle 에서 입력 중을 멈춘다', () => {
  const t = new MobileReplyTracker();
  t.decide(userMsg('p1', 'mobile'), false);
  t.decide(thinking(1, ['p1'], true), false);
  assert.equal(t.decide({ kind: 'error', text: '한도', at, turn: 1 }, false), '(오류) 한도');
  t.decide(idle(1), false);
  assert.equal(t.typing, false);
});

test('"입력 중" 10분 상한: 닿으면 멈추고, 다른 화면 이벤트로는 다시 켜지지 않으며, 기다리는 말·차례가 바뀔 때만 풀린다', () => {
  const MAX = 10 * 60_000;
  const t = new MobileReplyTracker();
  const g = new TypingGate(MAX);
  const want = (now: number) => g.shouldType(t.typing, t.typingKey, now);
  t.decide(userMsg('m1'), false);
  t.decide(thinking(1, ['m1']), false); // 맥 차례가 오래 돔
  t.decide(userMsg('p1', 'mobile'), false); // 그 사이 휴대폰 말
  assert.equal(want(0), true);
  assert.equal(want(MAX), true);
  assert.equal(want(MAX + 1), false, '상한에 닿으면 멈춤');
  // 보고 카드·흘려 쓰는 답 같은 다른 이벤트 → 다시 켜지지 않음
  t.decide({ kind: 'report', missionId: 'm', missionName: '홈', ok: true, firstLine: 'x', at }, false);
  t.decide({ kind: 'live', turn: 1, text: '쓰는 중', steps: [] }, false);
  assert.equal(want(MAX + 5000), false, '다른 이벤트로 다시 켜지지 않음');
  // 차례가 끝남 → 풀림 (다시 10분)
  t.decide(idle(1), false);
  assert.equal(want(MAX + 6000), true, '차례가 끝나면 풀림');
  assert.equal(want(2 * MAX + 6000), true);
  assert.equal(want(2 * MAX + 6001), false);
  // 기다리는 말 목록이 바뀜 → 풀림
  t.decide(userMsg('p2', 'mobile'), false);
  assert.equal(want(2 * MAX + 7000), true, '새 휴대폰 말이 오면 풀림');
  // 답이 가고 차례가 끝나 기다릴 말이 없으면 멈춤
  t.decide(thinking(2, ['p1', 'p2']), false);
  t.decide(ranoMsg(['p1', 'p2'], 2), false);
  t.decide(idle(2), false);
  assert.equal(t.typing, false);
  assert.equal(want(2 * MAX + 8000), false);
});

test('흘려 쓰는 답(live)·리더 패널 오류는 보내지 않는다', () => {
  const t = new MobileReplyTracker();
  t.decide(thinking(1, ['p1'], true), true);
  assert.equal(t.decide({ kind: 'live', turn: 1, text: '쓰는 중', steps: [] }, true), null);
  assert.equal(t.decide({ kind: 'error', text: '리더 오류', at, missionId: 'm', turn: 1 }, true), null);
});

test('보고 카드: 설정을 따르고, 휴대폰 글에서는 비밀처럼 보이는 값을 가린다', () => {
  const card: RanoUiEvent = { kind: 'report', missionId: 'm', missionName: '홈', ok: true, firstLine: '배포 키 token=abcdEFGH1234ijklMNOP5678qrstUVWX 로 확인함', at };
  assert.equal(new MobileReplyTracker().decide(card, false), null);
  const out = new MobileReplyTracker().decide(card, true) ?? '';
  assert.match(out, /^📋 홈 리더 보고 · 완료/);
  assert.ok(out.includes('(가림)'));
  assert.ok(!out.includes('abcdEFGH1234'));
  assert.ok(reportCardText({ missionName: '홈', ok: false, firstLine: 'x' }).includes('중단'));
});

test('보고 첫 줄: 제목은 건너뛰고 첫 본문 줄, 꾸밈 기호 없이, 120자로 자른다', () => {
  assert.equal(reportFirstLine('# 결과 보고\n\n- **로그인 화면**을 `고쳤어요`.\n둘째 줄'), '로그인 화면을 고쳤어요.');
  assert.equal(reportFirstLine('## 제목만'), '제목만');
  const long = reportFirstLine('가'.repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
  assert.equal(reportFirstLine(''), '(보고 없음)');
});
