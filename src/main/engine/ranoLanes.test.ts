// 라노 줄 규칙 시험 (순수 함수): 사용자 말 우선, 묶음 상한(개수·그림), 알림 붙이기·최대 대기, 프롬프트, 꺼짐 뒤 답 없는 말, 도구 문구.
// 실행: 빌드 후 `node --test dist/main/engine/ranoLanes.test.js`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatAttachment, ChatMessage } from '../../shared/types.js';
import { BATCH_RULE, findUnanswered, LANE_LIMITS, markPassed, planNextTurn, takeBatch, toolLabel, userTurnPrompt, type LaneNotice, type LaneUser } from './ranoLanes.js';

const pics = (n: number): ChatAttachment[] => Array.from({ length: n }, (_, i) => ({ id: `img${i}`, name: `그림${i}.png`, mime: 'image/png' }));
const user = (id: string, at: number, images = 0, via?: 'mobile'): LaneUser => ({ id, text: `말 ${id}`, attachments: pics(images), at, ...(via ? { via } : {}) });
const notice = (id: string, at: number, kind: 'report' | 'direct' = 'report', passed = 0): LaneNotice => ({ id, text: `[앱 알림] 보고 ${id}`, kind, at, passed });

test('묶음: 최대 개수(5)까지만, 나머지는 다음 차례', () => {
  const us = Array.from({ length: 7 }, (_, i) => user(`u${i}`, i));
  const b = takeBatch(us);
  assert.equal(b.length, LANE_LIMITS.maxBatch);
  assert.deepEqual(b.map((u) => u.id), ['u0', 'u1', 'u2', 'u3', 'u4']);
});

test('묶음: 그림 합계 6장을 넘기면 그 말부터 다음 차례 (첫 말은 많아도 넣음)', () => {
  assert.deepEqual(takeBatch([user('a', 1, 4), user('b', 2, 2), user('c', 3, 1)]).map((u) => u.id), ['a', 'b']);
  assert.deepEqual(takeBatch([user('a', 1, 7), user('b', 2, 0)]).map((u) => u.id), ['a']);
  assert.deepEqual(takeBatch([user('a', 1, 0), user('b', 2, 6), user('c', 3, 0)]).map((u) => u.id), ['a', 'b', 'c']);
});

test('줄: 사용자 말이 먼저. 사용자 말보다 늦게 온 알림은 붙이지 않고 기다린다', () => {
  const p = planNextTurn([user('a', 100)], [notice('n', 200)], 300);
  assert.equal(p?.kind, 'user');
  assert.equal(p?.kind === 'user' && p.notices.length, 0);
});

test('줄: 사용자 말보다 먼저 온 알림은 같은 프롬프트 앞에 붙는다', () => {
  const p = planNextTurn([user('a', 100)], [notice('n1', 50), notice('n2', 200)], 300);
  assert.ok(p && p.kind === 'user');
  assert.deepEqual(p.notices.map((n) => n.id), ['n1']);
});

test('줄: 붙이지 못한 알림이 사용자 말 차례 2번 밀리거나 60초 넘게 기다리면 따로 먼저 한 차례', () => {
  const byPassed = planNextTurn([user('a', 100)], [notice('n', 200, 'report', 2)], 300);
  assert.equal(byPassed?.kind, 'notice');
  const byTime = planNextTurn([user('a', 100)], [notice('n', 200, 'direct', 0)], 200 + 60_000);
  assert.equal(byTime?.kind, 'notice');
  const notYet = planNextTurn([user('a', 100)], [notice('n', 200, 'report', 1)], 200 + 59_000);
  assert.equal(notYet?.kind, 'user');
});

test('줄: markPassed 는 밀린 횟수를 하나씩 올린다', () => {
  const ns = [notice('n', 1)];
  markPassed(ns);
  markPassed(ns);
  assert.equal(ns[0].passed, 2);
});

test('줄: 사용자 말이 없으면 알림을 하나씩, 둘 다 없으면 null', () => {
  const p = planNextTurn([], [notice('n1', 1), notice('n2', 2)], 3);
  assert.ok(p && p.kind === 'notice');
  assert.equal(p.notice.id, 'n1');
  assert.equal(planNextTurn([], [], 0), null);
});

test('프롬프트: 묶음은 번호를 붙이고 "빠짐없이·뒤 말을 따르라" 규칙, 휴대폰 표시·그림 id 를 말마다 유지', () => {
  const p = userTurnPrompt([user('a', 1, 1, 'mobile'), user('b', 2, 2)], []);
  assert.match(p, /연달아 보낸 말 2개/);
  assert.ok(p.includes(BATCH_RULE));
  assert.match(p, /1\) \(휴대폰에서 보냄\) 말 a \[그림 1개: img0\]/);
  assert.match(p, /2\) 말 b \[그림 2개: img0, img1\]/);
  assert.match(p, /\[앱 안내\] 사용자가 그림 3개를 붙였어요/);
});

test('프롬프트: 말 하나는 지금과 같은 모양, 그 사이 도착한 보고는 원문을 앞에 붙인다', () => {
  const one = userTurnPrompt([user('a', 1, 0, 'mobile')], []);
  assert.equal(one, '말 a\n\n(휴대폰에서 보냄)');
  const withNotice = userTurnPrompt([user('a', 1)], [notice('n', 0)]);
  assert.match(withNotice, /^\[앱 알림 — 그 사이 도착한 보고·알림 1건\]/);
  assert.ok(withNotice.includes('[앱 알림] 보고 n'));
  assert.ok(withNotice.indexOf('보고 n') < withNotice.indexOf('[사용자 말]'));
});

const msg = (id: string, role: ChatMessage['role'], replyTo?: string[]): ChatMessage => ({ id, role, text: id, at: '2026-11-08T00:00:00Z', ...(replyTo ? { replyTo } : {}) });

test('꺼짐 뒤: 마지막 라노 답 뒤 답 없는 내 말을 찾는다', () => {
  assert.deepEqual(findUnanswered([msg('u1', 'user'), msg('r1', 'rano'), msg('u2', 'user'), msg('u3', 'user')]), ['u2', 'u3']);
  assert.deepEqual(findUnanswered([msg('u1', 'user'), msg('r1', 'rano')]), []);
  assert.deepEqual(findUnanswered([msg('u1', 'user')]), ['u1']);
});

test('꺼짐 뒤: 답 차례 동안 들어와 답 앞에 저장된 말도 찾는다 (replyTo 로 판단)', () => {
  // u1 에 답하는 사이 u2 가 저장됨 → r1(replyTo u1) 뒤에 꺼짐
  assert.deepEqual(findUnanswered([msg('u0', 'user'), msg('r0', 'rano'), msg('u1', 'user'), msg('u2', 'user'), msg('r1', 'rano', ['u1'])]), ['u2']);
  // 묶어 답한 말은 답한 것으로
  assert.deepEqual(findUnanswered([msg('u1', 'user'), msg('u2', 'user'), msg('r1', 'rano', ['u1', 'u2'])]), []);
});

test('꺼짐 뒤: replyTo: [] 인 새 형식 답(알림 차례·끊긴 답)은 기준에서 건너뛴다', () => {
  // 보고 정리 중 M 저장 → 보고 요약 R(replyTo []) 저장 → M 답 전 꺼짐
  assert.deepEqual(findUnanswered([msg('u0', 'user'), msg('a0', 'rano', ['u0']), msg('M', 'user'), msg('R', 'rano', [])]), ['M']);
  // 칸 없는 예전 답은 그대로 기준 (그 앞은 모두 답한 것으로)
  assert.deepEqual(findUnanswered([msg('u0', 'user'), msg('a0', 'rano'), msg('M', 'user'), msg('R', 'rano', [])]), ['M']);
  assert.deepEqual(findUnanswered([msg('u0', 'user'), msg('M', 'user'), msg('a0', 'rano'), msg('R', 'rano', [])]), []);
  // 기준 답이 하나도 없으면 replyTo 에 없는 내 말 모두
  assert.deepEqual(findUnanswered([msg('M', 'user'), msg('R', 'rano', [])]), ['M']);
  // 끊긴 답(replyTo [])의 말은 답 없는 말, 그 뒤 제대로 답하면 빠짐
  assert.deepEqual(findUnanswered([msg('u1', 'user'), msg('cut', 'rano', [])]), ['u1']);
  assert.deepEqual(findUnanswered([msg('u1', 'user'), msg('cut', 'rano', []), msg('a1', 'rano', ['u1'])]), []);
});

test('도구 이름 → 쉬운 진행 문구 (mcp__서버__도구 모양 포함)', () => {
  assert.equal(toolLabel('mcp__rano-todo__todo_add'), '할 일에 넣는 중');
  assert.equal(toolLabel('mcp__rano-memory__read_memory'), '기억 확인 중');
  assert.equal(toolLabel('mcp__rano-mission__assign_to_mission'), '미션에 맡기는 중');
  assert.equal(toolLabel('mcp__rano-org__org_overview'), '조직 살펴보는 중');
  assert.equal(toolLabel('mystery'), '일하는 중');
});
