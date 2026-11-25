// 0.9.21 시험: 0.9.20 실사용(2026-11-23~25) 검토에서 나온 것
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MissionConfig, MissionLeaderApi, RanoConfig } from '../../shared/types.js';
import { TodoStore } from '../todo/todoStore.js';
import { MissionDispatcher } from './dispatcher.js';
import { followUpTask } from './followUps.js';
import { taskTitle } from './taskText.js';
import { existsSync, readFileSync } from 'node:fs';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { connectorSends, decideConnectorTool, LeaderGuard, readTailOnly } from './leaderPermissions.js';
import { missionTmpDir } from './missionTmp.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-0921-')));
const TARGET = path.join(ROOT, 'repo');
const HOME = path.join(ROOT, 'home');
const BREW = path.join(ROOT, 'brew', 'bin');
for (const d of [path.join(TARGET, 'src'), path.join(TARGET, 'docs'), path.join(TARGET, '.git'), path.join(TARGET, 'venv', 'bin'), HOME, BREW]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(TARGET, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/a.git\n');
// 가상 환경의 파이썬은 폴더 밖 실제 파이썬을 가리키는 바로가기다
writeFileSync(path.join(BREW, 'python3.12'), '');
writeFileSync(path.join(BREW, 'rm'), '');
symlinkSync(path.join(BREW, 'python3.12'), path.join(TARGET, 'venv', 'bin', 'python'));
symlinkSync(path.join(BREW, 'rm'), path.join(TARGET, 'venv', 'bin', 'python3'));

const trusted: MissionConfig = {
  id: 'm1', name: '시험', zone: 'personal', home: HOME, targets: [TARGET], readonlyRefs: [], rulesFiles: [], rolesDir: path.join(HOME, 'roles'),
  roleDirs: [], roles: ['w'], reviewerRoles: [], stagePolicy: 'approval', directWriteDirs: [], trustRepo: true,
};
const runsDir = path.join(ROOT, 'rano', 'runs');
const config: RanoConfig = {
  rootDir: path.join(ROOT, 'rano'), authMethod: 'max', models: { rano: 'x', repoLeader: 'x', member: 'x' }, blocked: ['**/.env'],
  memoryDir: path.join(ROOT, 'rano', 'memory'), memoryFiles: [], autoCommit: false, runsDir, missions: [trusted], raw: {},
};
const TMP = missionTmpDir(config, 'm1');
const DRAFTS = path.join(runsDir, 'drafts', 'm1');
for (const d of [TMP, DRAFTS]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(TMP, 'show.py'), 'print(1)\n');
writeFileSync(path.join(TMP, 'a.txt'), 'x\n');
const guard = () => {
  const g = new LeaderGuard({ config, mission: trusted, log: () => {} });
  g.setTask({ id: 't1', title: '시험' });
  g.markTeamApproved('t1');
  return g;
};
async function judge(g: LeaderGuard, command: string): Promise<'allow' | 'ask' | 'deny'> {
  const r = await (g.canUseTool as CanUseTool)('Bash', { command }, { signal: new AbortController().signal, suggestions: [], toolUseID: 'x' } as never);
  if (!r || r.behavior === 'allow') return 'allow';
  return 'message' in r && String(r.message).includes('승인함이 연결되지 않아') ? 'ask' : 'deny';
}

test('믿는 미션: 작업 폴더 안 가상 환경 파이썬은 폴더 안 프로그램으로 본다 (이름만 파이썬인 다른 프로그램은 묻는다)', async () => {
  const g = guard();
  for (const c of [
    `venv/bin/python -m pytest -q > ${TMP}/pytest_1.txt 2>&1; tail -3 ${TMP}/pytest_1.txt`,
    `venv/bin/python ${TMP}/show.py`,
    `${TARGET}/venv/bin/python -I ${TMP}/show.py ${TARGET}/docs`,
  ])
    assert.equal(await judge(g, c), 'allow', c);
  // venv/bin/python3 은 rm 을 가리킨다 · 코드를 넣어 돌리기 · 폴더 밖 스크립트는 그대로 묻는다
  for (const c of ['venv/bin/python3 -m pytest', 'venv/bin/python -c "print(1)"', `venv/bin/python ${ROOT}/brew/x.py`, `${BREW}/python3.12 ${TMP}/show.py`]) assert.equal(await judge(g, c), 'ask', c);
});

test('믿는 미션: 임시 폴더에 만든 스크립트를 같은 명령에서 돌리기, 파일 이름 찾기, 이 맥 포트 확인은 바로', async () => {
  const g = guard();
  for (const c of [
    `cd ${TMP} && cat > sim.cjs <<'EOF'\nconsole.log(1)\nEOF\nnode sim.cjs | head -40`,
    'mdfind -name "보고서 2024" 2>/dev/null | head',
    'nc -z -w 2 localhost 5432 && echo open || echo closed',
    'nc -z 127.0.0.1 8080',
  ])
    assert.equal(await judge(g, c), 'allow', c);
  for (const c of [
    `cat > src/new.cjs <<'EOF'\nconsole.log(1)\nEOF\nnode ${TMP}/none.cjs`, // 만든 파일과 다른, 없는 파일
    `mdfind "kMDItemFSName == '*보고서*'c" | head`,
    'mdfind -name x -onlyin /Users',
    'nc -z example.com 80',
    'nc localhost 5432',
    'echo hi | nc -z localhost 5432',
  ])
    assert.equal(await judge(g, c), 'ask', c);
});

test('믿는 미션: 앞으로 감기로만 받기와 일부만 담기는 바로, 다른 과제가 돌면 경고 카드', async () => {
  const g = guard();
  for (const c of ['git merge --ff-only origin/develop && git status -sb | head -1', 'git pull --ff-only', `git apply --cached ${TMP}/a.txt && git diff --cached --stat`]) assert.equal(await judge(g, c), 'allow', c);
  for (const c of ['git merge origin/develop', 'git pull', 'git pull --ff-only evil main', 'git stash', 'git apply x.patch', 'git apply --cached /etc/hosts', 'git merge --ff-only origin/develop && git push', 'git commit -m x'])
    assert.equal(await judge(g, c), 'ask', c);
  const busy = new LeaderGuard({ config, mission: trusted, log: () => {}, others: () => [{ id: 'o1', title: '다른 일' }] });
  busy.setTask({ id: 't1', title: '시험' });
  busy.markTeamApproved('t1');
  assert.equal(await judge(busy, 'git merge --ff-only origin/develop'), 'ask');
});

test('미리 승인받은 push 뒤에 결과만 보는 꼬리를 붙여도 다시 묻지 않는다', () => {
  for (const t of [' 2>&1 | tail -3 && git status -sb | head -1 && git diff --stat | tail -1', ' && git status -sb | head -1', ' 2>&1 | tail -3', '; git log --oneline -3', '']) assert.equal(readTailOnly(t), true, t);
  for (const t of [' --force', ' && git push origin main', ' && rm -rf x', ' > out.txt', ' && git diff --output=x', ' && git status; echo $(whoami)', ' | sh', ' && git log | tee x', ' main'])
    assert.equal(readTailOnly(t), false, t);
});

test('외부 연결: 읽기 이름이라도 보내는 방식이면 묻고, 민감한 읽기는 "쓰기"라고 하지 않는다', () => {
  const cfg = { ...config, connectors: { svc: { label: '서비스' } } } as unknown as RanoConfig;
  const m = { ...trusted, connectors: ['svc'] } as MissionConfig;
  const d = (tool: string, input: Record<string, unknown>) => decideConnectorTool(cfg, m, `mcp__svc__${tool}`, input);
  assert.equal(d('check_app_endpoint', { path_or_url: '/health' })?.type, 'allow');
  assert.equal(d('check_app_endpoint', { path_or_url: '/health', method: 'GET' })?.type, 'allow');
  const post = d('check_app_endpoint', { path_or_url: '/api/run', method: 'POST', request_json: { a: 1 } });
  assert.equal(post?.type, 'ask');
  assert.match(post?.ask?.title ?? '', /서비스에 쓰기/);
  const env = d('get_app_env_vars', { app_name: 'x' });
  assert.equal(env?.type, 'ask');
  assert.match(env?.ask?.title ?? '', /민감한 정보 읽기/);
  assert.match(d('update_app_env_vars', { app_name: 'x' })?.ask?.title ?? '', /에 쓰기/);
  assert.equal(connectorSends({ method: 'get', body: {} }), false);
});

test('나중에 다시 확인: 리더가 예약하면 할 일은 기다리는 중, 그 시각에 같은 업무로 확인 과제가 가고, 앱을 다시 켜도 예약이 남는다', async () => {
  const root = path.join(ROOT, 'follow');
  const mission = { id: 'f1', name: '시험', zone: 'work', home: path.join(root, 'home'), targets: [root], stagePolicy: 'approval' } as unknown as MissionConfig;
  mkdirSync(path.join(mission.home, 'memory'), { recursive: true });
  const cfg = { rootDir: root, runsDir: path.join(root, 'runs'), memoryDir: path.join(root, 'memory'), missions: [mission], autoCommit: false, blocked: [], raw: {} } as unknown as RanoConfig;
  mkdirSync(cfg.memoryDir, { recursive: true });
  const todos = new TodoStore(cfg, () => {});
  const runs: string[] = [];
  let finish: (r: { ok: boolean; report: string; taskId?: string }) => void = () => {};
  const leader: MissionLeaderApi = {
    run: (task) => {
      runs.push(task.text);
      task.onStart?.();
      task.onTask?.(`t-${runs.length}`);
      return new Promise((res) => (finish = res));
    },
    busy: () => false,
  };
  const works = { linkTask: () => {}, byTask: (id: string) => (id.startsWith('t-') ? { id: 'w_1' } : undefined), get: (id?: string | null) => (id ? { id, name: '시험 실행 지켜보기' } : undefined) };
  const make = () => new MissionDispatcher({ config: cfg, leaders: new Map([['f1', leader]]), trackers: new Map(), notifyRano: async () => {}, todos, works });
  const d = make();
  await d.assign('f1', '시험을 시작하고 결과를 확인해 주세요', undefined, false, false, 'w_1');
  const todo = todos.list().find((x) => x.workId === 'w_1')!;
  // 너무 짧은 설명·범위 밖 시간은 받지 않는다
  assert.match(d.scheduleFollowUp('f1', 't-1', 30, '확인'), /조금 더 자세히/);
  assert.match(d.scheduleFollowUp('f1', 't-1', 1, '시험 실행 r-12 가 끝났는지 상태 도구로 확인'), /3분에서 240분/);
  const said = d.scheduleFollowUp('f1', 't-1', 30, '시험 실행 r-12 가 끝났는지 상태 도구로 확인하고, 끝났으면 결과 숫자를 정리');
  assert.match(said, /30분 뒤\)에 다시 확인하도록 예약/);
  finish({ ok: true, report: '시험을 시작했고 30분 뒤 다시 확인해요', taskId: 't-1' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(todos.get(todo.id)?.status, 'hold');
  assert.match(todos.get(todo.id)?.note ?? '', /에 리더가 다시 확인해요/);
  // 앱을 다시 켜도 예약이 남아 있다
  assert.ok(existsSync(path.join(cfg.runsDir, 'missions', 'f1', 'followups.json')));
  const d2 = make();
  const [item] = d2.followUpList('f1');
  assert.equal(item.round, 1);
  assert.equal(item.workId, 'w_1');
  assert.ok(!readFileSync(path.join(cfg.runsDir, 'missions', 'f1', 'followups.json'), 'utf-8').includes('undefined'));
  // 그 시각이 되면 같은 업무·같은 할 일로 확인 과제가 간다
  d.fireFollowUp('f1', item.id);
  assert.equal(runs.length, 2);
  assert.match(runs[1], /예약된 다시 확인 1번째/);
  assert.match(runs[1], /시험 실행 r-12/);
  assert.equal(taskTitle(runs[1]).startsWith('다시 확인:'), true);
  assert.equal(todos.get(todo.id)?.status, 'active');
  assert.equal(d.followUpList('f1').length, 0);
  finish({ ok: true, report: '끝났어요', taskId: 't-2' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(todos.get(todo.id)?.status, 'review');
  // 사용자가 끝낸 일은 다시 확인하지 않는다
  d.scheduleFollowUp('f1', 't-2', 10, '시험 실행 r-12 의 뒤처리가 끝났는지 다시 확인');
  todos.update(todo.id, { status: 'done' }, 'user');
  d.fireFollowUp('f1', d.followUpList('f1')[0].id);
  assert.equal(runs.length, 2);
  assert.match(followUpTask({ id: 'x', dueAt: 0, what: '무엇', round: 3 }), /3번째/);
});
