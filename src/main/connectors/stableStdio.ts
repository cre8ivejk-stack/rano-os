// 외부 연결(이 맥에서 띄우는 MCP 서버)을 감싸는 작은 중간 프로그램 (0.9.16).
// 어떤 서버는 켤 때마다 도구 설명 안의 목록 순서를 바꿔서 준다(뜻은 같음). 도구 설명이 한 글자라도 다르면
// 엔진이 그 뒤의 모든 내용(다른 도구 설명·지침)을 과제마다 새로 읽어 값이 크게 든다.
// 그래서 처음 본 도구 설명을 파일에 적어 두고, 뜻이 같은 설명이 오면 적어 둔 글자 그대로 넘긴다. 뜻이 달라지면 새것으로 바꿔 적는다.
// 쓰는 법: node stableStdio.js <적어 둘 파일> <원래 명령> [인자…]. 주고받는 다른 말은 그대로 지나간다.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIST = /^[\w.*:-]+(\s*,\s*[\w.*:-]+)+$/;

/** 뜻이 같은지 견줄 꼴: 키 순서, 쉼표로 이은 낱말 목록의 순서, 낱말만 든 배열의 순서를 맞춘다 */
export function canonTool(v: unknown): unknown {
  if (typeof v === 'string') return LIST.test(v) ? v.split(',').map((x) => x.trim()).sort().join(',') : v;
  if (Array.isArray(v)) {
    const a = v.map(canonTool);
    return a.every((x) => typeof x === 'string' || typeof x === 'number') ? [...a].sort() : a;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonTool((v as Record<string, unknown>)[k])]));
  return v;
}

/** 도구 목록을 적어 둔 것과 맞춘다. 뜻이 같으면 적어 둔 글자 그대로, 다르면 새것을 쓰고 적어 둔다. changed: 적어 둔 것이 바뀌었는지 */
export function stabilizeTools(tools: unknown[], cache: Record<string, unknown>): { tools: unknown[]; changed: boolean } {
  let changed = false;
  const out = tools.map((t) => {
    const name = (t as { name?: unknown })?.name;
    if (typeof name !== 'string') return t;
    const old = cache[name];
    if (old !== undefined && JSON.stringify(canonTool(old)) === JSON.stringify(canonTool(t))) return old;
    cache[name] = t;
    changed = true;
    return t;
  });
  return { tools: out, changed };
}

function loadCache(file: string): Record<string, unknown> {
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8'));
    return j && typeof j === 'object' && j.tools && typeof j.tools === 'object' ? (j.tools as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function saveCache(file: string, cache: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tools: cache }));
    renameSync(tmp, file);
  } catch {
    // 적어 두지 못해도 연결은 그대로 쓴다
  }
}

/** 줄 단위(JSON 한 줄씩)로 끊어 넘기는 도우미 */
function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf-8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      onLine(line);
    }
  };
}

function main(): void {
  const [cacheFile, command, ...args] = process.argv.slice(2);
  if (!cacheFile || !command) {
    process.stderr.write('stableStdio: 인자가 모자라요\n');
    process.exit(2);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 이 프로그램을 띄울 때만 쓴 값이라 원래 서버에는 넘기지 않는다
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const listIds = new Set<string>();
  process.stdin.on(
    'data',
    lines((line) => {
      try {
        const m = JSON.parse(line);
        if (m && m.method === 'tools/list' && m.id !== undefined) listIds.add(String(m.id));
      } catch {
        // JSON 이 아닌 줄도 그대로 넘긴다
      }
      child.stdin.write(`${line}\n`);
    }),
  );
  process.stdin.on('end', () => child.stdin.end());
  child.stdout.on(
    'data',
    lines((line) => {
      let outLine = line;
      try {
        const m = JSON.parse(line);
        if (m && m.id !== undefined && listIds.has(String(m.id)) && Array.isArray(m.result?.tools)) {
          listIds.delete(String(m.id));
          const cache = loadCache(cacheFile);
          const r = stabilizeTools(m.result.tools, cache);
          if (r.changed) saveCache(cacheFile, cache);
          m.result.tools = r.tools;
          outLine = JSON.stringify(m);
        }
      } catch {
        // 그대로 넘긴다
      }
      process.stdout.write(`${outLine}\n`);
    }),
  );
  child.stdin.on('error', () => undefined);
  process.stdout.on('error', () => undefined);
  child.on('error', (e) => {
    process.stderr.write(`stableStdio: 원래 명령을 띄우지 못했어요: ${e.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, () => child.kill(s));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
