// Claude 계정 연결: 이 맥의 Claude 로그인(구독 Pro·Max 또는 Console) 상태 보기·로그인·로그아웃, API 키 저장.
// 로그인은 앱에 들어 있는 Claude 실행 파일의 `auth login` 을 그대로 쓴다. 브라우저에서 로그인하면 나오는 코드를 앱에 붙여 넣는다.
// 이 맥에 열리는 포트는 없다. API 키는 맥 키체인으로 암호화(safeStorage)해서 데이터 폴더 runs/secrets 에만 둔다.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { AuthStatus, RanoConfig } from '../../shared/types.js';
import { readRaw, writeRaw } from '../admin/paths.js';
import { claudeBinaryPath } from './claudeBinary.js';

let apiKeyCache: string | null = null; // 복호화한 API 키 (메모리에만)

function keyFile(config: RanoConfig): string {
  return path.join(config.runsDir, 'secrets', 'anthropic-key.bin');
}

/** 저장된 API 키 (없으면 null). buildSdkEnv 가 부른다 */
export function storedApiKey(config: RanoConfig): string | null {
  if (apiKeyCache !== null) return apiKeyCache || null;
  apiKeyCache = '';
  try {
    const f = keyFile(config);
    if (existsSync(f) && safeStorage.isEncryptionAvailable()) apiKeyCache = safeStorage.decryptString(readFileSync(f));
  } catch {
    apiKeyCache = '';
  }
  return apiKeyCache || null;
}

/** 로그인 확인·로그인에 쓰는 환경변수: API 키는 빼서 계정 로그인만 본다 */
function loginEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function run(args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string }> {
  const bin = claudeBinaryPath();
  if (!bin) return Promise.resolve({ code: -1, out: 'Claude 실행 파일을 찾지 못했어요' });
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: loginEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve({ code: -1, out: '' });
    });
  });
}

const ESC_URL = /https:\/\/[^\s\x1b\x07]+/;

export interface AuthApi {
  status(): Promise<AuthStatus>;
  startLogin(kind: 'claudeai' | 'console'): Promise<{ ok: boolean; url?: string; message?: string }>;
  submitCode(code: string): Promise<{ ok: boolean; message: string }>;
  cancelLogin(): void;
  logout(): Promise<{ ok: boolean; message: string }>;
  saveApiKey(key: string): Promise<{ ok: boolean; message: string }>;
  useMethod(method: 'max' | 'apiKey'): Promise<{ ok: boolean; message: string }>;
  removeApiKey(): Promise<{ ok: boolean; message: string }>;
}

export function createAuth(config: RanoConfig): AuthApi {
  let login: { child: ChildProcessWithoutNullStreams; out: string; done: Promise<number | null> } | null = null;

  const status = async (): Promise<AuthStatus> => {
    const key = storedApiKey(config);
    const base = { method: config.authMethod, apiKeySaved: !!key, apiKeyHint: key ? `…${key.slice(-4)}` : undefined } as const;
    const r = await run(['auth', 'status', '--json']);
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
      return {
        ...base,
        loggedIn: j.loggedIn === true,
        account: j.loggedIn ? { kind: j.authMethod === 'claude.ai' ? 'subscription' : 'console', email: j.email, orgName: j.orgName, plan: j.subscriptionType, expiresAt: j.loginExpiresAt } : undefined,
      };
    } catch {
      return { ...base, loggedIn: false, error: r.code === -1 ? r.out || 'Claude 실행 파일을 실행하지 못했어요' : '로그인 상태를 읽지 못했어요' };
    }
  };

  const cancelLogin = () => {
    if (login) {
      login.child.kill();
      login = null;
    }
  };

  const startLogin = async (kind: 'claudeai' | 'console') => {
    cancelLogin();
    const bin = claudeBinaryPath();
    if (!bin) return { ok: false, message: 'Claude 실행 파일을 찾지 못했어요' };
    const child = spawn(bin, ['auth', 'login', kind === 'console' ? '--console' : '--claudeai'], { env: loginEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const cur = { child, out: '', done: new Promise<number | null>((res) => child.on('close', (c) => res(c))) };
    login = cur;
    child.stdout.on('data', (d) => (cur.out += String(d)));
    child.stderr.on('data', (d) => (cur.out += String(d)));
    child.on('error', () => (cur.out += '\n(실행 실패)'));
    // 로그인 주소가 나올 때까지 기다린다 (실행 파일이 브라우저도 연다)
    for (let i = 0; i < 40; i++) {
      const m = ESC_URL.exec(cur.out);
      if (m) return { ok: true, url: m[0] };
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    cancelLogin();
    return { ok: false, message: '로그인 페이지 주소를 받지 못했어요. 잠시 뒤 다시 눌러 주세요' };
  };

  const submitCode = async (code: string) => {
    const c = String(code ?? '').trim();
    if (!login) return { ok: false, message: '로그인을 먼저 시작해 주세요' };
    if (!c || c.length > 500 || /\s/.test(c)) return { ok: false, message: '브라우저에 나온 코드를 그대로 붙여 넣어 주세요' };
    const cur = login;
    cur.child.stdin.write(`${c}\n`);
    const exit = await Promise.race([cur.done, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
    if (exit === 'timeout') {
      cancelLogin();
      return { ok: false, message: '로그인이 끝나지 않았어요. 처음부터 다시 해 주세요' };
    }
    login = null;
    const s = await status();
    if (exit === 0 && s.loggedIn) return { ok: true, message: '로그인했어요' };
    return { ok: false, message: '로그인하지 못했어요. 코드가 맞는지 확인하고 처음부터 다시 해 주세요' };
  };

  const logout = async () => {
    const r = await run(['auth', 'logout']);
    const s = await status();
    return s.loggedIn ? { ok: false, message: '로그아웃하지 못했어요' } : { ok: r.code === 0 || !s.loggedIn, message: '로그아웃했어요' };
  };

  const setMethodInFile = async (method: 'max' | 'apiKey') => {
    const raw = await readRaw(config.rootDir);
    raw.auth = { ...(raw.auth ?? {}), method };
    await writeRaw(config.rootDir, raw);
    config.authMethod = method; // 다음 대화부터 바로 반영
  };

  const saveApiKey = async (key: string) => {
    const k = String(key ?? '').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return { ok: false, message: 'Anthropic API 키 모양이 아니에요 (sk-ant- 로 시작해요)' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: '이 맥에서 키를 안전하게 저장할 수 없어요' };
    try {
      const f = keyFile(config);
      mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      writeFileSync(f, safeStorage.encryptString(k), { mode: 0o600 });
      apiKeyCache = k;
      await setMethodInFile('apiKey');
    } catch {
      return { ok: false, message: 'API 키를 저장하지 못했어요' };
    }
    return { ok: true, message: 'API 키를 저장했고, 이제 API 키로 일해요' };
  };

  const useMethod = async (method: 'max' | 'apiKey') => {
    if (method === 'apiKey' && !storedApiKey(config)) return { ok: false, message: '저장된 API 키가 없어요' };
    try {
      await setMethodInFile(method);
    } catch {
      return { ok: false, message: '설정을 저장하지 못했어요' };
    }
    return { ok: true, message: method === 'apiKey' ? '이제 API 키로 일해요' : '이제 Claude 계정 로그인으로 일해요' };
  };

  const removeApiKey = async () => {
    try {
      rmSync(keyFile(config), { force: true });
      apiKeyCache = '';
      if (config.authMethod === 'apiKey') await setMethodInFile('max');
    } catch {
      return { ok: false, message: 'API 키를 지우지 못했어요' };
    }
    return { ok: true, message: 'API 키를 지웠어요. Claude 계정 로그인으로 일해요' };
  };

  return { status, startLogin, submitCode, cancelLogin, logout, saveApiKey, useMethod, removeApiKey };
}
