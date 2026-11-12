// 대화 화면 위쪽의 "지금" 줄: 진행 중인 과제([멈추기])와 나를 기다리는 승인 카드([승인]·[반려]·[자세히])를 탭을 옮기지 않고 본다.
import { el, mustGet } from './dom.js';

/** 그 자리에서 바로 승인·반려할 수 있는 카드 종류(고를 것·볼 것이 없는 단순 확인). 나머지는 [자세히]로 승인함에서 본다 */
const SIMPLE = new Set<string>(['command', 'write', 'outsideWrite', 'commit', 'delete', 'external', 'db', 'deploy']);

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
  private readonly box = mustGet<HTMLDivElement>('chat-now');

  onOpenApprovals: (id: string) => void = () => {};

  constructor() {
    // 걸린 시간 표시를 1분마다 새로
    setInterval(() => {
      if (!this.box.hidden) this.render();
    }, 60_000);
  }

  setMission(s: MissionStatus): void {
    if (!s || typeof s.missionId !== 'string') return;
    this.missions.set(s.missionId, s);
    this.render();
  }

  setApprovals(items: ApprovalRequest[]): void {
    if (!Array.isArray(items)) return;
    this.pending = items.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    this.box.hidden = !running.length && !this.pending.length;
    if (this.box.hidden) return;

    for (const a of this.pending.slice(0, 4)) {
      const row = el('div', 'now-row now-approval');
      row.dataset.approval = a.id;
      const text = el('div', 'now-text');
      text.appendChild(el('span', 'now-tag now-tag-wait', '승인 대기'));
      text.appendChild(el('span', 'now-title', a.title));
      const what = [a.who, a.what].filter(Boolean).join(' · ');
      if (what) text.appendChild(el('span', 'now-sub', what));
      row.appendChild(text);
      const btns = el('div', 'now-btns');
      const simple = SIMPLE.has(a.kind) && !a.decisionItems?.length && !a.bundle?.length;
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
    if (this.pending.length > 4) this.box.appendChild(el('div', 'now-more', `승인 대기 ${this.pending.length - 4}건 더 있어요 (승인함에서 볼 수 있어요)`));

    for (const { mission, task } of running) {
      const row = el('div', 'now-row');
      const text = el('div', 'now-text');
      text.appendChild(el('span', 'now-tag', '진행 중'));
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
