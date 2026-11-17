// 대화 화면 위쪽의 "지금" 줄: 진행 중인 과제([멈추기])와 나를 기다리는 승인 카드([승인]·[반려]·[자세히])를 탭을 옮기지 않고 본다.
// 바로 승인은 일반 명령·작업 폴더 밖 쓰기만(approvalSafety.ts). 커밋·지우기·파일 쓰기·DB·배포·외부 게시는 빨간 표를 붙이고 [열어서 정하기]로 승인함에서 본다.
import { canQuickApprove, carefulTag, commandOf, filesOf } from './approvalSafety.js';
import { el, mustGet } from './dom.js';
import { registerTask, taskChip, taskRef } from './taskTags.js';

function minutesSince(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? '방금 시작' : m < 60 ? `${m}분째` : `${Math.floor(m / 60)}시간 ${m % 60}분째`;
}

export class ChatNow {
  private rano = window.rano;
  private missions = new Map<string, MissionStatus>();
  private pending: ApprovalRequest[] = [];
  private confirmStop: string | null = null; // 멈추기 확인 중인 과제 id
  private busy = new Set<string>();
  private expanded = false; // 진행 중 과제 여러 건을 펼쳐 보는 중
  private readonly box = mustGet<HTMLDivElement>('chat-now');

  onOpenApprovals: (id: string) => void = () => {};
  /** 과제 띠에서 과제를 고르거나([전체]는 null) 풀었을 때 */
  onPickTask: (taskId: string | null) => void = () => {};
  /** 승인 카드의 과제 제목을 찾는다 */
  taskTitle: (missionId: string, taskId: string) => string | undefined = () => undefined;
  private selected: string | null = null; // 골라 보는 과제
  private hiddenNew = 0; // 골라 보는 동안 가려진 새 말 수

  /** 골라 보는 과제를 바꾼다(화면만. 대화 거르기는 부르는 쪽이 한다) */
  select(taskId: string | null): void {
    this.selected = taskId;
    this.hiddenNew = 0;
    this.render();
  }
  noteHiddenNew(): void {
    this.hiddenNew++;
    this.render();
  }

  /** 과제 띠에 올릴 과제: 진행 중 + 승인 대기가 있는 과제 + 골라 보는 과제 */
  private tasks(): { ref: TaskRef; waiting: number; running: boolean }[] {
    const out = new Map<string, { ref: TaskRef; waiting: number; running: boolean }>();
    for (const { mission, task } of this.running()) out.set(task.id, { ref: { missionId: mission.missionId, taskId: task.id, title: task.title }, waiting: 0, running: true });
    for (const a of this.pending) {
      if (!a.taskId) continue;
      const cur = out.get(a.taskId) ?? { ref: { missionId: a.missionId, taskId: a.taskId, title: taskRef(a.taskId)?.title || this.taskTitle(a.missionId, a.taskId) || '' }, waiting: 0, running: false };
      cur.waiting++;
      out.set(a.taskId, cur);
    }
    if (this.selected && !out.has(this.selected)) out.set(this.selected, { ref: taskRef(this.selected) ?? { missionId: '', taskId: this.selected, title: '' }, waiting: 0, running: false });
    for (const t of out.values()) registerTask(t.ref);
    return [...out.values()];
  }

  constructor() {
    // 걸린 시간 표시를 1분마다 새로
    setInterval(() => {
      if (!this.box.hidden) this.render();
    }, 60_000);
  }

  setMission(s: MissionStatus): void {
    if (!s || typeof s.missionId !== 'string') return;
    this.missions.set(s.missionId, s);
    for (const t of [...(s.running ?? []), ...(s.currentTask ? [s.currentTask] : [])]) registerTask({ missionId: s.missionId, taskId: t.id, title: t.title });
    this.render();
  }

  setApprovals(items: ApprovalRequest[]): void {
    if (!Array.isArray(items)) return;
    this.pending = items.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const a of this.pending) if (a.taskId) registerTask({ missionId: a.missionId, taskId: a.taskId, title: this.taskTitle(a.missionId, a.taskId) ?? '' });
    this.render();
  }

  private running(): { mission: MissionStatus; task: MissionTask }[] {
    const out: { mission: MissionStatus; task: MissionTask }[] = [];
    for (const m of this.missions.values()) {
      const list = m.running?.length ? m.running : m.leaderState === 'working' && m.currentTask?.status === 'running' ? [m.currentTask] : [];
      for (const t of list) out.push({ mission: m, task: t });
    }
    return out;
  }

  private async decide(a: ApprovalRequest, decision: 'approve' | 'reject'): Promise<void> {
    if (this.busy.has(a.id)) return;
    this.busy.add(a.id);
    this.render();
    try {
      await this.rano.approvalDecide(a.id, { decision });
    } catch {
      // 실패하면 카드가 그대로 남아 다시 누를 수 있다
    }
    this.busy.delete(a.id);
    this.render();
  }

  private async stop(missionId: string, taskId: string): Promise<void> {
    this.confirmStop = null;
    this.busy.add(taskId);
    this.render();
    try {
      await this.rano.missionStop(missionId, taskId);
    } catch {
      // 현황이 바뀌지 않으면 줄이 그대로 남는다
    }
    this.busy.delete(taskId);
    this.render();
  }

  private render(): void {
    const running = this.running();
    this.box.replaceChildren();
    const tasks = this.tasks();
    this.box.hidden = !running.length && !this.pending.length && !this.selected;
    if (this.box.hidden) return;

    // 과제 띠: 과제가 둘 이상 걸려 있거나 하나를 골라 보는 중일 때. 누르면 그 과제 것만 보이고, 말도 그 과제로 간다
    if (tasks.length > 1 || this.selected) {
      const bar = el('div', 'task-bar');
      bar.setAttribute('aria-label', '과제 골라 보기');
      for (const t of tasks) {
        const chip = taskChip(t.ref, (id) => this.onPickTask(this.selected === id ? null : id), 22);
        chip.classList.add('task-chip-big');
        chip.classList.toggle('task-chip-on', this.selected === t.ref.taskId);
        chip.setAttribute('aria-pressed', String(this.selected === t.ref.taskId));
        if (t.waiting) {
          const n = el('span', 'task-wait', String(t.waiting));
          n.title = `내 답을 기다리는 카드 ${t.waiting}장`;
          chip.appendChild(n);
        } else if (!t.running) chip.appendChild(el('span', 'task-done', '끝남'));
        bar.appendChild(chip);
      }
      const all = el('button', `task-all${this.selected ? '' : ' task-chip-on'}`, this.selected && this.hiddenNew ? `전체 · 새 말 ${this.hiddenNew}` : '전체');
      all.type = 'button';
      all.title = '모든 과제와 라노 대화를 함께 보기';
      all.addEventListener('click', () => this.onPickTask(null));
      bar.appendChild(all);
      this.box.appendChild(bar);
    }

    // 골라 보는 과제의 카드를 앞에 둔다
    const pending = this.selected ? [...this.pending.filter((a) => a.taskId === this.selected), ...this.pending.filter((a) => a.taskId !== this.selected)] : this.pending;
    for (const a of pending.slice(0, 2)) {
      const row = el('div', 'now-row now-approval');
      row.dataset.approval = a.id;
      const text = el('div', 'now-text');
      text.appendChild(el('span', 'now-tag now-tag-wait', '승인 대기'));
      if (a.taskId && tasks.length > 1) text.appendChild(taskChip({ taskId: a.taskId, title: taskRef(a.taskId)?.title || '과제' }, (id) => this.onPickTask(this.selected === id ? null : id)));
      const risk = carefulTag(a.kind, a);
      if (risk) text.appendChild(el('span', 'now-tag now-tag-risk', risk));
      text.appendChild(el('span', 'now-title', a.title));
      const what = [a.who, a.what].filter(Boolean).join(' · ');
      if (what) text.appendChild(el('span', 'now-sub', what));
      const simple = canQuickApprove(a);
      // 바로 승인 줄에는 무엇을 승인하는지 실제 명령(앱이 비밀을 가린 판)을, 명령이 없으면(폴더 밖 파일 쓰기) 파일 위치를 한 줄 보인다
      const cmd = simple ? commandOf(a.detail) : '';
      const file = simple && !cmd ? filesOf(a) : '';
      if (cmd || file) {
        const line = el('span', 'now-cmd', cmd ? `명령: ${cmd}` : `파일: ${file}`);
        line.title = cmd ? commandOf(a.detail, 2000) : filesOf(a, 2000);
        text.appendChild(line);
      }
      row.appendChild(text);
      const btns = el('div', 'now-btns');
      if (simple) {
        const ok = el('button', 'now-btn now-btn-main', '승인');
        ok.type = 'button';
        ok.disabled = this.busy.has(a.id);
        ok.addEventListener('click', () => void this.decide(a, 'approve'));
        const no = el('button', 'now-btn', '반려');
        no.type = 'button';
        no.disabled = this.busy.has(a.id);
        no.addEventListener('click', () => void this.decide(a, 'reject'));
        btns.append(ok, no);
      }
      const more = el('button', `now-btn${simple ? '' : ' now-btn-main'}`, simple ? '자세히' : '열어서 정하기');
      more.type = 'button';
      more.addEventListener('click', () => this.onOpenApprovals(a.id));
      btns.appendChild(more);
      row.appendChild(btns);
      this.box.appendChild(row);
    }
    if (pending.length > 2) {
      const more = el('button', 'now-more now-more-btn', `승인 대기 ${pending.length - 2}건 더 있어요 · 승인함에서 보기`);
      more.type = 'button';
      more.addEventListener('click', () => this.onOpenApprovals(pending[2].id));
      this.box.appendChild(more);
    }
    // 진행 중 과제가 여러 건이면 한 줄로 접는다(대화 영역을 밀어 올리지 않게)
    if (running.length > 1) {
      const row = el('div', 'now-row');
      const text = el('div', 'now-text');
      text.appendChild(el('span', 'now-tag', `진행 중 ${running.length}건`));
      const by = new Map<string, number>();
      for (const r of running) by.set(r.mission.name, (by.get(r.mission.name) ?? 0) + 1);
      text.appendChild(el('span', 'now-sub', [...by].map(([n, c]) => `${n} ${c}건`).join(' · ')));
      row.appendChild(text);
      const btns = el('div', 'now-btns');
      const toggle = el('button', 'now-btn', this.expanded ? '접기' : '펼치기');
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        this.expanded = !this.expanded;
        this.render();
      });
      btns.appendChild(toggle);
      row.appendChild(btns);
      this.box.appendChild(row);
      if (!this.expanded && !running.some((r) => r.task.id === this.confirmStop)) return;
    }

    for (const { mission, task } of running) {
      const row = el('div', 'now-row');
      const text = el('div', 'now-text');
      text.appendChild(el('span', 'now-tag', '진행 중'));
      if (tasks.length > 1) text.appendChild(taskChip({ taskId: task.id, title: '' }, undefined, 0)).classList.add('task-chip-dot');
      text.appendChild(el('span', 'now-title', `${mission.name} · ${task.title}`));
      const working = mission.members.filter((m) => (m.state === 'working' || m.state === 'reviewing') && (!m.taskId || m.taskId === task.id));
      text.appendChild(el('span', 'now-sub', `${minutesSince(task.startedAt)}${working.length ? ` · ${working.some((m) => m.state === 'reviewing') ? '검수 중' : `팀원 ${working.length}명 작업 중`}` : ''}`));
      row.appendChild(text);
      const btns = el('div', 'now-btns');
      if (this.confirmStop === task.id) {
        const yes = el('button', 'now-btn now-btn-danger', '정말 멈추기');
        yes.type = 'button';
        yes.addEventListener('click', () => void this.stop(mission.missionId, task.id));
        const no = el('button', 'now-btn', '계속하기');
        no.type = 'button';
        no.addEventListener('click', () => {
          this.confirmStop = null;
          this.render();
        });
        btns.append(yes, no);
      } else {
        const stop = el('button', 'now-btn', this.busy.has(task.id) ? '멈추는 중…' : '멈추기');
        stop.type = 'button';
        stop.disabled = this.busy.has(task.id);
        stop.title = '이 과제를 멈춰요. 이미 고친 파일은 그대로 남아요';
        stop.addEventListener('click', () => {
          this.confirmStop = task.id;
          this.render();
        });
        btns.appendChild(stop);
      }
      row.appendChild(btns);
      this.box.appendChild(row);
    }
  }
}
