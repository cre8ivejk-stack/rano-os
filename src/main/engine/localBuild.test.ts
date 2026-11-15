// 이 맥에서 포장한 새 판 찾기 시험 (0.9.11). 실행: npm test
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findLocalBuild, readBundleInfo, runningBundle, SWAP_SCRIPT } from './localBuild.js';

const ROOT = mkdtempSync(path.join(tmpdir(), 'rano-local-'));
function mkApp(dir: string, id: string, version: string, builtSec: number): string {
  const app = path.join(dir, '라노 OS.app');
  mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<plist><dict>\n<key>CFBundleIdentifier</key>\n    <string>${id}</string>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>`);
  const asar = path.join(app, 'Contents', 'Resources', 'app.asar');
  writeFileSync(asar, 'x');
  utimesSync(asar, builtSec, builtSec);
  return app;
}
const installed = mkApp(path.join(ROOT, 'Applications'), 'local.rano.os', '0.9.10', 1000);
const cur = { bundle: installed, id: 'local.rano.os', version: '0.9.10', builtAt: 1000 * 1000 };

test('번들 정보 읽기·지금 앱 위치', () => {
  assert.deepEqual(readBundleInfo(installed), { id: 'local.rano.os', version: '0.9.10', builtAt: 1000 * 1000 });
  assert.equal(readBundleInfo(path.join(ROOT, 'none.app')), null);
  assert.equal(runningBundle('/Applications/라노 OS.app/Contents/MacOS/라노 OS'), '/Applications/라노 OS.app');
  assert.equal(runningBundle('/x/node_modules/electron/dist/electron'), null);
});

test('더 높은 버전·같은 버전의 더 늦은 포장만 새 판으로 본다', () => {
  const repo = (name: string) => path.join(ROOT, name);
  const out = (name: string) => path.join(repo(name), 'out', '라노 OS-darwin-arm64');
  assert.equal(findLocalBuild([repo('empty')], cur), null);
  mkApp(out('older'), 'local.rano.os', '0.9.9', 5000);
  assert.equal(findLocalBuild([repo('older')], cur), null, '낮은 버전은 권하지 않음');
  mkApp(out('same-old'), 'local.rano.os', '0.9.10', 900);
  assert.equal(findLocalBuild([repo('same-old')], cur), null, '같은 버전·더 이른 포장');
  mkApp(out('other'), 'com.other.app', '9.9.9', 5000);
  assert.equal(findLocalBuild([repo('other')], cur), null, '다른 앱');
  const same = mkApp(out('same-new'), 'local.rano.os', '0.9.10', 2000);
  assert.equal(findLocalBuild([repo('same-new')], cur)?.path, same);
  const newer = mkApp(out('newer'), 'local.rano.os', '0.9.11', 3000);
  const b = findLocalBuild([repo('older'), repo('same-new'), repo('newer')], cur);
  assert.equal(b?.path, newer);
  assert.equal(b?.version, '0.9.11');
  // out 폴더의 앱을 바로 켜 쓰는 중이면 자기 자신은 권하지 않는다
  assert.equal(findLocalBuild([repo('newer')], { ...cur, bundle: newer }), null);
});

test('바꾸는 셸 글: 경로를 글에 끼워 넣지 않고 인자로만 받고, 실패하면 원래 앱을 되돌린다', () => {
  assert.match(SWAP_SCRIPT, /PID="\$1"; SRC="\$2"; DST="\$3"/);
  assert.match(SWAP_SCRIPT, /kill -0 "\$PID"/);
  assert.match(SWAP_SCRIPT, /ditto "\$SRC" "\$DST"/);
  assert.match(SWAP_SCRIPT, /else rm -rf "\$DST"; mv "\$OLD" "\$DST"/);
  assert.ok(!/\$\{/.test(SWAP_SCRIPT));
});
