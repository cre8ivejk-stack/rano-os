// 외부 연결(MCP 서버): Confluence 같은 사내 서비스를 리더·팀원이 쓰게 한다.
// - Claude Code 사용자 설정(~/.claude.json 의 mcpServers)에서 이름·실행 방법만 가져온다. 비밀로 보이는 환경변수 값은
//   rano.json 에 쓰지 않고 맥 키체인으로 암호화해 데이터 폴더 runs/secrets 에 둔다
// - 미션마다 쓸 연결을 고른다(rano.json missions[].connectors). 고른 미션의 리더·팀원만 그 도구를 받는다
// - 읽기 도구(검색·조회)는 바로, 그 밖(만들기·고치기·댓글·지우기 등)은 승인함(external)을 거친다(leaderPermissions)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { ConnectorCandidate, ConnectorInfo, MissionConfig, RanoConfig } from '../../shared/types.js';
import { readRaw, writeRaw } from '../admin/paths.js';

const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const SECRET_NAME = /token|secret|key|pass|pwd|auth|cookie|credential|session/i;

/** 비밀로 다룰 환경변수: 이름이 비밀 같거나(GIT_CONFIG_* 설정 이름은 제외) 값이 길고 무작위로 보이는 것 */
function isSecretEnv(k: string, v: string): boolean {
  if (/^GIT_CONFIG_(COUNT|KEY_\d+)$/.test(k)) return false;
  if (SECRET_NAME.test(k)) return true;
  return /(bearer|basic)\s|authorization/i.test(v) || /[A-Za-z0-9_\-+/=]{32,}/.test(v.replace(/[/.:][A-Za-z0-9_.\-/:]+/g, ''));
}

let cfg: RanoConfig | null = null;
export function initConnectors(config: RanoConfig): void {
  cfg = config;
}

function secretFile(name: string): string {
  return path.join(cfg!.runsDir, 'secrets', `connector-${name}.bin`);
}

function readSecrets(name: string): Record<string, string> {
  try {
    const f = secretFile(name);
    if (!existsSync(f) || !safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(readFileSync(f)));
  } catch {
    return {};
  }
}

/** Claude Code 사용자 설정의 MCP 서버들 (가져오기 후보). 값은 돌려주지 않고 이름만 */
function transportOf(v: any): 'stdio' | 'http' | 'sse' {
  return typeof v?.command === 'string' ? 'stdio' : v?.type === 'sse' ? 'sse' : 'http';
}

function claudeServers(): Record<string, any> {
  try {
    const d = JSON.parse(readFileSync(path.join(homedir(), '.claude.json'), 'utf-8'));
    const s = d?.mcpServers && typeof d.mcpServers === 'object' ? d.mcpServers : {};
    // 이 맥에서 실행(stdio) 또는 https 주소로 접속(http·sse)
    return Object.fromEntries(Object.entries(s).filter(([k, v]: [string, any]) => NAME_RE.test(k) && (typeof v?.command === 'string' || (typeof v?.url === 'string' && /^https:\/\//.test(v.url)))));
  } catch {
    return {};
  }
}

export function candidates(): ConnectorCandidate[] {
  const have = cfg?.connectors ?? {};
  return Object.entries(claudeServers()).map(([name, v]) => ({
    name,
    transport: transportOf(v),
    ...(typeof v.url === 'string' ? { url: String(v.url).split('?')[0] } : {}),
    command: String(v.command ?? ''),
    args: Array.isArray(v.args) ? v.args.map((a: unknown) => (SECRET_NAME.test(String(a)) && String(a).length > 20 ? '(가림)' : String(a))) : [],
    envNames: [...Object.keys(v.env ?? {}), ...Object.keys(v.headers ?? {})],
    imported: !!have[name],
  }));
}

export function listConnectors(): ConnectorInfo[] {
  if (!cfg) return [];
  return Object.values(cfg.connectors ?? {}).map((c) => ({
    name: c.name,
    label: c.label,
    transport: c.transport,
    ...(c.url ? { url: c.url.split('?')[0] } : {}),
    missingSecrets: c.secretEnv.filter((k) => !readSecrets(c.name)[k]),
    command: c.command,
    args: c.args,
    envNames: [...Object.keys(c.env), ...c.secretEnv],
    secretEnv: c.secretEnv,
    usedBy: cfg!.missions.filter((m) => m.connectors?.includes(c.name)).map((m) => m.id),
    ...(c.from ? { from: c.from } : {}),
  }));
}

function prettyLabel(name: string): string {
  // 이름에서 "-mcp" 같은 꼬리를 떼고 첫 글자를 대문자로 (예: confluence → Confluence)
  const base = name.replace(/[-_]?mcp$/i, '').replace(/^mcp[-_]?/i, '') || name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** 비밀 값을 이 맥 사용자가 직접 넣거나 바꾼다(키체인 암호화). 빈 값이면 지운다. 새 이름이면 비밀 목록에 더한다 */
export async function setConnectorSecret(name: string, key: string, value: string): Promise<{ ok: boolean; message: string }> {
  if (!cfg) return { ok: false, message: '준비되지 않았어요' };
  const c = cfg.connectors?.[name];
  if (!c) return { ok: false, message: '그 연결을 찾지 못했어요' };
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(key)) return { ok: false, message: '이름은 영문·숫자·_·- 로 써 주세요' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: '이 맥에서 비밀 값을 안전하게 저장할 수 없어요' };
  const all = readSecrets(name);
  if (value.trim()) all[key] = value.trim();
  else delete all[key];
  mkdirSync(path.dirname(secretFile(name)), { recursive: true, mode: 0o700 });
  writeFileSync(secretFile(name), safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 });
  const adding = !!value.trim();
  if (adding !== c.secretEnv.includes(key) || (adding && key in c.env)) {
    const nextList = (list: string[]) => (adding ? [...new Set([...list, key])] : list.filter((k) => k !== key));
    try {
      const raw = await readRaw(cfg.rootDir);
      const rc = raw.connectors?.[name];
      if (rc) {
        rc.secretEnv = nextList(Array.isArray(rc.secretEnv) ? rc.secretEnv : []);
        if (adding && rc.env) delete rc.env[key];
        await writeRaw(cfg.rootDir, raw);
      }
    } catch {
      return { ok: false, message: '설정 파일을 저장하지 못했어요' };
    }
    c.secretEnv = nextList(c.secretEnv);
    if (adding) delete c.env[key];
  }
  return { ok: true, message: value.trim() ? `${c.label}의 ${key} 값을 암호화해 저장했어요 (다음 과제부터)` : `${c.label}의 ${key} 값을 지웠어요` };
}

/** Claude Code 설정에서 가져와 rano.json 에 넣는다 (비밀 값은 암호화 저장) */
export async function importConnector(name: string, label?: string): Promise<{ ok: boolean; message: string }> {
  if (!cfg) return { ok: false, message: '준비되지 않았어요' };
  const src = claudeServers()[name];
  if (!src) return { ok: false, message: '그 연결을 Claude Code 설정에서 찾지 못했어요' };
  const env: Record<string, string> = {};
  const secret: Record<string, string> = {};
  const transport = transportOf(src);
  for (const [k, v] of Object.entries((src.env ?? {}) as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (isSecretEnv(k, v)) secret[k] = v;
    else env[k] = v;
  }
  // 주소 접속 방식의 요청 머리글(인증 등)은 모두 비밀로 다룬다
  for (const [k, v] of Object.entries((src.headers ?? {}) as Record<string, unknown>)) if (typeof v === 'string' && transport !== 'stdio') secret[k] = v;
  if (Object.keys(secret).length) {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: '이 맥에서 비밀 값을 안전하게 저장할 수 없어요' };
    mkdirSync(path.dirname(secretFile(name)), { recursive: true, mode: 0o700 });
    writeFileSync(secretFile(name), safeStorage.encryptString(JSON.stringify(secret)), { mode: 0o600 });
  }
  const entry = {
    label: label?.trim() || prettyLabel(name),
    transport,
    command: transport === 'stdio' ? String(src.command) : '',
    ...(transport !== 'stdio' ? { url: String(src.url) } : {}),
    args: transport === 'stdio' && Array.isArray(src.args) ? src.args.map(String) : [],
    env,
    secretEnv: Object.keys(secret),
    from: 'Claude Code 사용자 설정',
  };
  try {
    const raw = await readRaw(cfg.rootDir);
    raw.connectors = raw.connectors && typeof raw.connectors === 'object' ? raw.connectors : {};
    raw.connectors[name] = entry;
    await writeRaw(cfg.rootDir, raw);
  } catch {
    return { ok: false, message: '설정 파일을 저장하지 못했어요' };
  }
  cfg.connectors = { ...(cfg.connectors ?? {}), [name]: { name, ...entry } };
  return { ok: true, message: `${entry.label} 연결을 가져왔어요. 조직 탭에서 이 연결을 쓸 미션을 골라 주세요` };
}

export async function removeConnector(name: string): Promise<{ ok: boolean; message: string }> {
  if (!cfg || !NAME_RE.test(name)) return { ok: false, message: '이름을 읽지 못했어요' };
  try {
    const raw = await readRaw(cfg.rootDir);
    if (raw.connectors) delete raw.connectors[name];
    for (const m of Array.isArray(raw.missions) ? raw.missions : []) if (Array.isArray(m.connectors)) m.connectors = m.connectors.filter((x: string) => x !== name);
    await writeRaw(cfg.rootDir, raw);
  } catch {
    return { ok: false, message: '설정 파일을 저장하지 못했어요' };
  }
  rmSync(secretFile(name), { force: true });
  if (cfg.connectors) delete cfg.connectors[name];
  for (const m of cfg.missions) if (m.connectors) m.connectors = m.connectors.filter((x) => x !== name);
  return { ok: true, message: `${name} 연결을 지웠어요` };
}

/** 미션이 쓸 연결을 바꾼다 (다음 과제부터 반영) */
export async function setMissionConnectors(missionId: string, names: string[]): Promise<{ ok: boolean; message: string }> {
  if (!cfg) return { ok: false, message: '준비되지 않았어요' };
  const have = cfg.connectors ?? {};
  const clean = [...new Set(names.filter((n) => have[n]))];
  try {
    const raw = await readRaw(cfg.rootDir);
    const m = (Array.isArray(raw.missions) ? raw.missions : []).find((x: any) => x?.id === missionId);
    if (!m) return { ok: false, message: '그 미션을 찾지 못했어요' };
    m.connectors = clean;
    await writeRaw(cfg.rootDir, raw);
  } catch {
    return { ok: false, message: '설정 파일을 저장하지 못했어요' };
  }
  const live = cfg.missions.find((x) => x.id === missionId);
  if (live) live.connectors = clean;
  return { ok: true, message: clean.length ? `이 미션이 쓰는 외부 연결: ${clean.map((n) => have[n].label).join(', ')} (다음 과제부터)` : '이 미션은 외부 연결을 쓰지 않아요' };
}

/** 리더 세션에 넘길 MCP 서버 설정 */
type ServerCfg = { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } | { type: 'http' | 'sse'; url: string; headers: Record<string, string> };
export function mcpServersFor(config: RanoConfig, mission: MissionConfig): Record<string, ServerCfg> {
  const out: Record<string, ServerCfg> = {};
  for (const n of mission.connectors ?? []) {
    const c = config.connectors?.[n];
    if (!c) continue;
    const secrets = cfg ? readSecrets(n) : {};
    if (c.transport === 'stdio') out[n] = { type: 'stdio', command: c.command, args: c.args, env: { ...c.env, ...secrets } };
    else if (c.url) out[n] = { type: c.transport, url: c.url, headers: secrets };
  }
  return out;
}

/** 외부 연결 도구가 읽기(바로 허용)인지 */
