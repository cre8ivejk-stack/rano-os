// config/rano.json 을 읽어 RanoConfig 로 바꾼다. 인증 방식·모델·차단 목록은 이 파일 한 곳에서만 정한다.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ConnectorConfig, MissionConfig, RanoConfig, Zone, ZoneConfig } from '../shared/types.js';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

export function defaultRootDir(): string {
  return process.env.RANO_ROOT ? expandHome(process.env.RANO_ROOT) : path.join(homedir(), 'rano');
}

/** 구역의 외부 역할 폴더(rano.json zones.<구역>.externalPool, 읽기만). 없으면 빈 목록 */
export function externalPools(raw: any, rootDir: string, zone: Zone): string[] {
  const v = raw?.zones?.[zone]?.externalPool;
  const list: string[] = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter((x: unknown) => typeof x === 'string' && x);
  return list.map((p) => {
    const e = expandHome(p);
    return path.resolve(path.isAbsolute(e) ? e : path.join(rootDir, e));
  });
}

/** 역할을 찾을 폴더들: rano.json 의 roleDirs → 미션 rolesDir → 인재풀(pool/<구역>) → 구역의 외부 역할 폴더. 중복은 앞의 것만 남긴다. */
export function roleDirsFor(m: any, rootDir: string, resolve: (p: string) => string, raw?: any): string[] {
  const zone = m?.zone === 'personal' ? 'personal' : 'work';
  const list: string[] = [
    ...(Array.isArray(m?.roleDirs) ? m.roleDirs.filter((d: unknown) => typeof d === 'string' && d).map(resolve) : []),
    resolve(m?.rolesDir ?? `${m?.home}/roles`),
    path.join(rootDir, 'pool', zone),
    // 외부 역할 폴더는 그 구역 미션에만 붙인다
    ...externalPools(raw, rootDir, zone),
  ];
  const out: string[] = [];
  for (const d of list) {
    const n = path.resolve(d);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** 구역 설정. rano.json 에 없으면 회사 = ~/work, 개인 = ~/personal 로 두고, 서로의 폴더와 미션 홈을 막는다. */
export function zonesFrom(raw: any, rootDir: string): Record<Zone, ZoneConfig> {
  const resolve = (p: string) => {
    const e = expandHome(p);
    return path.resolve(path.isAbsolute(e) ? e : path.join(rootDir, e));
  };
  const one = (z: Zone, label: string, root: string, deny: string[]): ZoneConfig => {
    const r = raw?.zones?.[z] ?? {};
    const denyRaw: string[] = Array.isArray(r.denyRead) ? r.denyRead.filter((x: unknown) => typeof x === 'string' && x) : deny;
    return { label: typeof r.label === 'string' ? r.label : label, root: resolve(typeof r.root === 'string' && r.root ? r.root : root), denyRead: denyRaw.map(resolve) };
  };
  return {
    work: one('work', '회사', '~/work', ['~/personal', 'missions/personal', 'pool/personal']),
    personal: one('personal', '개인', '~/personal', ['~/work', 'missions/work', 'pool/work']),
  };
}

/** rano.json connectors (이름 → 실행 방법). 비밀 값은 따로 암호화 저장 */
export function connectorsFrom(raw: any): Record<string, ConnectorConfig> {
  const out: Record<string, ConnectorConfig> = {};
  const src = raw?.connectors && typeof raw.connectors === 'object' ? raw.connectors : {};
  for (const [name, c] of Object.entries(src as Record<string, any>)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) continue;
    const transport = c?.transport === 'http' || c?.transport === 'sse' ? c.transport : 'stdio';
    if (transport === 'stdio' ? typeof c?.command !== 'string' : typeof c?.url !== 'string' || !/^https:\/\//.test(c.url)) continue;
    out[name] = {
      name,
      label: typeof c.label === 'string' ? c.label : name,
      transport,
      command: typeof c.command === 'string' ? c.command : '',
      ...(transport !== 'stdio' ? { url: c.url } : {}),
      args: Array.isArray(c.args) ? c.args.filter((a: unknown) => typeof a === 'string') : [],
      env: c.env && typeof c.env === 'object' ? Object.fromEntries(Object.entries(c.env).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {},
      secretEnv: Array.isArray(c.secretEnv) ? c.secretEnv.filter((a: unknown) => typeof a === 'string') : [],
      ...(typeof c.from === 'string' ? { from: c.from } : {}),
    };
  }
  return out;
}

export function loadConfig(rootDir: string = defaultRootDir()): RanoConfig {
  const file = path.join(rootDir, 'config', 'rano.json');
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  const resolve = (p: string) => {
    const e = expandHome(p);
    return path.isAbsolute(e) ? e : path.join(rootDir, e);
  };
  const method = raw?.auth?.method === 'apiKey' ? 'apiKey' : 'max';
  return {
    rootDir,
    zones: zonesFrom(raw, rootDir),
    authMethod: method,
    models: {
      rano: raw.models?.rano ?? 'claude-opus-5-5',
      repoLeader: raw.models?.repoLeader ?? 'claude-opus-5-5',
      member: raw.models?.member ?? 'claude-opus-5-5',
    },
    // ** 로 시작하는 패턴은 그대로 두고, ~ 경로만 절대 경로로 푼다
    blocked: (raw.blocked ?? []).map((p: string) => (p.startsWith('**') ? p : expandHome(p))),
    memoryDir: resolve(raw.memory?.dir ?? 'memory'),
    memoryFiles: raw.memory?.files ?? ['me.md', 'priorities.md', 'missions.md'],
    autoCommit: raw.memory?.autoCommit !== false,
    runsDir: resolve(raw.runsDir ?? 'runs'),
    connectors: connectorsFrom(raw),
    // archived: true 인 미션은 현황판·리더를 만들지 않는다 (조직 화면은 raw 에서 읽는다)
    missions: (raw.missions ?? []).filter((m: any) => m && m.archived !== true).map(
      (m: any): MissionConfig => ({
        id: m.id,
        name: m.name ?? m.id,
        zone: m.zone === 'personal' ? 'personal' : 'work',
        home: resolve(m.home),
        targets: (m.targets ?? []).map(resolve),
        readonlyRefs: (m.readonlyRefs ?? []).map(resolve),
        rulesFiles: (m.rulesFiles ?? []).map(resolve),
        rolesDir: resolve(m.rolesDir ?? `${m.home}/roles`),
        roleDirs: roleDirsFor(m, rootDir, resolve, raw),
        roles: m.roles ?? [],
        reviewerRoles: m.reviewerRoles ?? [],
        stagePolicy: m.stagePolicy === 'approval' ? 'approval' : 'readOnly',
        directWriteDirs: (m.directWriteDirs ?? []).map(resolve),
        connectors: Array.isArray(m.connectors) ? m.connectors.filter((x: unknown) => typeof x === 'string') : [],
      }),
    ),
    raw,
  };
}
