// 외부 연결이 지금 닿는지 잠깐 확인한다. 닿지 않는 연결(사내망 밖 등)을 리더가 시작할 때 30초씩 기다리지 않게 하려는 것
import { connect as netConnect } from 'node:net';

const PROBE_MS = 2500;
const PROBE_KEEP_MS = 30_000;
const probeCache = new Map<string, { at: number; ok: boolean }>();

/** 주소(host:port)에 잠깐 접속해 보고 닿는지 본다. 사내망 밖처럼 닿지 않는 연결을 리더가 30초씩 기다리지 않게 하려는 것 */
function probeUrl(url: string, timeoutMs = PROBE_MS): Promise<boolean> {
  let host = '';
  let port = 443;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
  } catch {
    return Promise.resolve(true); // 주소를 못 읽으면 판단하지 않고 그대로 둔다
  }
  const key = `${host}:${port}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_KEEP_MS) return Promise.resolve(hit.ok);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      probeCache.set(key, { at: Date.now(), ok });
      sock.destroy();
      resolve(ok);
    };
    const sock = netConnect({ host, port });
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

/** 지금 닿는 연결만 남긴다(주소로 붙는 연결만 확인. 이 맥에서 띄우는 연결은 그대로). down 은 뺀 연결 이름 */
export async function liveMcpServers<T extends { type: string; url?: string }>(servers: Record<string, T>): Promise<{ servers: Record<string, T>; down: string[] }> {
  const names = Object.keys(servers);
  const oks = await Promise.all(names.map((n) => (servers[n].type !== 'stdio' && servers[n].url ? probeUrl(servers[n].url as string) : Promise.resolve(true))));
  const out: Record<string, T> = {};
  const down: string[] = [];
  names.forEach((n, i) => {
    if (oks[i]) out[n] = servers[n];
    else down.push(n);
  });
  return { servers: out, down };
}
