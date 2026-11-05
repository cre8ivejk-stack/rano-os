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
