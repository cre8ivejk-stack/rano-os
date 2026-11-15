// 믿는 미션 기록 시험 (T3-B): 조직 화면에서 바꾼 쓰기 방식 기록, 앱 밖에서(rano.json 손으로) 믿는 미션이 된 것 찾기·기록·알림 글.
// 임시 폴더에 runs·미션 홈을 만들어 실제 파일로 확인한다.
// 실행: 빌드 후 `node --test dist/main/admin/trustLog.test.js`
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendDecisionLog,
  checkTrustAtStart,
  findNewlyTrusted,
  noteTrustChange,
  trustDetail,
  OUTSIDE_TRUST_NOTE,
  readTrustState,
  TRUST_STATE_FILE,
  trustedFromRaw,
  trustNoticeText,
  writeModeDecision,
} from './trustLog.js';

const fresh = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rano-trust-'));
  return { root, runs: path.join(root, 'runs') };
};
const mission = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `미션 ${id}`, home: `missions/personal/${id}`, stagePolicy: 'approval', ...over });
const logOf = (root: string, id: string) => {
  const f = path.join(root, 'missions', 'personal', id, 'memory', '결정로그.md');
  return existsSync(f) ? readFileSync(f, 'utf-8') : '';
};

test('rano.json 에서 믿는 미션 고르기: config.ts 와 같은 기준, 보관한 미션 포함', () => {
  const raw = {
    missions: [
      mission('a', { trustRepo: true }),
      mission('b', { trustRepo: true, stagePolicy: 'readOnly' }), // 읽기만이면 trustRepo 가 있어도 아님
      mission('c'),
      mission('d', { trustRepo: 'true' }), // 글자 "true" 는 아님
      mission('e', { trustRepo: true, archived: true }),
      null,
      { name: 'id 없음', stagePolicy: 'approval', trustRepo: true },
    ],
  };
  assert.deepEqual(trustedFromRaw(raw).map((m) => m.id), ['a', 'e']);
  assert.deepEqual(trustedFromRaw({}), []);
  assert.deepEqual(trustedFromRaw(null), []);
});

test('새로 믿게 된 것 찾기: 처음(지난 목록 없음)은 아무것도 알리지 않음', () => {
  const now = trustedFromRaw({ missions: [mission('a', { trustRepo: true }), mission('b', { trustRepo: true })] });
  assert.deepEqual(findNewlyTrusted(null, now), []);
  assert.deepEqual(findNewlyTrusted(['a'], now).map((m) => m.id), ['b']);
  assert.deepEqual(findNewlyTrusted(['a', 'b', 'x'], now), []);
});

test('앱이 켜질 때: 처음엔 기준만 저장, 손으로 믿는 미션을 늘리면 결정로그에 남기고 돌려줌, 다시 켜면 또 알리지 않음', () => {
  const { root, runs } = fresh();
  const raw1 = { missions: [mission('a', { trustRepo: true }), mission('b')] };
  const r1 = checkTrustAtStart({ raw: raw1, rootDir: root, runsDir: runs, date: '2026-11-15' });
  assert.equal(r1.first, true);
  assert.deepEqual(r1.found, []);
  assert.deepEqual(readTrustState(runs), ['a']);
  assert.equal(logOf(root, 'a'), '');

  // 손으로 b 를 믿는 미션으로
  const raw2 = { missions: [mission('a', { trustRepo: true }), mission('b', { trustRepo: true })] };
  const r2 = checkTrustAtStart({ raw: raw2, rootDir: root, runsDir: runs, date: '2026-11-16' });
  assert.equal(r2.first, false);
  assert.deepEqual(r2.found.map((m) => m.id), ['b']);
  assert.deepEqual(r2.logFailed, []);
  assert.equal(logOf(root, 'b'), `# 결정로그\n\n- 2026-11-16 ${OUTSIDE_TRUST_NOTE}\n`);
  assert.deepEqual(readTrustState(runs), ['a', 'b']);

  const r3 = checkTrustAtStart({ raw: raw2, rootDir: root, runsDir: runs, date: '2026-11-17' });
  assert.deepEqual(r3.found, []);
  assert.equal(logOf(root, 'b').split('\n').filter((l) => l.startsWith('- ')).length, 1);

  // 풀었다가 다시 손으로 켜면 다시 찾는다
  checkTrustAtStart({ raw: raw1, rootDir: root, runsDir: runs, date: '2026-11-18' });
  assert.deepEqual(readTrustState(runs), ['a']);
  const r4 = checkTrustAtStart({ raw: raw2, rootDir: root, runsDir: runs, date: '2026-11-19' });
  assert.deepEqual(r4.found.map((m) => m.id), ['b']);
});

test('조직 화면에서 켠 믿는 미션은 다음에 켤 때 "앱 밖에서 바뀜"으로 보지 않음', () => {
  const { root, runs } = fresh();
  // 목록 파일이 없으면 조직 화면 기록은 건드리지 않음(켤 때 기준을 만든다)
  noteTrustChange(runs, 'a', true);
  assert.equal(existsSync(path.join(runs, TRUST_STATE_FILE)), false);

  checkTrustAtStart({ raw: { missions: [mission('a'), mission('b')] }, rootDir: root, runsDir: runs, date: '2026-11-15' });
  assert.deepEqual(readTrustState(runs), []);
  noteTrustChange(runs, 'a', true); // 조직 화면에서 a 를 믿는 미션으로
  const r = checkTrustAtStart({ raw: { missions: [mission('a', { trustRepo: true }), mission('b')] }, rootDir: root, runsDir: runs, date: '2026-11-16' });
  assert.deepEqual(r.found, []);
  noteTrustChange(runs, 'a', false); // 조직 화면에서 풂
  assert.deepEqual(readTrustState(runs), []);
});

test('목록 파일이 깨졌으면 처음처럼 기준만 다시 만든다', () => {
  const { root, runs } = fresh();
  checkTrustAtStart({ raw: { missions: [] }, rootDir: root, runsDir: runs, date: '2026-11-15' });
  writeFileSync(path.join(runs, TRUST_STATE_FILE), '{ 깨짐', 'utf-8');
  const r = checkTrustAtStart({ raw: { missions: [mission('a', { trustRepo: true })] }, rootDir: root, runsDir: runs, date: '2026-11-16' });
  assert.equal(r.first, true);
  assert.deepEqual(r.found, []);
  assert.deepEqual(readTrustState(runs), ['a']);
});

test('미션 홈이 없으면 기록 실패만 알리고 목록은 저장', () => {
  const { root, runs } = fresh();
  checkTrustAtStart({ raw: { missions: [] }, rootDir: root, runsDir: runs, date: '2026-11-15' });
  const r = checkTrustAtStart({ raw: { missions: [{ id: 'x', name: 'X', stagePolicy: 'approval', trustRepo: true }] }, rootDir: root, runsDir: runs, date: '2026-11-16' });
  assert.deepEqual(r.found.map((m) => m.id), ['x']);
  assert.deepEqual(r.logFailed, ['x']);
  assert.deepEqual(readTrustState(runs), ['x']);
});

test('조직 화면 쓰기 방식 변경 기록 글', () => {
  assert.equal(writeModeDecision('trusted', 'trusted'), null);
  assert.equal(writeModeDecision('approval', 'trusted'), '사용자가 앱에서 믿는 미션(작업 폴더 안 고치기는 묻지 않기)을 허용 (이전: 승인함을 거쳐 쓰기)');
  assert.equal(writeModeDecision('readOnly', 'trusted'), '사용자가 앱에서 믿는 미션(작업 폴더 안 고치기는 묻지 않기)을 허용 (이전: 읽기만)');
  assert.equal(writeModeDecision('trusted', 'approval'), '사용자가 앱에서 믿는 미션을 풀고 승인함을 거쳐 쓰기(으)로 바꿈');
  assert.equal(writeModeDecision('readOnly', 'approval'), '사용자가 앱에서 승인함을 거친 쓰기를 허용'); // 예전 글 그대로
  assert.equal(writeModeDecision('approval', 'readOnly'), '사용자가 앱에서 읽기만(으)로 바꿈 (이전: 승인함을 거쳐 쓰기)');
});

test('결정로그 한 줄 더하기: 없으면 머리를 만들고, 끝 줄바꿈이 없어도 이어 붙인다', () => {
  const { root } = fresh();
  const home = path.join(root, 'h');
  appendDecisionLog(home, '2026-11-15', '첫 줄');
  const f = path.join(home, 'memory', '결정로그.md');
  assert.equal(readFileSync(f, 'utf-8'), '# 결정로그\n\n- 2026-11-15 첫 줄\n');
  writeFileSync(f, '# 결정로그\n\n- 옛 줄', 'utf-8');
  appendDecisionLog(home, '2026-11-16', '둘째');
  assert.equal(readFileSync(f, 'utf-8'), '# 결정로그\n\n- 옛 줄\n- 2026-11-16 둘째\n');
});

test('라노 알림 글: [앱 알림] 으로 시작하고 미션 이름이 들어감', () => {
  const t = trustNoticeText([{ id: 'a', name: '홈페이지', home: '', detail: '' }, { id: 'b', name: '앱', home: '', detail: '' }]);
  assert.match(t, /^\[앱 알림\] /);
  assert.match(t, /「홈페이지」, 「앱」/);
  assert.match(t, /rano\.json/);
});

test('조직 화면·앱 시작 코드가 기록을 부른다', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url)), 'utf-8');
  const org = src('main/admin/orgAdmin.ts');
  assert.match(org, /writeModeDecision\(before\.writeMode, draft\.writeMode\)/);
  assert.match(org, /appendDecisionLog\(before\.home, today\(\), decision\)/);
  assert.match(org, /noteTrustChange\(config\.runsDir, id, true, trustDetail\(/);
  assert.match(org, /noteTrustChange\(config\.runsDir, id, draft\.writeMode === 'trusted', trustDetail\(m\)\)/);
  // 예전처럼 "읽기만 → 승인함" 일 때만 남기는 조건은 없다
  assert.ok(!org.includes("before.writeMode === 'readOnly' && draft.writeMode === 'approval'"));
  const main = src('main/main.ts');
  assert.match(main, /checkTrustAtStart\(\{ raw: config\.raw, rootDir: config\.rootDir, runsDir: config\.runsDir, date: today\(\) \}\)/);
  assert.match(main, /rano\.notify\(trustNoticeText\(t\.found, t\.changed\), 'direct'\)/);
});

test('0.9.10: 믿는 미션의 작업 폴더·DB 읽기 설정이 앱 밖에서 바뀌면 알아챈다(앱에서 바꾼 것은 아님)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rano-trust-scope-'));
  const runs = path.join(root, 'runs');
  const mk = (targets: string[], extra: object = {}) => ({ missions: [{ id: 'a', name: '가', home: 'missions/a', stagePolicy: 'approval', trustRepo: true, targets, ...extra }] });
  const at = (raw: unknown) => checkTrustAtStart({ raw, rootDir: root, runsDir: runs, date: '2026-11-16' });
  assert.equal(at(mk(['~/x'])).changed.length, 0); // 처음
  assert.equal(at(mk(['~/x'])).changed.length, 0); // 그대로
  const c = at(mk(['~/y']));
  assert.deepEqual(c.changed.map((m) => m.id), ['a']);
  assert.match(readFileSync(path.join(root, 'missions/a/memory/결정로그.md'), 'utf-8'), /작업 폴더·운영 DB 읽기 설정이 달라짐/);
  assert.equal(at(mk(['~/y'])).changed.length, 0); // 한 번만
  assert.equal(at(mk(['~/y'], { dbRead: { tool: 't', apps: ['p'] } })).changed.length, 1);
  // 앱(조직 화면)에서 바꾼 것은 목록을 맞춰 두어 알리지 않는다
  const next = mk(['~/z'], { dbRead: { tool: 't', apps: ['p'] } });
  noteTrustChange(runs, 'a', true, trustDetail(next.missions[0]));
  assert.equal(at(next).changed.length, 0);
  assert.match(trustNoticeText([], c.changed), /작업 폴더나 운영 DB 읽기 설정/);
});
