// 0.9.12 시험: 첫 실사용(2026-11-16)에서 찾은 열 가지
// 실행: npm test (실제 명령은 실행하지 않고 판단만 본다)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ChatMessage, MissionConfig, RanoConfig } from '../../shared/types.js';
import { carryText, CARRY_HEAD, COLD_MS, COLD_TOKENS, RanoContextFile, ROTATE_TOKENS, shouldRotate } from '../engine/ranoCarry.js';
import { classifyBash } from './bashRules.js';
import { buildCarryBlock } from './leaderCarry.js';
import { bashTitle, decideApprovalStage, LeaderGuard, pickWhy } from './leaderPermissions.js';
import { missionTmpDir } from './missionTmp.js';
import { userAskedSync } from './syncIntent.js';
import { taskTitle } from './taskText.js';
import { MissionTracker } from './tracker.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-0912-')));
const TARGET = path.join(ROOT, 'repo');
const HOME = path.join(ROOT, 'home');
for (const d of [path.join(TARGET, 'src'), path.join(TARGET, '.git'), HOME]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(TARGET, 'src', 'a.ts'), 'x');
writeFileSync(path.join(TARGET, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/a.git\n');

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
const actor = { isSubagent: false, teamApproved: true, trustRepo: true };
const stage = (m: MissionConfig, command: string, a = actor) => decideApprovalStage(config, m, 'Bash', { command }, TARGET, a).type;

test('3. 읽기만 하는 git 명령(merge-base 등)은 바로, 믿는 미션의 git add 파일 이름도 바로', () => {
  for (const c of ['git merge-base --is-ancestor abc1234 origin/main', 'git merge-base HEAD origin/main', 'git for-each-ref --format="%(refname)" refs/heads', 'git name-rev HEAD', 'git diff-tree --stat HEAD'])
    assert.equal(stage(trusted, c), 'allow', c);
  assert.equal(stage(base, 'git merge-base HEAD origin/main', { ...actor, trustRepo: false }), 'allow', '믿는 미션이 아니어도 읽기는 바로');
  assert.equal(stage(trusted, 'git add src/a.ts'), 'allow');
  assert.equal(stage(trusted, 'git add src/a.ts && git diff --cached --stat'), 'allow');
  assert.equal(stage(base, 'git add src/a.ts', { ...actor, trustRepo: false }), 'ask', '믿는 미션이 아니면 그대로 묻는다');
  for (const c of ['git add -A', 'git add .', 'git add src', 'git add src/', 'git add -u', 'git add "src/*.ts"', 'git add -p src/a.ts', 'git commit -m x', 'git push origin main', 'git add src/a.ts && git commit -m x', 'git reset --hard', 'git checkout -- src/a.ts'])
    assert.notEqual(stage(trusted, c), 'allow', c);
});

test('4. push 만 하는 카드는 "서버에 올리기", 받아오기를 뜻하는 말 넓히기', () => {
  const title = (command: string) => {
    const b = classifyBash(command, { cwd: TARGET, targets: [TARGET], isBlocked: () => false } as never);
    return bashTitle(trusted, b.kind ?? 'command', b);
  };
  assert.equal(title('git push origin develop'), '시험 커밋을 서버에 올리기(push)');
  assert.equal(title('git push origin develop 2>&1 | tail -5 && git status -sb | head -20'), '시험 커밋을 서버에 올리기(push)');
  assert.equal(title('git commit -m x'), '시험 변경 내용 기록(커밋)');
  assert.equal(title('git commit -m x && git push'), '시험 변경 내용 기록(커밋)');
  assert.equal(userAskedSync('이번수정 바로 dev에 커밋 푸시 해주세요. 원격에 업데이트가 있다면 리베이스후 커밋 푸시 해주세요'), true);
  assert.equal(userAskedSync('커밋하고 푸시해 줘'), false, '받아오기를 말하지 않았으면 그대로');
});

test('7. 카드의 "왜": 명령에 붙인 한국어 설명이 먼저, 영어 혼잣말은 맡은 일로', () => {
  assert.equal(pickWhy('첫 조회가 시간 제한에 걸렸어요', '커밋이 운영 갈래에 들어갔는지 확인', '메뉴 검토'), '커밋이 운영 갈래에 들어갔는지 확인');
  assert.equal(pickWhy('Now find the feature.', undefined, '메뉴 검토'), '맡은 일: 메뉴 검토');
  assert.equal(pickWhy('Now find the feature.', 'Find feature files', '메뉴 검토'), '맡은 일: 메뉴 검토');
  assert.equal(pickWhy('원격보다 9커밋 뒤처져 있어서 받아옵니다', 'pull latest', '받아오기'), '원격보다 9커밋 뒤처져 있어서 받아옵니다');
  assert.equal(pickWhy('', undefined, undefined), '');
});

test('9. 직전 과제 묶음: 없는 인수 메모는 "없음"으로 적는다', () => {
  const input = (exists?: (p: string) => boolean) => ({
    tasks: [{ taskId: 't1', missionId: 'm1', title: '앞 과제', from: 'rano' as const, status: 'done' as const, startedAt: '2026-11-16T01:00:00.000Z', endedAt: '2026-11-16T01:10:00.000Z', leaderReport: '4. 결과: 끝' }],
    messages: [] as ChatMessage[],
    approvals: [],
    draftsDir: (id: string) => path.join(ROOT, 'drafts', id),
    handoffFile: '인수메모.md',
    ...(exists ? { exists } : {}),
  });
  const memo = path.join(ROOT, 'drafts', 't1', '인수메모.md');
  assert.ok(buildCarryBlock(input() as never).includes(`인수 메모: ${memo}`), '확인 함수를 안 주면 예전처럼');
  const none = buildCarryBlock(input((p) => p === path.join(ROOT, 'drafts', 't1')) as never);
  assert.ok(none.includes('인수 메모: 없음') && !none.includes(memo));
  assert.ok(!buildCarryBlock(input(() => false) as never).includes('시안 폴더'), '폴더도 없으면 줄을 뺀다');
  assert.ok(buildCarryBlock(input(() => true) as never).includes(`인수 메모: ${memo}`));
});

test('10. 과제 제목: "○○님 지시:" 머리말을 떼고 웹 주소는 사이트 이름만', () => {
  assert.equal(taskTitle('[커밋·푸시] 홍길동님 지시: 「메뉴 정리」 수정을 develop 에 커밋·푸시하세요.'), '[커밋·푸시] 「메뉴 정리」 수정을 develop 에 커밋·푸시하세요');
  assert.equal(taskTitle('사용자 요청: 메뉴 문서를 정리해 주세요.'), '메뉴 문서를 정리해 주세요');
  assert.equal(taskTitle('알려 주신 주소 http://docs.example.com/index.do?x=1 가 무엇인지 조사'), '알려 주신 주소 docs.example.com 가 무엇인지 조사');
  assert.equal(taskTitle('[검토] 메뉴 구조를 다시 검토해 주세요. 홍길동님 요청이에요.'), '[검토] 메뉴 구조를 다시 검토해 주세요');
});

test('10. 기록 파일: 바로 앞과 같은 상태 줄은 다시 적지 않는다', () => {
  const cfg = { ...config, runsDir: path.join(ROOT, 'runs-ev') } as RanoConfig;
  const t = new MissionTracker(cfg, trusted, () => {});
  const lines = () => {
    try {
      return readFileSync(path.join(cfg.runsDir, 'events.jsonl'), 'utf-8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  t.setQueue([]);
  const a = lines();
  t.setQueue([]);
  t.setQueue([]);
  assert.equal(lines(), a, '같은 상태는 한 번만');
  t.activity('앱', '새 활동');
  assert.ok(lines() > a, '바뀌면 적는다');
});

test('6. 진행 중에 덧붙인 말: 리더가 도구를 쓴 직후에 한 번 받고, 팀원에게는 가지 않는다', async () => {
  const g = new LeaderGuard({ config, mission: trusted, log: () => {} });
  g.setTask({ id: 't1', title: '검토' });
  const post = g.hooks().PostToolUse![0].hooks[0];
  const call = async (agent?: string) =>
    (await post({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: '', cwd: TARGET, session_id: 's', transcript_path: '', ...(agent ? { agent_id: agent } : {}) } as never, 'x', {
      signal: new AbortController().signal,
    })) as { hookSpecificOutput?: { additionalContext?: string } };
  assert.equal((await call()).hookSpecificOutput, undefined, '덧붙인 말이 없으면 아무것도 안 한다');
  g.addUserNote('dev 말고 prd 를 봐라');
  g.addUserNote('  ');
  assert.equal((await call('sub-1')).hookSpecificOutput, undefined, '팀원에게는 전하지 않는다');
  const got = (await call()).hookSpecificOutput?.additionalContext ?? '';
  assert.ok(got.includes('dev 말고 prd 를 봐라') && got.includes('사용자가 이 과제를 하는 도중에 덧붙인 말'));
  assert.equal((await call()).hookSpecificOutput, undefined, '한 번만 전한다');
});

test('2. 미션 임시 폴더 경로', () => {
  assert.ok(missionTmpDir(config, 'm1').startsWith(runsDir));
});

// ---------------- 5. 라노 대화 줄이기 ----------------
const msg = (id: string, role: ChatMessage['role'], text: string, at: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, text, at, ...extra });

test('5. 새 대화로 이을지: 대화가 크거나, 오래 쉬었고 어느 정도 클 때만', () => {
  const now = 1_000_000_000;
  const info = (tokens: number, ago: number, sessionId = 's1') => ({ sessionId, tokens, at: now - ago });
  assert.equal(shouldRotate(null, 's1', now), false);
  assert.equal(shouldRotate(info(ROTATE_TOKENS, 1000), 's1', now), true, '크면 쉬지 않았어도');
  assert.equal(shouldRotate(info(ROTATE_TOKENS - 1, 1000), 's1', now), false);
  assert.equal(shouldRotate(info(COLD_TOKENS, COLD_MS), 's1', now), true, '오래 쉬었고 어느 정도 크면');
  assert.equal(shouldRotate(info(COLD_TOKENS - 1, COLD_MS * 5), 's1', now), false, '작으면 그대로 이어 쓴다');
  assert.equal(shouldRotate(info(COLD_TOKENS, COLD_MS - 1), 's1', now), false);
  assert.equal(shouldRotate(info(ROTATE_TOKENS * 2, 0, 'other'), 's1', now), false, '다른 대화의 기록이면 판단하지 않는다');
  assert.equal(shouldRotate(info(ROTATE_TOKENS * 2, 0), undefined, now), false);
});

test('5. 넘기는 글: 최근 말만, 이번에 답할 말은 빼고, 긴 말은 줄인다', () => {
  const list: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) list.push(msg(`m${i}`, i % 2 ? 'rano' : 'user', `말 ${i}`, `2026-11-16T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}:00.000Z`));
  list.push(msg('long', 'rano', '가'.repeat(5000), '2026-11-16T05:00:00.000Z', { form: 'report', mission: '홈페이지', report: { title: '검토', ok: true } }));
  list.push(msg('lead', 'leader', '리더 말', '2026-11-16T05:01:00.000Z'));
  list.push(msg('now', 'user', '이번에 답할 말', '2026-11-16T05:02:00.000Z'));
  const c = carryText(list, ['now']);
  assert.ok(c.startsWith(CARRY_HEAD));
  assert.ok(!c.includes('이번에 답할 말') && !c.includes('리더 말'));
  assert.ok(c.includes('말 39') && !c.includes('말 10\n'), '최근 24개만');
  assert.ok(c.includes('라노(홈페이지 리더 보고 전달: 검토)') && c.includes('자 생략)'));
  assert.ok(c.length < 30_000);
  assert.equal(carryText([], []), '');
  assert.equal(carryText([msg('now', 'user', 'x', '2026-11-16T05:02:00.000Z')], ['now']), '');
});

test('5. 대화 크기 파일: 저장하고 다시 읽는다', () => {
  const f = RanoContextFile.at(path.join(ROOT, 'ctx-runs'));
  assert.equal(f.load(), null);
  f.save({ sessionId: 's1', tokens: 1234, at: 5 });
  assert.deepEqual(f.load(), { sessionId: 's1', tokens: 1234, at: 5 });
});
