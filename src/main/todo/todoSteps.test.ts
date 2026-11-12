// 할 일 단계(마일스톤) 시험
// 실행: npm run build 후 `node --test dist/main/todo/todoSteps.test.js`
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RanoConfig } from '../../shared/types.js';
import { MAX_STEPS, TodoStore } from './todoStore.js';
import { stepsFromNote } from './todoTools.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-steps-')));
const config = { rootDir: ROOT, memoryDir: path.join(ROOT, 'memory'), autoCommit: false, missions: [] } as unknown as RanoConfig;

test('단계: 정하기, 끝남 표시, 되돌리기, 목록 바꾸기', () => {
  const todos = new TodoStore(config, () => {});
  const x = todos.add(null, '월간 자료 만들기', 'rano');
  let t = todos.update(x.id, { steps: ['자료 수집', '초안', ' 초안 ', '검수', '확인'] }, 'rano');
  assert.deepEqual(t.steps, [
    { title: '자료 수집', done: false },
    { title: '초안', done: false },
    { title: '검수', done: false },
    { title: '확인', done: false },
  ]);
  t = todos.update(x.id, { doneSteps: [1, 2] }, 'rano');
  assert.deepEqual(t.steps?.map((s) => s.done), [true, true, false, false]);
  // 마지막 단계는 사용자만
  assert.throws(() => todos.update(x.id, { doneSteps: [4] }, 'rano'), /마지막 단계는 사용자가/);
  assert.throws(() => todos.update(x.id, { doneSteps: [9] }, 'rano'), /단계 9번이 없어요/);
  t = todos.update(x.id, { doneSteps: [4] }, 'user');
  assert.equal(t.steps?.[3].done, true);
  t = todos.update(x.id, { undoneSteps: [2] }, 'user');
  assert.deepEqual(t.steps?.map((s) => s.done), [true, false, false, true]);
  // 목록을 새로 정하면 같은 이름의 단계는 끝남 표시가 이어진다
  t = todos.update(x.id, { steps: ['자료 수집', '표 만들기', '확인'] }, 'user');
  assert.deepEqual(t.steps, [
    { title: '자료 수집', done: true },
    { title: '표 만들기', done: false },
    { title: '확인', done: true },
  ]);
  assert.match(todos.describe(), /단계: 1\.✓자료 수집 → 2\.표 만들기 → 3\.✓확인/);
  // 한도
  t = todos.update(x.id, { steps: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }, 'user');
  assert.equal(t.steps?.length, MAX_STEPS);
  // 빈 목록이면 단계를 지운다
  t = todos.update(x.id, { steps: [] }, 'user');
  assert.equal(t.steps, undefined);
  // 다시 읽어도 남아 있다
  todos.update(x.id, { steps: ['하나', '둘'] }, 'user');
  const again = new TodoStore(config, () => {});
  assert.deepEqual(again.get(x.id)?.steps, [
    { title: '하나', done: false },
    { title: '둘', done: false },
  ]);
});

test('단계를 메모에 적어 보낸 글은 단계 목록으로 옮긴다', () => {
  assert.deepEqual(stepsFromNote('단계: 1.폴더 내용 조사 → 2.목차 정하기 → 3.초안 쓰기 → 4.검수 → 5.확인'), ['폴더 내용 조사', '목차 정하기', '초안 쓰기', '검수', '확인']);
  assert.deepEqual(stepsFromNote('마일스톤: 조사, 초안, 확인'), ['조사', '초안', '확인']);
  assert.equal(stepsFromNote('리더 보고 도착 11-12 17:28'), null);
  assert.equal(stepsFromNote('단계: 하나뿐'), null);
});
