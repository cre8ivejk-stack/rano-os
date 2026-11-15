// package.json 스크립트 시험.
// - test: 시험을 한 번에 돌리는 명령이 있고, src/main 아래 시험 파일을 모두 잡는지
// - package:check: 포장 전에 켜진 라노 OS 앱(설치한 앱·out 폴더 앱의 본체와 도우미)을 찾는 패턴이 맞는지
//   (macOS pgrep 은 자기 조상 프로세스를 빼고 찾으므로, 라노 안에서 돌려도 걸리도록 도우미까지 잡아야 한다.
//    맥 파일 이름의 한글은 자모 분해형(NFD)이라 패턴에는 한글을 넣지 않는다.)
// 실행: 빌드 후 `node --test dist/main/admin/packageScripts.test.js`
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..', '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

function checkPattern(): string {
  const m = /spawnSync\('pgrep',\['-f','([^']+)'\]\)/.exec(pkg.scripts['package:check'] ?? '');
  assert.ok(m, 'package:check 안에서 pgrep -f 패턴을 찾지 못함');
  return m[1];
}

test('test 스크립트: 빌드한 뒤 dist/main 아래 시험을 한 번에 돌린다', () => {
  const t = pkg.scripts.test;
  assert.equal(typeof t, 'string');
  assert.match(t, /^tsc -p tsconfig\.json && /);
  assert.match(t, /node --test dist\/main\/\*\/\*\.test\.js$/);
});

test('test 스크립트: src/main 의 시험 파일은 모두 한 단계 폴더 안이라 dist/main/*/*.test.js 에 잡힌다', () => {
  const base = path.join(ROOT, 'src', 'main');
  if (!existsSync(base)) return; // 포장된 앱처럼 src 가 없으면 볼 것이 없음
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.test.ts')) found.push(path.relative(base, full));
    }
  };
  walk(base);
  assert.ok(found.length >= 20, `시험 파일이 너무 적음: ${found.length}`);
  const notCaught = found.filter((f) => f.split(path.sep).length !== 2);
  assert.deepEqual(notCaught, [], 'dist/main/*/*.test.js 에 안 잡히는 위치의 시험 파일');
});

test('package:check 패턴: 한글·역슬래시 없이 pgrep(확장 정규식)과 JS 에서 같은 뜻', () => {
  const p = checkPattern();
  assert.match(p, /^[\x20-\x7e]+$/, '패턴에 한글 등 ASCII 밖 글자가 있음');
  assert.ok(!p.includes('\\'), '패턴에 역슬래시가 있음');
});

const APP = '라노 OS';
const SHOULD_MATCH = [
  `/Applications/${APP}.app/Contents/MacOS/${APP}`,
  `/Applications/${APP}.app/Contents/Frameworks/${APP} Helper.app/Contents/MacOS/${APP} Helper --type=utility`,
  `/Applications/${APP}.app/Contents/Frameworks/${APP} Helper (Renderer).app/Contents/MacOS/${APP} Helper (Renderer) --type=renderer`,
  `/Applications/${APP}.app/Contents/Frameworks/${APP} Helper (GPU).app/Contents/MacOS/${APP} Helper (GPU) --type=gpu-process`,
  `/Users/x/personal/rano-app/out/${APP}-darwin-arm64/${APP}.app/Contents/MacOS/${APP}`,
  `/Users/x/personal/rano-app/out/${APP}-darwin-arm64/${APP}.app/Contents/Frameworks/${APP} Helper (Renderer).app/Contents/MacOS/${APP} Helper (Renderer)`,
];
const SHOULD_NOT_MATCH = [
  '/Users/x/personal/rano-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
  '/Users/x/personal/rano-app/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper',
  '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
  '/Applications/Install macOS Sequoia.app/Contents/MacOS/InstallAssistant',
  '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper',
  `/Applications/${APP}.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
  '/Users/x/rano/app/out/rano.app/Contents/MacOS/rano',
];

test('package:check 패턴: 켜진 라노 OS 앱(설치·out 폴더, 본체·도우미)을 잡는다 — 한글 NFC·NFD 모두', () => {
  const re = new RegExp(checkPattern());
  for (const s of SHOULD_MATCH) {
    for (const form of ['NFC', 'NFD'] as const) {
      const line = s.normalize(form);
      assert.ok(re.test(line), `${form} 에서 못 잡음: ${s}`);
    }
  }
});

test('package:check 패턴: 다른 앱·개발용 Electron·엔진 프로세스는 잡지 않는다', () => {
  const re = new RegExp(checkPattern());
  for (const s of SHOULD_NOT_MATCH) {
    for (const form of ['NFC', 'NFD'] as const) assert.ok(!re.test(s.normalize(form)), `${form} 에서 잘못 잡음: ${s}`);
  }
});

test('package:check 패턴: 확인 명령 자신(node -e·npm 의 sh -c 줄)은 잡지 않는다', () => {
  const re = new RegExp(checkPattern());
  const cmd = pkg.scripts['package:check'];
  assert.ok(!re.test(cmd), 'node -e 글자 자체가 패턴에 걸림');
  assert.ok(!re.test(`sh -c ${cmd}`), 'npm 이 띄우는 sh -c 줄이 패턴에 걸림');
});
