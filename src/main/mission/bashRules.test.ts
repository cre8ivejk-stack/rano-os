// bashRules 단위 시험. 실행: npm run build 후 `node --test dist/main/mission/bashRules.test.js`
// (실제 명령은 실행하지 않고 분류만 본다)
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyBash, type BashContext } from './bashRules.js';

const HOME = homedir();
const TARGET = path.join(HOME, 'work', 'homepage');
const REF = path.join(HOME, 'work', 'design-guide');

const ctx: BashContext = {
  cwd: TARGET,
  targets: [TARGET],
  readRoots: [TARGET, REF],
  isBlocked: (p) =>
    /(^|\/)\.env(\.[^/]*)?$/.test(p) ||
    p.startsWith(path.join(HOME, '.ssh')) ||
    p.startsWith(path.join(HOME, '.aws')),
};

// [명령, 기대 결과('allow' | 'deny' | 승인함 종류)]
export const CASES: [string, string][] = [
  // 바로 허용(작업 폴더 안 읽기)
  ['git status', 'allow'],
  ['git diff --stat', 'allow'],
  ['git log --oneline -5', 'allow'],
  ['ls -la docs', 'allow'],
  ['cat docs/renewal/README.md | head -20', 'allow'],
  ['wc -l src/app.ts && git rev-parse HEAD', 'allow'],
  // 커밋
  ['git add . && git commit -m "메뉴 문서"', 'commit'],
  ['git push origin main', 'commit'],
  ['git checkout -- docs/a.md', 'commit'],
  ['git reset --hard HEAD~1', 'commit'],
  // 삭제
  ['rm -rf dist', 'delete'],
  ['git rm docs/old.md', 'delete'],
  ['find . -name "*.tmp" -delete', 'delete'],
  ['git clean -fd', 'delete'],
  // DB
  ['psql -c "update users set x=1"', 'db'],
  ['npx prisma migrate dev', 'db'],
  ['npm run db:seed', 'db'],
  // 배포
  ['vercel --prod', 'deploy'],
  ['kubectl apply -f k8s.yaml', 'deploy'],
  ['npm publish', 'deploy'],
  ['docker push repo/app:1', 'deploy'],
  // 파일 바꾸기
  ['echo "x" > docs/new.md', 'write'],
  ['cat a.md >> /tmp/out.md', 'outsideWrite'],
  ['sed -i "" "s/a/b/" docs/a.md', 'write'],
  ['cp docs/a.md ~/Desktop/a.md', 'outsideWrite'],
  ['mv docs/a.md docs/b.md', 'write'],
  ['git log | tee log.txt', 'write'],
  // 그 밖의 명령
  ['npm test', 'command'],
  ['node scripts/check.js', 'command'],
  ['cat /etc/hosts', 'command'],
  ['ls $(npm bin)', 'command'],
  ['cd /tmp && ls', 'command'],
  ['cat <<EOF > x.md\nhi\nEOF', 'write'],
  // 이어 쓴 명령: 가장 엄격한 것
  ['git status; rm -rf node_modules', 'delete'],
  ['git diff && git commit -am wip && git push', 'commit'],
  ['ls | xargs rm', 'delete'],
  ['echo ok && vercel deploy', 'deploy'],
  // 차단 경로
  ['cat .env', 'deny'],
  ['cat ~/.ssh/id_rsa', 'deny'],
  ['grep -r KEY . --include=.env.local', 'deny'],
  ['ls ~/.aws', 'deny'],
  ['git status && cat "$(echo .env)"', 'deny'],
  ['echo "$(cat config/.env.production)"', 'deny'],
];

function label(r: ReturnType<typeof classifyBash>): string {
  return r.decision === 'ask' ? r.kind ?? 'command' : r.decision;
}

for (const [cmd, want] of CASES) {
  test(`${want.padEnd(12)} ${cmd.replace(/\n/g, '⏎')}`, () => {
    const r = classifyBash(cmd, ctx);
    assert.equal(label(r), want, `reasons: ${r.reasons.join('; ')}`);
  });
}

test('차단 경로는 기록용 경로를 남긴다', () => {
  const r = classifyBash('cat ~/.ssh/id_rsa', ctx);
  assert.equal(r.decision, 'deny');
  assert.ok(r.blockedPaths.some((p) => p.endsWith('.ssh/id_rsa')));
});

test('쓰기 대상 경로를 돌려준다', () => {
  const r = classifyBash('echo hi > docs/new.md', ctx);
  assert.deepEqual(r.writePaths, [path.join(TARGET, 'docs/new.md')]);
});

// ---- 2026-11-05 추가: 지문(해시)·정렬 읽기 명령 ----
test('md5·shasum·sort·uniq 읽기는 바로 허용', () => {
  for (const cmd of ['md5 -q docs/a.md', 'shasum -a 256 docs/a.md', 'md5 -q docs/a.md | sort']) {
    assert.equal(classifyBash(cmd, ctx).decision, 'allow', cmd);
  }
});
test('sort -o 는 쓰기라서 승인', () => {
  assert.notEqual(classifyBash("sort -o docs/out.txt docs/a.md", ctx).decision, 'allow');
});
test('md5 로도 비밀 파일은 차단', () => {
  assert.equal(classifyBash("md5 -q .env", ctx).decision, 'deny');
});

// ---- 2026-11-06 추가: 승인이 너무 잦은 읽기·확인 명령 줄이기 ----
const SECRET_DIR = path.join(TARGET, 'secret-zone');
const ctx2: BashContext = {
  ...ctx,
  secretsUnder: (dir) =>
    dir === TARGET ? [path.join(TARGET, '.env'), path.join(SECRET_DIR, 'prod.secret')] : dir.startsWith(SECRET_DIR) ? [path.join(SECRET_DIR, 'prod.secret')] : [],
  allowChecks: true,
};
export const CASES2: [string, string][] = [
  // 읽기 명령은 바로 허용
  ['grep -rn "addMonths" src --include=*.ts | head -20', 'allow'],
  ['grep -n "export function x" -A8 src/lib/a.ts; head -12 src/b.ts', 'allow'],
  ['sed -n 1,80p docs/README.md', 'allow'],
  ['sed -n 30,60p src/a.tsx; grep -n "기준월" docs/x.md | head -30', 'allow'],
  ["sed -e 's/<style>.*<\\/style>//' docs/a.html | head -c 9000", 'allow'],
  ['find src -name "*.ts" | sort', 'allow'],
  ['ls -d node_modules 2>&1; ls node_modules 2>/dev/null | wc -l', 'allow'],
  ['which tsx npx node', 'allow'],
  ['node -v && npm -v', 'allow'],
  ['diff src/a.ts src/b.ts', 'allow'],
  ['for f in src/a.ts src/b.ts; do wc -l $f; done', 'allow'],
  ['grep -c "error TS" /tmp/tc.txt', 'command'], // ctx2 읽기 폴더에 /tmp 없음(앱에서는 임시 폴더 허용)
  // 확인 명령(타입 검사·린트·시험)
  ['npm run typecheck 2>&1 | tail -40; echo "EXIT=${PIPESTATUS[0]}"', 'allow'],
  ['npm test', 'allow'],
  ['npx tsx --test src/lib/a.test.ts 2>&1 | tail -40', 'allow'],
  ['npx eslint --max-warnings=0 src/lib', 'allow'],
  ['npx tsc --noEmit', 'allow'],
  ['npx vitest run', 'allow'],
  // 여전히 승인
  ['npx eslint --fix src', 'command'],
  ['npx tsc', 'command'],
  ['npm run lint:fix', 'command'],
  ['npm ci', 'command'],
  ['npm run test:deploy', 'deploy'],
  ['grep -rn KEY .', 'command'], // 리포 전체에 비밀 파일이 있음
  ['grep -rn KEY secret-zone/sub', 'command'],
  ['cat secret-zone/*', 'command'],
  ['sed -n "s/a/b/w out.txt" docs/a.md', 'command'],
  ['sed "1e rm -rf x" docs/a.md', 'command'],
  ['find . -name "*.ts" -exec cat {} +', 'command'],
  ['find / -name x', 'command'],
  ['grep -n x /etc/hosts', 'command'],
  ['cd /tmp && grep x a.txt', 'command'],
  ['npm run typecheck > /tmp/tc.txt 2>&1', 'outsideWrite'], // 앱에서는 임시 폴더라 허용
  ['echo x>&2', 'allow'],
  ['grep -rln "orderTotal" --include=*.ts --include=*.md -l . | head -30', 'allow'],
  ['grep -rn KEY --include=*.ts --include=prod.* .', 'command'],
  ['grep -rn KEY --exclude=.env* --exclude=prod.secret .', 'allow'],
  ['find docs -type f -exec md5 -q {} \\; | sort | md5 -q', 'allow'],
  ['find . -type f -exec cat {} +', 'command'],
  ['ls eslint.config.* .eslintrc* 2>/dev/null', 'allow'],
  ['cat *.md', 'command'],
  ['git ls-files --others --exclude-standard', 'allow'],
];
for (const [cmd, want] of CASES2) {
  test(`v2 ${want.padEnd(12)} ${cmd}`, () => {
    const r = classifyBash(cmd, ctx2);
    assert.equal(label(r), want, `reasons: ${r.reasons.join('; ')}`);
  });
}
test('확인 명령은 allowChecks 없이는 승인', () => {
  assert.equal(label(classifyBash('npm run typecheck', ctx)), 'command');
});
