// 라노 지침 고정·바뀐 내용 안내의 순수 판단 시험 (파일은 시험용 임시 폴더에만).
// 실행: 빌드 후 `node --test dist/main/engine/ranoPromptState.test.js`
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MissionConfig } from '../../shared/types.js';
import { buildRanoSystemPrompt, ranoMissionList, ranoPromptFrame } from './ranoPrompt.js';
import { changedOf, contentKey, nextState, planPrompt, PROMPT_STATE_VERSION, PromptStateFile, seenOf, withNotice, type RanoPromptState } from './ranoPromptState.js';

const mem = (missions = '- 홈: 진행 중') => [
  { name: 'me.md', content: '이름: 지케이' },
  { name: 'missions.md', content: missions },
];
let built = 0;
const build = () => `지침 ${++built}`;

test('내용 지문: 할 일 줄 끝 앱 메모의 시각만 다르면 같고, 기억은 글자 그대로 비교(줄 끝 공백만 무시)', () => {
  assert.equal(contentKey('- a — 리더 보고 도착 11-08 14:20', true), contentKey('- a — 리더 보고 도착 11-09 09:05', true));
  assert.equal(contentKey('- a (id: t1) — 리더 작업이 중단됨 11-08 14:20', true), contentKey('- a (id: t1) — 리더 작업이 중단됨 11-08 15:00', true));
  assert.notEqual(contentKey('- a — 리더 보고 도착 11-08 14:20', true), contentKey('- a — 리더 작업이 중단됨 11-08 14:20', true), '메모 글이 바뀌면 다름');
  assert.notEqual(contentKey('at 2026-11-08T05:20:11.123Z', true), contentKey('at 2026-11-08T06:00:00Z', true), '앱 메모가 아닌 시각은 내용');
  assert.notEqual(contentKey('- [대기] a', true), contentKey('- [진행 중] a', true));
  assert.notEqual(contentKey('회의 14:00'), contentKey('회의 15:00'), '기억 안의 시각은 내용');
  assert.equal(contentKey('a  \nb'), contentKey('a\nb'));
  const a = seenOf(mem(), '- x — 리더 보고 도착 11-08 14:20');
  const b = seenOf(mem(), '- x — 리더 보고 도착 11-08 14:21');
  assert.deepEqual(changedOf(a, b), { memory: [], todo: false });
  assert.deepEqual(changedOf(a, seenOf(mem('- 홈: 끝'), '- x')), { memory: ['missions.md'], todo: true });
  assert.deepEqual(changedOf(a, seenOf([mem()[0]], '- x — 리더 보고 도착 11-08 14:20')).memory, ['missions.md'], '사라진 파일도 바뀜');
});

test('할 일 시각: 제목·사용자 메모 안의 날짜·시각이 바뀌면 안내가 붙고, 앱 메모 시각만 바뀌면 안 붙는다', () => {
  const line = (title: string, note = '') => `### 홈 (missionId: h)\n- [대기] ${title} (id: t1)${note ? ` — ${note}` : ''}`;
  const base = line('회의 11-08 14:00 준비', '리더 보고 도착 11-08 14:20');
  const st: RanoPromptState = { version: PROMPT_STATE_VERSION, sessionId: 's1', systemPrompt: '고정', seen: seenOf(mem(), base) };
  const titleMoved = planPrompt(st, 's1', mem(), line('회의 11-09 15:30 준비', '리더 보고 도착 11-08 14:20'), build);
  assert.equal(titleMoved.reason, 'changed', '제목의 날짜·시각은 내용');
  assert.ok(titleMoved.notice.includes('회의 11-09 15:30 준비'));
  const noteMoved = planPrompt(st, 's1', mem(), line('회의 11-08 14:00 준비', '리더 보고 도착 11-09 08:05'), build);
  assert.deepEqual([noteMoved.reason, noteMoved.notice], ['same', ''], '앱 메모 시각만 바뀜');
  const userNote = planPrompt({ ...st, seen: seenOf(mem(), line('회의 준비', '11-08 14:00 에 시작')) }, 's1', mem(), line('회의 준비', '11-09 10:00 에 시작'), build);
  assert.equal(userNote.reason, 'changed', '사용자 메모의 시각은 내용');
});

test('지침 틀 지문: 미션 목록이 바뀌면 rebuild 로 지침을 새로 만들고 안내에 미션 목록을 넣는다', () => {
  const todo = '- [대기] a (id: t1)';
  const fr = (missions: string) => ({ key: contentKey(`틀 ${missions}`), missions });
  const f1 = fr('- 홈 (id: h, 개인 구역)');
  const st = nextState(null, planPrompt(null, undefined, mem(), todo, build, f1), 's1', true, false)!;
  assert.equal(st.frame, f1.key, '틀 지문 저장');
  assert.equal(planPrompt(st, 's1', mem(), todo, build, f1).reason, 'same', '틀이 같으면 그대로');
  const f2 = fr('- 홈 (id: h, 개인 구역)\n- 가계부 (id: b, 개인 구역)');
  const p = planPrompt(st, 's1', mem(), todo, build, f2);
  assert.equal(p.reason, 'rebuild');
  assert.notEqual(p.systemPrompt, st.systemPrompt, '지침을 새로 만듦');
  assert.ok(p.notice.startsWith('[앱 안내] 바뀐 내용(전체)'));
  assert.ok(p.notice.includes('### 미션 목록 (최신 전체)\n- 홈 (id: h, 개인 구역)\n- 가계부 (id: b, 개인 구역)'));
  const st2 = nextState(st, p, 's1', true, false)!;
  assert.equal(st2.frame, f2.key);
  assert.equal(planPrompt(st2, 's1', mem(), todo, build, f2).reason, 'same', '다음 차례부터는 그대로');
  assert.equal(planPrompt({ ...st, frame: undefined }, 's1', mem(), todo, build, f1).reason, 'rebuild', '틀 지문이 없는 옛 판도 한 번 새로');
  assert.equal(nextState(st, p, 's1', false, false), st, '끊긴 차례면 틀 지문도 그대로');
});

test('planPrompt: 새 대화·처음 적용·형식 바뀜·다른 대화·요약·같음·바뀜', () => {
  const todo = '- [대기] a (id: t1)';
  const fresh = planPrompt(null, undefined, mem(), todo, build);
  assert.equal(fresh.reason, 'new');
  assert.equal(fresh.notice, '');

  const first = planPrompt(null, 's1', mem(), todo, build);
  assert.equal(first.reason, 'first');
  assert.ok(first.notice.startsWith('[앱 안내] 바뀐 내용(전체)'));
  assert.ok(first.notice.includes('### 기억 me.md (최신 전체)\n이름: 지케이'));
  assert.ok(first.notice.includes('### 할 일 목록 (최신 전체)\n- [대기] a (id: t1)'));

  const st: RanoPromptState = { version: PROMPT_STATE_VERSION, sessionId: 's1', systemPrompt: '고정 지침', seen: seenOf(mem(), todo) };
  assert.equal(planPrompt({ ...st, version: 0 }, 's1', mem(), todo, build).reason, 'first');
  assert.equal(planPrompt(st, 's2', mem(), todo, build).reason, 'first', '다른 대화');
  const rb = planPrompt({ ...st, rebuild: true }, 's1', mem(), todo, build);
  assert.equal(rb.reason, 'rebuild');
  assert.notEqual(rb.systemPrompt, '고정 지침');
  assert.ok(rb.notice.startsWith('[앱 안내] 바뀐 내용(전체)'));

  const same = planPrompt(st, 's1', mem(), todo, build);
  assert.deepEqual([same.reason, same.systemPrompt, same.notice], ['same', '고정 지침', '']);

  const ch = planPrompt(st, 's1', mem('- 홈: 끝'), todo, build);
  assert.equal(ch.reason, 'changed');
  assert.equal(ch.systemPrompt, '고정 지침');
  assert.ok(ch.notice.startsWith('[앱 안내] 바뀐 내용 —'));
  assert.ok(ch.notice.includes('### 기억 missions.md (최신 전체)\n- 홈: 끝'));
  assert.ok(!ch.notice.includes('me.md') && !ch.notice.includes('### 할 일'));
  assert.equal(withNotice('안녕', ''), '안녕');
  assert.ok(withNotice('안녕', ch.notice).endsWith('\n\n---\n\n안녕'));
});

test('nextState: 정상으로 끝난 차례만 기준을 바꾸고, 끊긴 차례는 앞 판 그대로(요약이면 다시 만들기 표시만)', () => {
  const st: RanoPromptState = { version: PROMPT_STATE_VERSION, sessionId: 's1', systemPrompt: '고정', seen: seenOf(mem(), 'a') };
  const plan = planPrompt(st, 's1', mem('- 홈: 끝'), 'a', build);
  assert.equal(nextState(st, plan, 's1', false, false), st, '끊긴 차례: 그대로');
  const ok = nextState(st, plan, 's1', true, false)!;
  assert.deepEqual(ok.seen, plan.seen);
  assert.equal(ok.systemPrompt, '고정');
  assert.equal(ok.rebuild, undefined);
  assert.equal(nextState(st, plan, 's1', true, true)!.rebuild, true);
  const cut = nextState(st, plan, 's1', false, true)!;
  assert.equal(cut.rebuild, true);
  assert.deepEqual(cut.seen, st.seen, '요약됐어도 끊긴 차례면 기준은 그대로');
  assert.equal(nextState(null, plan, null, true, false), null, '대화 번호를 모르면 저장하지 않음');
});

test('저장 파일: 없거나 깨졌으면 null, 저장한 것은 그대로 읽힌다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rano-ps-'));
  const f = PromptStateFile.at(dir);
  assert.equal(f.load(), null);
  const st: RanoPromptState = { version: PROMPT_STATE_VERSION, sessionId: 's1', systemPrompt: '고정', seen: seenOf(mem(), 'a'), frame: 'k1', rebuild: true };
  f.save(st);
  assert.deepEqual(PromptStateFile.at(dir).load(), st);
  writeFileSync(path.join(dir, 'rano', 'prompt-state.json'), '{깨짐', 'utf-8');
  assert.equal(PromptStateFile.at(dir).load(), null);
});

test('라노 지침 문구: 파일마다 그 파일이 실린 가장 최근 [앱 안내]를 근거로, 기억 고치기 전에는 늘 read_memory', () => {
  const p = buildRanoSystemPrompt(mem(), [], '- a');
  assert.ok(p.includes('기억 파일마다 그 파일이 실린 가장 최근 "[앱 안내] 바뀐 내용"(어디에도 없으면 아래 "현재 기억")을 근거로 답한다'));
  assert.ok(p.includes('할 일 목록이 실린 가장 최근 "[앱 안내] 바뀐 내용"(어디에도 없으면 아래 "현재 할 일 목록")을 근거로 답한다'));
  assert.ok(p.includes('고치기 전에 늘 read_memory 로 지금 내용을 읽고, 그 내용을 바탕으로 고친다'));
  assert.ok(!p.includes('판이 확실하지 않으면 read_memory 로 먼저 읽는다'));
  assert.ok(!p.includes('"[앱 안내] 바뀐 내용"의 기억 판'));
  assert.ok(!p.includes('아래 "현재 기억"에 적힌 내용을 근거로 답한다'));
});

test('지침 틀: 기억 내용·할 일이 바뀌어도 같고, 미션 목록이 바뀌면 다르다', () => {
  const ms = [{ id: 'h', name: '홈', zone: 'personal' }] as unknown as MissionConfig[];
  const a = ranoPromptFrame(mem(), ms);
  assert.equal(a, ranoPromptFrame(mem('- 홈: 끝'), ms));
  assert.ok(!a.includes('- 홈: 진행 중') && !a.includes('이름: 지케이'), '기억 내용은 틀에 없음');
  assert.notEqual(a, ranoPromptFrame(mem(), [...ms, { id: 'b', name: '가계부', zone: 'personal' } as unknown as MissionConfig]));
  assert.equal(ranoMissionList(ms), '- 홈 (id: h, 개인 구역)');
  assert.ok(buildRanoSystemPrompt(mem(), ms, '- a').includes('## 미션 목록\n- 홈 (id: h, 개인 구역)'));
});
