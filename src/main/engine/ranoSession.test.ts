// 라노 세션 흐름 시험: 엔진(SDK query)을 가짜로 바꿔 끼워 stream_event·assistant·result·오류를 차례로 흘려 준다.
// 실제 모델·네트워크·Electron 은 쓰지 않는다. 대화 기록·events.jsonl 은 시험용 임시 폴더에만 쓴다.
// 실행: 빌드 후 `node --test dist/main/engine/ranoSession.test.js`
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ChatMessage, MemoryServiceApi, RanoConfig, RanoUiEvent } from '../../shared/types.js';
import { ConversationStore } from './conversationStore.js';
import { CUT_NOTE, RanoCore, type QueryFn } from './ranoCore.js';
import { ranoEffortFrom } from '../config.js';
import { MobileReplyTracker } from '../mobile/mobileRules.js';

type Script = (args: { prompt: unknown; options: any }) => AsyncGenerator<any>;

function makeConfig(extra: Partial<RanoConfig> = {}): RanoConfig {
  const root = mkdtempSync(path.join(tmpdir(), 'rano-core-'));
  return {
    rootDir: root,
    authMethod: 'max',
    models: { rano: 'test-model', repoLeader: 'x', member: 'x' },
    blocked: [],
    memoryDir: path.join(root, 'memory'),
    memoryFiles: [],
    autoCommit: false,
    runsDir: path.join(root, 'runs'),
    missions: [],
    raw: {},
    ...extra,
  };
}

const memory: MemoryServiceApi = { readAll: async () => [], read: async () => '', write: async () => ({ committed: false }) };

type Engine = AsyncIterable<any> & { close?: () => void };

function setup(scripts: (Script | ((args: any) => Engine))[], extra: Partial<RanoConfig> = {}, opts: { engineDrainMs?: number; order?: string[] } = {}) {
  const config = makeConfig(extra);
  const store = new ConversationStore(config);
  const events: RanoUiEvent[] = [];
  const calls: { prompt: unknown; options: any }[] = [];
  const afterResult: unknown[] = [];
  const queryFn: QueryFn = ((args: any) => {
    calls.push(args);
    opts.order?.push(`call${calls.length}`);
    const s = scripts.shift();
    if (!s) throw new Error('시험 대본이 모자라요');
    return s(args);
  }) as QueryFn;
  const core = new RanoCore({ config, memory, store, emit: (e) => events.push(e), memoryMcp: {}, queryFn, sdkEnv: () => ({}), liveThrottleMs: 0, afterResult: (q) => afterResult.push(q), ...(opts.engineDrainMs !== undefined ? { engineDrainMs: opts.engineDrainMs } : {}) });
  const logLines = () => {
    const f = path.join(config.runsDir, 'events.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { config, store, events, calls, core, logLines, afterResult };
}

// ---- 가짜 엔진 메시지 ----
const init = { type: 'system', subtype: 'init', session_id: 'sess-1' };
const se = (event: unknown, extra: Record<string, unknown> = {}) => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u', session_id: 'sess-1', ...extra });
const delta = (text: string, extra: Record<string, unknown> = {}) => se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, extra);
const textStart = se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const toolStart = (id: string, name: string) => se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name, input: {} } });
const assistant = (id: string, content: unknown[]) => ({ type: 'assistant', message: { id, role: 'assistant', content }, parent_tool_use_id: null, uuid: `a-${id}`, session_id: 'sess-1' });
const ok = (result = '') => ({ type: 'result', subtype: 'success', is_error: false, result, duration_ms: 1234, ttft_ms: 321, session_id: 'sess-1' });

function simpleAnswer(text: string): Script {
  return async function* () {
    yield init;
    yield textStart;
    yield delta(text.slice(0, 2), { ttft_ms: 111 });
    yield delta(text.slice(2));
    yield assistant('m1', [{ type: 'text', text }]);
    yield ok(text);
  };
}

function gate() {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

const lives = (events: RanoUiEvent[]) => events.filter((e): e is Extract<RanoUiEvent, { kind: 'live' }> => e.kind === 'live');
const ranoMsgs = (events: RanoUiEvent[]) => events.filter((e): e is Extract<RanoUiEvent, { kind: 'message' }> => e.kind === 'message' && e.message.role === 'rano');

test('흘려 보이기: 글자 조각은 화면 이벤트(live)로 가고 events.jsonl 에는 남지 않는다. 저장은 최종 답 하나', async () => {
  const t = setup([simpleAnswer('안녕하세요, 라노예요.')]);
  await t.core.send('안녕');
  await t.core.whenIdle();
  const ls = lives(t.events);
  assert.ok(ls.some((e) => e.text === '안녕'), '첫 조각이 바로 화면으로');
  assert.ok(ls.some((e) => e.text === '안녕하세요, 라노예요.'));
  const logged = t.logLines();
  assert.equal(logged.filter((l) => l.kind === 'live').length, 0, 'live 는 기록하지 않음');
  assert.ok(logged.some((l) => l.kind === 'message' && l.message.role === 'rano'));
  const { messages } = await t.store.load();
  assert.deepEqual(messages.map((m) => m.role), ['user', 'rano']);
  assert.equal(messages[1].text, '안녕하세요, 라노예요.');
  assert.deepEqual(messages[1].replyTo, [messages[0].id]);
  // 응답 시간 한 줄: 내용 없이 시각·ttft 만
  const timing = logged.find((l) => l.kind === 'timing');
  assert.ok(timing);
  assert.equal(timing.ttft_ms, 111);
  assert.equal(timing.engineMs, 1234);
  assert.equal(typeof timing.firstShownMs, 'number');
  assert.equal(typeof timing.answeredMs, 'number');
  assert.equal(JSON.stringify(timing).includes('안녕'), false, '기록에 말 내용 없음');
});

test('도구 전 말은 화면에서 회색 줄로 줄이고, 최종 저장에서는 뺀다', async () => {
  const t = setup([
    async function* () {
      yield init;
      yield textStart;
      yield delta('확인해 볼게요.');
      yield toolStart('tool-1', 'mcp__rano-todo__todo_add');
      yield assistant('m1', [{ type: 'text', text: '확인해 볼게요.' }, { type: 'tool_use', id: 'tool-1', name: 'mcp__rano-todo__todo_add', input: {} }]);
      yield textStart;
      yield delta('할 일에 넣었어요.');
      yield assistant('m2', [{ type: 'text', text: '할 일에 넣었어요.' }]);
      yield ok('할 일에 넣었어요.');
    },
  ]);
  await t.core.send('할 일에 넣어 줘');
  await t.core.whenIdle();
  const step = lives(t.events).find((e) => e.steps.length >= 2);
  assert.ok(step, '회색 줄이 생김');
  assert.deepEqual(step.steps[0], { tone: 'said', text: '확인해 볼게요.' });
  assert.deepEqual(step.steps[1], { tone: 'doing', text: '할 일에 넣는 중' });
  assert.equal(step.text, '', '도구가 시작되면 쓰던 말풍선은 비우고 회색 줄로');
  assert.equal(lives(t.events).filter((e) => e.steps.some((s) => s.text === '할 일에 넣는 중')).length >= 1, true);
  const { messages } = await t.store.load();
  assert.equal(messages.filter((m) => m.role === 'rano').length, 1);
  assert.equal(messages[1].text, '할 일에 넣었어요.');
});

test('이어가기 실패로 새 세션 재시도: 쓰던 말풍선을 비우고 다시 쓴다', async () => {
  const t = setup([
    async function* () {
      yield delta('앞 시도');
      throw new Error('No conversation found with session ID old');
    },
    simpleAnswer('새로 답해요'),
  ]);
  await t.store.setSessionId('old');
  await t.core.send('계속');
  await t.core.whenIdle();
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[0].options.resume, 'old');
  assert.equal(t.calls[1].options.resume, undefined);
  const ls = lives(t.events);
  const firstIdx = ls.findIndex((e) => e.text === '앞 시도');
  const resetIdx = ls.findIndex((e, i) => i > firstIdx && e.text === '' && !e.steps.length);
  const againIdx = ls.findIndex((e) => e.text.startsWith('새로'));
  assert.ok(firstIdx >= 0 && resetIdx > firstIdx && againIdx > resetIdx, '앞 시도 → 비움 → 새 글 순서');
  assert.equal(ranoMsgs(t.events).length, 1);
  assert.equal(ranoMsgs(t.events)[0].message.text, '새로 답해요');
  assert.equal(t.events.filter((e) => e.kind === 'error').length, 0);
});

test('글이 조금 나온 뒤 오류: 화면엔 남기되 "끊김" 표시를 붙이고, 답한 말로 치지 않는다(replyTo [] → 답 없는 말)', async () => {
  const t = setup([
    async function* () {
      yield init;
      yield textStart;
      yield delta('반쯤 쓴 답');
      throw new Error('socket hang up');
    },
  ]);
  await t.core.send('질문', [], 'mobile');
  await t.core.whenIdle();
  const msgs = ranoMsgs(t.events);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].message.text, `반쯤 쓴 답\n\n${CUT_NOTE}`, '화면(=휴대폰으로 가는 글)에도 끊김 표시');
  assert.equal(CUT_NOTE, '(답이 중간에 끊겼어요)');
  assert.deepEqual(msgs[0].message.replyTo, []);
  const kinds = t.events.map((e) => e.kind);
  assert.ok(kinds.lastIndexOf('error') > kinds.indexOf('message', kinds.indexOf('live')));
  const { messages } = await t.store.load();
  const saved = messages.filter((m) => m.role === 'rano')[0];
  assert.equal(saved?.text, `반쯤 쓴 답\n\n${CUT_NOTE}`);
  assert.deepEqual(saved?.replyTo, []);
  const userId = messages.find((m) => m.role === 'user')!.id;
  assert.deepEqual(await t.core.unanswered(), [userId], '끊긴 답의 말은 [다시 보내기] 대상');
  // 휴대폰으로 갈 글도 같은 표시 (휴대폰 판단 규칙에 그대로 넣어 봄)
  const tracker = new MobileReplyTracker();
  const phone = t.events.map((e) => tracker.decide(e, false)).filter((x): x is string => x !== null);
  assert.ok(phone.includes(`반쯤 쓴 답\n\n${CUT_NOTE}`), '휴대폰에도 끊김 표시가 붙은 글');
});

test('확정 메시지 없이 끝나도(idle) 쓰던 말풍선·회색 줄은 반드시 지운다', async () => {
  const t = setup([
    async function* () {
      yield init;
      yield toolStart('t1', 'mcp__rano-memory__read_memory');
      yield { type: 'result', subtype: 'error_max_turns', errors: [], duration_ms: 5, session_id: 'sess-1' };
    },
  ]);
  await t.core.send('긴 일');
  await t.core.whenIdle();
  assert.equal(ranoMsgs(t.events).length, 0);
  const idleIdx = t.events.findIndex((e) => e.kind === 'status' && e.status === 'idle');
  const lastLive = t.events.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'live').pop();
  assert.ok(lastLive, 'live 이벤트가 있음');
  const [le, li] = lastLive as [Extract<RanoUiEvent, { kind: 'live' }>, number];
  assert.equal(le.text, '');
  assert.equal(le.steps.length, 0, '마지막 live 는 비움');
  assert.ok(li < idleIdx, '비움이 idle 보다 먼저');
  assert.ok(t.events.some((e) => e.kind === 'error'));
});

test('차례 번호: 조각·진행 줄에 차례 번호가 붙고, 다른 차례 것과 섞이지 않는다. 기다리는 말은 queued 로 표시', async () => {
  const g = gate();
  const t = setup([
    async function* () {
      yield init;
      yield delta('첫 답');
      await g.p;
      yield assistant('m1', [{ type: 'text', text: '첫 답' }]);
      yield ok('첫 답');
    },
    simpleAnswer('둘째 답'),
  ]);
  await t.core.send('하나');
  await new Promise((r) => setTimeout(r, 10));
  await t.core.send('둘');
  const second = t.events.find((e) => e.kind === 'message' && e.message.role === 'user' && e.message.text === '둘');
  assert.ok(second && second.kind === 'message' && second.queued === true, '앞 차례가 도는 동안 보낸 말은 queued');
  g.open();
  await t.core.whenIdle();
  const thinking = t.events.filter((e): e is Extract<RanoUiEvent, { kind: 'status' }> => e.kind === 'status' && e.status === 'thinking');
  assert.deepEqual(thinking.map((e) => e.turn), [1, 2]);
  const t2Start = t.events.indexOf(thinking[1]);
  for (const [i, e] of t.events.entries()) {
    if (e.kind !== 'live') continue;
    assert.equal(e.turn, i < t2Start ? 1 : 2, '차례 2가 시작된 뒤에는 차례 2 조각만');
  }
  assert.deepEqual(ranoMsgs(t.events).map((e) => e.turn), [1, 2]);
});

test('묶어 답하기: 기다리는 동안 쌓인 내 말은 한 차례로, 프롬프트에 번호·규칙, 답의 replyTo 에 묶은 말 모두', async () => {
  const g = gate();
  const t = setup([
    async function* () {
      yield init;
      await g.p;
      yield ok('하나 답');
    },
    simpleAnswer('셋 모두 답'),
  ]);
  await t.core.send('하나');
  await new Promise((r) => setTimeout(r, 10));
  await t.core.send('둘');
  await t.core.send('셋', [], 'mobile');
  await t.core.send('넷');
  g.open();
  await t.core.whenIdle();
  assert.equal(t.calls.length, 2, '두 차례만');
  const prompt = String(t.calls[1].prompt);
  assert.match(prompt, /연달아 보낸 말 3개/);
  assert.match(prompt, /빠짐없이 답하고, 뒤 말이 앞 말을 고치거나 취소하면 뒤 말을 따르세요/);
  assert.match(prompt, /2\) \(휴대폰에서 보냄\) 셋/);
  const { messages } = await t.store.load();
  const ids = messages.filter((m) => m.role === 'user').map((m) => m.id);
  const last = messages[messages.length - 1];
  assert.deepEqual(last.replyTo, ids.slice(1));
  const answer = ranoMsgs(t.events)[1];
  assert.equal(answer.mobile, true, '휴대폰 말이 든 묶음의 답은 휴대폰 표시');
});

test('사용자 말 우선: 내 말보다 늦게 온 보고는 내 말 다음 차례(보고 정리 중 표시), 먼저 온 보고는 내 말 프롬프트에 붙고 따로 요약하지 않음', async () => {
  const g = gate();
  const t = setup([
    async function* () {
      yield init;
      await g.p;
      yield ok('A 답');
    },
    simpleAnswer('B 답과 보고 1 전달'),
    simpleAnswer('보고 2 정리'),
  ]);
  await t.core.send('A');
  await new Promise((r) => setTimeout(r, 10));
  const n1 = t.core.notify('[앱 알림] 홈 리더 보고 (과제: 하나, 결과: 완료)\n\n보고 1 원문', 'report');
  await new Promise((r) => setTimeout(r, 2));
  await t.core.send('B');
  await new Promise((r) => setTimeout(r, 2));
  const n2 = t.core.notify('[앱 알림] 홈 리더 보고 (과제: 둘, 결과: 완료)\n\n보고 2 원문', 'report');
  g.open();
  await t.core.whenIdle();
  await n1;
  await n2;
  assert.equal(t.calls.length, 3, 'A · (B + 보고 1) · 보고 2');
  const p2 = String(t.calls[1].prompt);
  assert.match(p2, /그 사이 도착한 보고/);
  assert.ok(p2.includes('보고 1 원문'));
  assert.ok(!p2.includes('보고 2 원문'));
  assert.ok(p2.trimEnd().endsWith('B'));
  const p3 = String(t.calls[2].prompt);
  assert.ok(p3.startsWith('[앱 알림]') && p3.includes('보고 2 원문'));
  assert.equal(t.calls.filter((c) => String(c.prompt).includes('보고 1 원문')).length, 1, '보고 1 은 한 번만');
  const th = t.events.filter((e): e is Extract<RanoUiEvent, { kind: 'status' }> => e.kind === 'status' && e.status === 'thinking');
  assert.equal(th[2].label, '보고 정리 중');
  assert.equal(th[1].label, undefined);
});

test('답 확정은 결과(result)에서 바로: 엔진이 뒤에서 끝나지 않아도(사용 한도 받기 등) 기다리지 않는다', async () => {
  const t = setup([
    async function* () {
      yield init;
      yield assistant('m1', [{ type: 'text', text: '바로 확정' }]);
      yield ok('바로 확정');
      await new Promise(() => undefined); // 영영 끝나지 않음
    },
  ]);
  await t.core.send('빨리');
  await t.core.whenIdle();
  assert.equal(ranoMsgs(t.events)[0]?.message.text, '바로 확정');
  assert.equal(t.afterResult.length, 1, '결과 뒤 할 일(사용 한도 받기)은 부르기만 함');
});

test('생각 깊이: 라노 옵션에만 effort(기본 low) + 흘려 받기 켜짐, rano.json ranoEffort 칸이 동작', async () => {
  const t = setup([simpleAnswer('a'), simpleAnswer('b')]);
  await t.core.send('x');
  await t.core.whenIdle();
  assert.equal(t.calls[0].options.effort, 'low');
  assert.equal(t.calls[0].options.includePartialMessages, true);
  assert.equal(t.calls[0].options.model, 'test-model');
  const h = setup([simpleAnswer('c')], { ranoEffort: ranoEffortFrom({ ranoEffort: 'HIGH' }) });
  await h.core.send('y');
  await h.core.whenIdle();
  assert.equal(h.calls[0].options.effort, 'high');
  assert.equal(ranoEffortFrom({}), 'low');
  assert.equal(ranoEffortFrom({ ranoEffort: 'turbo' }), 'low');
  assert.equal(ranoEffortFrom({ ranoEffort: 'max' }), 'max');
  assert.equal(ranoEffortFrom({ models: { ranoEffort: 'high' } }), 'low', 'models 안이 아니라 맨 위 칸');
});

test('꺼짐 뒤 답 없는 말: 찾기만 하고 자동 실행 안 함, [다시 보내기]는 같은 말을 줄에 세워 replyTo 로 잇는다', async () => {
  const t = setup([simpleAnswer('이제 답해요')]);
  const old: ChatMessage = { id: 'old-1', role: 'user', text: '꺼지기 전 말', at: '2026-11-08T00:00:00Z' };
  await t.store.append({ id: 'r0', role: 'rano', text: '앞 답', at: '2026-11-08T00:00:00Z' });
  await t.store.append(old);
  assert.deepEqual(await t.core.unanswered(), ['old-1']);
  assert.equal(t.calls.length, 0, '자동으로 다시 실행하지 않음');
  const r = await t.core.resend('old-1');
  assert.equal(r.ok, true);
  await t.core.whenIdle();
  const { messages } = await t.store.load();
  assert.equal(messages.filter((m) => m.id === 'old-1').length, 1, '말을 새로 저장하지 않음');
  assert.deepEqual(messages[messages.length - 1].replyTo, ['old-1']);
  assert.deepEqual(await t.core.unanswered(), []);
  assert.equal((await t.core.resend('old-1')).ok, false, '이미 답한 말은 다시 보내지 않음');
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstAnswer = [init, assistant('m1', [{ type: 'text', text: '첫 답' }]), ok('첫 답')];

test('다음 엔진은 앞 엔진이 끝난 뒤에 켠다: 답 확정은 결과에서 바로, 두 번째 엔진 호출은 앞 엔진 정리 뒤', async () => {
  const order: string[] = [];
  const g = gate();
  const t = setup(
    [
      async function* () {
        try {
          for (const m of firstAnswer) yield m;
          await g.p; // 결과 뒤 바로 끝나지 않음 (사용 한도 받기 등)
        } finally {
          order.push('end1');
        }
      },
      simpleAnswer('둘째 답'),
    ],
    {},
    { engineDrainMs: 5000, order },
  );
  await t.core.send('하나');
  await t.core.whenIdle();
  assert.equal(ranoMsgs(t.events)[0]?.message.text, '첫 답', '첫 답은 엔진이 끝나기 전에 확정');
  await t.core.send('둘');
  await sleep(30);
  assert.equal(t.calls.length, 1, '앞 엔진이 붙어 있는 동안 새 엔진을 켜지 않음');
  g.open();
  await t.core.whenIdle();
  assert.deepEqual(order, ['call1', 'end1', 'call2']);
  assert.equal(ranoMsgs(t.events)[1]?.message.text, '둘째 답');
});

test('앞 엔진이 제한 시간 안에 안 끝나면 close() 로 끄고, 정리된 뒤 다음 엔진을 켠다', async () => {
  const order: string[] = [];
  const g = gate();
  const stuck = (): Engine => {
    const it = (async function* () {
      try {
        for (const m of firstAnswer) yield m;
        await g.p;
      } finally {
        order.push('end1');
      }
    })();
    return Object.assign(it, {
      close: () => {
        order.push('close1');
        g.open(); // 실제 SDK 처럼 끄면 반복이 끝난다
      },
    });
  };
  const t = setup([stuck, simpleAnswer('둘째 답')], {}, { engineDrainMs: 30, order });
  await t.core.send('하나');
  await t.core.whenIdle();
  await t.core.send('둘');
  await t.core.whenIdle();
  assert.deepEqual(order, ['call1', 'close1', 'end1', 'call2']);
  assert.deepEqual(ranoMsgs(t.events).map((e) => e.message.text), ['첫 답', '둘째 답']);
});

test('close() 뒤에도 안 끝나면 조금 더 기다렸다가 그래도 다음 차례를 진행한다', async () => {
  const order: string[] = [];
  const never = (): Engine =>
    Object.assign(
      (async function* () {
        for (const m of firstAnswer) yield m;
        await new Promise(() => undefined);
      })(),
      { close: () => void order.push('close1') },
    );
  const t = setup([never, simpleAnswer('둘째 답')], {}, { engineDrainMs: 20, order });
  await t.core.send('하나');
  await t.core.whenIdle();
  await t.core.send('둘');
  await t.core.whenIdle();
  assert.deepEqual(order, ['call1', 'close1', 'call2']);
  assert.equal(ranoMsgs(t.events)[1]?.message.text, '둘째 답');
});

test('보고 정리 중 보낸 말 M → 보고 요약 R 저장(replyTo []) → M 답 전 꺼짐 → 다시 켜면 M 이 답 없는 말', async () => {
  const at = '2026-11-08T00:00:00Z';
  const g = gate();
  const t = setup([
    async function* () {
      yield init;
      await g.p;
      yield assistant('r', [{ type: 'text', text: '보고 요약' }]);
      yield ok('보고 요약');
    },
    async function* () {
      yield init;
      await new Promise(() => undefined); // M 에 답하는 도중 앱이 꺼짐
    },
  ]);
  await t.store.append({ id: 'u0', role: 'user', text: '앞 말', at });
  await t.store.append({ id: 'a0', role: 'rano', text: '앞 답', at, replyTo: ['u0'] });
  const n = t.core.notify('[앱 알림] 홈 리더 보고 (과제: 하나, 결과: 완료)\n\n보고 원문', 'report');
  await sleep(10);
  await t.core.send('M 말');
  g.open();
  await n;
  await sleep(20);
  const { messages } = await t.store.load();
  const rIdx = messages.findIndex((m) => m.role === 'rano' && m.text === '보고 요약');
  const mIdx = messages.findIndex((m) => m.text === 'M 말');
  assert.ok(rIdx > mIdx && mIdx >= 0, 'M 이 R 보다 먼저 저장됨');
  assert.deepEqual(messages[rIdx].replyTo, [], '알림 차례 답은 replyTo: []');
  // 다시 켬: 같은 기록을 새 세션으로 읽는다
  const again = new RanoCore({ config: t.config, memory, store: new ConversationStore(t.config), emit: () => undefined, memoryMcp: {}, queryFn: (() => { throw new Error('쓰지 않음'); }) as QueryFn, sdkEnv: () => ({}) });
  assert.deepEqual(await again.unanswered(), [messages[mIdx].id]);
});

test('오류 줄에도 차례 번호·휴대폰 표시가 붙는다', async () => {
  const t = setup([
    async function* () {
      yield init;
      yield { type: 'result', subtype: 'success', is_error: true, result: 'overloaded_error', duration_ms: 1, session_id: 'sess-1' };
    },
  ]);
  await t.core.send('폰에서', [], 'mobile');
  await t.core.whenIdle();
  const err = t.events.find((e): e is Extract<RanoUiEvent, { kind: 'error' }> => e.kind === 'error');
  assert.ok(err);
  assert.equal(err.turn, 1);
  assert.equal(err.mobile, true);
});
