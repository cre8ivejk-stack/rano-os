// "이번 과제 동안 다시 묻지 않기" 범위 시험: 명령(Bash)은 매번 묻고, 파일 쓰기(Write·Edit 도구)만 기억한다.
// 실제 승인함(ApprovalQueue)을 임시 폴더에 만들고, 카드가 뜨면 시험이 대신 결정한다. 명령은 실행하지 않고 판단만 본다.
// 실행: 빌드 후 `node --test dist/main/mission/approvalScope.test.js`
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalDecision, ApprovalRequest, MissionConfig, PermissionLogEntry, RanoConfig } from '../../shared/types.js';
import { ApprovalQueue, fileKey, grantKeyFor } from '../approvals/approvalQueue.js';
import { LeaderGuard, rememberScope } from './leaderPermissions.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-scope-')));
const TARGET = path.join(ROOT, 'games');
const HOME = path.join(ROOT, 'mission-home');
mkdirSync(path.join(TARGET, 'keep'), { recursive: true });
mkdirSync(HOME, { recursive: true });

const mission: MissionConfig = {
  id: 'm1',
  name: '시험 미션',
  zone: 'personal',
  home: HOME,
  targets: [TARGET],
  readonlyRefs: [],
  rulesFiles: [],
  rolesDir: path.join(HOME, 'roles'),
  roleDirs: [],
  roles: ['personal-worker'],
  reviewerRoles: [],
  stagePolicy: 'approval',
  directWriteDirs: [],
};
const config: RanoConfig = {
  rootDir: path.join(ROOT, 'rano'),
  authMethod: 'max',
  models: { rano: 'x', repoLeader: 'x', member: 'x' },
  blocked: ['**/.env'],
  memoryDir: path.join(ROOT, 'rano', 'memory'),
  memoryFiles: [],
  autoCommit: false,
  runsDir: path.join(ROOT, 'rano', 'runs'),
  missions: [mission],
  raw: {},
};

// 승인함: 카드가 뜰 때마다 asked 에 담고, next 결정으로 바로 처리한다
const asked: ApprovalRequest[] = [];
let next: ApprovalDecision = { decision: 'approve', rememberFile: true };
const seen = new Set<string>();
let queue!: ApprovalQueue;
queue = new ApprovalQueue({
  config,
  emit: () => {},
  onChange: () => {
    for (const r of queue.list()) {
      if (r.status !== 'pending' || seen.has(r.id)) continue;
      seen.add(r.id);
      asked.push(r);
      const d = next;
      setImmediate(() => queue.decide(r.id, d));
    }
  },
});
const logs: PermissionLogEntry[] = [];

function newGuard(taskId: string): LeaderGuard {
  const g = new LeaderGuard({ config, mission, log: (l) => logs.push(l), approvals: queue });
  g.setTask({ id: taskId, title: '시험 과제' });
  g.agents.set('member-1', 'personal-worker');
  return g;
}
async function run(g: LeaderGuard, tool: string, input: Record<string, unknown>, agentID?: string): Promise<'allow' | 'deny'> {
  const r = await (g.canUseTool as CanUseTool)(tool, input, { signal: new AbortController().signal, suggestions: [], toolUseID: 'x', ...(agentID ? { agentID } : {}) } as never);
  return r?.behavior === 'allow' ? 'allow' : 'deny';
}
const bash = (command: string) => ({ command });

test('명령 카드는 "다시 묻지 않기"를 골라도 기억하지 않는다: 다른 명령·같은 명령 모두 다시 묻는다', async () => {
  for (const agentID of [undefined, 'member-1']) {
    const g = newGuard(agentID ? 't1b' : 't1');
    next = { decision: 'approve', rememberFile: true };
    const n0 = asked.length;
    assert.equal(await run(g, 'Bash', bash('python3 check.py'), agentID), 'allow');
    assert.equal(asked.length, n0 + 1);
    const card = asked[asked.length - 1];
    assert.equal(card.tool, 'Bash');
    assert.equal(card.rememberKey, undefined);
    assert.equal(card.rememberLabel, undefined);
    assert.equal(queue.list().find((r) => r.id === card.id)?.rememberFile, undefined); // 승인 기록에도 기억 표시 없음
    assert.equal(queue.isGranted(agentID ? 't1b' : 't1', `bash:${agentID ? 'personal-worker' : 'm1-leader'}`), false);
    // 다른 명령(pkill) → 다시 승인함
    assert.equal(await run(g, 'Bash', bash('pkill -f Electron'), agentID), 'allow');
    assert.equal(asked.length, n0 + 2);
    assert.equal(asked[asked.length - 1].title, '프로그램 끄기: pkill Electron'); // 대상이 한 단어 이름 하나면 제목에 보임
    // 같은 명령 다시 → 다시 승인함
    assert.equal(await run(g, 'Bash', bash('python3 check.py'), agentID), 'allow');
    assert.equal(asked.length, n0 + 3);
    assert.ok(!logs.some((l) => l.reason.includes('다시 묻지 않기로 승인된 범위: bash:')));
  }
});

test('Write 로 기억한 파일: Write 다시 쓰기는 통과, 같은 파일로 출력하는 명령(echo y > X)은 승인함', async () => {
  const g = newGuard('t2');
  const X = path.join(TARGET, 'keep', 'x.md');
  next = { decision: 'approve', rememberFile: true };
  const n0 = asked.length;
  assert.equal(await run(g, 'Write', { file_path: X, content: 'a' }), 'allow');
  assert.equal(asked.length, n0 + 1);
  assert.equal(asked[n0].tool, 'Write');
  assert.equal(asked[n0].rememberKey, fileKey(X));
  assert.equal(queue.isFileGranted('t2', X), true);
  assert.equal(await run(g, 'Write', { file_path: X, content: 'b' }), 'allow');
  assert.equal(asked.length, n0 + 1); // 카드 없이 통과
  assert.match(logs[logs.length - 1].reason, /다시 묻지 않기로 승인된 범위: file:/);
  assert.equal(logs[logs.length - 1].command, undefined); // Write 기록에는 명령 칸 없음
  // 명령은 파일 기억이 있어도 다시 묻는다
  next = { decision: 'reject', note: '시험' };
  assert.equal(await run(g, 'Bash', bash(`echo y > ${X}`)), 'deny');
  assert.equal(asked.length, n0 + 2);
  const card = asked[n0 + 1];
  assert.equal(card.kind, 'write');
  assert.equal(card.tool, 'Bash');
  assert.equal(card.rememberKey, undefined);
  assert.equal(await run(g, 'Bash', bash(`pkill -f x > ${X}`)), 'deny');
  assert.equal(asked.length, n0 + 3);
  // 팀원도 같음
  assert.equal(await run(g, 'Bash', bash(`echo y > ${X}`), 'member-1'), 'deny');
  assert.equal(asked.length, n0 + 4);
});

test('rememberScope: Bash 는 어떤 종류든 범위 없음, Write·Edit 는 파일, 외부 연결은 도구', () => {
  const who = { label: '팀원', logName: 'personal-worker' };
  const X = path.join(TARGET, 'keep', 'x.md');
  for (const kind of ['command', 'write', 'outsideWrite', 'delete', 'commit'] as const) {
    assert.equal(rememberScope({ kind, title: 't', what: 'w', filePath: X, bash: true }, 'Bash', who), null, kind);
    assert.equal(rememberScope({ kind, title: 't', what: 'w', filePath: X }, 'Bash', who), null, kind);
  }
  assert.equal(rememberScope({ kind: 'write', title: 't', what: 'w', filePath: X }, 'Write', who)?.key, fileKey(X));
  assert.equal(rememberScope({ kind: 'outsideWrite', title: 't', what: 'w', filePath: X }, 'Edit', who)?.key, fileKey(X));
  assert.equal(rememberScope({ kind: 'external', title: 't', what: 'w' }, 'mcp__wiki__create_page', who)?.key, 'ext:mcp__wiki__create_page');
});

test('승인함 쪽: Bash 요청은 rememberKey 없이도 파일 열쇠를 만들지 않고, 예전 bash: 범위도 기억하지 않는다', async () => {
  const X = path.join(TARGET, 'keep', 'q.md');
  assert.equal(grantKeyFor({ tool: 'Bash', kind: 'write', filePath: X }), undefined);
  assert.equal(grantKeyFor({ tool: 'Bash', kind: 'outsideWrite', filePath: X }), undefined);
  assert.equal(grantKeyFor({ tool: 'Bash', kind: 'command', rememberKey: 'bash:x' }), undefined);
  assert.equal(grantKeyFor({ kind: 'command', rememberKey: 'bash:x' }), undefined);
  assert.equal(grantKeyFor({ tool: 'Write', kind: 'write', filePath: X }), fileKey(X));
  assert.equal(grantKeyFor({ tool: 'Edit', kind: 'outsideWrite', filePath: X }), fileKey(X));
  // rememberKey 없이 filePath 로 열쇠를 만드는 대체 규칙은 Write·Edit 류 도구 요청에만
  assert.equal(grantKeyFor({ kind: 'write', filePath: X }), undefined); // 도구 표시 없는 요청은 기억하지 않음
  assert.equal(grantKeyFor({ tool: 'mcp__wiki__create_page', kind: 'write', filePath: X }), undefined);
  // 외부 연결 도구는 rememberKey 가 있으면 그 열쇠로 기억한다
  assert.equal(grantKeyFor({ tool: 'mcp__wiki__create_page', kind: 'external', rememberKey: 'ext:mcp__wiki__create_page' }), 'ext:mcp__wiki__create_page');
  assert.equal(grantKeyFor({ tool: 'Write', kind: 'write', filePath: X, rememberKey: fileKey(X) }), fileKey(X));
  // 실제 승인: Bash 쓰기 요청을 "다시 묻지 않기"로 승인해도 기억 없음
  const q = new ApprovalQueue({ config: { ...config, runsDir: path.join(ROOT, 'runs-q') }, emit: () => {} });
  const p = q.request({ missionId: 'm1', taskId: 'tq', who: '팀원', kind: 'write', title: 't', what: 'w', why: '', recommendation: '', filePath: X, tool: 'Bash' });
  const id = q.list()[0].id;
  q.decide(id, { decision: 'approve', rememberFile: true });
  const d = await p;
  assert.equal(d.rememberFile, undefined);
  assert.equal(q.isFileGranted('tq', X), false);
  assert.equal(q.list()[0].rememberFile, undefined);
});

test('휴대폰 승인(텔레그램 버튼)은 기억을 만들지 않는다', async () => {
  const X = path.join(TARGET, 'keep', 'phone.md');
  const q = new ApprovalQueue({ config: { ...config, runsDir: path.join(ROOT, 'runs-p') }, emit: () => {} });
  // 텔레그램 승인 버튼과 같은 호출: decide(id, { decision: 'approve' })
  const p = q.request({ missionId: 'm1', taskId: 'tp', who: '팀원', kind: 'write', title: 't', what: 'w', why: '', recommendation: '', filePath: X, tool: 'Write', rememberKey: fileKey(X) });
  q.decide(q.list()[0].id, { decision: 'approve' });
  assert.equal((await p).rememberFile, undefined);
  assert.equal(q.isFileGranted('tp', X), false);
  // telegram.ts 의 승인 버튼은 rememberFile 없이 승인만 한다(코드가 그대로인지)
  const src = readFileSync(fileURLToPath(new URL('../../../src/main/mobile/telegram.ts', import.meta.url)), 'utf-8');
  assert.match(src, /this\.deps\.approvals\.decide\(id, \{ decision: 'approve' \}\)/);
  assert.ok(!src.includes('rememberFile'));
});

test('화면(승인함 카드): Bash 요청이면 체크 칸을 띄우지 않는다', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../src/renderer/approvals.ts', import.meta.url)), 'utf-8');
  assert.match(src, /const bashRequest = a\.tool === 'Bash' \|\| !!a\.rememberKey\?\.startsWith\('bash:'\);/);
  assert.match(src, /const rememberText = bashRequest \? '' :/);
  // 화면도 filePath 만으로 체크 칸을 띄우는 것은 Write·Edit 류 도구 요청만(grantKeyFor 와 같은 기준)
  assert.match(src, /fileTool && a\.filePath/);
});

test('Bash 판단이면 요청 tool 칸은 Bash, 자세히의 판단 근거도 비밀을 가린다', async () => {
  const g = newGuard('t6');
  next = { decision: 'reject', note: '시험' };
  const n0 = asked.length;
  assert.equal(await run(g, 'Bash', bash('python3 check.py')), 'deny');
  assert.equal(asked.length, n0 + 1);
  assert.equal(asked[n0].tool, 'Bash');
  // 판단 근거(자세히)에도 비밀 값이 남지 않는다
  // (npm 은 근거에 "npm + 앞 인자 2개"가 들어간다)
  assert.equal(await run(g, 'Bash', bash('npm --token tok98765secret')), 'deny');
  const card = asked[asked.length - 1];
  const why = (card.detail ?? '').split('\n').find((l) => l.startsWith('판단 근거:')) ?? '';
  assert.match(why, /npm --token \(가림\)/, String(card.detail));
  assert.ok(!(card.detail ?? '').includes('tok98765secret'), String(card.detail));
});

test('기록: 카드가 뜬 명령은 가린 명령 글과 대상 칸을 남긴다', async () => {
  const g = newGuard('t4');
  next = { decision: 'reject', note: '시험' };
  const last = () => logs[logs.length - 1];
  assert.equal(await run(g, 'Bash', bash('pkill -f Electron')), 'deny');
  assert.equal(last().command, 'pkill -f Electron');
  assert.equal(last().target, '프로그램 끄기(pkill): Electron');
  assert.match(last().reason, /^사용자 반려\(/);
  assert.equal(await run(g, 'Bash', bash('curl -u alice:s3cret -H "Authorization: Bearer abc123" https://bob:hunter2@api.example.com/x')), 'deny');
  for (const s of ['s3cret', 'abc123', 'hunter2']) assert.ok(!last().command!.includes(s), String(last().command));
  assert.equal(last().target, '인터넷 전송(curl): api.example.com');
  next = { decision: 'approve' };
  assert.equal(await run(g, 'Bash', bash(`rm ${path.join(TARGET, 'keep', 'gone.md')}`)), 'allow');
  assert.match(last().target ?? '', /^지우기\(rm\): .*games\/keep\/gone\.md$/);
  assert.match(last().reason, /^사용자 승인\(/);
  assert.equal(await run(g, 'Bash', bash('python3 x.py')), 'allow');
  assert.equal(last().command, 'python3 x.py');
  assert.equal(last().target, undefined);
  assert.equal(await run(g, 'Bash', bash(`python3 -c "print(1)" ${'가 '.repeat(400)}`)), 'allow');
  assert.ok(last().command!.endsWith('…(줄임)'));
  assert.ok(last().command!.length <= 500 + '…(줄임)'.length);
  // 바로 허용된 읽기 명령은 예전처럼 명령 칸 없음
  assert.equal(await run(g, 'Bash', bash('ls')), 'allow');
  assert.equal(last().command, undefined);
});

test('앞에 설정값을 붙인 명령은 승인함(문지기에서)', async () => {
  const g = newGuard('t5');
  next = { decision: 'reject' };
  const n0 = asked.length;
  assert.equal(await run(g, 'Bash', bash("GIT_EXTERNAL_DIFF='pkill -f Electron' git diff")), 'deny');
  assert.equal(await run(g, 'Bash', bash('FOO=1 ls')), 'deny');
  assert.equal(asked.length, n0 + 2);
  assert.equal(asked[n0].title, '프로그램 끄기: pkill Electron');
  assert.equal(asked[n0].kind, 'command');
  assert.equal(asked[n0 + 1].title, '명령 실행: ls');
  assert.equal(await run(g, 'Bash', bash('ls')), 'allow');
  assert.equal(asked.length, n0 + 2); // 설정값 없으면 예전처럼 바로
});
