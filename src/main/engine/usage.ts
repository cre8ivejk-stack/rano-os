// Claude 사용량 기록: 라노·리더가 일을 하나 끝낼 때마다 쓴 양(토큰·API 기준 예상 비용·시간)을 runs/usage.jsonl 에 남기고,
// 구독 계정의 사용 한도(5시간·주간 %)는 엔진이 알려 줄 때마다 runs/usage-limits.json 에 최신값을 둔다.
// 이어 가는 대화(resume)는 엔진이 누적값을 주므로, 같은 세션의 앞 기록을 빼서 이번 일만큼만 센다.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UsageSummary } from '../../shared/types.js';

interface UsageRec {
  at: string;
  who: string; // 'rano' 또는 미션 id
  session?: string;
  cost: number; // 이번 일 (API 기준 예상, 달러)
  tokens: number; // 이번 일 (입력+출력+캐시)
  ms: number;
  cumCost: number; // 세션 누적 (다음 기록에서 빼기용)
  cumTokens: number;
}

let runsDir = '';
let last = new Map<string, { cost: number; tokens: number }>(); // 세션 → 마지막 누적값
let loaded = false;

export function initUsage(dir: string): void {
  runsDir = dir;
}

function file(): string {
  return path.join(runsDir, 'usage.jsonl');
}
function limitsFile(): string {
  return path.join(runsDir, 'usage-limits.json');
}

function readAll(): UsageRec[] {
  if (!runsDir || !existsSync(file())) return [];
  const out: UsageRec[] = [];
  for (const line of readFileSync(file(), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return out;
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  last = new Map();
  for (const r of readAll()) if (r.session) last.set(r.session, { cost: r.cumCost, tokens: r.cumTokens });
}

/** 엔진의 결과 메시지(type: 'result') 하나를 기록한다 */
export function recordResult(who: string, msg: any, resumed = false): void {
  if (!runsDir || !msg) return;
  try {
    ensureLoaded();
    const mu = (msg.modelUsage ?? {}) as Record<string, any>;
    let cumTokens = 0;
    for (const u of Object.values(mu)) cumTokens += (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0);
    const cumCost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0;
    const session = typeof msg.session_id === 'string' ? msg.session_id : undefined;
    const prev = session ? last.get(session) : undefined;
    // 누적값이 앞보다 작으면(새로 시작) 그대로 쓴다.
    // 기록이 없던 예전 대화를 이어 간 첫 번째 일은 앞의 누적이 섞여 있어 기준점만 남기고 세지 않는다
    const baselineOnly = resumed && !prev;
    const cost = baselineOnly ? 0 : prev && cumCost >= prev.cost ? cumCost - prev.cost : cumCost;
    const tokens = baselineOnly ? 0 : prev && cumTokens >= prev.tokens ? cumTokens - prev.tokens : cumTokens;
    if (session) last.set(session, { cost: cumCost, tokens: cumTokens });
    const rec: UsageRec = { at: new Date().toISOString(), who, ...(session ? { session } : {}), cost, tokens, ms: msg.duration_ms ?? 0, cumCost, cumTokens };
    mkdirSync(runsDir, { recursive: true });
    appendFileSync(file(), JSON.stringify(rec) + '\n', 'utf-8');
  } catch {
    // 기록 실패가 일을 막지 않게 한다
  }
}

/** 엔진의 사용 한도 알림(type: 'rate_limit_event')을 최신값으로 둔다 */
export function recordLimit(info: any): void {
  if (!runsDir || !info?.rateLimitType) return;
  try {
    let cur: Record<string, any> = {};
    try {
      cur = JSON.parse(readFileSync(limitsFile(), 'utf-8'));
    } catch {
      cur = {};
    }
    cur[info.rateLimitType] = {
      status: info.status,
      ...(typeof info.utilization === 'number' ? { utilization: info.utilization } : {}),
      ...(info.resetsAt ? { resetsAt: new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString() } : {}),
      at: new Date().toISOString(),
    };
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(limitsFile(), JSON.stringify(cur, null, 2), 'utf-8');
  } catch {
    // 무시
  }
}

/** 엔진에게 구독 사용 한도(5시간·주간 %)를 물어 최신값으로 둔다. 시험 기능이라 없거나 실패하면 넘어간다 */
export async function fetchPlanLimits(q: any): Promise<void> {
  const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (!runsDir || typeof fn !== 'function') return;
  try {
    const r: any = await Promise.race([fn.call(q, { skipBehaviors: true }), new Promise((res) => setTimeout(() => res(null), 8000))]);
    const rl = r?.rate_limits;
    if (!r?.rate_limits_available || !rl) return;
    let cur: Record<string, any> = {};
    try {
      cur = JSON.parse(readFileSync(limitsFile(), 'utf-8'));
    } catch {
      cur = {};
    }
    const at = new Date().toISOString();
    for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      const w = rl[key];
      if (!w || typeof w.utilization !== 'number') continue;
      cur[key] = { ...(cur[key] ?? {}), status: cur[key]?.status ?? 'allowed', utilization: w.utilization, ...(w.resets_at ? { resetsAt: w.resets_at } : {}), at };
    }
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(limitsFile(), JSON.stringify(cur, null, 2), 'utf-8');
  } catch {
    // 무시
  }
}

/** 이 맥 시간 기준 날짜 YYYY-MM-DD */
function ymd(d: Date): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** 이번 주(월요일 0시부터)·오늘 미션별 사용량과 최신 한도 */
export function usageSummary(names: Record<string, string>): UsageSummary {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(dayStart);
  weekStart.setDate(dayStart.getDate() - ((dayStart.getDay() + 6) % 7)); // 월요일
  const rows = new Map<string, { who: string; name: string; weekRuns: number; weekTokens: number; weekCost: number; todayRuns: number; todayTokens: number; todayCost: number }>();
  const days = new Map<string, number>(); // 최근 7일 날짜별 토큰
  for (let i = 6; i >= 0; i--) {
    const d = new Date(dayStart);
    d.setDate(dayStart.getDate() - i);
    days.set(ymd(d), 0);
  }
  for (const r of readAll()) {
    const t = new Date(r.at);
    const key = ymd(t);
    if (days.has(key)) days.set(key, (days.get(key) ?? 0) + (r.tokens || 0));
    if (t < weekStart) continue;
    let row = rows.get(r.who);
    if (!row) rows.set(r.who, (row = { who: r.who, name: names[r.who] ?? (r.who === 'rano' ? '라노' : r.who), weekRuns: 0, weekTokens: 0, weekCost: 0, todayRuns: 0, todayTokens: 0, todayCost: 0 }));
    row.weekRuns++;
    row.weekTokens += r.tokens || 0;
    row.weekCost += r.cost || 0;
    if (t >= dayStart) {
      row.todayRuns++;
      row.todayTokens += r.tokens || 0;
      row.todayCost += r.cost || 0;
    }
  }
  let limits: UsageSummary['limits'] = [];
  try {
    const cur = JSON.parse(readFileSync(limitsFile(), 'utf-8')) as Record<string, any>;
    limits = Object.entries(cur).map(([type, v]) => ({ type, status: v.status, utilization: v.utilization, resetsAt: v.resetsAt, at: v.at }));
  } catch {
    limits = [];
  }
  return {
    weekStart: weekStart.toISOString(),
    rows: [...rows.values()].sort((a, b) => b.weekTokens - a.weekTokens),
    days: [...days.entries()].map(([date, tokens]) => ({ date, tokens })),
    limits,
  };
}
