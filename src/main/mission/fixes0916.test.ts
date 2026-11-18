// 0.9.16 시험: 실사용 셋째 날(2026-11-18) 검토에서 나온 것
// 도구 설명 고정(과제 시작 값), 운영 DB 읽기 꼴(비밀번호 파일), 카드 제목, 라노가 카드·결과 파일 읽기, 업무 방 잇기, 할 일 합치기
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ApprovalRequest, RanoConfig } from '../../shared/types.js';
import { canonTool, stabilizeTools } from '../connectors/stableStdio.js';
import { leadMsgIds } from '../engine/works.js';
import { TodoStore } from '../todo/todoStore.js';
import { classifyBash, type BashContext } from './bashRules.js';
import { isReadOnlyPsql } from './dbRead.js';
import { BACKGROUND_RUN } from './leaderPermissions.js';
import { describePendingCards, readTaskFile } from './ranoPeek.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-0916-')));

test('도구 설명 고정: 순서만 다른 설명은 처음 본 글자 그대로, 뜻이 다르면 새것으로', () => {
  const a = { name: 'get_issue', description: '이슈 읽기', inputSchema: { type: 'object', properties: { fields: { default: 'summary,status,labels', type: 'string' } }, required: ['key', 'fields'] } };
  const b = { name: 'get_issue', description: '이슈 읽기', inputSchema: { properties: { fields: { type: 'string', default: 'labels,summary,status' } }, required: ['fields', 'key'], type: 'object' } };
  assert.equal(JSON.stringify(canonTool(a)), JSON.stringify(canonTool(b)));
  const cache: Record<string, unknown> = {};
  const first = stabilizeTools([a], cache);
  assert.equal(first.changed, true);
  const second = stabilizeTools([b], cache);
  assert.equal(second.changed, false);
  assert.equal(JSON.stringify(second.tools[0]), JSON.stringify(a)); // 적어 둔 글자 그대로
  // 뜻이 달라지면(설명이 바뀜) 새것을 쓰고 적어 둔다
  const c = { ...b, description: '이슈 읽기(새 설명)' };
  const third = stabilizeTools([c], cache);
  assert.equal(third.changed, true);
  assert.equal(third.tools[0], c);
  // 문장 속 쉼표는 목록으로 보지 않는다
  assert.equal(canonTool('b, a 그리고 c'), 'b, a 그리고 c');
  assert.notEqual(JSON.stringify(canonTool({ d: '첫째, 둘째' })), JSON.stringify(canonTool({ d: '둘째, 첫째 ' + 'x y' })));
});

test('운영 DB 읽기 꼴: 비밀번호 파일을 읽어 넘기는 꼴도 글자 그대로만 받는다', () => {
  const RO = `PGOPTIONS='-c default_transaction_read_only=on' psql -X -At -U "$POSTGRES_USER" -d "\${POSTGRES_DB:-postgres}"`;
  for (const ok of [
    `PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" ${RO} -c "select 1"`,
    `PGPASSWORD="$(cat $POSTGRES_PASSWORD_FILE)" ${RO} -c "select 1" 2>&1 | head -5`,
    `PGPASSWORD="\${POSTGRES_PASSWORD:-$(cat "$POSTGRES_PASSWORD_FILE")}" ${RO} -c "select count(*) from t"`,
    `PGPASSWORD="$POSTGRES_PASSWORD" ${RO} -c "select 1"`,
  ])
    assert.equal(isReadOnlyPsql(ok), true, ok);
  for (const bad of [
    `PGPASSWORD="$(cat /etc/passwd)" ${RO} -c "select 1"`,
    `PGPASSWORD="$(cat "$OTHER_FILE")" ${RO} -c "select 1"`,
    `PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE"; id)" ${RO} -c "select 1"`,
    `PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" ${RO} -c "update t set a=1"`,
    `PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" echo x`,
  ])
    assert.equal(isReadOnlyPsql(bad), false, bad);
});

test('카드 제목: 찾는 글자에 deploy 가 있는 읽기 명령은 배포로 보지 않는다', () => {
  const ctx: BashContext = { cwd: ROOT, targets: [ROOT], readRoots: [ROOT], isBlocked: () => false, secretsUnder: () => [], allowChecks: true };
  const r = classifyBash('grep -i -E "cust|deploy|status" package.json | head', ctx);
  assert.ok(!JSON.stringify(r).includes('배포·운영'), JSON.stringify(r).slice(0, 300));
  const d = classifyBash('vercel deploy', ctx);
  assert.ok(JSON.stringify(d).includes('배포·운영'));
});

test('운영 서버에서 뒤에서 돌리기 알아보기', () => {
  for (const s of ['cd /app && (nohup node /tmp/q.js > /tmp/q.out 2>&1 &) ; echo started', 'node q.js &', 'sleep 100 & disown']) assert.ok(BACKGROUND_RUN.test(s), s);
  for (const s of ['cat /tmp/q.out; ps aux | grep -c q', 'a && b', 'psql -c "select 1" 2>&1 | head -5']) assert.ok(!BACKGROUND_RUN.test(s), s);
});

test('라노가 카드 읽기: 결정 카드의 안과 권장안이 글에 나온다', () => {
  const card = {
    id: 'a1', missionId: 'm1', taskId: 't-1', who: '리더', kind: 'decision', title: '정리 방법 고르기', what: '세 가지 안', why: '손이 많이 감', recommendation: 'A안',
    status: 'pending', createdAt: new Date().toISOString(),
    decisionItems: [{ id: '1', question: '어느 안?', recommended: 'A', options: [{ key: 'A', label: '한 번에 정리하기', detail: '빠름' }, { key: 'C', label: '나눠서 정리하기' }] }],
  } as unknown as ApprovalRequest;
  const done = { ...card, id: 'a2', status: 'approved', title: '끝난 카드' } as ApprovalRequest;
  const text = describePendingCards([card, done], { workOf: () => '문서 정리' });
  assert.ok(text.includes('정리 방법 고르기') && text.includes('A안 (권장): 한 번에 정리하기') && text.includes('C안: 나눠서 정리하기') && text.includes('업무: 문서 정리'), text);
  assert.ok(!text.includes('끝난 카드'));
  assert.equal(describePendingCards([done]), '답을 기다리는 카드가 없어요.');
  assert.ok(describePendingCards([card], { missionId: 'other' }).includes('없어요'));
});

test('라노가 과제 결과 파일 읽기: 그 과제 폴더의 글 파일만', () => {
  const runs = path.join(ROOT, 'runs');
  const dir = path.join(runs, 'drafts', 'm1', '0a1b2c3d-1111-4222-8333-444455556666');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '문의메일.txt'), '[제목] 문의드립니다\n본문');
  writeFileSync(path.join(dir, '표.xlsx'), 'PK');
  writeFileSync(path.join(runs, 'secret.txt'), '비밀');
  const list = readTaskFile(runs, '0a1b2c3d');
  assert.ok(list.ok && list.text.includes('문의메일.txt') && list.text.includes('표.xlsx'));
  const got = readTaskFile(runs, '0a1b2c3d', '문의메일.txt');
  assert.ok(got.ok && got.text.includes('[제목] 문의드립니다'));
  assert.equal(readTaskFile(runs, '0a1b2c3d', '표.xlsx').ok, false);
  assert.equal(readTaskFile(runs, '0a1b2c3d', '../../../secret.txt').ok, false);
  assert.equal(readTaskFile(runs, '../..').ok, false);
  assert.equal(readTaskFile(runs, 'deadbeef').ok, false);
});

test('새 업무에 맡기기 직전 말 잇기: 달리지 않은 말만, 보고·틈·다른 업무에서 멈춘다', () => {
  const t = (min: number) => new Date(Date.UTC(2026, 10, 18, 5, min)).toISOString();
  const msgs = [
    { id: 'old', role: 'user', at: t(0) },
    { id: 'rep', role: 'rano', at: t(1), form: 'report' },
    { id: 'u1', role: 'user', at: t(49) },
    { id: 'r1', role: 'rano', at: t(50) },
    { id: 'u2', role: 'user', at: t(53) },
  ];
  assert.deepEqual(leadMsgIds(msgs, ['u2'], () => false), ['u1', 'r1']);
  assert.deepEqual(leadMsgIds(msgs, ['u2'], (id) => id === 'r1'), []);
  // 20분 넘게 벌어지면 멈춘다
  assert.deepEqual(leadMsgIds([{ id: 'a', role: 'user', at: t(0) }, { id: 'b', role: 'user', at: t(40) }, { id: 'c', role: 'user', at: t(41) }], ['c'], () => false), ['b']);
});

test('할 일: 기다리는 중 상태, 업무 방 잇기(앱만), 라노가 읽는 글은 끝난 일을 줄인다', () => {
  const config = { rootDir: ROOT, memoryDir: path.join(ROOT, 'memory'), autoCommit: false, missions: [] } as unknown as RanoConfig;
  const todos = new TodoStore(config, () => {});
  const x = todos.add(null, '담당 부서 문의', 'rano');
  assert.equal(todos.update(x.id, { status: 'hold', note: '담당 부서 답 기다림' }, 'rano').status, 'hold');
  assert.equal(todos.update(x.id, { workId: 'w_1' }, 'rano').workId, undefined); // 라노는 못 잇는다
  assert.equal(todos.update(x.id, { workId: 'w_1' }, 'app').workId, 'w_1');
  assert.ok(todos.describe().includes('[기다리는 중] 담당 부서 문의') && todos.describe().includes('workId: w_1'));
  for (let i = 0; i < 8; i++) {
    const d = todos.add(null, `끝난 일 ${i}`, 'user');
    todos.update(d.id, { status: 'done' }, 'user');
  }
  const text = todos.describe();
  assert.equal((text.match(/\[완료\]/g) ?? []).length, 5);
  assert.ok(text.includes('그 밖에 끝난 일 3개'));
});
