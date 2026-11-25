// 라노·사용자의 지시를 미션 리포 리더에게 넘기고, 끝나면 미션 기억에 남긴 뒤 라노에게 보고를 전달한다.
import { taskTitle } from './taskText.js';
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
import { clock, FOLLOW_MAX_MINUTES, FOLLOW_MAX_ROUNDS, FOLLOW_MIN_MINUTES, followUpTask, FollowUpStore, type FollowUp } from './followUps.js';
import { redactCommand } from './leaderPermissions.js';

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
  notifyRano: (text: string, kind?: 'report' | 'direct', workId?: string) => Promise<void>;
  onReport?: (card: ReportCard) => void; // 리더 보고가 오면 바로 (첫 줄 카드)
  todos?: TodoStoreApi; // 할 일 목록: 배정·보고에 맞춰 상태를 바꾼다
  works?: { linkTask(workId: string, taskId: string): void; byTask(taskId: string): { id: string } | undefined; get?(id: string | undefined | null): { id: string; name: string } | undefined }; // 업무(대화 방): 과제를 업무에 단다
}

const PROGRESS_FILE = '진행업무.md';

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 보고 첫 줄: 제목(# …)은 건너뛰고 첫 본문 줄을 쓴다. 본문이 없으면 제목이라도 쓴다. 120자까지 */
export function firstLine(text: string): string {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const body = lines.filter((l) => !l.startsWith('#'));
  // "1. 한 일" 처럼 번호와 짧은 이름만 있는 절 머리는 건너뛰고 그 아래 내용을 쓴다
  const line = body.find((l) => !SECTION_HEAD.test(l)) ?? body[0] ?? lines[0] ?? '(보고 없음)';
  return oneLine(line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, ''), 120);
}

/** 번호와 짧은 이름만 있는 절 머리 줄 (예: "1. 한 일", "**2) 결과**", "3. 남은 일:") */
const SECTION_HEAD = /^(?:[-*]\s+)?\**\d+\s*[.)]\s*[^:：.!?]{1,12}?\**\s*[:：]?\**$/;

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
  private readonly followUps = new Map<string, FollowUpStore>(); // 미션별 "나중에 다시 확인" 예약
  private readonly followTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly followRounds = new Map<string, number>(); // 업무(없으면 과제)별 지금까지 돈 다시 확인 횟수

  constructor(private readonly deps: MissionDispatcherDeps) {
    for (const m of deps.config.missions) this.queues.set(m.id, new TaskQueueStore(deps.config.runsDir, m.id));
  }

  private followStore(missionId: string): FollowUpStore {
    let s = this.followUps.get(missionId);
    if (!s) {
      s = new FollowUpStore(this.deps.config.runsDir, missionId);
      this.followUps.set(missionId, s);
    }
    return s;
  }

  /** 리더의 check_later: 몇 분 뒤 같은 미션·같은 업무로 확인 과제를 맡기도록 예약한다. 리더에게 돌려줄 안내 글 */
  scheduleFollowUp(missionId: string, taskId: string, minutes: number, what: string): string {
    const mission = this.deps.config.missions.find((m) => m.id === missionId);
    if (!mission) return '미션을 찾지 못해 예약하지 못했어요. 보고에 "나중에 확인할 일"로 적어 주세요.';
    const text = String(what ?? '').trim();
    if (text.length < 10) return '무엇을 어떻게 확인할지 조금 더 자세히 적어 다시 불러 주세요(다음 과제의 리더가 그 글만 보고 확인해요).';
    if (!Number.isFinite(minutes) || minutes < FOLLOW_MIN_MINUTES || minutes > FOLLOW_MAX_MINUTES) return `${FOLLOW_MIN_MINUTES}분에서 ${FOLLOW_MAX_MINUTES}분 사이로 정해 다시 불러 주세요.`;
    const workId = this.deps.works?.byTask(taskId)?.id;
    const todo = workId ? this.deps.todos?.list().find((x) => x.workId === workId && x.status !== 'done') : undefined;
    const round = (this.followRounds.get(workId ?? taskId) ?? 0) + 1;
    if (round > FOLLOW_MAX_ROUNDS) return `이 업무에서 다시 확인을 이미 ${FOLLOW_MAX_ROUNDS}번 했어요. 더 예약하지 않아요. 지금 상태와 사용자가 직접 확인할 방법을 보고에 적어 주세요.`;
    const item = this.followStore(missionId).add({ dueAt: Date.now() + Math.round(minutes) * 60_000, what: redactCommand(text).slice(0, 1500), fromTaskId: taskId, ...(workId ? { workId } : {}), ...(todo ? { todoId: todo.id } : {}), round });
    this.armFollowUp(missionId, item);
    this.deps.trackers.get(missionId)?.activity('앱', `${clock(item.dueAt)} 에 다시 확인하도록 예약했어요: ${oneLine(text, 60)}`);
    return `${clock(item.dueAt)}(${Math.round(minutes)}분 뒤)에 다시 확인하도록 예약했어요. 지금은 기다리지 말고, 지금까지 한 일과 "${clock(item.dueAt)} 에 무엇을 다시 확인하기로 했는지"를 보고에 적고 이 과제를 끝내세요.`;
  }

  private armFollowUp(missionId: string, item: FollowUp): void {
    const old = this.followTimers.get(item.id);
    if (old) clearTimeout(old);
    const t = setTimeout(() => this.fireFollowUp(missionId, item.id), Math.max(1_000, item.dueAt - Date.now()));
    t.unref?.();
    this.followTimers.set(item.id, t);
  }

  /** 예약한 시각이 됨: 같은 미션·같은 업무로 확인 과제를 맡긴다 (시험에서도 직접 부른다) */
  fireFollowUp(missionId: string, id: string): void {
    this.followTimers.delete(id);
    if (this.closing) return;
    const store = this.followStore(missionId);
    const item = store.all().find((x) => x.id === id);
    if (!item) return; // 새 예약으로 바뀌었거나 지워짐
    store.remove(id);
    const found = this.find(missionId);
    if (typeof found === 'string') return;
    const { mission, leader } = found;
    const todos = this.deps.todos;
    const todo = item.todoId && todos ? todos.get(item.todoId) : undefined;
    // 사용자가 그 사이 그 일을 끝냈으면 다시 확인하지 않는다
    if (item.todoId && (!todo || todo.status === 'done')) {
      this.deps.trackers.get(missionId)?.activity('앱', `예약한 다시 확인은 하지 않았어요(그 일을 이미 끝내셨어요): ${oneLine(item.what, 40)}`);
      return;
    }
    this.followRounds.set(item.workId ?? item.fromTaskId ?? id, item.round);
    if (todo && todos) this.safeTodo(() => todos.update(todo.id, { status: 'active', queued: leader.busy(), note: '예약한 다시 확인 중' }, 'app'));
    this.deps.trackers.get(missionId)?.activity('앱', `예약한 다시 확인을 시작해요: ${oneLine(item.what, 60)}`);
    this.runInBackground(mission, leader, followUpTask(item), 'rano', todo?.id, false, false, [], false, item.workId);
  }

  /** 예약 목록(시험·화면용) */
  followUpList(missionId: string): FollowUp[] {
    return this.followStore(missionId).all();
  }

  /** 이 할 일(업무)에 걸린 다시 확인 예약(없으면 undefined) */
  private pendingFollowUp(missionId: string, todoId?: string, taskId?: string): FollowUp | undefined {
    return this.followStore(missionId).all().find((x) => (!!todoId && x.todoId === todoId) || (!!taskId && x.fromTaskId === taskId));
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
        this.runInBackground(mission, leader, e.text, e.from, e.todoId, true, !!e.planFirst, e.attachments ?? [], !!e.preSync, e.workId);
      }
      if (waiting.length) tracker?.activity('앱', `앱을 다시 켜서 기다리던 과제 ${waiting.length}건을 이어서 맡겼어요`);
      this.pushQueue(mission.id);
    }
    // 예약해 둔 다시 확인: 시각이 지났으면 조금 뒤 바로, 아니면 그 시각에
    for (const mission of this.deps.config.missions) {
      for (const item of this.followStore(mission.id).all()) {
        const key = item.workId ?? item.fromTaskId ?? item.id;
        this.followRounds.set(key, Math.max(this.followRounds.get(key) ?? 0, item.round - 1));
        this.armFollowUp(mission.id, item.dueAt < Date.now() + 30_000 ? { ...item, dueAt: Date.now() + 30_000 } : item);
      }
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

  async assign(missionId: string, text: string, todoId?: string, planFirst?: boolean, preSync?: boolean, workId?: string): Promise<string> {
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
    // 할 일을 적지 않았어도 같은 업무 방에 달린 할 일이 있으면 그 할 일의 과제로 본다(업무 하나가 곧 할 일 하나, 0.9.16)
    if (!todo && !todoId && workId && todos) todo = todos.list().find((x) => x.workId === workId && x.status !== 'done' && (!x.missionId || x.missionId === mission.id));
    const wasBusy = leader.busy();
    const alongside = leader.working?.() ?? 0; // 같은 미션에서 동시에 하고 있는 과제 수
    if (todo && todos) {
      this.safeTodo(() => todos.update(todo!.id, { status: 'active', queued: wasBusy, note: wasBusy ? '앞 과제가 끝나면 시작' : '', ...(workId && !todo!.workId ? { workId } : {}) }, 'app'));
    }
    this.runInBackground(mission, leader, text, 'rano', todo?.id, false, !!planFirst, [], !!preSync, workId);
    return wasBusy
      ? `${mission.name} 리더가 앞 과제를 하는 중이에요. 앞 과제가 끝나면 이어서 진행해요. 진행 상황은 현황판에서 볼 수 있어요.`
      : alongside > 0
        ? `${mission.name}에서 하고 있는 과제 ${alongside}건과 동시에 시작했어요(같은 작업 폴더, 리더를 한 명 더 붙임). 진행 상황은 현황판에서 볼 수 있어요. 끝나면 보고가 도착해요.`
        : `${mission.name} 리더에게 배정했어요. 진행 상황은 현황판에서 볼 수 있어요. 끝나면 보고가 도착해요.`;
  }

  /** 진행 중 과제에 사용자의 말을 덧붙여 전한다(라노의 tell_running_task) */
  note(missionId: string, text: string, taskId?: string): { ok: boolean; message: string } {
    const found = this.find(missionId);
    if (typeof found === 'string') return { ok: false, message: found };
    if (!text.trim()) return { ok: false, message: '전할 말이 비어 있어요' };
    const n = found.leader.note?.(text, taskId) ?? 0;
    return n > 0
      ? { ok: true, message: `${found.mission.name}에서 진행 중인 과제${n > 1 ? ` ${n}건` : ''}에 전했어요. 리더가 지금 하는 단계를 마치는 대로 읽고 반영해요(승인을 기다리는 중이면 그 카드를 처리한 뒤).` }
      : { ok: false, message: `${found.mission.name}에 지금 진행 중인 과제가 없어요. 새 과제로 맡기려면 assign_to_mission 을 쓰세요.` };
  }

  /** 사용자가 진행 중 과제를 멈춘다 */
  stop(missionId: string, taskId?: string): { ok: boolean; message?: string } {
    const found = this.find(missionId);
    if (typeof found === 'string') return { ok: false, message: found };
    const stopped = found.leader.stop?.(taskId) ?? false;
    return stopped ? { ok: true } : { ok: false, message: '지금 멈출 수 있는 과제가 없어요' };
  }

  async userSend(missionId: string, text: string, attachments: ChatAttachment[] = [], workId?: string): Promise<void> {
    const found = this.find(missionId);
    if (typeof found === 'string') throw new Error(found);
    const { mission, leader } = found;
    this.deps
      .notifyRano(`[앱 알림] 사용자가 ${mission.name} 리더에게 직접 지시했습니다: ${text}${attachments.length ? ` (그림 ${attachments.length}개 첨부)` : ''}`, 'direct', workId)
      .catch((e) => console.error('[dispatcher] 라노 알림 실패:', e));
    this.runInBackground(mission, leader, text, 'user', undefined, false, false, attachments, userAskedSync(text), workId); // 사용자가 직접 쓴 말
  }

  /** 그 업무의 끝나지 않은 할 일을 찾거나 새로 만들어 진행 중으로 둔다. 업무를 모르면 undefined */
  private ensureTodo(mission: MissionConfig, workId: string): string | undefined {
    const todos = this.deps.todos;
    const work = this.deps.works?.get?.(workId);
    if (!todos || !work) return undefined;
    try {
      let t = todos.list().find((x) => x.workId === workId && x.status !== 'done' && (!x.missionId || x.missionId === mission.id));
      if (!t) {
        t = todos.add(mission.id, work.name, 'rano');
        todos.update(t.id, { workId }, 'app');
      }
      todos.update(t.id, { status: 'active', queued: false, note: '' }, 'app');
      return t.id;
    } catch (e) {
      console.error('[dispatcher] 업무의 할 일 만들기 실패:', e);
      return undefined;
    }
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

  private runInBackground(mission: MissionConfig, leader: MissionLeaderApi, text: string, from: 'rano' | 'user', todoId?: string, resumed = false, planFirst = false, attachments: ChatAttachment[] = [], preSync = false, workId?: string) {
    const todos = this.deps.todos;
    const queue = this.queues.get(mission.id);
    // 업무 하나가 곧 할 일 하나: 이 업무에 살아 있는 할 일이 없으면 앱이 만든다(끝낸 업무에 새 일이 붙어도 "확인할 보고"에 뜨게, 0.9.19)
    if (!todoId && workId && !resumed) todoId = this.ensureTodo(mission, workId);
    const entry = queue?.add({ text, from, todoId, resumed, planFirst, preSync, attachments, ...(workId ? { workId } : {}) });
    const onTask = (taskId: string) => {
      if (workId) this.deps.works?.linkTask(workId, taskId);
    };
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
      .run({ text, from, onStart, onTask, planFirst, ...(preSync ? { preSync: true } : {}), ...(attachments.length ? { attachments } : {}) })
      .catch((e) => ({ ok: false, report: `리더 실행 중 오류가 났어요: ${e instanceof Error ? e.message : String(e)}` }))
      .then((result) => {
        if (this.closing) return; // 앱이 꺼지며 멈춘 과제는 다음 실행 때 이어 간다
        if (entry) queue?.remove(entry.id);
        this.pushQueue(mission.id);
        this.todoAfterRun(todoId, result.ok, 'taskId' in result ? result.taskId : undefined, mission.id);
        return this.afterRun(mission, text, result, todoId, 'taskId' in result ? result.taskId : undefined);
      })
      .catch((e) => console.error('[dispatcher] 마무리 처리 실패:', e));
  }

  // 리더 일이 끝나면 연결된 할 일을 확인 요청(성공) 또는 대기(중단)로 돌린다. 사용자가 이미 완료했으면 그대로 둔다.
  private todoAfterRun(todoId: string | undefined, ok: boolean, taskId?: string, missionId?: string) {
    const todos = this.deps.todos;
    if (!todoId || !todos) return;
    const t = todos.get(todoId);
    if (!t || t.status === 'done') return;
    const now = stamp().slice(5);
    // 리더가 다시 확인을 예약하고 끝냈으면 "확인 요청"이 아니라 "기다리는 중"으로 둔다(그 시각에 앱이 확인 과제를 맡긴다)
    const later = ok && missionId ? this.pendingFollowUp(missionId, todoId, taskId) : undefined;
    if (later) {
      this.safeTodo(() => todos.update(todoId, { status: 'hold', note: `${clock(later.dueAt)} 에 리더가 다시 확인해요`, ...(taskId ? { taskId } : {}) }, 'app'));
      return;
    }
    this.safeTodo(() =>
      todos.update(todoId, ok ? { status: 'review', note: `리더 보고 도착 ${now}`, ...(taskId ? { taskId } : {}) } : { status: 'waiting', note: `리더 작업이 중단됨 ${now}` }, 'app'),
    );
  }

  private async afterRun(mission: MissionConfig, text: string, result: { ok: boolean; report: string }, todoId?: string, taskId?: string) {
    const title = taskTitle(text);
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
    // 연결된 할 일에 단계가 있으면 지금 단계 상태를 함께 알려, 보고로 확인된 단계를 라노가 표시하게 한다
    let stepNote = '';
    try {
      const steps = todoId ? this.deps.todos?.get(todoId)?.steps : undefined;
      if (steps?.length)
        stepNote = `\n[앱 안내] 이 할 일의 단계: ${steps.map((s, i) => `${i + 1}.${s.done ? '✓' : ''}${s.title}`).join(' → ')}. 이 보고로 끝난 것이 확인된 단계는 todo_update 의 doneSteps 로 표시하세요(마지막 단계는 사용자가 표시).`;
    } catch {
      stepNote = '';
    }
    await this.deps.notifyRano(`[앱 알림] ${mission.name} 리더 보고 (과제: ${title}, 결과: ${outcome}${todoId ? `, 연결된 할 일 id: ${todoId}` : ''}${taskId ? `, 과제 id: ${taskId}` : ''})${stepNote}\n\n${result.report}`, 'report');
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
