// 같은 미션 동시 작업 (2026-11-12 사용자 결정: 같은 작업 폴더에서, 개수 제한 없이)
// 과제가 들어올 때 쉬고 있는 리더가 있으면 그 리더에게, 모두 일하는 중이면 리더를 한 명 더 만들어 맡긴다.
// 리더마다 권한 상태(과제·승인·팀 구성)가 따로라 서로의 승인이 섞이지 않는다. 현황판·대화 기록은 미션 하나를 같이 쓴다.
import type { MissionLeaderApi, MissionTask, ChatAttachment } from '../../shared/types.js';

type RunTask = Parameters<MissionLeaderApi['run']>[0];

/** 리더 하나. MissionLeader 가 이 꼴을 만족한다 */
export interface PoolLeader extends MissionLeaderApi {
  /** 지금 맡은 과제(없으면 null) */
  current?(): MissionTask | null;
}

export class MissionLeaderPool implements MissionLeaderApi {
  private readonly slots: PoolLeader[] = [];
  private closed = false;

  /** make(slot, others): slot 번째 리더를 만든다. others() 는 그 리더 말고 다른 리더가 지금 하고 있는 과제들 */
  constructor(private readonly make: (slot: number, others: () => MissionTask[]) => PoolLeader) {
    this.slots.push(this.create(0));
  }

  private create(slot: number): PoolLeader {
    let self: PoolLeader | null = null;
    const others = () => this.slots.filter((l) => l !== self).map((l) => l.current?.() ?? null).filter((t): t is MissionTask => !!t);
    self = this.make(slot, others);
    return self;
  }

  /** 쉬는 리더에게 맡기고, 모두 일하는 중이면 한 명 더 만든다. 바로 시작하므로 기다리지 않는다 */
  run(task: RunTask & { attachments?: ChatAttachment[] }): ReturnType<MissionLeaderApi['run']> {
    if (this.closed) return Promise.resolve({ ok: false, report: '앱이 종료되는 중이라 시작하지 않았어요' });
    let leader = this.slots.find((l) => !l.busy());
    if (!leader) {
      leader = this.create(this.slots.length);
      this.slots.push(leader);
    }
    return leader.run(task);
  }

  /** 동시 작업이라 새 과제가 기다릴 일이 없다 */
  busy(): boolean {
    return false;
  }

  /** 지금 일하는 리더 수 */
  working(): number {
    return this.slots.filter((l) => l.busy()).length;
  }

  /** 진행 중 과제를 멈춘다. taskId 가 없으면 일하는 리더 모두 */
  stop(taskId?: string): boolean {
    let any = false;
    for (const l of this.slots) if (l.stop?.(taskId)) any = true;
    return any;
  }

  close(): void {
    this.closed = true;
    for (const l of this.slots) l.close?.();
  }
}
