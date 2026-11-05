// 결과물함: 과제마다 작업 대상 폴더에서 바뀐 파일, 리포 리더 보고, 검수 보고를 모은다.
// 변경 감지는 git 읽기 명령(status)과 내용 해시만 쓴다. 저장은 runs/missions/<id>/outputs.json, 목록은 미션 홈 outputs.md 표.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Emit, MissionConfig, MissionTask, OutputsApi, RanoConfig, TaskOutput } from '../../shared/types.js';
import { isBlockedPath } from '../engine/permissions.js';

const KEEP = 100;
const MAX_HASH_BYTES = 50 * 1024 * 1024; // 이보다 큰 파일은 크기·수정 시각으로 비교

export interface OutputsStoreDeps {
  config: RanoConfig;
  emit: Emit;
}

type Change = TaskOutput['changedFiles'][number]['change'];
interface Entry {
  code: string; // git status XY
  hash: string; // 내용 해시, 없는 파일은 'missing'
}
type Snapshot = Map<string, Entry>; // 절대 경로 → 상태

function run(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' }, (err, stdout) =>
      resolve({ ok: !err, stdout: String(stdout ?? '') }),
    );
  });
}

export function isEnvLike(p: string): boolean {
  const b = path.basename(p);
  return b === '.env' || b.startsWith('.env.');
}

async function hashFile(p: string): Promise<string> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return st.isDirectory() ? 'dir' : 'other';
    if (st.size > MAX_HASH_BYTES) return `big:${st.size}:${st.mtimeMs}`;
    return createHash('sha1').update(await fs.readFile(p)).digest('hex');
  } catch {
    return 'missing';
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function tildify(p: string): string {
  const h = homedir();
  return p === h ? '~' : p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p;
}

function cell(s: string): string {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
}

function today(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function commonDir(files: string[]): string {
  if (!files.length) return '';
  let parts = path.dirname(files[0]).split(path.sep);
  for (const f of files.slice(1)) {
    const q = path.dirname(f).split(path.sep);
    let i = 0;
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(path.sep) || path.sep;
}

export class OutputsStore implements OutputsApi {
  private readonly records = new Map<string, TaskOutput[]>(); // missionId → 최신순
  private readonly baselines = new Map<string, Map<string, Snapshot | null>>(); // taskId → (대상 폴더 → 시작 때 상태). null = git 리포 아님
  private mdQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OutputsStoreDeps) {
    const now = new Date().toISOString();
    for (const m of deps.config.missions) {
      const list = this.load(m.id);
      // 앱이 꺼지면서 끝나지 못한 과제는 중단으로 정리 (시작 때 상태를 잃어 변경 파일은 알 수 없다)
      let fixed = false;
      for (const r of list) {
        if (r.status === 'running') {
          Object.assign(r, { status: 'failed', endedAt: now, leaderReport: r.leaderReport ?? '앱이 꺼져 작업이 멈췄어요' });
          fixed = true;
        }
      }
      this.records.set(m.id, list);
      if (fixed) this.save(m.id);
    }
  }

  // ---- 공개 API ----
  async taskStarted(mission: MissionConfig, task: MissionTask): Promise<void> {
    const base = new Map<string, Snapshot | null>();
    for (const dir of mission.targets) base.set(dir, await this.snapshot(dir));
    this.baselines.set(task.id, base);

    const rec: TaskOutput = {
      taskId: task.id,
      missionId: mission.id,
      title: task.title,
      from: task.from,
      status: 'running',
      startedAt: task.startedAt,
      reviewReports: [],
      changedFiles: [],
    };
    const list = this.listFor(mission.id).filter((r) => r.taskId !== task.id);
    list.unshift(rec);
    this.records.set(mission.id, list.slice(0, KEEP));
    this.changed(mission.id);
  }

  reviewReport(missionId: string, taskId: string, role: string, text: string): void {
    const rec = this.find(missionId, taskId);
    if (!rec) {
      console.error('[outputs] 검수 보고를 붙일 과제를 찾지 못했어요:', missionId, taskId);
      return;
    }
    rec.reviewReports.push({ role, text, at: new Date().toISOString() });
    this.changed(missionId);
  }

  async taskEnded(mission: MissionConfig, task: MissionTask, report: string): Promise<void> {
    const base = this.baselines.get(task.id);
    this.baselines.delete(task.id);

    const changedFiles: TaskOutput['changedFiles'] = [];
    for (const dir of mission.targets) {
      const before = base?.get(dir);
      if (!before) continue; // 시작 때 상태가 없거나 git 리포가 아니면 감지하지 않는다
      const after = await this.snapshot(dir);
      if (!after) continue;
      const folder = path.basename(dir);
      for (const f of await this.diff(before, after)) {
        const rel = path.relative(dir, f.path);
        changedFiles.push(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? { ...f, rel, folder } : f);
      }
    }
    changedFiles.sort((a, b) => a.path.localeCompare(b.path));

    let rec = this.find(mission.id, task.id);
    if (!rec) {
      rec = { taskId: task.id, missionId: mission.id, title: task.title, from: task.from, status: 'running', startedAt: task.startedAt, reviewReports: [], changedFiles: [] };
      this.listFor(mission.id).unshift(rec);
    }
    Object.assign(rec, {
      title: task.title || rec.title,
      status: task.status === 'failed' ? 'failed' : 'done', // 'running' 으로 넘어와도 끝난 것으로 본다
      endedAt: task.endedAt ?? new Date().toISOString(),
      leaderReport: report,
      changedFiles,
    });
    this.changed(mission.id);

    try {
      await this.appendOutputsMd(mission, rec);
    } catch (e) {
      console.error('[outputs] outputs.md 기록 실패:', e);
    }
  }

  list(missionId?: string): TaskOutput[] {
    const all = missionId ? this.listFor(missionId) : [...this.records.values()].flat();
    return [...all]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((r) => ({ ...r, reviewReports: r.reviewReports.map((x) => ({ ...x })), changedFiles: r.changedFiles.map((x) => ({ ...x })) }));
  }

  // ---- 변경 감지 ----
  private async snapshot(dir: string): Promise<Snapshot | null> {
    // 리포 최상위에서 이 폴더까지의 상대 위치. git 은 심볼릭 링크를 푼 경로를 쓰므로, 결과 경로는 대상 폴더(dir) 기준으로 다시 맞춘다
    const pre = await run(['-C', dir, 'rev-parse', '--show-prefix']);
    if (!pre.ok) return null; // git 리포가 아니면 건너뜀
    const prefix = pre.stdout.trim();
    const st = await run(['-C', dir, 'status', '--porcelain=v1', '-uall', '-z', '--', '.']);
    if (!st.ok) return null;

    const snap: Snapshot = new Map();
    const parts = st.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      const code = e.slice(0, 2);
      const abs = path.resolve(dir, path.relative(prefix || '.', e.slice(3))); // porcelain 경로는 리포 최상위 기준
      if (code[0] === 'R' || code[0] === 'C') i++; // 다음 칸은 원래 이름
      if (isEnvLike(abs) || isBlockedPath(this.deps.config, abs)) continue; // 비밀 파일은 해시도 목록도 만들지 않는다
      snap.set(abs, { code, hash: await hashFile(abs) });
    }
    return snap;
  }

  private async diff(before: Snapshot, after: Snapshot): Promise<TaskOutput['changedFiles']> {
    const out: TaskOutput['changedFiles'] = [];
    for (const [p, a] of after) {
      const b = before.get(p);
      if (!b) {
        const change: Change = a.hash === 'missing' || a.code.includes('D') ? 'deleted' : a.code.includes('?') || a.code.includes('A') ? 'added' : 'modified';
        out.push({ path: p, change });
      } else if (a.hash !== b.hash) {
        out.push({ path: p, change: a.hash === 'missing' ? 'deleted' : b.hash === 'missing' ? 'added' : 'modified' });
      }
    }
    // 시작 때 바뀌어 있던 파일이 목록에서 사라짐: 원래대로 되돌렸거나(수정) 새 파일을 지웠다(삭제)
    for (const [p, b] of before) {
      if (after.has(p)) continue;
      const now = await exists(p);
      if (!now) out.push({ path: p, change: 'deleted' });
      else if (b.hash !== (await hashFile(p))) out.push({ path: p, change: 'modified' });
    }
    return out;
  }

  // ---- outputs.md ----
  private appendOutputsMd(mission: MissionConfig, rec: TaskOutput): Promise<void> {
    const run = this.mdQueue.then(async () => {
      const file = path.join(mission.home, 'outputs.md');
      const n = rec.changedFiles.length;
      const names = rec.changedFiles.slice(0, 3).map((f) => path.basename(f.path)).join(', ');
      const result = n ? `바뀐 파일 ${n}개: ${names}${n > 3 ? ` 외 ${n - 3}개` : ''}` : '바뀐 파일 없음';
      const where = n ? tildify(commonDir(rec.changedFiles.map((f) => f.path))) : mission.targets.map(tildify).join(', ') || '-';
      const review = rec.reviewReports.length ? '있음' : '없음';
      const status = rec.status === 'failed' ? ' (중단)' : '';
      const row = `| ${cell(rec.title + status)} | ${cell(result)} | ${cell(where)} | ${review} | ${today(new Date(rec.endedAt ?? Date.now()))} |`;

      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        content = `# ${mission.name} 결과물 목록\n\n| 과제 | 결과물 | 위치 | 검수 | 날짜 |\n|---|---|---|---|---|\n`;
      }
      const lines = content.split('\n');
      const sep = lines.findIndex((l) => /^\|\s*-{3,}/.test(l.trim()));
      if (sep >= 0) {
        let end = sep + 1;
        while (end < lines.length && lines[end].trim().startsWith('|')) end++;
        lines.splice(end, 0, row); // 표 맨 아래에 붙인다
      } else {
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        lines.push('', '| 과제 | 결과물 | 위치 | 검수 | 날짜 |', '|---|---|---|---|---|', row);
      }
      let next = lines.join('\n');
      if (!next.endsWith('\n')) next += '\n';

      const tmp = path.join(mission.home, `.outputs.md.${process.pid}.${Date.now()}.tmp`);
      try {
        await fs.writeFile(tmp, next, 'utf-8');
        await fs.rename(tmp, file);
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
    });
    this.mdQueue = run.catch(() => undefined);
    return run;
  }

  // ---- 저장 ----
  private file(missionId: string): string {
    return path.join(this.deps.config.runsDir, 'missions', missionId, 'outputs.json');
  }

  private load(missionId: string): TaskOutput[] {
    try {
      const raw = JSON.parse(readFileSync(this.file(missionId), 'utf-8'));
      return Array.isArray(raw) ? (raw as TaskOutput[]).slice(0, KEEP) : [];
    } catch {
      return [];
    }
  }

  private listFor(missionId: string): TaskOutput[] {
    let list = this.records.get(missionId);
    if (!list) this.records.set(missionId, (list = []));
    return list;
  }

  private find(missionId: string, taskId: string): TaskOutput | undefined {
    return this.listFor(missionId).find((r) => r.taskId === taskId);
  }

  private save(missionId: string) {
    const file = this.file(missionId);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(this.listFor(missionId).slice(0, KEEP), null, 2), 'utf-8');
        renameSync(tmp, file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } catch (e) {
      console.error('[outputs] 저장 실패:', e);
    }
  }

  private changed(missionId: string) {
    const list = this.listFor(missionId);
    if (list.length > KEEP) list.length = KEEP;
    this.save(missionId);
    try {
      this.deps.emit({ kind: 'outputs', items: this.list() });
    } catch (e) {
      console.error('[outputs] 화면 알림 실패:', e);
    }
  }
}
