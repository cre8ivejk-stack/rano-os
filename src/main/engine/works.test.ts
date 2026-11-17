// 업무(대화 방) 시험 (0.9.15)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { userTurnPrompt } from './ranoLanes.js';
import { cleanWorkName, nameFromTask, roomNoteText, WorkStore, WorkTurn } from './works.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'rano-works-'));

test('업무 이름 다듬기', () => {
  assert.equal(cleanWorkName('  「메뉴\n문서 정리」 '), '메뉴 문서 정리');
  assert.equal(cleanWorkName(''), '');
  assert.equal(cleanWorkName(123), '');
  assert.equal(cleanWorkName('가'.repeat(40)).length, 24);
  assert.equal(nameFromTask('[마무리] 로그인 화면 문구를 고쳐 주세요'), '로그인 화면 문구');
  assert.equal(nameFromTask(''), '새 업무');
});

test('업무 만들기·과제와 말 달기·다시 읽기', () => {
  const d = dir();
  let pushed = 0;
  const s = new WorkStore(d, () => pushed++);
  const a = s.create('메뉴 문서 정리', 'm1');
  const b = s.create('로그인 오류', 'm1');
  assert.match(a.id, /^w_[0-9a-f]{8}$/);
  assert.notEqual(a.color, b.color, '잇달아 만든 업무는 색이 다르다');
  s.linkTask(a.id, 't1');
  s.linkTask(a.id, 't1');
  s.linkTask(b.id, 't2');
  s.linkMsgs(a.id, ['u1', 'r1']);
  s.linkMsgs(b.id, ['u1', 'u2']); // u1 은 이미 a 에 달려 옮기지 않는다
  assert.equal(s.byTask('t1')?.id, a.id);
  assert.equal(s.byTask('nope'), undefined);
  assert.equal(s.ofMsg('u1')?.id, a.id);
  assert.deepEqual(s.get(b.id)?.msgIds, ['u2']);
  s.linkMsgs(b.id, ['u1'], true);
  assert.equal(s.ofMsg('u1')?.id, b.id, 'force 면 옮긴다');
  s.linkMsgs('w_none', ['x']);
  assert.ok(pushed >= 6);
  const again = new WorkStore(d);
  assert.deepEqual(again.list().map((w) => w.name), ['메뉴 문서 정리', '로그인 오류']);
  assert.equal(again.byTask('t2')?.id, b.id);
  assert.ok(JSON.parse(readFileSync(path.join(d, 'rano', 'works.json'), 'utf-8')).works.length === 2);
});

test('맡길 업무 정하기: id → 이름(같은 이름은 같은 업무) → 이번 차례의 방 → 지시문 이름', () => {
  const s = new WorkStore(dir());
  const a = s.create('메뉴 문서 정리', 'm1');
  assert.equal(s.resolve({ workId: a.id, workName: '다른 이름', missionId: 'm1', title: 'x' }).id, a.id);
  assert.equal(s.resolve({ workId: 'w_wrong', workName: '메뉴 문서 정리', missionId: 'm1', title: 'x' }).id, a.id, '같은 이름·같은 미션은 같은 업무');
  const other = s.resolve({ workName: '메뉴 문서 정리', missionId: 'm2', title: 'x' });
  assert.notEqual(other.id, a.id, '다른 미션이면 새 업무');
  assert.equal(s.resolve({ missionId: 'm1', fallbackId: a.id, title: 'x' }).id, a.id);
  const made = s.resolve({ missionId: 'm1', fallbackId: null, title: '로그인 화면 문구를 고쳐 주세요' });
  assert.equal(made.name, '로그인 화면 문구');
  assert.equal(s.list().length, 3);
});

test('정리·꺼내기·이름 바꾸기, 새 일이 달리면 다시 꺼낸다', () => {
  const s = new WorkStore(dir());
  const a = s.create('가', 'm1');
  assert.equal(s.archive(a.id, true), true);
  assert.equal(s.get(a.id)?.archived, true);
  assert.equal(s.describe(), '', '정리한 업무는 라노 목록에 없다');
  s.linkTask(a.id, 't9');
  assert.equal(s.get(a.id)?.archived, undefined);
  assert.equal(s.rename(a.id, '  새 이름 '), true);
  assert.equal(s.rename(a.id, '   '), false);
  assert.equal(s.rename('w_none', 'x'), false);
  const text = s.describe(() => ['abcd1234'], () => '시험 미션');
  assert.ok(text.includes(a.id) && text.includes('새 이름') && text.includes('시험 미션') && text.includes('진행 중 abcd1234') && text.includes('workId'), text);
});

test('깨진 저장 파일이어도 빈 목록으로 시작한다', () => {
  const d = dir();
  mkdirSync(path.join(d, 'rano'), { recursive: true });
  writeFileSync(path.join(d, 'rano', 'works.json'), '{ not json');
  assert.deepEqual(new WorkStore(d).list(), []);
});

test('업무 방에서 한 말에는 안내가 붙는다', () => {
  const s = new WorkStore(dir());
  const w = s.create('메뉴 문서 정리', 'm1');
  const note = (id: string) => roomNoteText(s.get(id)!, [{ id: 'task-1', title: '문서 고치기' }], '시험 미션');
  const one = userTurnPrompt([{ id: 'u1', text: '운영 기준으로 봐', attachments: [], at: 0, workId: w.id }], [], note);
  assert.ok(one.startsWith('[앱 안내]') && one.includes(w.id) && one.includes('task-1') && one.includes('tell_running_task') && one.endsWith('운영 기준으로 봐'), one);
  assert.ok(!userTurnPrompt([{ id: 'u1', text: '안녕', attachments: [], at: 0 }], [], note).includes('[앱 안내]'));
  assert.ok(roomNoteText(s.get(w.id)!, []).includes('진행 중인 과제는 없어요'));
  const t = new WorkTurn();
  t.assigned.push('x');
  t.begin(w.id, ['u1']);
  assert.deepEqual([t.workId, t.userIds, t.assigned], [w.id, ['u1'], []]);
});
