// 처음 켰을 때 안내(설정 마법사)의 본체.
// 사용자 정보는 기억 me.md 에, 구역 폴더는 rano.json zones 에 저장한다. 끝나면 rano.json setup.done = true.
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MemoryServiceApi, RanoConfig, SetupInput, SetupStatus, Zone } from '../shared/types.js';
import { expandHome } from './config.js';
import { isBlockedPath } from './engine/permissions.js';
import { isInside, readRaw, realOr, shrinkHome, writeRaw, zoneText } from './admin/paths.js';

const ME_FIELDS = { name: '이름', callName: '부르는 호칭', org: '소속', job: '직무', devLevel: '개발 경험' } as const;
type MeKey = keyof typeof ME_FIELDS;

const DEV_LEVEL_TEXT: Record<string, string> = {
  none: '비개발자. 코드를 직접 읽거나 고치지 않는다. 기능·화면 기준으로 쉬운 말로 설명받는다',
  some: '조금 안다. 코드를 읽을 수는 있지만 설명은 쉬운 말 위주로 받는다',
  dev: '개발자. 코드·명령어·파일 경로를 그대로 보여 줘도 된다',
};

function field(text: string, key: string): string {
  const m = new RegExp(`^- ${key}:[ \\t]*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

function setField(text: string, key: string, value: string): string {
  const v = value.replace(/\s+/g, ' ').trim();
  const re = new RegExp(`^- ${key}:.*$`, 'm');
  if (re.test(text)) return text.replace(re, `- ${key}: ${v}`);
  // 칸이 없으면 '## 기본' 아래에 더한다
  if (/^## 기본\s*$/m.test(text)) return text.replace(/^## 기본\s*$/m, `## 기본\n- ${key}: ${v}`);
  return `${text.replace(/\s*$/, '\n')}\n## 기본\n- ${key}: ${v}\n`;
}

export interface SetupApi {
  status(): Promise<SetupStatus>;
  saveProfile(profile: SetupInput['profile']): Promise<{ ok: boolean; message: string }>;
  saveZones(zones: Record<Zone, string>): Promise<{ ok: boolean; message: string; needsRestart: boolean }>;
  checkFolder(zone: Zone, p: string): { ok: boolean; path: string; display: string; exists: boolean; problem?: string };
  save(input: SetupInput): Promise<{ ok: boolean; message: string; needsRestart: boolean }>;
}

export function createSetup(config: RanoConfig, memory: MemoryServiceApi): SetupApi {
  const home = homedir();

  const checkFolder = (zone: Zone, raw: string) => {
    const abs = path.resolve(expandHome(String(raw ?? '').trim()));
    const real = realOr(abs);
    const display = shrinkHome(real);
    const out = { ok: false, path: real, display, exists: false } as { ok: boolean; path: string; display: string; exists: boolean; problem?: string };
    if (!String(raw ?? '').trim()) return { ...out, problem: '폴더를 골라 주세요' };
    try {
      out.exists = existsSync(real) && statSync(real).isDirectory();
      if (existsSync(real) && !out.exists) return { ...out, problem: '파일이 아니라 폴더를 골라 주세요' };
    } catch {
      out.exists = false;
    }
    if (!isInside(real, realOr(home)) || real === realOr(home)) return { ...out, problem: '홈 폴더 안의 폴더 하나를 골라 주세요 (홈 폴더 전체는 고를 수 없어요)' };
    if (isInside(real, path.join(realOr(home), 'Library'))) return { ...out, problem: '맥 시스템 자료 폴더(Library)는 고를 수 없어요' };
    if (isInside(real, realOr(config.rootDir)) || isInside(realOr(config.rootDir), real)) return { ...out, problem: '라노 데이터 폴더와 겹치는 폴더는 고를 수 없어요' };
    if (isBlockedPath(config, real)) return { ...out, problem: '차단 목록에 걸린 폴더라 고를 수 없어요' };
    void zone;
    return { ...out, ok: true };
  };

  const status = async (): Promise<SetupStatus> => {
    let raw: any = config.raw ?? {};
    try {
      raw = await readRaw(config.rootDir);
    } catch {
      // 처음 읽은 설정을 쓴다
    }
    const me = await memory.read('me.md').catch(() => '');
    const zt = zoneText(config);
    const missions = Array.isArray(raw?.missions) ? raw.missions.length : 0;
    // 예전부터 쓰던 사람(미션이 있거나 이름을 적어 둔 사람)은 안내를 띄우지 않는다
    const needed = raw?.setup?.done !== true && missions === 0 && !field(me, ME_FIELDS.name);
    const zone = (z: Zone) => {
      const root = config.zones?.[z]?.root ?? path.join(home, z);
      return { label: zt[z].label, root: shrinkHome(root), exists: existsSync(root) };
    };
    return {
      needed,
      dataDir: shrinkHome(config.rootDir),
      profile: {
        name: field(me, ME_FIELDS.name),
        callName: field(me, ME_FIELDS.callName),
        org: field(me, ME_FIELDS.org),
        job: field(me, ME_FIELDS.job),
        devLevel: field(me, ME_FIELDS.devLevel),
      },
      zones: { work: zone('work'), personal: zone('personal') },
    };
  };

  /** 구역 폴더 검사. 통과하면 절대 경로 */
  const checkRoots = (zones: Record<Zone, string> | undefined): { error: string } | { roots: Record<Zone, string> } => {
    const roots = {} as Record<Zone, string>;
    for (const z of ['work', 'personal'] as const) {
      const c = checkFolder(z, zones?.[z] ?? '');
      if (!c.ok) return { error: `${zoneText(config)[z].label} 폴더: ${c.problem}` };
      roots[z] = c.path;
    }
    if (isInside(roots.work, roots.personal) || isInside(roots.personal, roots.work)) return { error: '회사 폴더와 개인 폴더는 서로 겹치지 않게 골라 주세요' };
    return { roots };
  };

  const writeProfile = async (p: SetupInput['profile']): Promise<string | null> => {
    const name = String(p?.name ?? '').trim();
    if (!name) return '이름을 적어 주세요';
    try {
      let me = await memory.read('me.md');
      if (!me.trim()) me = '# 나에 대한 정보 (me.md)\n\n## 기본\n';
      const values: Record<MeKey, string> = {
        name,
        callName: String(p?.callName ?? '').trim() || `${name}님`,
        org: String(p?.org ?? '').trim(),
        job: String(p?.job ?? '').trim(),
        devLevel: DEV_LEVEL_TEXT[String(p?.devLevel ?? '')] ?? String(p?.devLevel ?? '').trim(),
      };
      // 칸을 비우면 비운 채로 둔다(이름은 꼭 있음). 호칭이 비면 이름+님
      for (const k of Object.keys(ME_FIELDS) as MeKey[]) {
        const cur = field(me, ME_FIELDS[k]);
        if (values[k] || k === 'name' || cur) me = setField(me, ME_FIELDS[k], values[k]);
      }
      await memory.write('me.md', me, '사용자 정보를 앱 화면에서 적음');
    } catch {
      return '사용자 정보를 저장하지 못했어요. 잠시 뒤 다시 해 주세요';
    }
    return null;
  };

  const writeZones = async (roots: Record<Zone, string>, markSetupDone: boolean): Promise<string | null> => {
    try {
      for (const z of ['work', 'personal'] as const) await mkdir(roots[z], { recursive: true });
    } catch {
      return '구역 폴더를 만들지 못했어요. 다른 폴더를 골라 주세요';
    }
    try {
      const raw = await readRaw(config.rootDir);
      raw.zones = raw.zones ?? {};
      const other: Record<Zone, Zone> = { work: 'personal', personal: 'work' };
      for (const z of ['work', 'personal'] as const) {
        raw.zones[z] = raw.zones[z] ?? {};
        raw.zones[z].root = shrinkHome(roots[z]);
        raw.zones[z].denyRead = [shrinkHome(roots[other[z]]), `missions/${other[z]}`, `pool/${other[z]}`];
      }
      if (markSetupDone) raw.setup = { done: true, at: new Date().toISOString() };
      await writeRaw(config.rootDir, raw);
    } catch {
      return '설정 파일을 저장하지 못했어요. 잠시 뒤 다시 해 주세요';
    }
    return null;
  };

  const save = async (input: SetupInput) => {
    if (!input || typeof input !== 'object') return { ok: false, message: '입력 내용을 읽지 못했어요', needsRestart: false };
    if (!String(input.profile?.name ?? '').trim()) return { ok: false, message: '이름을 적어 주세요', needsRestart: false };
    const r = checkRoots(input.zones);
    if ('error' in r) return { ok: false, message: r.error, needsRestart: false };
    const e1 = await writeProfile(input.profile);
    if (e1) return { ok: false, message: e1, needsRestart: false };
    const e2 = await writeZones(r.roots, true);
    if (e2) return { ok: false, message: e2, needsRestart: false };
    return { ok: true, message: '설정을 저장했어요. 앱을 다시 시작해 반영할게요', needsRestart: true };
  };

  const saveProfile = async (p: SetupInput['profile']) => {
    const e = await writeProfile(p);
    return e ? { ok: false, message: e } : { ok: true, message: '나에 대한 정보를 저장했어요. 라노와 리더가 다음 대화부터 이 정보를 써요' };
  };

  /** 설정 화면에서 구역 폴더 바꾸기: 미션이 있는 구역은 폴더를 바꿀 수 없다 */
  const saveZones = async (zones: Record<Zone, string>) => {
    const r = checkRoots(zones);
    if ('error' in r) return { ok: false, message: r.error, needsRestart: false };
    let raw: any;
    try {
      raw = await readRaw(config.rootDir);
    } catch {
      return { ok: false, message: '설정 파일을 읽지 못했어요', needsRestart: false };
    }
    const changed = (['work', 'personal'] as const).filter((z) => realOr(path.resolve(expandHome(String(raw?.zones?.[z]?.root ?? path.join(home, z))))) !== r.roots[z]);
    if (!changed.length) return { ok: true, message: '바뀐 폴더가 없어요', needsRestart: false };
    for (const z of changed) {
      const used = (Array.isArray(raw?.missions) ? raw.missions : []).filter((m: any) => m?.archived !== true && (m?.zone === 'personal' ? 'personal' : 'work') === z);
      if (used.length)
        return { ok: false, message: `${zoneText(config)[z].label} 구역에 미션(${used.map((m: any) => m.name ?? m.id).join(', ')})이 있어서 폴더를 바꿀 수 없어요. 그 미션을 보관한 뒤 바꿔 주세요`, needsRestart: false };
    }
    const e = await writeZones(r.roots, false);
    if (e) return { ok: false, message: e, needsRestart: false };
    return { ok: true, message: '구역 폴더를 바꿨어요. 앱을 다시 시작하면 반영돼요', needsRestart: true };
  };

  return { status, checkFolder, save, saveProfile, saveZones };
}
