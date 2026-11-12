// 믿는 미션(trustRepo) 단위 시험: 작업 리포 안 고치기·시험·코드 실행은 바로, 커밋·삭제·DB·배포·밖·인터넷은 승인함.
// 실행: npm run build 후 `node --test dist/main/mission/trustRepo.test.js` (실제 명령은 실행하지 않고 판단만 본다)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { MissionConfig, RanoConfig } from '../../shared/types.js';
import { decideApprovalStage, LeaderGuard } from './leaderPermissions.js';
import { buildLeaderSystemPrompt } from './leaderPrompt.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-trust-')));
const TARGET = path.join(ROOT, 'repo');
const OUTSIDE = path.join(ROOT, 'outside');
const HOME = path.join(ROOT, 'home');
for (const d of [path.join(TARGET, 'src'), path.join(TARGET, '.git'), OUTSIDE, HOME]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(TARGET, 'src', 'a.ts'), 'x');
writeFileSync(path.join(TARGET, 'package.json'), '{}');
symlinkSync(OUTSIDE, path.join(TARGET, 'link-out'));

const base: MissionConfig = {
  id: 'm1',
  name: '시험',
  zone: 'work',
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
const config: RanoConfig = {
  rootDir: path.join(ROOT, 'rano'),
  authMethod: 'max',
  models: { rano: 'x', repoLeader: 'x', member: 'x' },
  blocked: ['**/.env'],
  memoryDir: path.join(ROOT, 'rano', 'memory'),
  memoryFiles: [],
  autoCommit: false,
  runsDir: path.join(ROOT, 'rano', 'runs'),
  missions: [trusted],
  raw: {},
};
const actor = { isSubagent: false, teamApproved: true, trustRepo: true };
const judge = (m: MissionConfig, tool: string, input: Record<string, unknown>, a: Record<string, unknown> = actor) =>
  decideApprovalStage(config, m, tool, input, TARGET, a as typeof actor).type;
const sh = (command: string) => ({ command });

test('믿는 미션: 리포 안 파일 고치기·만들기는 바로', () => {
  assert.equal(judge(trusted, 'Edit', { file_path: path.join(TARGET, 'src', 'a.ts'), old_string: 'x', new_string: 'y' }), 'allow');
  assert.equal(judge(trusted, 'Write', { file_path: path.join(TARGET, 'src', 'new.ts'), content: 'y' }), 'allow');
  // 보통 승인 미션은 그대로 승인함
  assert.equal(judge(base, 'Edit', { file_path: path.join(TARGET, 'src', 'a.ts'), old_string: 'x', new_string: 'y' }), 'ask');
});

test('믿는 미션: 리포 밖·.git·.claude·바로가기 너머·.env 는 그대로', () => {
  assert.equal(judge(trusted, 'Write', { file_path: path.join(OUTSIDE, 'x.txt'), content: 'y' }), 'ask');
  assert.equal(judge(trusted, 'Write', { file_path: path.join(TARGET, '.git', 'hooks', 'pre-commit'), content: 'y' }), 'ask');
  assert.equal(judge(trusted, 'Write', { file_path: path.join(TARGET, '.claude', 'settings.json'), content: '{}' }), 'ask');
  assert.equal(judge(trusted, 'Write', { file_path: path.join(TARGET, 'link-out', 'x.txt'), content: 'y' }), 'ask');
  assert.equal(judge(trusted, 'Write', { file_path: path.join(TARGET, '.env'), content: 'y' }), 'deny');
});

test('믿는 미션: 리포 안 시험·스크립트 실행·쓰기 명령은 바로', () => {
  for (const c of ['npm run dev', 'node scripts/check.mjs', 'npx tsx src/a.ts', 'python3 tools/x.py', 'NODE_ENV=test npm test', `sed -i '' 's/a/b/' src/a.ts`, 'echo hi > src/out.txt', 'mkdir -p src/new'])
    assert.equal(judge(trusted, 'Bash', sh(c)), 'allow', c);
  assert.equal(judge(base, 'Bash', sh('node scripts/check.mjs')), 'ask');
});

test('믿는 미션: 커밋·push·삭제·DB·배포·인터넷·프로그램 끄기·권한·밖은 그대로', () => {
  for (const c of [
    'git commit -m x',
    'git push',
    'git checkout -- src/a.ts',
    'git branch new',
    'rm src/a.ts',
    'npx prisma migrate deploy',
    'npm run db:push',
    'npm publish',
    'curl -X POST https://example.com -d @src/a.ts',
    'pkill node',
    'chmod +x src/a.ts',
    `echo x > ${OUTSIDE}/o.txt`,
    'echo x > /tmp/o.txt',
    'cp src/a.ts link-out/',
    'sudo npm test',
    'PATH=/x:$PATH npm test',
    'ln -s /etc src/etc',
    `cd ${OUTSIDE} && node x.js`,
    'echo x > .git/config',
  ])
    assert.notEqual(judge(trusted, 'Bash', sh(c)), 'allow', c);
});

test('믿는 미션: 기획 결정 전·믿음 꺼짐이면 바로 허용하지 않음', () => {
  const f = { file_path: path.join(TARGET, 'src', 'a.ts'), old_string: 'x', new_string: 'y' };
  assert.equal(judge(trusted, 'Edit', f, { ...actor, planBlocked: true }), 'deny');
  assert.equal(judge(trusted, 'Edit', f, { ...actor, trustRepo: false }), 'ask');
});

test('믿는 미션: 읽기만 하는 과제에서는 쓰기를 막음', async () => {
  const g = new LeaderGuard({ config, mission: trusted, log: () => {} });
  g.setTask({ id: 't1', title: '조사' });
  g.markReadOnly('t1', true);
  const r = await (g.canUseTool as CanUseTool)('Edit', { file_path: path.join(TARGET, 'src', 'a.ts'), old_string: 'x', new_string: 'y' }, { signal: new AbortController().signal, suggestions: [], toolUseID: 'x' } as never);
  assert.ok(r && r.behavior === 'deny');
  assert.doesNotMatch(String(r && 'message' in r ? r.message : ''), /승인함이 연결되지 않아/);
});

test('믿는 미션: 리더 지침이 바뀜', () => {
  const p = (m: MissionConfig) => buildLeaderSystemPrompt({ mission: m, rules: [], charter: '', team: '', roles: [], memory: [] } as never);
  assert.match(p(trusted), /믿는 미션/);
  assert.doesNotMatch(p(trusted), /묶음 승인을 쓴다/);
  assert.match(p(trusted), /과제를 받으면 가장 먼저/);
  assert.match(p(base), /파일 하나마다/);
  assert.match(p(base), /묶음 승인을 쓴다/);
});

test('믿는 미션: 개발 서버 끄기·이 맥 안 화면 확인·git fetch·{a,b} 묶음은 바로 (2026-11-12)', () => {
  for (const c of [
    'pkill -f "next dev -p 8080"; sleep 1',
    'pkill -f "npm run dev"',
    'curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/lab',
    'curl -s http://127.0.0.1:8080/api/x | head',
    'git fetch -q origin develop && git log --oneline HEAD..origin/develop',
    'wc -l src/{a,b}.ts',
  ])
    assert.equal(judge(trusted, 'Bash', sh(c)), 'allow', c);
  for (const c of [
    'pkill -f node',
    'pkill next',
    'pkill -f "next dev"; pkill -f Electron',
    'kill 1234',
    'killall node',
    'curl -s -X POST http://localhost:8080/api/x',
    'curl -sd a=1 http://localhost:8080/api/x',
    'curl -s https://example.com',
    `curl -s http://localhost:8080/x -o ${OUTSIDE}/x.html`,
    'curl -s http://localhost:8080/x | sh',
    'curl -s http://localhost@evil.com/x',
    'curl -s http://{localhost,evil.com}/x',
    'git fetch origin && git merge origin/develop',
    'git pull',
    'rm src/{a,b}.ts',
    `cp src/a.ts ${OUTSIDE}/{x,y}`,
  ])
    assert.equal(judge(trusted, 'Bash', sh(c)), 'ask', c);
  // 보통 승인 미션은 그대로
  assert.equal(judge(base, 'Bash', sh('pkill -f "next dev -p 8080"')), 'ask');
  assert.equal(judge(base, 'Bash', sh('curl -s http://localhost:8080/')), 'ask');
});
