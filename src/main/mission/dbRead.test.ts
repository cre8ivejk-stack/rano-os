// 믿는 미션의 운영 DB 읽기 조회 판단 시험. 정해진 꼴의 psql 읽기만 바로, 나머지는 승인함.
// 실행: npm run build 후 `node --test dist/main/mission/dbRead.test.js`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionConfig } from '../../shared/types.js';
import { isReadOnlyPsql, isReadOnlySql, trustedDbRead, dbReadGuide } from './dbRead.js';

const RO = `PGOPTIONS='-c default_transaction_read_only=on' psql`;
const OPTS = `-X -At -F '|' -U "$POSTGRES_USER" -d "\${POSTGRES_DB:-postgres}"`;

test('DB 읽기: 정해진 꼴의 SELECT 는 바로', () => {
  for (const sql of [
    `select count(*) from oerp_zrer951 where zzequnr = 'ME00038863'`,
    `with lat as (select zzpymon, max(dt) dt from bill_vs_sys_slot group by 1) select * from lat order by 1 desc limit 5;`,
    `select case when a > 0 then 'y' else 'n' end as f, \\"isAdmin\\" from users`,
    `select 'it''s; drop table x' as s`,
    `explain select 1`,
    `show server_version`,
    `select end_date, updated_at, \\"update\\" from t`,
  ]) {
    const cmd = `${RO} ${OPTS} -c "${sql}"`;
    assert.equal(isReadOnlyPsql(cmd), true, cmd);
  }
  assert.equal(isReadOnlyPsql(`${RO} -At -c "select 1" -c "select 2" 2>&1 | head -20`), true);
  assert.equal(isReadOnlyPsql(`${RO} -At -h 127.0.0.1 -v ON_ERROR_STOP=1 -c "select 1" | head -n 5`), true);
});

test('DB 읽기: 읽기 전용 설정이 없거나 꼴이 다르면 승인함', () => {
  for (const cmd of [
    `psql -At -c "select 1"`, // 읽기 전용 설정 없음
    `PGOPTIONS='-c default_transaction_read_only=off' psql -c "select 1"`,
    `${RO} -At -f /tmp/q.sql`,
    `${RO} -At -c "select 1"; rm -rf /app`,
    `${RO} -At -c "select 1" && curl http://x`,
    `${RO} -At -c "select 1" > /tmp/out`,
    `${RO} -At -c "select 1" | sh`,
    `${RO} -At -c "select 1" | head -5 | sh`,
    `${RO} -At -c "select \`id\`"`,
    `${RO} -At -c "select $(id)"`,
    `${RO} -At -c "select 1" -o /tmp/x`,
    `${RO} -h evil.example.com -c "select 1"`,
    `${RO} -U "$POSTGRES_PASSWORD" -c "select 1"`,
    `${RO} -U "$HOME" -c "select 1"`,
    `${RO} -At`, // 문장 없음
    `cd /app && node -e 'require("pg")'`,
    `${RO} -At -c 'select 1'\npsql -c "drop table x"`,
  ]) {
    assert.equal(isReadOnlyPsql(cmd), false, cmd);
  }
});

test('DB 읽기: 쓰기·설정 바꾸기·위험 함수는 승인함', () => {
  for (const sql of [
    `update users set role='admin'`,
    `delete from t`,
    `insert into t values (1)`,
    `select 1; update t set a=1`,
    `set default_transaction_read_only=off`,
    `select set_config('default_transaction_read_only','off',false)`,
    `begin; select 1`,
    `commit`,
    `select pg_terminate_backend(123)`,
    `select pg_sleep(100)`,
    `select nextval('s')`,
    `select lo_import('/etc/passwd')`,
    `select pg_read_file('/etc/passwd')`,
    `select * into newtable from t`,
    `select * from t for update`,
    `explain analyze delete from t`,
    `explain analyze select 1`,
    `copy t to '/tmp/x'`,
    `select 1 -- update`,
    `select /* x */ 1`,
    `\\! id`,
    `select $$x$$`,
    `select 'unterminated`,
    `do $$ begin end $$`,
    `create table x (a int)`,
  ]) {
    assert.equal(isReadOnlySql(sql), false, sql);
  }
});

const mission = (extra: Partial<MissionConfig> = {}): MissionConfig =>
  ({
    id: 'm',
    name: 'm',
    zone: 'work',
    home: '/h',
    targets: ['/r'],
    readonlyRefs: [],
    rulesFiles: [],
    rolesDir: '/h/roles',
    roleDirs: [],
    roles: [],
    reviewerRoles: [],
    stagePolicy: 'approval',
    directWriteDirs: [],
    trustRepo: true,
    dbRead: { tool: 'mcp__srv__run_app_command', apps: ['db-app'] },
    ...extra,
  }) as MissionConfig;

test('DB 읽기: 미션에 지정한 도구·앱·믿는 미션일 때만', () => {
  const ok = { app_name: 'db-app', command: `${RO} -At -c "select 1"`, timeout_seconds: 60 };
  assert.equal(trustedDbRead(mission(), 'mcp__srv__run_app_command', ok), true);
  assert.equal(trustedDbRead(mission(), 'mcp__srv__run_app_command', { ...ok, app_name: 'web-app' }), false);
  assert.equal(trustedDbRead(mission(), 'mcp__other__run_app_command', ok), false);
  assert.equal(trustedDbRead(mission({ trustRepo: false }), 'mcp__srv__run_app_command', ok), false);
  assert.equal(trustedDbRead(mission({ dbRead: undefined }), 'mcp__srv__run_app_command', ok), false);
  assert.equal(trustedDbRead(mission(), 'mcp__srv__run_app_command', { ...ok, env: { X: '1' } }), false);
  assert.equal(trustedDbRead(mission(), 'mcp__srv__run_app_command', { ...ok, command: `${RO} -c "delete from t"` }), false);
  assert.match(dbReadGuide(mission()), /default_transaction_read_only=on/);
  assert.equal(dbReadGuide(mission({ trustRepo: false })), '');
});

test('DB 읽기: 첫 -c 로 읽기 전용을 켜는 꼴도 받음', () => {
  assert.equal(isReadOnlyPsql(`psql -X -At -c "SET default_transaction_read_only=on;" -c "select 1"`), true);
  assert.equal(isReadOnlyPsql(`psql -X -At -c "select 1" -c "SET default_transaction_read_only=on;"`), false);
  assert.equal(isReadOnlyPsql(`psql -X -At -c "SET default_transaction_read_only=on;"`), false);
});
