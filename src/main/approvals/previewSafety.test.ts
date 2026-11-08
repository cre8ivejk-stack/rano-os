// [시안 열기] 안전 확인 시험. 실행: npm run build 후 `node --test dist/main/approvals/previewSafety.test.js`
// (실제로 열지는 않고 판단만 본다)
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkPreviewFile, taskDraftsDir } from './previewSafety.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-preview-')));
const RUNS = path.join(ROOT, 'runs');
const DIR = taskDraftsDir(RUNS, 'm1', 't1')!;
const OTHER_TASK = taskDraftsDir(RUNS, 'm1', 't2')!;
const OUTSIDE = path.join(ROOT, 'outside');
mkdirSync(DIR, { recursive: true });
mkdirSync(OTHER_TASK, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

function file(dir: string, name: string, mode = 0o644): string {
  const p = path.join(dir, name);
  writeFileSync(p, 'x');
  chmodSync(p, mode);
  return p;
}

const ok = (p: string) => checkPreviewFile(p, DIR);
const blocked = (p: string) => {
  const r = checkPreviewFile(p, DIR);
  assert.equal(r.ok, false, `${p} 는 열리면 안 됨`);
  return r as { ok: false; message: string; reveal?: string };
};

test('과제 시안 폴더 계산: 과제 정보가 없거나 이상하면 null', () => {
  assert.equal(DIR, path.join(RUNS, 'drafts', 'm1', 't1'));
  assert.equal(taskDraftsDir(RUNS, 'm1', undefined), null); // 옛 카드
  assert.equal(taskDraftsDir(RUNS, undefined, 't1'), null);
  assert.equal(taskDraftsDir(RUNS, 'm1', '../t2'), null);
  assert.equal(taskDraftsDir(RUNS, '..', 't1'), null);
  assert.equal(taskDraftsDir(RUNS, 'm1', 'a/b'), null);
});

test('옛 카드(과제 정보 없음)는 열지 않음', () => {
  const p = file(DIR, 'old.png');
  const r = checkPreviewFile(p, taskDraftsDir(RUNS, 'm1', undefined));
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /과제 정보를 확인할 수 없어/);
  // 과제 이름 모양이 이상한 경우도 같은 문구
  assert.match((checkPreviewFile(p, taskDraftsDir(RUNS, 'm1', '../t2')) as { message: string }).message, /과제 정보를 확인할 수 없어/);
});

test('정상 그림·PDF·대문자 HTML 은 실제 경로로 열림', () => {
  for (const name of ['a.png', 'b.pdf', 'C.HTML', 'd.md', 'e.docx']) {
    const p = file(DIR, name);
    const r = ok(p);
    assert.deepEqual(r, { ok: true, path: p }, name);
  }
});

test('실행 파일 형식(.command·.COMMAND·.sh·.app 이름 파일·확장자 없음)은 막음', () => {
  for (const name of ['x.command', 'Y.COMMAND', 'z.sh', 'w.terminal', 'v.docm', 'q.app', 'R.APP', 'noext']) { // q.app·R.APP: .app 이름의 보통 파일
    const r = blocked(file(DIR, name));
    assert.match(r.message, /형식/, name);
    assert.ok(r.reveal, '폴더에서 보기 위치를 준다');
  }
});

test('실행 권한이 붙은 html 은 막음', () => {
  const r = blocked(file(DIR, 'run.html', 0o755));
  assert.match(r.message, /실행 권한/);
  assert.equal(r.reveal, path.join(DIR, 'run.html'));
  assert.equal(blocked(file(DIR, 'run2.html', 0o744)).ok, false);
});

test('폴더와 .app 묶음은 막음', () => {
  mkdirSync(path.join(DIR, 'folder.html'), { recursive: true });
  mkdirSync(path.join(DIR, 'Evil.app', 'Contents'), { recursive: true });
  assert.match(blocked(path.join(DIR, 'folder.html')).message, /폴더/);
  assert.match(blocked(path.join(DIR, 'Evil.app')).message, /폴더/);
});

test('시안 폴더 밖을 가리키는 바로가기는 막고, 바로가기 자체를 폴더에서 보여 줌', () => {
  const target = file(OUTSIDE, 'evil.html');
  const link = path.join(DIR, 'nice.html');
  symlinkSync(target, link);
  const r = blocked(link);
  assert.match(r.message, /바로가기/);
  assert.equal(r.reveal, link);
  // 이름은 html 인데 가리키는 것이 실행 파일
  const cmd = file(DIR, 'real.command');
  const link2 = path.join(DIR, 'looks.html');
  symlinkSync(cmd, link2);
  assert.match(blocked(link2).message, /형식/);
});

test('시안 폴더 안을 가리키는 바로가기는 실제 경로로 열림', () => {
  const target = file(DIR, 'inner.png');
  const link = path.join(DIR, 'inner-link.png');
  symlinkSync(target, link);
  assert.deepEqual(ok(link), { ok: true, path: target });
});

test('다른 과제 시안 폴더의 파일은 막음', () => {
  const p = file(OTHER_TASK, 'other.png');
  assert.equal(blocked(p).reveal, DIR); // 이 과제 시안 폴더를 보여 준다
});

test('없는 파일·상대 경로는 막음', () => {
  assert.equal(blocked(path.join(DIR, 'missing.png')).ok, false);
  assert.equal(checkPreviewFile('a.png', DIR).ok, false);
  assert.equal(checkPreviewFile(undefined, DIR).ok, false);
});
