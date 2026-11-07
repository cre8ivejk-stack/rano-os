// 인재풀: 여러 역할 폴더를 훑어 역할 목록을 만들고, 인재풀(~/rano/pool/work, pool/personal)에만 역할을 저장한다.
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AdminResult, RoleDraft, RoleInfo, Zone } from '../../shared/types.js';
import { externalPools, roleDirsFor } from '../config.js';
import { parseRoleFile } from '../mission/roles.js';
import { isInside, realOr, resolveIn } from './paths.js';

export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

interface RoleHit {
  info: RoleInfo;
  file: string;
}

const missionsOf = (raw: any): any[] => (Array.isArray(raw?.missions) ? raw.missions : []);

/** 살펴볼 역할 폴더들(앞의 것이 이긴다): 모든 미션(보관 포함)의 roleDirs → pool/work → pool/personal → 구역별 외부 역할 폴더 */
function scanDirs(rootDir: string, raw: any): string[] {
  const resolve = (p: string) => resolveIn(rootDir, p);
  const dirs: string[] = [];
  const add = (d: string) => {
    const n = path.resolve(d);
    if (!dirs.includes(n)) dirs.push(n);
  };
  for (const m of missionsOf(raw)) for (const d of roleDirsFor(m, rootDir, resolve, raw)) add(d);
  add(path.join(rootDir, 'pool', 'work'));
  add(path.join(rootDir, 'pool', 'personal'));
  for (const z of ['work', 'personal'] as const) for (const d of externalPools(raw, rootDir, z)) add(d);
  return dirs;
}

function sourceOf(rootDir: string, raw: any, dir: string): RoleInfo['source'] {
  const real = realOr(dir);
  const ext = [...externalPools(raw, rootDir, 'work'), ...externalPools(raw, rootDir, 'personal')];
  if (ext.some((e) => isInside(real, realOr(e)))) return 'work';
  if (isInside(real, realOr(path.join(rootDir, 'pool')))) return 'pool';
  return 'mission';
}

/** 역할 폴더가 어느 구역 것인지: 개인 인재풀·개인 미션 홈·개인 외부 역할 폴더면 개인, 나머지는 회사 */
function zoneOf(rootDir: string, raw: any, dir: string): Zone {
  const real = realOr(dir);
  if (externalPools(raw, rootDir, 'personal').some((e) => isInside(real, realOr(e)))) return 'personal';
  if (isInside(real, realOr(path.join(rootDir, 'pool', 'personal')))) return 'personal';
  if (isInside(real, realOr(path.join(rootDir, 'missions', 'personal')))) return 'personal';
  return 'work';
}

/** 이름별로 처음 찾은 역할 하나씩 */
export function scanRoles(rootDir: string, raw: any, withBody: boolean): RoleHit[] {
  const rawMissions = missionsOf(raw);
  const byName = new Map<string, RoleHit>();
  for (const dir of scanDirs(rootDir, raw)) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of names.sort()) {
      const name = f.slice(0, -3);
      if (byName.has(name) || !/^[A-Za-z0-9][\w.-]*$/.test(name)) continue;
      const file = path.join(dir, f);
      let text: string;
      try {
        text = readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const parsed = parseRoleFile(text, name);
      const tools = parsed.tools;
      const source = sourceOf(rootDir, raw, dir);
      byName.set(name, {
        file,
        info: {
          name,
          description: parsed.description,
          tools,
          canWrite: tools === null || tools.some((t) => t === 'Write' || t === 'Edit' || t === 'NotebookEdit'),
          canRun: tools === null || tools.includes('Bash'),
          zone: zoneOf(rootDir, raw, dir),
          source,
          dir,
          editable: source === 'pool',
          usedBy: rawMissions.filter((m) => Array.isArray(m?.roles) && m.roles.includes(name)).map((m) => String(m.id)),
          model: source === 'work' ? 'default' : parsed.model, // 회사 역할 폴더의 model 은 따르지 않는다
          ...(withBody ? { body: parsed.body } : {}),
        },
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
}

function oneLine(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 인재풀에 역할 저장. 이름 바꾸기는 막는다(옛 파일을 지우지 않기 위해). */
export async function savePoolRole(
  rootDir: string,
  raw: any,
  draft: RoleDraft,
  originalName?: string,
): Promise<AdminResult> {
  const name = String(draft?.name ?? '').trim();
  if (!ROLE_NAME_RE.test(name))
    return { ok: false, message: '역할 이름은 영문 소문자·숫자·- 로 2~41자여야 해요 (예: report-writer)' };
  if (originalName && originalName !== name)
    return { ok: false, message: '역할 이름은 바꿀 수 없어요. 새 이름으로 역할을 새로 만들어 주세요' };
  const description = oneLine(draft.description);
  if (!description) return { ok: false, message: '역할 설명을 한 줄 적어 주세요' };
  const body = String(draft.body ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return { ok: false, message: '역할 지침을 적어 주세요' };

  const existing = scanRoles(rootDir, raw, false).find((r) => r.info.name === name);
  if (existing && existing.info.source !== 'pool') return { ok: false, message: '이미 있는 역할 이름이에요. 다른 이름을 골라 주세요' };
  if (existing && !originalName) return { ok: false, message: '이미 있는 역할 이름이에요. 다른 이름을 골라 주세요' };

  const tools = ['Read', 'Grep', 'Glob', ...(draft.canWrite ? ['Edit', 'Write'] : []), ...(draft.canRun ? ['Bash'] : [])];
  const model = draft.model === 'sonnet' || draft.model === 'opus' ? draft.model : null;
  const text = `---\nname: ${name}\ndescription: ${description}\ntools: ${tools.join(', ')}\n${model ? `model: ${model}\n` : ''}---\n\n${body}\n`;
  const zone: Zone = draft.zone === 'personal' ? 'personal' : 'work';
  if (existing && existing.info.zone !== zone)
    return { ok: false, message: '다른 구역에 같은 이름의 역할이 있어요. 다른 이름을 골라 주세요' };
  const dir = path.join(rootDir, 'pool', zone);
  const file = path.join(dir, `${name}.md`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, text, 'utf-8');
    await rename(tmp, file);
  } catch {
    await unlink(tmp).catch(() => {});
    return { ok: false, message: '역할 파일을 저장하지 못했어요. 잠시 뒤 다시 해 주세요' };
  }
  return {
    ok: true,
    id: name,
    message: existing ? `${name} 역할을 고쳤어요. 다음 과제부터 반영돼요` : `${name} 역할을 ${zone === 'personal' ? '개인' : '회사'} 인재풀에 만들었어요`,
  };
}
