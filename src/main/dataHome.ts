// 데이터 폴더(기본 ~/rano) 준비. 프로그램(이 앱)과 사용자 데이터(설정·기억·미션·기록·역할)는 나뉘어 있다.
// 데이터 폴더에 설정 파일이 없으면 처음 쓰는 사람으로 보고, 앱에 들어 있는 기본 틀(defaults/)을 복사한다.
// 이미 있는 파일은 절대 덮어쓰지 않는다.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** 앱에 들어 있는 기본 틀 폴더 (개발 중: app/defaults, 포장 후: app.asar/defaults) */
export function defaultsDir(appPath: string): string {
  return path.join(appPath, 'defaults');
}

function copyMissing(from: string, to: string): number {
  let n = 0;
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) n += copyMissing(src, dst);
    else if (e.isFile() && !existsSync(dst)) {
      copyFileSync(src, dst);
      n++;
    }
  }
  return n;
}

export interface DataHomeResult {
  created: boolean; // 이번에 처음 만들었는지 (처음 쓰는 사람)
  copied: number;
}

/** 데이터 폴더를 준비한다. 설정 파일이 없을 때만 기본 틀을 채운다. 폴더 뼈대는 늘 확인한다. */
export function ensureDataHome(rootDir: string, defaults: string): DataHomeResult {
  const fresh = !existsSync(path.join(rootDir, 'config', 'rano.json'));
  let copied = 0;
  if (fresh && existsSync(defaults)) copied = copyMissing(defaults, rootDir);
  for (const d of ['config', 'memory', 'runs', 'pool/work', 'pool/personal', 'missions/work', 'missions/personal']) {
    mkdirSync(path.join(rootDir, d), { recursive: true });
  }
  return { created: fresh, copied };
}
