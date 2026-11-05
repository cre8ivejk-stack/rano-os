// 배포용 맥 앱 묶기: (npm run package 뒤에) 앱 전체에 로컬 서명(ad-hoc)을 하고 zip 으로 묶는다.
// 결과: out/rano-os-<버전>-mac-arm64.zip  — GitHub Releases 에 올려 받게 한다.
// Apple 개발자 인증서가 없으므로 받은 사람은 처음 한 번 "그래도 열기"를 눌러야 한다(README 참고).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
const outDir = path.join(root, 'out');
const appDir = path.join(outDir, '라노 OS-darwin-arm64');
const app = path.join(appDir, '라노 OS.app');
if (!existsSync(app)) {
  console.error('포장된 앱이 없어요. 먼저 npm run package 를 실행해 주세요.');
  process.exit(1);
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

console.log('1/3 앱 전체에 로컬 서명(ad-hoc)…');
run('codesign', ['--force', '--deep', '--sign', '-', app]);
run('codesign', ['--verify', '--deep', '--strict', app]);

console.log('2/3 zip 으로 묶기…');
const zip = path.join(outDir, `rano-os-${version}-mac-arm64.zip`);
rmSync(zip, { force: true });
// ditto 는 맥 앱의 링크·권한·서명을 그대로 보존한다
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);

console.log(`3/3 완료: ${path.relative(root, zip)} (${Math.round(statSync(zip).size / 1024 / 1024)}MB)`);
