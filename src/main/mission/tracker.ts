// 미션 현황(현황판 카드)을 기억하고 바뀔 때마다 화면에 알린다.
// 상태는 runs/missions/<id>/state.json 에 원자적으로 저장하고, 바뀐 내용은 runs/events.jsonl 에 한 줄씩 덧붙인다.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ActivityItem,
  Emit,
  MemberStatus,
  MissionConfig,
  MissionStatus,
  MissionTask,
  MissionTrackerApi,
  QueuedTaskView,
  RanoConfig,
} from '../../shared/types.js';

const KEEP_ACTIVITIES = 50;
const SHOW_ACTIVITIES = 5;

interface SavedState {
  leaderState: 'idle' | 'working';
  currentTask: MissionTask | null;
  running?: MissionTask[]; // 동시에 진행 중인 과제들
  members: MemberStatus[];
  activities: ActivityItem[]; // 최신순
  pendingApprovals?: number; // 3단계: 승인 대기 건수
}

// 여러 줄 지시를 현황판에 보일 한 줄로 줄인다
export function oneLine(text: string, max = 60): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class MissionTracker implements MissionTrackerApi {
  private state: SavedState;
  private readonly stateFile: string;
  private readonly eventsFile: string;
  private readonly leaderName: string;
  private queued: QueuedTaskView[] = []; // 기다리는 과제 (디스패처가 알려 줌, 저장은 대기열 파일이 맡음)
  private readonly rejectedIn = new Set<string>(); // 승인함 반려가 있었던 과제 id

  constructor(
    private readonly config: RanoConfig,
    private readonly mission: MissionConfig,
    private readonly emit: Emit,
  ) {
    this.stateFile = path.join(config.runsDir, 'missions', mission.id, 'state.json');
    this.eventsFile = path.join(config.runsDir, 'events.jsonl');
    this.leaderName = `${mission.name} 리더`;
    this.state = this.load();

    // 앱이 일하는 도중 꺼졌으면 그 과제는 멈춘 것으로 정리한다
    if (this.state.leaderState === 'working') {
      const now = new Date().toISOString();
      const t = this.state.currentTask;
      if (t && t.status === 'running') {
        this.state.currentTask = { ...t, status: 'failed', endedAt: now, report: t.report ?? '앱이 꺼져 작업이 멈췄어요' };
      }
      this.state.running = [];
      for (const m of this.state.members) {
        if (m.state === 'working' || m.state === 'reviewing') Object.assign(m, { state: 'idle', updatedAt: now });
      }
      this.state.leaderState = 'idle';
      // 어떤 과제가 멈췄는지는 디스패처가 앱을 켤 때 한 줄로 알린다(대기열 기록 기준)
      this.changed();
    }
  }

  private load(): SavedState {
    const empty: SavedState = { leaderState: 'idle', currentTask: null, running: [], members: [], activities: [], pendingApprovals: 0 };
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      return {
        leaderState: raw?.leaderState === 'working' ? 'working' : 'idle',
        currentTask: raw?.currentTask ?? null,
        running: Array.isArray(raw?.running) ? raw.running : [],
        members: Array.isArray(raw?.members) ? raw.members : [],
        activities: Array.isArray(raw?.activities) ? raw.activities.slice(0, KEEP_ACTIVITIES) : [],
        pendingApprovals: 0, // 앱이 다시 켜지면 남은 승인 요청은 만료되므로 0 에서 시작 (승인함이 곧 다시 알려 준다)
      };
    } catch {
      return empty; // 처음이거나 파일이 깨졌으면 빈 상태로 시작
    }
  }

  status(): MissionStatus {
    return {
      missionId: this.mission.id,
      name: this.mission.name,
      leaderState: this.state.leaderState,
      currentTask: this.state.currentTask ? { ...this.state.currentTask } : null,
      running: (this.state.running ?? []).map((t) => ({ ...t })),
      members: this.state.members.map((m) => ({ ...m })),
      pendingApprovals: this.state.pendingApprovals ?? 0,
      recent: this.state.activities.slice(0, SHOW_ACTIVITIES).map((a) => ({ ...a })),
      queued: this.queued.map((q) => ({ ...q })),
    };
  }

  private runningList(): MissionTask[] {
    return (this.state.running ??= []);
  }

  /** taskId 가 없으면 가장 최근에 시작한 진행 중 과제 */
  private taskIdOr(taskId?: string): string | undefined {
    if (taskId) return taskId;
    const r = this.runningList();
    return r.length ? r[r.length - 1].id : this.state.currentTask?.id;
  }

  taskStart(task: { title: string; from: 'rano' | 'user' }): MissionTask {
    const now = new Date().toISOString();
    const t: MissionTask = { id: randomUUID(), title: oneLine(String(task.title ?? '').replace(/^\s*\[[^\]]{1,10}\]\s*/, '')), from: task.from, status: 'running', startedAt: now };
    const running = this.runningList();
    // 끝난 과제의 팀원은 정리하고, 동시에 도는 다른 과제의 팀원은 남긴다
    const live = new Set(running.map((x) => x.id));
    this.state.members = this.state.members.filter((m) => m.taskId && live.has(m.taskId));
    running.push(t);
    this.state.currentTask = t;
    this.state.leaderState = 'working';
    const also = running.length > 1 ? ` (다른 과제 ${running.length - 1}건과 동시에)` : '';
    if (task.from === 'rano') this.pushActivity('라노', `라노가 과제를 배정했어요: ${t.title}${also}`);
    else this.pushActivity(this.leaderName, `직접 지시를 받았어요: ${t.title}${also}`);
    this.changed();
    return { ...t };
  }

  taskEnd(result: { ok: boolean; report: string }, taskId?: string): void {
    const now = new Date().toISOString();
    const id = this.taskIdOr(taskId);
    const running = this.runningList();
    const at = running.findIndex((x) => x.id === id);
    const base = at >= 0 ? running[at] : this.state.currentTask && this.state.currentTask.id === id ? this.state.currentTask : null;
    const mine = (m: MemberStatus) => !m.taskId || m.taskId === id;
    const rejected = !!id && this.rejectedIn.has(id);
    const ended: MissionTask | null = base
      ? {
          ...base,
          status: result.ok ? 'done' : 'failed',
          endedAt: now,
          report: result.report,
          ...(result.ok && rejected && this.state.members.filter(mine).length === 0 ? { stoppedByRejection: true } : {}),
        }
      : null;
    if (at >= 0) running.splice(at, 1);
    for (const m of this.state.members) {
      if (mine(m) && (m.state === 'working' || m.state === 'reviewing')) Object.assign(m, { state: 'done', updatedAt: now });
    }
    // 아직 도는 과제가 있으면 그 과제를 보여 주고 리더는 계속 일하는 중
    if (running.length) {
      this.state.currentTask = running[running.length - 1];
      this.state.leaderState = 'working';
    } else {
      if (ended) this.state.currentTask = ended;
      this.state.leaderState = 'idle';
    }
    const stopped = ended?.stoppedByRejection === true;
    const what = running.length && ended ? `: ${ended.title}` : '';
    this.pushActivity(this.leaderName, (stopped ? '반려로 멈췄어요' : result.ok ? '과제 완료' : '과제가 중단됐어요') + what);
    if (id) this.rejectedIn.delete(id);
    this.changed();
  }

  memberStart(role: string, task: string, taskId?: string): void {
    const now = new Date().toISOString();
    const id = this.taskIdOr(taskId);
    const state = this.mission.reviewerRoles.includes(role) ? 'reviewing' : 'working';
    const line = oneLine(task);
    const existing = this.state.members.find((m) => m.role === role && (m.taskId ?? id) === id);
    if (existing) Object.assign(existing, { state, task: line, updatedAt: now, ...(id ? { taskId: id } : {}) });
    else this.state.members.push({ role, state, task: line, updatedAt: now, ...(id ? { taskId: id } : {}) });
    this.pushActivity(role, `작업 시작: ${line}`);
    this.changed();
  }

  memberEnd(role: string, ok: boolean, taskId?: string): void {
    const now = new Date().toISOString();
    const id = this.taskIdOr(taskId);
    const existing = this.state.members.find((m) => m.role === role && (m.taskId ?? id) === id);
    if (existing) Object.assign(existing, { state: 'done', updatedAt: now });
    else this.state.members.push({ role, state: 'done', updatedAt: now, ...(id ? { taskId: id } : {}) });
    this.pushActivity(role, ok ? '완료' : '작업이 중단됐어요');
    this.changed();
  }

  setPendingApprovals(n: number): void {
    const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if ((this.state.pendingApprovals ?? 0) === next) return;
    this.state.pendingApprovals = next;
    this.changed();
  }

  setQueue(items: QueuedTaskView[]): void {
    const next = Array.isArray(items) ? items.map((q) => ({ ...q })) : [];
    if (JSON.stringify(next) === JSON.stringify(this.queued)) return;
    this.queued = next;
    this.changed();
  }

  activity(who: string, text: string, taskId?: string): void {
    // "문서를 읽는 중" 같은 진행 중 표시만 한 줄로 합친다. 차단·승인 같은 사건은 각각 남긴다.
    const line = oneLine(text, 120);
    const id = this.taskIdOr(taskId);
    if (line.startsWith('반려됨:') && id) this.rejectedIn.add(id);
    this.pushActivity(who, line, /중(…|\.\.\.)?$/.test(line));
    this.changed();
  }

  // progress = "문서를 읽는 중" 같은 중간 움직임. 같은 사람의 중간 움직임이 이어지면 새 줄 대신 맨 위 줄을 고쳐 써서
  // 최근 활동 5칸이 '작업 시작'·'완료' 같은 중요한 일을 밀어내지 않게 한다.
  private pushActivity(who: string, text: string, progress = false) {
    const top = this.state.activities[0] as (ActivityItem & { progress?: boolean }) | undefined;
    if (progress && top && top.progress && top.who === who) {
      Object.assign(top, { at: new Date().toISOString(), text });
      return;
    }
    // 같은 사람의 같은 사건(예: 차단 안내)이 이어지면 새 줄 대신 횟수만 올린다
    const t = top as (ActivityItem & { progress?: boolean; base?: string; count?: number }) | undefined;
    if (!progress && t && !t.progress && t.who === who && (t.base ?? t.text) === text) {
      t.count = (t.count ?? 1) + 1;
      t.base = text;
      Object.assign(t, { at: new Date().toISOString(), text: `${text} (${t.count}번)` });
      return;
    }
    this.state.activities.unshift({ at: new Date().toISOString(), who, text, ...(progress ? { progress: true } : {}) });
    if (this.state.activities.length > KEEP_ACTIVITIES) this.state.activities.length = KEEP_ACTIVITIES;
  }

  // 저장 → 화면 알림 → 이벤트 기록. 어느 단계가 실패해도 앱은 계속 돈다.
  private changed() {
    const status = this.status();
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
        renameSync(tmp, this.stateFile);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } catch (e) {
      console.error('[mission tracker] 상태 저장 실패:', e);
    }
    try {
      this.emit({ kind: 'mission', status });
    } catch (e) {
      console.error('[mission tracker] 화면 알림 실패:', e);
    }
    try {
      mkdirSync(path.dirname(this.eventsFile), { recursive: true });
      appendFileSync(this.eventsFile, JSON.stringify({ at: new Date().toISOString(), kind: 'mission', status }) + '\n', 'utf-8');
    } catch (e) {
      console.error('[mission tracker] 이벤트 기록 실패:', e);
    }
  }
}
