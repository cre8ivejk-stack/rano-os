// 조직 화면 공용 도우미: 경로 줄이기·풀기, 날짜, rano.json 원본 읽기·원자적 저장.
import { existsSync, realpathSync } from 'node:fs';
import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { expandHome } from '../config.js';
import type { RanoConfig, Zone } from '../../shared/types.js';

/** 홈 폴더를 ~ 로 줄인 경로 */
export function shrinkHome(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return '~/' + p.slice(home.length + 1);
  return p;
}

/** rano.json 안의 경로(~, 상대 경로)를 절대 경로로 푼다 */
export function resolveIn(rootDir: string, p: string): string {
  const e = expandHome(p);
  return path.isAbsolute(e) ? path.normalize(e) : path.join(rootDir, e);
}

/** 심볼릭 링크를 풀 수 있으면 풀고, 아니면 그대로 정규화 */
export function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** a 가 b 와 같거나 b 안에 있으면 true */
export function isInside(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** 회사 작업 폴더(~/work) 실제 경로 */
export function workRoot(): string {
  return realOr(path.join(homedir(), 'work'));
}

/** 구역 루트(회사 ~/work, 개인 ~/personal) 실제 경로 */
export function zoneRoot(config: RanoConfig, zone: Zone): string {
  return realOr(config.zones?.[zone]?.root ?? path.join(homedir(), zone === 'personal' ? 'personal' : 'work'));
}

/** 구역 이름과 폴더(~ 로 줄임). 설정에 없으면 회사 ~/work, 개인 ~/personal */
export function zoneText(config: Pick<RanoConfig, 'zones'>): Record<Zone, { label: string; root: string }> {
  const one = (z: Zone) => ({
    label: config.zones?.[z]?.label ?? (z === 'work' ? '회사' : '개인'),
    root: shrinkHome(config.zones?.[z]?.root ?? path.join(homedir(), z)),
  });
  return { work: one('work'), personal: one('personal') };
}

/** ~ 를 구역 루트의 실제 경로 기준으로 풀어 절대 경로로. 상대 경로는 구역 루트 아래로 본다 */
export function zonePath(config: RanoConfig, zone: Zone, p: string): string {
  const e = expandHome(p.trim());
  return path.isAbsolute(e) ? path.normalize(e) : path.join(zoneRoot(config, zone), e);
}

/** 이 맥의 날짜 YYYY-MM-DD */
export function today(): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function configFile(rootDir: string): string {
  return path.join(rootDir, 'config', 'rano.json');
}

/** rano.json 원본을 디스크에서 새로 읽는다(앱이 켜진 뒤 바뀐 내용까지 보려고) */
export async function readRaw(rootDir: string): Promise<any> {
  return JSON.parse(await readFile(configFile(rootDir), 'utf-8'));
}

/** rano.json 을 임시 파일에 쓴 뒤 이름을 바꿔 한 번에 갈아 끼운다(들여쓰기 2칸, 끝에 줄바꿈). */
export async function writeRaw(rootDir: string, raw: unknown): Promise<void> {
  const file = configFile(rootDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/** 파일·폴더가 있는지 (내용은 열지 않음) */
export function exists(p: string): boolean {
  return existsSync(p);
}

/** 표 칸에 넣을 글: 줄바꿈·| 를 정리한다 */
export function cell(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}
