// 라노·사용자의 지시를 미션 리포 리더에게 넘기고, 끝나면 미션 기억에 남긴 뒤 라노에게 보고를 전달한다.
import { promises as fs } from 'node:fs';
import { userAskedSync } from './syncIntent.js';
import path from 'node:path';
import type {
  MissionConfig,
  MissionDispatcherApi,
  MissionLeaderApi,
  MissionStatus,
  MissionTrackerApi,
  RanoConfig,
  TodoStoreApi,
  ChatAttachment,
} from '../../shared/types.js';
import { autoCommit } from '../memory/autoCommit.js';
import { oneLine } from './tracker.js';
import { TaskQueueStore } from './taskQueue.js';

/** 리더 보고 도착 카드 (라노 요약을 기다리지 않고 바로 화면에) */
export interface ReportCard {
  missionId: string;
  missionName: string;
  ok: boolean;
  firstLine: string;
}

export interface MissionDispatcherDeps {
  config: RanoConfig;
  leaders: Map<string, MissionLeaderApi>;
  trackers: Map<string, MissionTrackerApi>;
  notifyRano: (text: string, kind?: 'report' | 'direct') => Promise<void>;
  onReport?: (card: ReportCard) => void; // 리더 보고가 오면 바로 (첫 줄 카드)
  todos?: TodoStoreApi; // 할 일 목록: 배정·보고에 맞춰 상태를 바꾼다
}

const PROGRESS_FILE = '진행업무.md';

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 보고 첫 줄: 제목(# …)은 건너뛰고 첫 본문 줄을 쓴다. 본문이 없으면 제목이라도 쓴다. 120자까지 */
export function firstLine(text: string): string {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines.find((l) => !l.startsWith('#')) ?? lines[0] ?? '(보고 없음)';
  return oneLine(line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, ''), 120);
}

/**
 * 미션 기억(진행업무)에 남길 한 줄: 보고의 "4. 결과" 절 첫 내용(없으면 첫 줄).
 * 첫 줄은 "한 일"이라 반려·중단된 일도 "했습니다"처럼 읽힐 수 있어, 실제 결과를 남긴다.
 */
export function progressLine(report: string): string {
  const text = String(report ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^[\s>#_*-]*4\s*[.)]\s*결과(?!물)/.test(l));
  if (at >= 0) {
    const rest = lines[at].replace(/^[\s>#_*-]*4\s*[.)]\s*결과\s*[:：]?\s*/, '').trim();
    if (rest) return oneLine(rest, 120);
    const next = lines.slice(at + 1).map((l) => l.trim()).find((l) => l && !/^[\s>#_*-]*[1-9]\s*[.)]/.test(l) && !l.startsWith('```'));
    if (next) return oneLine(next.replace(/^#+\s*/, '').replace(/^[-*]\s+/, ''), 120);
  }
  return firstLine(text);
}

/** 보고 카드용 첫 줄: firstLine 에서 꾸밈 기호(**, `)만 더 뺀다 (화면에는 글자 그대로 넣는다) */
export function reportFirstLine(report: string): string {
  return firstLine(String(report ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'));
}

export class MissionDispatcher implements MissionDispatcherApi {
  private fileQueue: Promise<unknown> = Promise.resolve(); // 진행업무.md 쓰기를 하나씩
  private readonly queues = new Map<string, TaskQueueStore>(); // 미션별 대기열 기록 (앱을 다시 켜도 이어 가기)
  private closing = false; // 앱이 꺼지는 중이면 대기열·할 일·미션 기억을 건드리지 않는다

  constructor(private readonly deps: MissionDispatcherDeps) {
    for (const m of deps.config.missions) this.queues.set(m.id, new TaskQueueStore(deps.config.runsDir, m.id));
  }

  /** 앱이 꺼질 때 main 이 부른다. 이후 멈추는 과제는 '중단'으로 기록하지 않고 다음 실행 때 이어 간다. */
  shutdown(): void {
    this.closing = true;
  }

  /** 앱을 켤 때 한 번: 기다리던 과제는 받은 순서대로 다시 맡기고, 하다 멈춘 과제는 정리해서 알린다. */
  resumePending(): void {
    for (const mission of this.deps.config.missions) {
      const queue = this.queues.get(mission.id);
      const leader = this.deps.leaders.get(mission.id);
      const tracker = this.deps.trackers.get(mission.id);
      if (!queue || !leader) continue;
      const entries = queue.all();
      if (!entries.length) continue;
      const todos = this.deps.todos;
      for (const e of entries.filter((x) => x.state === 'running')) {
        queue.remove(e.id);
        tracker?.activity('앱', `앱이 꺼져 하던 과제가 멈췄어요: ${oneLine(e.text, 40)} — 다시 맡기려면 라노에게 말씀해 주세요`);
        if (e.todoId && todos) {
          const t = todos.get(e.todoId);
          if (t && t.status !== 'done') this.safeTodo(() => todos.update(e.todoId!, { status: 'waiting', note: '앱이 꺼져 멈춤 · 다시 맡겨 주세요' }, 'app'));
        }
      }
      const waiting = entries.filter((x) => x.state === 'queued');
      for (const e of waiting) {
        queue.remove(e.id);
        const busy = leader.busy();
        if (e.todoId && todos) {
          const t = todos.get(e.todoId);
          if (t && t.status !== 'done') this.safeTodo(() => todos.update(e.todoId!, { status: 'active', queued: busy, note: busy ? '앞 과제가 끝나면 시작' : '' }, 'app'));
        }
        this.runInBackground(mission, leader, e.text, e.from, e.todoId, true, !!e.planFirst, e.attachments ?? [], !!e.preSync);
      }
      if (waiting.length) tracker?.activity('앱', `앱을 다시 켜서 기다리던 과제 ${waiting.length}건을 이어서 맡겼어요`);
      this.pushQueue(mission.id);
    }
  }

  private pushQueue(missionId: string) {
    const q = this.queues.get(missionId);
    const t = this.deps.trackers.get(missionId);
    if (q && t) {
      try {
        t.setQueue(q.view());
      } catch (e) {
        console.error('[dispatcher] 대기열 표시 실패:', e);
      }
    }
  }

  private find(missionId: string): { mission: MissionConfig; leader: MissionLeaderApi } | string {
    const mission = this.deps.config.missions.find((m) => m.id === missionId);
    const leader = this.deps.leaders.get(missionId);
    if (!mission || !leader) {
      const ids = this.deps.config.missions.map((m) => `${m.id}(${m.name})`).join(', ') || '없음';
      return `"${missionId}" 미션을 찾지 못했어요. 등록된 미션: ${ids}`;
    }
    return { mission, leader };
  }

  async assign(missionId: string, text: string, todoId?: string, planFirst?: boolean, preSync?: boolean): Promise<string> {
    const found = this.find(missionId);
    if (typeof found === 'string') return found;
    if (!String(text ?? '').trim()) return '배정할 과제 내용이 비어 있어요.';
    const { mission, leader } = found;
    const todos = this.deps.todos;
    let todo = todoId && todos ? todos.get(todoId) : undefined;
    if (todoId && !todo) return `할 일 "${todoId}" 을(를) 찾지 못했어요. todo_list 로 id 를 확인하거나 todoId 없이 배정하세요.`;
    if (todo && todo.missionId && todo.missionId !== mission.id) {
      return `할 일 "${todo.title}" 은(는) 다른 미션(${todo.missionId})의 일이에요. 맞는 미션으로 배정하세요.`;
    }
    if (todo?.status === 'done') todo = undefined; // 사용자가 완료한 일은 건드리지 않는다
    const wasBusy = leader.busy();
    if (todo && todos) {
      this.safeTodo(() => todos.update(todo!.id, { status: 'active', queued: wasBusy, note: wasBusy ? '앞 과제가 끝나면 시작' : '' }, 'app'));
    }
    this.runInBackground(mission, leader, text, 'rano', todo?.id, false, !!planFirst, [], !!preSync);
    return wasBusy
      ? `${mission.name} 리더가 앞 과제를 하는 중이에요. 앞 과제가 끝나면 이어서 진행해요. 진행 상황은 현황판에서 볼 수 있어요.`
      : `${mission.name} 리더에게 배정했어요. 진행 상황은 현황판에서 볼 수 있어요. 끝나면 보고가 도착해요.`;
  }

  async userSend(missionId: string, text: string, attachments: ChatAttachment[] = []): Promise<void> {
    const found = this.find(missionId);
    if (typeof found === 'string') throw new Error(found);
    const { mission, leader } = found;
    this.deps
      .notifyRano(`[앱 알림] 사용자가 ${mission.name} 리더에게 직접 지시했습니다: ${text}${attachments.length ? ` (그림 ${attachments.length}개 첨부)` : ''}`, 'direct')
      .catch((e) => console.error('[dispatcher] 라노 알림 실패:', e));
    this.runInBackground(mission, leader, text, 'user', undefined, false, false, attachments, userAskedSync(text)); // 사용자가 직접 쓴 말
  }

  private safeTodo(fn: () => void) {
    try {
      fn();
    } catch (e) {
      console.error('[dispatcher] 할 일 갱신 실패:', e);
    }
  }

  statuses(): MissionStatus[] {
    return [...this.deps.trackers.values()].map((t) => t.status());
  }

  private runInBackground(mission: MissionConfig, leader: MissionLeaderApi, text: string, from: 'rano' | 'user', todoId?: string, resumed = false, planFirst = false, attachments: ChatAttachment[] = [], preSync = false) {
    const todos = this.deps.todos;
    const queue = this.queues.get(mission.id);
    const entry = queue?.add({ text, from, todoId, resumed, planFirst, preSync, attachments });
    this.pushQueue(mission.id);
    const onStart = () => {
      if (this.closing) return;
      if (entry) queue?.markRunning(entry.id);
      this.pushQueue(mission.id);
      if (todoId && todos) {
        const t = todos.get(todoId);
        if (t?.status === 'active') this.safeTodo(() => todos.update(todoId, { queued: false, note: '' }, 'app'));
      }
    };
    leader
      .run({ text, from, onStart, planFirst, ...(preSync ? { preSync: true } : {}), ...(attachments.length ? { attachments } : {}) })
      .catch((e) => ({ ok: false, report: `리더 실행 중 오류가 났어요: ${e instanceof Error ? e.message : String(e)}` }))
      .then((result) => {
        if (this.closing) return; // 앱이 꺼지며 멈춘 과제는 다음 실행 때 이어 간다
        if (entry) queue?.remove(entry.id);
        this.pushQueue(mission.id);
        this.todoAfterRun(todoId, result.ok, 'taskId' in result ? result.taskId : undefined);
        return this.afterRun(mission, text, result);
      })
      .catch((e) => console.error('[dispatcher] 마무리 처리 실패:', e));
  }

  // 리더 일이 끝나면 연결된 할 일을 확인 요청(성공) 또는 대기(중단)로 돌린다. 사용자가 이미 완료했으면 그대로 둔다.
  private todoAfterRun(todoId: string | undefined, ok: boolean, taskId?: string) {
    const todos = this.deps.todos;
    if (!todoId || !todos) return;
    const t = todos.get(todoId);
    if (!t || t.status === 'done') return;
    const now = stamp().slice(5);
    this.safeTodo(() =>
      todos.update(todoId, ok ? { status: 'review', note: `리더 보고 도착 ${now}`, ...(taskId ? { taskId } : {}) } : { status: 'waiting', note: `리더 작업이 중단됨 ${now}` }, 'app'),
    );
  }

  private async afterRun(mission: MissionConfig, text: string, result: { ok: boolean; report: string }) {
    const title = oneLine(text);
    const outcome = result.ok ? '완료' : '중단';
    const tracker = this.deps.trackers.get(mission.id);

    // ⓪ 보고 첫 줄 카드를 바로 (라노 요약은 뒤에 따로 온다)
    try {
      this.deps.onReport?.({ missionId: mission.id, missionName: mission.name, ok: result.ok, firstLine: reportFirstLine(result.report) });
    } catch (e) {
      console.error('[dispatcher] 보고 카드 표시 실패:', e);
    }

    // ① 미션 기억에 한 줄
    try {
      await this.appendProgress(mission, `- ${stamp()} · ${title} · ${outcome} · ${progressLine(result.report)}`);
    } catch (e) {
      console.error('[dispatcher] 진행업무.md 기록 실패:', e);
      tracker?.activity('앱', '미션 기억(진행업무)에 기록하지 못했어요');
    }

    // ② 미션 홈 자동 저장
    if (this.deps.config.autoCommit) {
      const r = await autoCommit(mission.home, `미션 기억 갱신: ${title} (${outcome})`);
      if (!r.committed && r.note && !r.note.includes('바뀐 내용이 없')) {
        tracker?.activity('앱', `미션 기억 자동 저장 실패: ${r.note}`);
      }
    }

    // ③ 라노에게 보고
    await this.deps.notifyRano(`[앱 알림] ${mission.name} 리더 보고 (과제: ${title}, 결과: ${outcome})\n\n${result.report}`, 'report');
  }

  // 제목·설명 아래, 기존 항목들 위에 새 줄을 넣는다(최신순)
  private appendProgress(mission: MissionConfig, line: string): Promise<void> {
    const run = this.fileQueue.then(async () => {
      const dir = path.join(mission.home, 'memory');
      const file = path.join(dir, PROGRESS_FILE);
      let content = '';
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        content = '# 진행 업무\n\n과제별 진행 상황을 최신순으로 적는다.\n';
      }
      const lines = content.split('\n');
      const firstItem = lines.findIndex((l) => l.startsWith('- '));
      if (firstItem >= 0) {
        lines.splice(firstItem, 0, line);
      } else {
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        lines.push('', line, '');
      }
      let next = lines.join('\n');
      if (!next.endsWith('\n')) next += '\n';

      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${PROGRESS_FILE}.${process.pid}.${Date.now()}.tmp`);
      try {
        await fs.writeFile(tmp, next, 'utf-8');
        await fs.rename(tmp, file);
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
    });
    this.fileQueue = run.catch(() => undefined);
    return run;
  }
}
