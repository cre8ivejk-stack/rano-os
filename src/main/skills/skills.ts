// 스킬 보관함: 데이터 폴더 skills/<이름>/SKILL.md (+ 딸린 파일).
// - 기본 스킬(앱의 defaults/skills)은 없을 때만 데이터 폴더로 복사한다(사용자가 고친 것은 덮어쓰지 않음)
// - 역할마다 쓸 스킬은 rano.json roleSkills 에 둔다. 리더가 팀원을 부를 때 그 역할 지침 끝에 스킬 안내(SKILL.md)를 붙인다
// - 가져오기는 폴더나 GitHub 주소에서 받아 먼저 보여 주고(미리 보기), 사용자가 승인하면 넣는다
// - 문서 도구(파이썬)는 데이터 폴더 tools/python 에 따로 설치한다(맥 전체 설치가 아님)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RanoConfig, SkillInfo, SkillPreview, ToolsStatus } from '../../shared/types.js';
import { readRaw, writeRaw } from '../admin/paths.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const MAX_FILES = 80;
const MAX_TOTAL = 3 * 1024 * 1024;
const SCRIPT_RE = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|command|applescript|scpt)$/i;
export const TOOL_PACKAGES = ['openpyxl', 'python-docx', 'python-pptx', 'pypdf', 'reportlab'];

let cfg: RanoConfig | null = null;
let defaultsSkills = '';
let roleMap: Record<string, string[]> = {};
const staged = new Map<string, { dir: string; info: SkillPreview }>();

function skillsDir(): string {
  return path.join(cfg!.rootDir, 'skills');
}
export function skillsRoot(config: RanoConfig): string {
  return path.join(config.rootDir, 'skills');
}
function toolsDir(): string {
  return path.join(cfg!.rootDir, 'tools', 'python');
}
/** 문서 도구 파이썬 경로 (설치돼 있으면) */
export function ranoPython(config: RanoConfig): string | null {
  const p = path.join(config.rootDir, 'tools', 'python', 'bin', 'python3');
  return existsSync(p) ? p : null;
}

function frontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { body: text };
  const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(m[1])?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { name: get('name'), description: get('description'), body: text.slice(m[0].length) };
}

function builtinNames(): string[] {
  try {
    return readdirSync(defaultsSkills).filter((n) => existsSync(path.join(defaultsSkills, n, 'SKILL.md')));
  } catch {
    return [];
  }
}

export function initSkills(config: RanoConfig, defaultsDir: string): void {
  cfg = config;
  defaultsSkills = path.join(defaultsDir, 'skills');
  // 기본 스킬: 데이터 폴더에 없을 때만 복사
  mkdirSync(skillsDir(), { recursive: true });
  for (const n of builtinNames()) {
    const dst = path.join(skillsDir(), n);
    if (!existsSync(dst)) {
      try {
        cpSync(path.join(defaultsSkills, n), dst, { recursive: true });
      } catch (e) {
        console.error('[skills] 기본 스킬 복사 실패:', n, e);
      }
    }
  }
  const raw = (config.raw ?? {}) as { roleSkills?: unknown };
  roleMap = {};
  if (raw.roleSkills && typeof raw.roleSkills === 'object')
    for (const [k, v] of Object.entries(raw.roleSkills as Record<string, unknown>))
      if (Array.isArray(v)) roleMap[k] = v.filter((x): x is string => typeof x === 'string' && NAME_RE.test(x));
}

function walk(dir: string, base = dir, out: { rel: string; size: number }[] = []): { rel: string; size: number }[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push({ rel: path.relative(base, full), size: statSync(full).size });
    if (out.length > MAX_FILES + 1) break;
  }
  return out;
}

export function listSkills(): SkillInfo[] {
  if (!cfg) return [];
  const builtin = new Set(builtinNames());
  const out: SkillInfo[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(skillsDir()).filter((n) => NAME_RE.test(n) && existsSync(path.join(skillsDir(), n, 'SKILL.md')));
  } catch {
    names = [];
  }
  for (const n of names.sort()) {
    const dir = path.join(skillsDir(), n);
    const fm = frontmatter(readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'));
    const files = walk(dir);
    out.push({
      name: n,
      description: fm.description ?? '',
      builtin: builtin.has(n),
      files: files.length,
      hasScripts: files.some((f) => SCRIPT_RE.test(f.rel)),
      usedBy: Object.entries(roleMap).filter(([, v]) => v.includes(n)).map(([k]) => k),
    });
  }
  return out;
}

export function readSkill(name: string): { name: string; description: string; body: string; files: string[] } | null {
  if (!cfg || !NAME_RE.test(name)) return null;
  const dir = path.join(skillsDir(), name);
  const f = path.join(dir, 'SKILL.md');
  if (!existsSync(f)) return null;
  const fm = frontmatter(readFileSync(f, 'utf-8'));
  return { name, description: fm.description ?? '', body: fm.body, files: walk(dir).map((x) => x.rel) };
}

export function roleSkills(): Record<string, string[]> {
  return JSON.parse(JSON.stringify(roleMap));
}

export async function setRoleSkills(role: string, names: string[]): Promise<{ ok: boolean; message: string }> {
  if (!cfg) return { ok: false, message: '준비되지 않았어요' };
  if (!/^[A-Za-z0-9][\w.-]{0,60}$/.test(role)) return { ok: false, message: '역할 이름을 읽지 못했어요' };
  const have = new Set(listSkills().map((s) => s.name));
  const clean = [...new Set(names.filter((n) => have.has(n)))];
  try {
    const raw = await readRaw(cfg.rootDir);
    raw.roleSkills = raw.roleSkills && typeof raw.roleSkills === 'object' ? raw.roleSkills : {};
    if (clean.length) raw.roleSkills[role] = clean;
    else delete raw.roleSkills[role];
    await writeRaw(cfg.rootDir, raw);
  } catch {
    return { ok: false, message: '설정 파일을 저장하지 못했어요' };
  }
  if (clean.length) roleMap[role] = clean;
  else delete roleMap[role];
  return { ok: true, message: clean.length ? `${role} 역할이 쓸 스킬: ${clean.join(', ')}` : `${role} 역할의 스킬을 모두 뺐어요` };
}

/** 역할 지침 끝에 붙일 스킬 안내. 없으면 '' */
export function skillPromptFor(role: string, draftsHint = '이 과제의 시안 폴더'): string {
  if (!cfg) return '';
  const names = roleMap[role] ?? [];
  const parts: string[] = [];
  for (const n of names) {
    const s = readSkill(n);
    if (!s) continue;
    const extra = s.files.filter((f) => f !== 'SKILL.md');
    parts.push(
      `### 스킬: ${n}\n스킬 폴더(읽기만): ${path.join(skillsDir(), n)}${extra.length ? `\n딸린 파일: ${extra.slice(0, 20).join(', ')}` : ''}\n\n${s.body.trim()}`,
    );
  }
  if (!parts.length) return '';
  const py = ranoPython(cfg);
  return `\n\n## 쓸 수 있는 스킬\n- 결과 파일과 스크립트는 ${draftsHint}에 먼저 만든다. 명령 실행은 승인함을 거친다.\n- 문서 도구 파이썬: ${py ? `$RANO_PY (${py})` : '아직 설치되지 않음 — 파일 만들기가 필요하면 보고에 "라노 OS 설정에서 문서 도구 설치 필요"라고 적는다'}\n\n${parts.join('\n\n')}`;
}

// ---------- 가져오기 ----------
async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rano-os' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GitHub 응답 ${r.status}`);
  return r.json();
}

/** github.com/<owner>/<repo>/tree/<ref>/<path> 를 받아 임시 폴더에 내려받는다 */
async function fetchGithub(url: string, dst: string): Promise<void> {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([^/]+)\/(.+?)\/?$/.exec(url.trim());
  if (!m) throw new Error('GitHub 주소는 https://github.com/<계정>/<저장소>/tree/<가지>/<스킬 폴더> 모양이어야 해요');
  const [, owner, repo, ref, sub] = m;
  let count = 0;
  let total = 0;
  const get = async (p: string, out: string) => {
    const items = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/contents/${p}?ref=${encodeURIComponent(ref)}`);
    if (!Array.isArray(items)) throw new Error('폴더 주소가 아니에요');
    mkdirSync(out, { recursive: true });
    for (const it of items) {
      if (it.type === 'dir') await get(`${p}/${it.name}`, path.join(out, it.name));
      else if (it.type === 'file' && !it.name.startsWith('.')) {
        if (++count > MAX_FILES) throw new Error(`파일이 너무 많아요 (${MAX_FILES}개까지)`);
        total += it.size ?? 0;
        if (total > MAX_TOTAL) throw new Error('스킬이 너무 커요 (3MB 까지)');
        const r = await fetch(it.download_url, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`${it.name} 을 받지 못했어요`);
        writeFileSync(path.join(out, it.name), Buffer.from(await r.arrayBuffer()));
      }
    }
  };
  await get(sub, dst);
}

export async function previewSkill(source: string): Promise<{ ok: true; preview: SkillPreview } | { ok: false; message: string }> {
  if (!cfg) return { ok: false, message: '준비되지 않았어요' };
  const src = String(source ?? '').trim();
  if (!src) return { ok: false, message: '폴더나 GitHub 주소를 넣어 주세요' };
  const token = randomUUID();
  const dir = path.join(cfg.runsDir, 'skill-staging', token);
  try {
    if (/^https?:\/\//.test(src)) await fetchGithub(src, dir);
    else {
      const abs = path.resolve(src.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
      if (!existsSync(path.join(abs, 'SKILL.md'))) return { ok: false, message: '그 폴더에 SKILL.md 가 없어요' };
      const files = walk(abs);
      if (files.length > MAX_FILES) return { ok: false, message: `파일이 너무 많아요 (${MAX_FILES}개까지)` };
      if (files.reduce((t, f) => t + f.size, 0) > MAX_TOTAL) return { ok: false, message: '스킬이 너무 커요 (3MB 까지)' };
      cpSync(abs, dir, { recursive: true, filter: (p) => !path.basename(p).startsWith('.') });
    }
    const skillMd = path.join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) throw new Error('SKILL.md 가 없어요');
    const text = readFileSync(skillMd, 'utf-8');
    const fm = frontmatter(text);
    const name = (fm.name ?? path.basename(src)).toLowerCase();
    if (!NAME_RE.test(name)) throw new Error(`스킬 이름 "${fm.name ?? ''}" 은 영문 소문자·숫자·- 만 쓸 수 있어요`);
    const files = walk(dir);
    const lic = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map((f) => path.join(dir, f)).find((f) => existsSync(f));
    const preview: SkillPreview = {
      token,
      name,
      description: fm.description ?? '',
      source: src,
      files: files.map((f) => ({ path: f.rel, size: f.size, script: SCRIPT_RE.test(f.rel) })),
      skillMd: text.slice(0, 20_000),
      license: lic ? readFileSync(lic, 'utf-8').slice(0, 1200) : undefined,
      exists: existsSync(path.join(skillsDir(), name)),
      builtin: builtinNames().includes(name),
    };
    staged.set(token, { dir, info: preview });
    return { ok: true, preview };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, message: e instanceof Error ? e.message : '가져오지 못했어요' };
  }
}

export function installSkill(token: string): { ok: boolean; message: string; name?: string } {
  const s = staged.get(String(token));
  if (!s || !cfg) return { ok: false, message: '미리 보기를 다시 해 주세요' };
  if (s.info.builtin) return { ok: false, message: '기본 스킬과 같은 이름이라 넣을 수 없어요' };
  const dst = path.join(skillsDir(), s.info.name);
  try {
    rmSync(dst, { recursive: true, force: true });
    cpSync(s.dir, dst, { recursive: true });
    rmSync(s.dir, { recursive: true, force: true });
    staged.delete(String(token));
  } catch {
    return { ok: false, message: '스킬을 넣지 못했어요' };
  }
  return { ok: true, message: `${s.info.name} 스킬을 넣었어요. 조직 탭에서 쓸 역할을 골라 주세요`, name: s.info.name };
}

export async function removeSkill(name: string): Promise<{ ok: boolean; message: string }> {
  if (!cfg || !NAME_RE.test(name)) return { ok: false, message: '스킬 이름을 읽지 못했어요' };
  if (builtinNames().includes(name)) return { ok: false, message: '기본 스킬은 지울 수 없어요 (역할에서 빼면 쓰지 않아요)' };
  const dir = path.join(skillsDir(), name);
  if (!existsSync(dir)) return { ok: false, message: '그 스킬이 없어요' };
  rmSync(dir, { recursive: true, force: true });
  for (const role of Object.keys(roleMap)) if (roleMap[role].includes(name)) await setRoleSkills(role, roleMap[role].filter((n) => n !== name));
  return { ok: true, message: `${name} 스킬을 지웠어요` };
}

// ---------- 문서 도구(파이썬) ----------
let installing = false;
let lastLog = '';

function run(cmd: string, args: string[], onLine: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
    const feed = (d: Buffer) => {
      for (const l of String(d).split('\n')) if (l.trim()) onLine(l.trim());
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('close', (c) => resolve(c ?? 1));
    p.on('error', () => resolve(1));
  });
}

export async function toolsStatus(): Promise<ToolsStatus> {
  if (!cfg) return { installed: false, installing: false, packages: [] };
  const py = ranoPython(cfg);
  if (!py) return { installed: false, installing, packages: [], log: lastLog || undefined };
  const lines: string[] = [];
  await run(py, ['-c', `import importlib.metadata as m\nfor p in ${JSON.stringify(TOOL_PACKAGES)}:\n  try: print(p, m.version(p))\n  except Exception: print(p, '-')`], (l) => lines.push(l));
  const packages = lines.map((l) => {
    const [name, ver] = l.split(' ');
    return { name, version: ver && ver !== '-' ? ver : undefined };
  });
  return { installed: packages.length > 0 && packages.every((p) => p.version), installing, packages, python: py, log: lastLog || undefined };
}

export async function installTools(onLine: (s: string) => void): Promise<{ ok: boolean; message: string }> {
  if (!cfg) return { ok: false, message: '준비되지 않았어요' };
  if (installing) return { ok: false, message: '이미 설치하는 중이에요' };
  installing = true;
  lastLog = '';
  const log = (s: string) => {
    lastLog = s.slice(0, 300);
    onLine(s);
  };
  try {
    mkdirSync(path.dirname(toolsDir()), { recursive: true });
    if (!ranoPython(cfg)) {
      log('파이썬 작업 공간 만드는 중…');
      const c = await run('/usr/bin/python3', ['-m', 'venv', toolsDir()], log);
      if (c !== 0 || !ranoPython(cfg)) return { ok: false, message: '파이썬 작업 공간을 만들지 못했어요 (맥에 python3 가 있어야 해요. 없으면 "개발자 도구"를 설치해 주세요)' };
    }
    log(`문서 도구 받는 중… (${TOOL_PACKAGES.join(', ')})`);
    const c = await run(ranoPython(cfg)!, ['-m', 'pip', 'install', '--upgrade', ...TOOL_PACKAGES], log);
    if (c !== 0) return { ok: false, message: '문서 도구를 받지 못했어요 (인터넷 연결을 확인해 주세요)' };
    log('설치를 마쳤어요');
    return { ok: true, message: '문서 도구를 설치했어요. 이제 엑셀·워드·파워포인트·PDF 스킬을 쓸 수 있어요' };
  } finally {
    installing = false;
  }
}
