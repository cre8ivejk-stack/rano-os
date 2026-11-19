// 0.9.14 시험: 실사용 둘째 날(2026-11-17)에 남은 승인 카드 원인과 사용량
// 실행: npm test (실제 명령은 실행하지 않고 판단만 본다)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MissionConfig, RanoConfig } from '../../shared/types.js';
import { isConnectorReadTool } from '../connectors/readTools.js';
import { COLD_MESSAGES, COLD_MS, shouldRotate } from '../engine/ranoCarry.js';
import { buildLeaderMaterial, buildLeaderSystemPrompt, MATERIAL_HEAD } from './leaderPrompt.js';
import { decideApprovalStage, ownOutputDirs } from './leaderPermissions.js';
import { taskTitle } from './taskText.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-0914-')));
const TARGET = path.join(ROOT, 'repo');
const HOME = path.join(ROOT, 'home');
const USER_HOME = path.join(ROOT, 'user');
for (const d of [path.join(TARGET, 'src'), path.join(TARGET, '.git'), HOME]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(TARGET, 'src', 'a.ts'), 'x');
writeFileSync(path.join(TARGET, 'a.html'), '<p>x</p>');

const base: MissionConfig = {
  id: 'm1',
  name: '시험',
  zone: 'personal',
  home: HOME,
  targets: [TARGET],
  readonlyRefs: [],
  rulesFiles: [],
  rolesDir: path.join(HOME, 'roles'),
  roleDirs: [],
  roles: ['w'],
  reviewerRoles: [],
  stagePolicy: 'approval',
  directWriteDirs: [],
};
const trusted: MissionConfig = { ...base, trustRepo: true };
const runsDir = path.join(ROOT, 'rano', 'runs');
const config: RanoConfig = {
  rootDir: path.join(ROOT, 'rano'),
  authMethod: 'max',
  models: { rano: 'x', repoLeader: 'x', member: 'x' },
  blocked: ['**/.env'],
  memoryDir: path.join(ROOT, 'rano', 'memory'),
  memoryFiles: [],
  autoCommit: false,
  runsDir,
  missions: [trusted],
  raw: {},
};
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';
const own = ownOutputDirs(TARGET, [SID], USER_HOME, 501);
const actor = { isSubagent: false, teamApproved: true, trustRepo: true, ownOutputs: own };
const stage = (m: MissionConfig, command: string, a: typeof actor | Omit<typeof actor, 'ownOutputs'> = actor, cwd = TARGET) => decideApprovalStage(config, m, 'Bash', { command }, cwd, a).type;
const read = (file: string, a: typeof actor | Omit<typeof actor, 'ownOutputs'> = actor) => decideApprovalStage(config, trusted, 'Read', { file_path: file }, TARGET, a).type;

test('1. 이 리더 대화의 도구 결과 보관 폴더·작업 출력은 읽기만 바로, 다른 대화 것은 그대로', () => {
  const slug = TARGET.replace(/[^a-zA-Z0-9]/g, '-');
  const results = path.join(USER_HOME, '.claude', 'projects', slug, SID, 'tool-results');
  const tasks = path.join('/private/tmp', 'claude-501', slug, SID, 'tasks');
  assert.ok(own.includes(results) && own.includes(tasks), own.join('\n'));
  mkdirSync(results, { recursive: true });
  writeFileSync(path.join(results, 'toolu_1.txt'), 'big');
  assert.equal(read(path.join(results, 'toolu_1.txt')), 'allow');
  assert.equal(read(path.join(tasks, 'b1.output')), 'allow');
  assert.equal(stage(trusted, `head -c 600 ${path.join(results, 'toolu_1.txt')}`), 'allow');
  assert.equal(stage(trusted, `cat ${path.join(tasks, 'b1.output')}; echo done`), 'allow');
  // 다른 대화(사용자의 터미널 등)의 보관 폴더, 대화 기록 파일, 보관 폴더 밖
  const otherDir = path.join(USER_HOME, '.claude', 'projects', slug, OTHER, 'tool-results');
  assert.equal(read(path.join(otherDir, 'x.txt')), 'deny');
  assert.equal(read(path.join(USER_HOME, '.claude', 'projects', slug, `${SID}.jsonl`)), 'deny');
  assert.notEqual(stage(trusted, `cat ${path.join(otherDir, 'x.txt')}`), 'allow');
  // 대화 번호를 모르면(넘기지 않으면) 그대로
  const { ownOutputs: _drop, ...plain } = actor;
  void _drop;
  assert.equal(read(path.join(results, 'toolu_1.txt'), plain), 'deny');
  assert.deepEqual(ownOutputDirs(TARGET, []), []);
  // 보관 폴더 안의 바로가기로 밖을 읽는 우회는 막힌다
  symlinkSync(path.join(ROOT, 'rano'), path.join(results, 'link'));
  assert.equal(read(path.join(results, 'link', 'secret.txt')), 'deny');
  // 쓰기는 그대로 묻는다
  assert.equal(decideApprovalStage(config, trusted, 'Write', { file_path: path.join(results, 'new.txt'), content: 'x' }, TARGET, actor).type, 'ask');
});

test('2. git grep 은 읽기 명령', () => {
  for (const c of ['git grep -n "계통" origin/main -- src | head -20', 'git grep -n -i -E "3g|fade" origin/develop -- docs', 'git grep -c foo'])
    assert.equal(stage(base, c, { ...actor, trustRepo: false }), 'allow', c);
  for (const c of ['git grep --no-index foo /etc', 'git grep -f /etc/passwd', 'git grep --untracked SECRET', 'git grep -O foo', 'git grep --open-files-in-pager=sh foo'])
    assert.notEqual(stage(trusted, c), 'allow', c);
});

test('3. 지금 폴더의 파일을 도는 for 반복(읽기)은 바로, 그 밖의 변수·$( )는 그대로', () => {
  assert.equal(stage(trusted, 'for f in *.html; do echo "== $f"; sed \'s/<[^>]*>/ /g\' "$f" | grep -n "비율" | head -15; done'), 'allow');
  assert.equal(stage(trusted, 'for f in src/*.ts; do wc -l "$f"; done'), 'allow');
  for (const c of [
    'for f in .e*; do cat "$f"; done', // 점 파일
    'for f in ../*; do cat "$f"; done', // 폴더 밖
    'for f in ~/.ssh/*; do cat "$f"; done',
    'for f in /etc/*; do cat "$f"; done',
    'for f in $(ls); do cat "$f"; done',
    'for f in *.html; do cat "$f" > "$f.bak"; done', // 쓰기
    'for f in *.html; do rm "$f"; done',
    'grep -rn "x" $(grep -rl "y" . | head -5)',
  ])
    assert.notEqual(stage(base, c, { ...actor, trustRepo: false }), 'allow', c);
});

test('5. 외부 연결: 상태 보기 도구는 읽기, 실행·바꾸기·비밀은 그대로', () => {
  for (const t of ['get_app_deploy_status', 'get_app_build_status', 'check_run_status', 'get_agent_build_status']) assert.equal(isConnectorReadTool(t), true, t);
  for (const t of ['trigger_app_build', 'run_app_command', 'start_app_endpoint_check', 'update_deploy_status', 'set_deploy_status', 'get_app_env_vars', 'get_secret_status', 'deploy_status', 'get_app_deploy', 'delete_status'])
    assert.equal(isConnectorReadTool(t), false, t);
});

test('과제 제목: "지난 과제(번호)에서 …" 머리말을 뗀다', () => {
  assert.equal(taskTitle('지난 과제(c2226f79)에서 고친 사용패턴 그래프 18개월 변경 파일 45개만 develop에 커밋하고 push해 주세요.'), '고친 사용패턴 그래프 18개월 변경 파일 45개만 develop에 커밋하고 pu…');
  assert.equal(taskTitle('지난 과제(2e5e0b17)에 이어서 진행해 주세요'), '지난 과제에 이어서 진행해 주세요');
  assert.equal(taskTitle('[마무리] 직전 과제(af915087)에서 만든 화면을 커밋해 주세요.'), '[마무리] 만든 화면을 커밋해 주세요');
  assert.equal(taskTitle('지난 과제에서'), '지난 과제에서');
});

test('라노: 크기 기록이 없어도 말이 많고 1시간 넘게 쉬었으면 새 대화로', () => {
  const now = 10 * COLD_MS;
  const at = (ms: number) => new Date(ms).toISOString();
  assert.equal(shouldRotate(null, 's1', now, { lastAt: at(now - COLD_MS), count: COLD_MESSAGES }), true);
  assert.equal(shouldRotate(null, 's1', now, { lastAt: at(now - COLD_MS + 1000), count: COLD_MESSAGES * 3 }), false, '방금 쓰던 대화');
  assert.equal(shouldRotate(null, 's1', now, { lastAt: at(now - COLD_MS * 5), count: COLD_MESSAGES - 1 }), false, '짧은 대화');
  assert.equal(shouldRotate(null, undefined, now, { lastAt: at(0), count: 999 }), false, '이어 쓸 대화가 없음');
  assert.equal(shouldRotate({ sessionId: 'other', tokens: 999_999, at: 0 }, 's1', now, { lastAt: at(0), count: 999 }), true, '다른 대화의 기록이면 말 수로 판단');
  assert.equal(shouldRotate(null, 's1', now, { count: 999 }), false);
});

test('리더 시스템 프롬프트는 미션 기억이 바뀌어도 같고, 미션 자료는 과제 글에 붙는다', () => {
  const input = { mission: trusted, rules: [], charter: '헌장', team: '', roles: [] };
  const a = buildLeaderSystemPrompt({ ...input, memory: [{ name: '코드지도.md', content: 'src/a.ts — 가' }, { name: '진행업무.md', content: '어제 한 일' }] });
  const b = buildLeaderSystemPrompt({ ...input, memory: [{ name: '코드지도.md', content: 'src/b.ts — 나' }, { name: '진행업무.md', content: '오늘 한 일' }] });
  assert.equal(a, b);
  assert.ok(!a.includes('src/a.ts — 가') && a.includes(MATERIAL_HEAD));
  const m = buildLeaderMaterial({ memory: [{ name: '코드지도.md', content: 'src/a.ts — 가' }, { name: '진행업무.md', content: '어제 한 일' }] });
  assert.ok(m.startsWith(MATERIAL_HEAD) && m.includes('src/a.ts — 가') && m.includes('### 진행업무.md\n어제 한 일'), m);
  assert.ok(buildLeaderMaterial({ memory: [] }).includes('(아직 없음'));
});

test('0.9.18: 앱에 딸린 문서용 파이썬으로 시안 폴더 안 스크립트 돌리기는 바로, 코드 넣기·폴더 밖 스크립트는 그대로', () => {
  const py = path.join(config.rootDir, 'tools', 'python', 'bin', 'python3');
  mkdirSync(path.dirname(py), { recursive: true });
  writeFileSync(py, '');
  const TID = '0a1b2c3d-1111-4222-8333-444455556666';
  const drafts = path.join(runsDir, 'drafts', trusted.id, TID);
  mkdirSync(drafts, { recursive: true });
  writeFileSync(path.join(drafts, 'build.py'), 'print(1)');
  writeFileSync(path.join(TARGET, 'make.py'), 'print(1)');
  const a = { ...actor, draftsDir: drafts };
  assert.equal(stage(trusted, `${py} ${path.join(drafts, 'build.py')}`, a), 'allow');
  assert.equal(stage(trusted, `${py} make.py`, a), 'allow');
  assert.notEqual(stage(trusted, `${py} -c "import os"`, a), 'allow');
  assert.notEqual(stage(trusted, `${py} ${path.join(ROOT, 'elsewhere.py')}`, a), 'allow');
  // 다른 곳의 파이썬은 그대로 묻는다
  assert.notEqual(stage(trusted, `${path.join(ROOT, 'other', 'bin', 'python3')} ${path.join(drafts, 'build.py')}`, a), 'allow');
  // 믿는 미션이 아니면 그대로
  assert.notEqual(stage(base, `${py} ${path.join(drafts, 'build.py')}`, a), 'allow');
  // 같은 미션의 다른 과제 결과 폴더 읽기는 전부터 바로 됨
  const prev = path.join(runsDir, 'drafts', trusted.id, '99999999-1111-4222-8333-444455556666');
  mkdirSync(prev, { recursive: true });
  writeFileSync(path.join(prev, '목록.txt'), 'x');
  assert.equal(stage(trusted, `head -15 ${path.join(prev, '목록.txt')}`, a), 'allow');
});
