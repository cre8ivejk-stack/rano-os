// 이 맥에서 포장한 새 판으로 바꾸고 다시 켜기 (0.9.11)
// 라노 OS 미션으로 라노 OS 자신을 고칠 때: 리더가 작업 폴더에서 포장(out/…/라노 OS.app)까지 하면,
// 앱이 그 판을 찾아 알려 주고, 사용자가 누르면 앱이 꺼진 뒤 지금 앱 자리에 새 판을 넣고 다시 켠다.
// 인터넷은 쓰지 않는다. 미션 작업 폴더의 out 폴더만 보고, 같은 앱(번들 ID)이고 지금보다 새 판일 때만 권한다.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { compareVersions } from './update.js';

export interface LocalBuild {
  path: string; // 포장된 .app 위치
  version: string;
  builtAt: number; // 포장한 시각(app.asar 수정 시각, 밀리초)
}

/** .app 의 번들 ID·버전·포장 시각. 읽을 수 없으면 null */
export function readBundleInfo(appPath: string): { id: string; version: string; builtAt: number } | null {
  try {
    const plist = readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf-8');
    const val = (key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? '';
    const id = val('CFBundleIdentifier');
    const version = val('CFBundleShortVersionString') || val('CFBundleVersion');
    if (!id || !version) return null;
    const asar = path.join(appPath, 'Contents', 'Resources', 'app.asar');
    const builtAt = statSync(existsSync(asar) ? asar : appPath).mtimeMs;
    return { id, version, builtAt };
  } catch {
    return null;
  }
}

/** 지금 켜진 앱 묶음(.app) 위치: …/라노 OS.app/Contents/MacOS/라노 OS → …/라노 OS.app. 포장된 앱이 아니면 null */
export function runningBundle(exePath: string): string | null {
  const b = path.resolve(exePath, '..', '..', '..');
  return b.endsWith('.app') && path.basename(path.dirname(exePath)) === 'MacOS' ? b : null;
}

/**
 * 미션 작업 폴더들의 out/<이름>-darwin-<arch>/<이름>.app 가운데, 지금 앱과 같은 번들 ID 이고 더 새 판인 것(가장 최근 포장).
 * 새 판: 버전이 더 높거나, 버전이 같고 포장 시각이 지금 앱보다 뒤. 버전이 낮으면 권하지 않는다.
 */
export function findLocalBuild(targets: readonly string[], current: { bundle: string; id: string; version: string; builtAt: number }): LocalBuild | null {
  let best: LocalBuild | null = null;
  for (const t of targets) {
    const out = path.join(t, 'out');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(out).filter((d) => /-darwin-(arm64|x64|universal)$/.test(d));
    } catch {
      continue;
    }
    for (const d of dirs) {
      let apps: string[] = [];
      try {
        apps = readdirSync(path.join(out, d)).filter((a) => a.endsWith('.app'));
      } catch {
        continue;
      }
      for (const a of apps) {
        const p = path.join(out, d, a);
        if (path.resolve(p) === path.resolve(current.bundle)) continue; // out 폴더의 앱을 바로 켜 쓰는 중
        const info = readBundleInfo(p);
        if (!info || info.id !== current.id) continue;
        const cmp = compareVersions(info.version, current.version);
        if (cmp < 0 || (cmp === 0 && info.builtAt <= current.builtAt)) continue;
        if (!best || info.builtAt > best.builtAt) best = { path: p, version: info.version, builtAt: info.builtAt };
      }
    }
  }
  return best;
}

/**
 * 앱이 꺼진 뒤 돌 셸 글: $1 앱 프로세스 번호, $2 새 판(.app), $3 지금 앱 자리(.app).
 * 앱이 꺼지기를 기다렸다가(1분까지) 지금 앱을 옆으로 치우고 새 판을 넣는다. 넣다 실패하면 원래 앱을 되돌린다. 끝나면 앱을 켠다.
 * 경로는 인자로만 받는다(글에 끼워 넣지 않음).
 */
export const SWAP_SCRIPT = [
  'PID="$1"; SRC="$2"; DST="$3"',
  'i=0; while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i+1)); done',
  'kill -0 "$PID" 2>/dev/null && exit 1',
  'sleep 0.5',
  'OLD="$DST.old-$$"',
  'mv "$DST" "$OLD" || { open "$DST"; exit 1; }',
  'if ditto "$SRC" "$DST"; then rm -rf "$OLD"; else rm -rf "$DST"; mv "$OLD" "$DST"; fi',
  'open "$DST"',
].join('\n');
