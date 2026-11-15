// 작업 폴더 뒤처짐 안내 시험 (S6-A, 2026-11-15). 임시 git 폴더만 쓰고 인터넷은 쓰지 않는다
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { behindNotes, formatBehind, gitBehind, whenText } from './gitBehind.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-behind-')));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf-8' });

const ORIGIN = path.join(ROOT, 'origin');
const WORK = path.join(ROOT, 'work');
const FRESH = path.join(ROOT, 'fresh');
const PLAIN = path.join(ROOT, 'plain');
mkdirSync(ORIGIN, { recursive: true });
mkdirSync(PLAIN, { recursive: true });
git(ORIGIN, 'init', '-q');
git(ORIGIN, 'commit', '-q', '--allow-empty', '-m', 'c1');
git(ROOT, 'clone', '-q', ORIGIN, WORK);
git(ORIGIN, 'commit', '-q', '--allow-empty', '-m', 'c2');
git(ORIGIN, 'commit', '-q', '--allow-empty', '-m', 'c3');
git(WORK, 'fetch', '-q', 'origin'); // 받아 두기만(작업 폴더는 그대로)
git(ROOT, 'clone', '-q', ORIGIN, FRESH);

test('S6-A 받아 둔 원격 기록보다 뒤처진 커밋 수와 마지막 받아온 시각', async () => {
  const info = await gitBehind(WORK);
  assert.ok(info);
  assert.equal(info.behind, 2);
  assert.equal(info.ahead, 0);
  assert.equal(info.upstream, 'origin/main');
  assert.ok(info.fetchedAt instanceof Date);
  const line = formatBehind(info) ?? '';
  assert.match(line, /2커밋 뒤처져/);
  assert.match(line, /마지막으로 받아온 때: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(line, /인터넷으로 다시 확인하지 않았/);
});

test('S6-A 뒤처지지 않았거나 git 폴더가 아니면 안내 없음', async () => {
  const fresh = await gitBehind(FRESH);
  assert.equal(fresh?.behind, 0);
  assert.equal(formatBehind(fresh!), null);
  assert.equal(await gitBehind(PLAIN), null);
  const notes = await behindNotes([WORK, FRESH, PLAIN, path.join(ROOT, 'none')]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /작업 폴더 work /);
});

test('S6-A 받아온 기록이 없거나 갈래가 갈라진 경우 문구', () => {
  const now = new Date(2026, 10, 15, 12, 0);
  assert.match(formatBehind({ repo: '/x/app', upstream: 'origin/main', behind: 3, ahead: 1, fetchedAt: null }, now) ?? '', /clone 한 때 기준.*작업 폴더에만 있는 커밋도 1개/);
  assert.equal(whenText(new Date(2026, 10, 12, 9, 5), now), '2026-11-12 09:05, 3일 전');
  assert.equal(whenText(new Date(2026, 10, 15, 11, 30), now), '2026-11-15 11:30, 30분 전');
});
