// 0.9.18 시험: 과제 결과 파일 목록, 기억 파일 한 군데 고치기
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyMemoryEdit } from '../memory/memoryTools.js';
import { findTaskDir, listTaskFiles, taskFilePath } from './taskFiles.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-0918-')));
const runs = path.join(ROOT, 'runs');
const ID = '0a1b2c3d-1111-4222-8333-444455556666';
const dir = path.join(runs, 'drafts', 'm1', ID);
mkdirSync(path.join(dir, 'sub'), { recursive: true });
writeFileSync(path.join(dir, '확인용_자료.xlsx'), 'PK');
writeFileSync(path.join(dir, '메일초안.txt'), '안녕하세요');
writeFileSync(path.join(dir, 'sub', '그림.png'), 'x');
writeFileSync(path.join(dir, 'build.py'), 'print(1)');
writeFileSync(path.join(dir, '인수메모.md'), '메모');
writeFileSync(path.join(dir, '.hidden.txt'), 'x');
writeFileSync(path.join(runs, 'secret.txt'), '비밀');
symlinkSync(path.join(runs, 'secret.txt'), path.join(dir, '바로가기.txt'));

test('결과 파일 목록: 문서·표·그림·글만, 스크립트·인수 메모·숨김·바로가기는 뺀다', () => {
  assert.equal(findTaskDir(runs, ID), dir);
  assert.equal(findTaskDir(runs, '0a1b2c3d'), null); // 온전한 id 만
  assert.equal(findTaskDir(runs, '../../x'), null);
  const files = listTaskFiles(dir);
  assert.deepEqual(files.map((f) => f.rel), ['확인용_자료.xlsx', path.join('sub', '그림.png'), '메일초안.txt']);
  assert.equal(files[0].kind, 'sheet');
  assert.deepEqual(listTaskFiles(null), []);
});

test('결과 파일 경로: 목록에 있는 것만', () => {
  assert.equal(taskFilePath(dir, '메일초안.txt'), path.join(dir, '메일초안.txt'));
  for (const bad of ['build.py', '바로가기.txt', '../../secret.txt', '인수메모.md', '', 3]) assert.equal(taskFilePath(dir, bad), null, String(bad));
});

test('기억 한 군데 고치기: 바꾸기, 덧붙이기, 없는 글·여러 번 나오는 글은 거절', () => {
  const now = '# 현황\n- A 미션: 조사 중\n- B 미션: 대기\n';
  const a = applyMemoryEdit(now, 'A 미션: 조사 중', 'A 미션: 구현 끝, 확인 대기');
  assert.ok(a.ok && a.content === '# 현황\n- A 미션: 구현 끝, 확인 대기\n- B 미션: 대기\n');
  const b = applyMemoryEdit(now, '', '- C 미션: 새로 시작');
  assert.ok(b.ok && b.content.endsWith('- B 미션: 대기\n- C 미션: 새로 시작\n'));
  assert.equal(applyMemoryEdit(now, '없는 글', 'x').ok, false);
  assert.equal(applyMemoryEdit(now, '미션', 'x').ok, false);
  const c = applyMemoryEdit(now, '- B 미션: 대기\n', '');
  assert.ok(c.ok && !c.content.includes('B 미션'));
  // 바꿀 글의 $ 표시는 글자 그대로 들어간다
  const d = applyMemoryEdit('값: x', 'x', '$& $1');
  assert.ok(d.ok && d.content === '값: $& $1');
});
