// 위험 표시(제목·기록용)·앞에 붙인 설정값·카드 제목·비밀 가리기 시험.
// 실행: 빌드 후 `node --test dist/main/mission/bashRisk.test.js` (실제 명령은 실행하지 않고 분류·글만 본다)
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MissionConfig } from '../../shared/types.js';
import { classifyBash, type BashContext, type BashDecision } from './bashRules.js';
import { bashLogTarget, bashTitle, commandForLog, redactCommand } from './leaderPermissions.js';

const HOME = homedir();
const TARGET = path.join(HOME, 'work', 'homepage');
const ctx: BashContext = {
  cwd: TARGET,
  targets: [TARGET],
  readRoots: [TARGET],
  isBlocked: (p) => /(^|\/)\.env(\.[^/]*)?$/.test(p),
  secretsUnder: () => [],
  allowChecks: true,
};
const mission = { id: 'm1', name: '시험 미션', targets: [TARGET] } as unknown as MissionConfig;

const label = (r: BashDecision) => (r.decision === 'ask' ? r.kind ?? 'command' : r.decision);
const titleOf = (cmd: string) => {
  const r = classifyBash(cmd, ctx);
  assert.equal(r.decision, 'ask', `${cmd}: ${r.reasons.join('; ')}`);
  return bashTitle(mission, r.kind ?? 'command', r);
};
const risk = (cmd: string, kind: string) => classifyBash(cmd, ctx).risks?.find((r) => r.kind === kind);

// ---- 4-A: 앞에 붙인 설정값 ----
test('앞에 설정값을 붙인 명령은 바로 허용하지 않는다(최소 일반 명령)', () => {
  const cases: [string, string][] = [
    ["GIT_EXTERNAL_DIFF='pkill -f Electron' git diff", 'command'],
    ['FOO=1 ls', 'command'],
    ['NODE_OPTIONS=--require=./x.js npm test', 'command'],
    ['PAGER=sh git log', 'command'],
    ['time FOO=1 npm test', 'command'],
    ['env FOO=1 ls', 'command'],
    // 원래 승인함(더 엄격한 종류)이던 명령은 그대로
    ['FOO=1 rm -rf dist', 'delete'],
    ['FOO=1 git push origin main', 'commit'],
    ['FOO=1 echo x > docs/a.md', 'write'],
    ['FOO=1 vercel --prod', 'deploy'],
    // 설정값만 있는 줄(변수 지정): 소문자 지역 변수는 예전처럼, 설정값을 바꾸는 줄은 승인함
    ['f=src/a.ts; wc -l $f', 'allow'],
    ['PATH=x; ls', 'command'],
    ['HOME=x; git status', 'command'],
    ['GIT_DIR=/x; git status', 'command'],
    ['DYLD_INSERT_LIBRARIES=x.dylib; ls', 'command'],
    ['Foo=1; ls', 'command'], // 대문자가 든 이름
    ['http_proxy=http://x:1; ls', 'command'], // 소문자지만 위험한 이름
    // zsh 가 대문자 설정값과 묶어 둔 소문자 이름(path=x 는 PATH 를 바꾼다)
    ['path=x; ls', 'command'],
    ['cdpath=/; cd etc && cat passwd', 'command'],
    ['fpath=x; ls', 'command'],
    ['manpath=x; ls', 'command'],
    ['module_path=x; ls', 'command'],
    ['commands=x; ls', 'command'],
    ['g=docs/a.md; cat $g', 'allow'], // 보통 소문자 지역 변수는 그대로(환경 변수와 상관없이)
    ['ls', 'allow'],
    ['git diff', 'allow'],
    ['npm test', 'allow'],
  ];
  for (const [cmd, want] of cases) {
    const r = classifyBash(cmd, ctx);
    assert.equal(label(r), want, `${cmd}: ${r.reasons.join('; ')}`);
  }
  // 근거에는 설정 이름만, 값(명령 글)은 넣지 않는다
  const r = classifyBash("GIT_EXTERNAL_DIFF='pkill -f Electron' git diff", ctx);
  assert.ok(r.reasons.some((x) => x.includes('GIT_EXTERNAL_DIFF')));
  assert.ok(!r.reasons.join(' ').includes('pkill'));
  // 설정값만 바꾸는 줄: 근거에는 이름만
  const p = classifyBash('PATH=/evil/bin; ls', ctx);
  assert.ok(p.reasons.includes('설정값을 바꾼 뒤 실행: PATH'), p.reasons.join('; '));
  assert.ok(!p.reasons.join(' ').includes('/evil'));
});

// ---- 3차: 대괄호·+= 꼴 설정값, 반복 변수 ----
test('대괄호·+= 꼴 설정값과 설정값 이름 반복 변수는 승인함', () => {
  const cmds = [
    "functions[ls]='x; /cat'; ls",
    'commands[ls]=/x/cat; ls',
    'path[1,0]=/x/cat; ls',
    'PATH+=:/x/cat; ls',
    'path+=/x/cat; ls',
    'for PATH in /x; do ls; done',
    'for path in /x; do ls; done',
    'export path=x',
    'typeset path=x; ls',
    'a[1]=/x/cat; ls', // 이름과 상관없이 대괄호 꼴
    'x+=/y; ls', // 이름과 상관없이 += 꼴
    'FOO[1]=x ls', // 앞에 붙인 대괄호 꼴
    'env PATH+=/x ls',
  ];
  for (const cmd of cmds) {
    const r = classifyBash(cmd, ctx);
    assert.equal(r.decision, 'ask', `${cmd}: ${r.reasons.join('; ')}`);
    assert.equal(r.kind, 'command', `${cmd}: ${r.reasons.join('; ')}`);
  }
  // 근거에는 이름만(대괄호 안·값은 넣지 않음)
  const f = classifyBash("functions[ls]='x; /cat'; ls", ctx);
  assert.ok(f.reasons.some((x) => x.includes('functions')), f.reasons.join('; '));
  assert.ok(!f.reasons.join(' ').includes('/cat'), f.reasons.join('; '));
  assert.ok(classifyBash('x+=/y; ls', ctx).reasons.includes('대괄호·+= 꼴로 설정값 바꾸기: x'));
  assert.ok(classifyBash('for PATH in /x; do ls; done', ctx).reasons.includes('반복 변수로 설정값 바꾸기: PATH'));
  assert.ok(classifyBash('for path in /x; do ls; done', ctx).reasons.includes('반복 변수로 설정값 바꾸기: path'));
  // 설정값으로 못 읽은 꼴이 맨 앞이면 basename(cat)으로 줄여 보지 않는다
  assert.ok(classifyBash('a[x=/y/cat docs/a.md', ctx).reasons.includes("명령 이름에 '=' 또는 '[' 가 들어 있음"));
  assert.equal(label(classifyBash('a[x=/y/cat docs/a.md', ctx)), 'command');
  // 소문자 지역 반복 변수는 원래 판단 그대로
  assert.equal(label(classifyBash('for f in src/a.ts src/b.ts; do wc -l $f; done', ctx)), 'allow');
  const g = classifyBash('for f in src/*.ts; do wc -l $f; done', ctx); // 글롭 값은 원래도 "경로를 알 수 없음"으로 승인함
  assert.equal(label(g), 'command', g.reasons.join('; '));
  assert.ok(!g.reasons.some((x) => x.includes('반복 변수')), g.reasons.join('; '));
  assert.ok(g.reasons.includes('변수·확장을 써서 경로를 알 수 없음'), g.reasons.join('; '));
  // 시험 명령 '[' 는 그대로
  assert.equal(label(classifyBash('[ -f docs/a.md ]', ctx)), 'allow');
  assert.equal(label(classifyBash('test -f docs/a.md', ctx)), 'allow');
});

// ---- 4차: 셸 문법 낱말 뒤 설정값, printf -v, awk 대괄호 인자 ----
test('셸 문법 낱말 뒤 설정값·printf -v 는 승인함, 원래 허용이던 것은 그대로', () => {
  const asks = [
    "{ functions[ls]='x'; }; ls",
    'if PATH=/x/bin; then ls; fi',
    '! path=/x; ls',
    'for f in a; do PATH=/x; done; ls',
    'while HOME=/x; do ls; done',
    'if PATH=/x ls; then ls; fi', // 셸 낱말 뒤 설정값+명령(앞에 붙인 설정값 규칙)
    'printf -v PATH /x/bin; ls',
    'printf -vPATH /x; ls',
    "printf -v 'functions[ls]' x; ls",
    "awk '{print}' a[1]=x docs/a.md",
  ];
  for (const cmd of asks) {
    const r = classifyBash(cmd, ctx);
    assert.equal(r.decision, 'ask', `${cmd}: ${r.reasons.join('; ')}`);
    assert.equal(r.kind, 'command', `${cmd}: ${r.reasons.join('; ')}`);
  }
  // 근거: 이름만
  assert.ok(classifyBash('if PATH=/x/bin; then ls; fi', ctx).reasons.includes('설정값을 바꾼 뒤 실행: PATH'));
  assert.ok(classifyBash("{ functions[ls]='x'; }; ls", ctx).reasons.includes('대괄호·+= 꼴로 설정값 바꾸기: functions'));
  assert.ok(classifyBash('if PATH=/x ls; then ls; fi', ctx).reasons.includes('앞에 설정값을 붙여 실행: PATH'));
  assert.ok(classifyBash('printf -vPATH /x; ls', ctx).reasons.includes('printf -v 로 설정값 바꾸기'));
  // 원래 허용이던 것
  for (const cmd of [
    "printf '%s\\n' hi",
    "printf '%s\\n' -v", // 서식 뒤의 -v 는 옵션이 아님
    'if [ -f docs/a.md ]; then cat docs/a.md; fi',
    '{ f=docs/a.md; }; cat $f',
    'if g=docs/a.md; then cat $g; fi',
    "awk '{print}' n=1 docs/a.md",
  ]) {
    const r = classifyBash(cmd, ctx);
    assert.equal(label(r), 'allow', `${cmd}: ${r.reasons.join('; ')}`);
  }
});

// ---- 5차: 설정값만 있는 줄의 리다이렉션 ----
test('설정값만 있는 줄도 리다이렉션 쓰기 표시·차단 경로 검사를 받는다', () => {
  const kinds: [string, string][] = [
    ['g=x > /tmp/a', 'outsideWrite'],
    ['if g=x > /tmp/a; then ls; fi', 'outsideWrite'],
    ['{ g=x > docs/a.md; }', 'write'],
    ['g=docs/a.md; cat $g', 'allow'], // 리다이렉션 없는 소문자 지역 변수는 그대로
  ];
  for (const [cmd, want] of kinds) {
    const r = classifyBash(cmd, ctx);
    assert.equal(label(r), want, `${cmd}: ${r.reasons.join('; ')}`);
  }
  assert.ok(classifyBash('g=x > /tmp/a', ctx).writePaths.includes('/tmp/a'));
  // 다른 구역(앱에서는 구역 denyRead 가 isBlocked 로 들어옴)을 가리키는 읽기·쓰기 리다이렉션은 차단
  const ZONE_TARGET = path.join(HOME, 'personal', 'app');
  const OTHER_ZONE = path.join(HOME, 'work');
  const zoneCtx: BashContext = {
    ...ctx,
    cwd: ZONE_TARGET,
    targets: [ZONE_TARGET],
    readRoots: [ZONE_TARGET],
    isBlocked: (p) => p === OTHER_ZONE || p.startsWith(OTHER_ZONE + path.sep),
  };
  for (const cmd of [
    `g=x < ${path.join(OTHER_ZONE, 'a')}`,
    `if g=x < ${path.join(OTHER_ZONE, 'a')}; then ls; fi`,
    `{ g=x > ${path.join(OTHER_ZONE, 'a')}; }`,
  ]) {
    const r = classifyBash(cmd, zoneCtx);
    assert.equal(r.decision, 'deny', `${cmd}: ${r.reasons.join('; ')}`);
  }
  assert.equal(label(classifyBash('g=x < docs/a.md', zoneCtx)), 'allow'); // 같은 구역 안 읽기는 그대로
});

// ---- 2-A: 위험 표시 ----
test('프로그램 끄기 표시와 끌 대상', () => {
  assert.deepEqual(risk('pkill -f Electron', 'kill')?.targets, ['Electron']);
  assert.deepEqual(risk('kill -9 1234', 'kill')?.targets, ['1234']);
  assert.deepEqual(risk('killall -u jk Dock', 'kill')?.targets, ['Dock']);
  assert.deepEqual(risk('launchctl bootout gui/501/com.x.agent', 'kill')?.targets, ['gui/501/com.x.agent']);
  assert.equal(risk('launchctl list', 'kill'), undefined); // 목록 보기는 끄기가 아님
  assert.deepEqual(risk('launchctl kickstart -k gui/501/com.x.agent', 'kill')?.targets, ['gui/501/com.x.agent']); // 끈 뒤 다시 켜기
  assert.equal(risk('launchctl kickstart gui/501/com.x.agent', 'kill'), undefined); // -k 없으면 켜기만
  assert.equal(risk("sh -c 'launchctl kickstart -k gui/501/com.x'", 'kill')?.program, 'launchctl');
  assert.equal(label(classifyBash('launchctl kickstart -k gui/501/com.x.agent', ctx)), label(classifyBash('launchctl kickstart gui/501/com.x.agent', ctx))); // 판단 종류는 그대로
  assert.deepEqual(risk(`osascript -e 'tell application "Safari" to quit'`, 'kill')?.targets, ['Safari']);
  assert.deepEqual(risk("sh -c 'killall Dock'", 'kill')?.targets, ['Dock']); // 글로 넘긴 명령 안
  assert.deepEqual(risk("GIT_EXTERNAL_DIFF='pkill -f Electron' git diff", 'kill')?.targets, ['Electron']); // 앞에 붙인 설정값 안
  assert.equal(risk('ls | xargs kill', 'kill')?.program, 'kill');
  // 판단(kind)은 그대로 일반 명령
  assert.equal(label(classifyBash('pkill -f Electron', ctx)), 'command');
});

test('인터넷 전송 표시와 호스트', () => {
  assert.deepEqual(risk('curl -s https://api.github.com/repos/x', 'network')?.targets, ['api.github.com']);
  assert.deepEqual(risk('curl -u alice:s3cret https://bob:pw@example.com:8443/x', 'network')?.targets, ['example.com']);
  assert.deepEqual(risk('wget -O out.html example.org/page', 'network')?.targets, ['example.org']);
  assert.deepEqual(risk('nc -z host.example.com 443', 'network')?.targets, ['host.example.com']);
  assert.deepEqual(risk('gh api repos/x/y', 'network')?.targets, ['github.com']);
  assert.deepEqual(risk('openssl s_client -connect mail.example.com:993', 'network')?.targets, ['mail.example.com']);
  assert.equal(risk('openssl dgst -sha256 docs/a', 'network'), undefined); // 내 컴퓨터 안 계산
  assert.equal(risk('ssh host', 'network'), undefined); // ssh·scp·rsync 는 배포로 그대로
  assert.equal(label(classifyBash('ssh host', ctx)), 'deploy');
  assert.equal(label(classifyBash('curl https://x.com', ctx)), 'command');
});

test('코드 실행·권한 바꾸기·공용 임시 폴더·지우기 표시', () => {
  for (const c of ['python3 x.py', 'python3.12 x.py', 'node x.js', 'bash run.sh', 'sh -c "ls"', 'osascript -e 1', 'ruby x.rb', 'npx something']) {
    assert.ok(risk(c, 'code'), c);
  }
  assert.equal(risk('node --test src/a.test.js', 'code'), undefined); // 확인 명령(바로 허용)은 표시 없음
  assert.equal(risk('chmod +x docs/a.command', 'mode')?.addsExec, true);
  assert.equal(risk('chmod 755 docs/a.command', 'mode')?.addsExec, true);
  assert.equal(risk('chmod 644 docs/a.md', 'mode')?.addsExec, undefined);
  assert.equal(risk('chmod -x docs/a.sh', 'mode')?.addsExec, undefined);
  assert.equal(risk('install docs/a docs/b', 'mode')?.addsExec, true); // 기본 755
  assert.equal(risk('install -m 644 docs/a docs/b', 'mode')?.addsExec, undefined);
  assert.deepEqual(risk('echo hi > /tmp/rano-check.txt', 'tmp')?.targets, ['/tmp/rano-check.txt']);
  assert.ok(risk('cp docs/a /private/tmp/b', 'tmp'));
  assert.equal(risk('echo hi > docs/a.md', 'tmp'), undefined);
  assert.deepEqual(risk('rm docs/a.txt docs/b.txt', 'delete')?.targets, [path.join(TARGET, 'docs/a.txt'), path.join(TARGET, 'docs/b.txt')]);
  assert.ok(risk('find . -name "*.tmp" -delete', 'delete'));
  assert.ok(risk('git rm docs/old.md', 'delete'));
});

// ---- 2-A: 카드 제목 ----
test('카드 제목: 쉬운 말 종류 + 대상 이름', () => {
  const cases: [string, string][] = [
    ['chmod +x docs/test-block.command', '실행 권한 붙이기: test-block.command'],
    ['chmod 644 docs/a.md', '파일 권한 바꾸기: a.md'],
    ['echo hi > /tmp/rano-check.txt', '공용 임시 폴더에 쓰기: rano-check.txt'],
    ['pkill -f Electron', '프로그램 끄기: pkill Electron'],
    ["GIT_EXTERNAL_DIFF='pkill -f Electron' git diff", '프로그램 끄기: pkill Electron'],
    [`osascript -e 'tell application "라노 OS" to quit'`, '프로그램 끄기: osascript'],
    ['curl -s -H "Authorization: Bearer abc123" "https://github.com/x?token=xyz"', '인터넷으로 보내기·받기: github.com'],
    ['rm docs/a.txt docs/b.txt docs/c.txt', '파일·폴더 지우기: a.txt 외 2개'],
    ['rm -rf dist', '파일·폴더 지우기: dist'],
    ['find . -name "*.tmp" -delete', '파일·폴더 지우기: find'],
    ['launchctl kickstart -k gui/501/com.x.agent', '프로그램 끄기: launchctl'],
    ['python3 scripts/check.py --key=sk-ant-abcdefghijklmn', '명령 실행: python3'],
    ['npm ci', '명령 실행: npm'],
    ['FOO=1 ls', '명령 실행: ls'],
    ['pkill -f x && curl https://example.com', '프로그램 끄기: pkill x (그 밖에 1가지)'],
    ['git push origin main', '시험 미션 변경 내용 기록(커밋)'],
    ['echo x > docs/new.md', '시험 미션 파일을 명령으로 바꾸기: new.md'],
    ['cp docs/a.md ~/Desktop/a.md', '작업 폴더 밖 파일을 명령으로 바꾸기: a.md'],
    ['vercel --prod', '배포·운영 설정 바꾸기: vercel'],
  ];
  for (const [cmd, want] of cases) assert.equal(titleOf(cmd), want, cmd);
});

test('프로그램 끄기 제목의 대상: 하나뿐인 한 단어(24자 이하 영문 이름·번호)만 보이고, 그 밖은 프로그램 이름만', () => {
  const cases: [string, string][] = [
    ['pkill Electron', '프로그램 끄기: pkill Electron'],
    ['killall Finder', '프로그램 끄기: killall Finder'],
    ['kill -9 12345', '프로그램 끄기: kill 12345'],
    ['pkill -f node_modules.bin-x', '프로그램 끄기: pkill node_modules.bin-x'],
    // 공백 든 -f 패턴은 대상 안 보임 (비밀번호 같은 인자가 섞일 수 있음)
    ["pkill -f 'mysql -u root hunter2'", '프로그램 끄기: pkill'],
    ['pkill -f "Electron Helper"', '프로그램 끄기: pkill'],
    // 경로·대상 둘 이상·24자 넘음·숫자로 시작·무작위 글·한글
    ['pkill -f /Applications/x.app/Contents/MacOS/x', '프로그램 끄기: pkill'],
    ['pkill Electron node', '프로그램 끄기: pkill'],
    ['kill 123 456', '프로그램 끄기: kill'],
    ['pkill abcdefghijklmnopqrstuvwxyz', '프로그램 끄기: pkill'],
    ['pkill 9lives', '프로그램 끄기: pkill'],
    ['pkill aB3xYz9Qw', '프로그램 끄기: pkill'],
    ['killall 라노', '프로그램 끄기: killall'],
  ];
  for (const [cmd, want] of cases) assert.equal(titleOf(cmd), want, cmd);
  for (const bad of ['mysql', 'root', 'hunter2', '-u']) assert.ok(!titleOf("pkill -f 'mysql -u root hunter2'").includes(bad), bad);
});

test('카드 제목에는 경로·인자·토큰이 들어가지 않는다', () => {
  const cmds = [
    'chmod +x /Users/someone/secret-place/test-block.command',
    'echo hi > /tmp/deep/dir/rano-check.txt',
    'pkill -f "Electron --token=ghp_ABCDEFGHIJKLmnopqrstuvwx"',
    'curl -u alice:s3cret -H "Authorization: Bearer abc123" https://bob:hunter2@api.example.com/v1?key=xyz',
    'rm /Users/someone/private/a.txt',
    'python3 -c "import os; print(os.environ[\'TOKEN\'])"',
    'sk=sk-ant-api03-abcdefghijklmnop python3 x.py',
  ];
  for (const c of cmds) {
    const t = titleOf(c);
    for (const bad of ['/', 'Users', 'someone', 'secret-place', 'deep', '-f', 'Electron', 'ghp_', 's3cret', 'alice', 'abc123', 'hunter2', 'bob', 'xyz', 'TOKEN', 'sk-ant', 'import'])
      assert.ok(!t.includes(bad), `${c} → ${t} 에 "${bad}"`);
  }
});

// ---- 3-A: 기록용 대상 칸·가리기 ----
test('기록 대상 칸: 끌 이름·지울 경로·보낼 호스트', () => {
  assert.equal(bashLogTarget(classifyBash('pkill -f Electron', ctx)), '프로그램 끄기(pkill): Electron');
  assert.equal(bashLogTarget(classifyBash('curl https://api.example.com/x', ctx)), '인터넷 전송(curl): api.example.com');
  assert.match(bashLogTarget(classifyBash('rm docs/a.txt', ctx)) ?? '', /^지우기\(rm\): .*work\/homepage\/docs\/a\.txt$/);
  assert.equal(bashLogTarget(classifyBash('python3 x.py', ctx)), undefined);
  assert.equal(bashLogTarget(classifyBash('chmod +x docs/a', ctx)), undefined);
});

test('비밀 가리기: Bearer 짧은 토큰, curl -u, 주소 안 비번, 토큰 모양 글, 비밀번호 옵션', () => {
  const cases: [string, string[]][] = [
    ['curl -H "Authorization: Bearer abc123" https://x.com', ['abc123']],
    ["curl -H 'Authorization: token ghp_short1' https://x.com", ['ghp_short1']],
    ['curl -H "Authorization: Basic dXNlcjpwYXNz" https://x.com', ['dXNlcjpwYXNz']],
    ['curl --oauth2-bearer zz99yy https://x.com', ['zz99yy']],
    ['curl -u alice:s3cret https://x.com', ['alice:s3cret', 's3cret']],
    ['curl --user alice:s3cret https://x.com', ['s3cret']],
    ['git clone https://bob:hunter2@github.com/x/y.git', ['hunter2', 'bob:']],
    ['git clone https://ghp_ABCDEFGHIJKLMNOPQRSTUVWX@github.com/x/y.git', ['ghp_ABCDEFGH']],
    ['echo ghp_ABCDEFGHijklmnop1234', ['ghp_ABCDEFGHijklmnop1234']],
    ['echo github_pat_11ABCDEFG0123456789_abcdefghijklmnop', ['github_pat_11ABC']],
    ['SLACK=xoxb-1234-5678-abcdefgh node x.js', ['xoxb-1234']],
    ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijk python3 x.py', ['sk-ant-api03']],
    ['mysql -psecretpw db', ['secretpw']],
    ['tool --password=pw12345 --token tok98765', ['pw12345', 'tok98765']],
    ['curl -H "X-Api-Key: k3y-value" https://x.com', ['k3y-value']],
    ['curl -H "Cookie: session=abcd1234" https://x.com', ['abcd1234']],
    ['echo QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVuIHNlc2FtZQ', ['QWxhZGRpbjpvcGVuIHNlc2FtZQ']],
  ];
  for (const [cmd, secrets] of cases) {
    const r = redactCommand(cmd);
    for (const s of secrets) assert.ok(!r.includes(s), `${cmd} → ${r}`);
    assert.ok(r.includes('(가림)'), `${cmd} → ${r}`);
  }
  // 보통 명령·경로·UUID 는 그대로
  const keep = [
    'git status --porcelain',
    'mkdir -p docs/x',
    'cat /Users/jk/rano/runs/drafts/rano-os/3da24812-4ada-4cf2-9418-0afd43d23218/a.txt',
    'curl https://github.com/cre8ivejk-stack/rano-os',
    'sort -u docs/a.md',
    'git diff -- src/main/mission/leaderPermissions.ts',
    'wc -l src/main/mission/approvalScope.test.ts src/renderer/approvals.ts',
  ];
  for (const c of keep) assert.equal(redactCommand(c), c);
  // '/' 가 든 글 안의 긴 마디(토큰)는 여전히 가린다
  const tok = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789zz';
  assert.equal(redactCommand(`curl https://x.com/api/${tok}/v1`), 'curl https://x.com/api/(가림)/v1');
  assert.equal(redactCommand(`cat docs/${tok}`), 'cat docs/(가림)');
  // '/' 가 든 비밀(AWS 비밀 키 모양 등)은 통째로 가린다
  const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  for (const c of [`echo ${aws}`, `AWS_SECRET=${aws} aws s3 ls`, `aws configure set x ${aws}`]) {
    const r = redactCommand(c);
    assert.ok(!r.includes('wJalrXUtnFEMI') && !r.includes('K7MDENG') && !r.includes('bPxRfiCY'), `${c} → ${r}`);
  }
  assert.equal(redactCommand(`echo ${aws}`), 'echo (가림)');
  assert.equal(redactCommand('echo abcdefghij+klmnopqrst/uvwxyzabcdefgh12'), 'echo (가림)'); // '+' 가 든 글
  assert.equal(redactCommand('echo abcdefghijklmnopqrst/uvwxyzabcdefgh12=='), 'echo (가림)=='); // 바로 뒤가 '='
  // 상대·절대 경로는 그대로
  for (const c of [
    'cat src/main/mission/leaderPermissions.ts',
    'cat ./src/renderer/orgMissions/missionDocs.ts',
    'ls ~/rano/missions/personal/rano-os/memory/코드지도.md',
    'cat /Users/jk/personal/rano-app/src/main/mission/leaderPermissions.ts',
    'cat src/main/approvals/previewSafety.test.ts',
  ]) assert.equal(redactCommand(c), c);
  // '/' 로 시작해도 무작위 같은 마디가 둘 이상이면 통째로 가린다
  assert.equal(redactCommand('echo /abcDEF12345678901234/XYZabc0987654321qwer'), 'echo (가림)');
  assert.equal(redactCommand('cat /abcDEF12345678901234/XYZabc0987654321qwer'), 'cat (가림)');
  // 절대 경로는 그대로
  for (const c of [
    'cat /Users/jk/personal/rano-app/src/main/mission/leaderPermissions.ts',
    'ls /tmp/rano-test-folder/sub/dir/another/file.txt',
    'cat /Users/jk/rano/runs/drafts/rano-os/3da24812-4ada-4cf2-9418-0afd43d23218/_bundle/src/main/mission/bashRules.ts',
    'ls /Applications/Electron.app/Contents/MacOS/Electron',
  ]) assert.equal(redactCommand(c), c);
});

test('기록용 명령 글은 500자까지', () => {
  const long = `echo ${'가'.repeat(800)}`;
  const t = commandForLog(long);
  assert.ok(t.length <= 500 + '…(줄임)'.length);
  assert.ok(t.endsWith('…(줄임)'));
  assert.equal(commandForLog('ls -la'), 'ls -la');
});

// ---- 11/09: 한 글자 대문자 자리 표시 변수 ----
test('D=폴더; 명령 $D/… 처럼 한 글자 대문자 변수는 소문자 지역 변수처럼 본다', () => {
  const ok = classifyBash(`D=${ctx.targets[0]}/src; cat $D/a.ts; O2=${ctx.targets[0]}; ls $O2`, ctx);
  assert.equal(ok.decision, 'allow', ok.reasons.join('; '));
  // 알려진 설정 이름·두 글자 이상 대문자는 그대로 승인함
  for (const cmd of ['PATH=/evil/bin; ls', 'OUT=/x; ls', 'IFS=/; ls', 'D=$(curl x); cat $D']) {
    assert.notEqual(classifyBash(cmd, ctx).decision, 'allow', cmd);
  }
});
