// 같은 미션 동시 작업 시험: 리더 묶음(쉬는 리더에게, 모두 바쁘면 한 명 더)과 현황판(과제 여러 개 동시 진행)
// 실행: npm run build 후 `node --test dist/main/mission/parallel.test.js`
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MissionConfig, MissionTask, RanoConfig } from '../../shared/types.js';
import { MissionLeaderPool, type PoolLeader } from './leaderPool.js';
import { MissionTracker } from './tracker.js';

/** 가짜 리더: run 이 끝나기를 손으로 정한다 */
class FakeLeader implements PoolLeader {
  pending = 0;
  task: MissionTask | null = null;
  finish: (() => void) | null = null;
  seenOthers: string[] = [];
  closed = false;
  constructor(
    readonly slot: number,
    private readonly others: () => MissionTask[],
  ) {}
  busy() {
    return this.pending > 0;
  }
  current() {
    return this.task;
  }
  close() {
    this.closed = true;
  }
  run(t: { text: string }) {
    this.pending++;
    this.task = { id: `t-${t.text}`, title: t.text, from: 'user', status: 'running', startedAt: new Date().toISOString() };
    this.seenOthers = this.others().map((x) => x.title);
    return new Promise<{ ok: boolean; report: string }>((resolve) => {
      this.finish = () => {
        this.pending--;
        this.task = null;
        resolve({ ok: true, report: `${t.text} 끝` });
      };
    });
  }
}

test('리더 묶음: 쉬는 리더에게 맡기고, 모두 바쁘면 한 명 더 만든다', async () => {
  const made: FakeLeader[] = [];
  const pool = new MissionLeaderPool((slot, others) => {
    const l = new FakeLeader(slot, others);
    made.push(l);
    return l;
  });
  assert.equal(made.length, 1);
  const a = pool.run({ text: 'A', from: 'user' });
  assert.equal(pool.busy(), false); // 새 과제는 기다리지 않는다
  assert.equal(pool.working(), 1);
  const b = pool.run({ text: 'B', from: 'user' });
  const c = pool.run({ text: 'C', from: 'user' });
  assert.equal(made.length, 3);
  assert.deepEqual(made.map((l) => l.slot), [0, 1, 2]);
  assert.deepEqual(made[2].seenOthers.sort(), ['A', 'B']); // 다른 리더의 과제를 안다
  assert.equal(pool.working(), 3);
  made[1].finish!();
  assert.equal((await b).report, 'B 끝');
  // 끝난 리더를 다시 쓴다(새로 만들지 않음)
  const d = pool.run({ text: 'D', from: 'user' });
  assert.equal(made.length, 3);
  assert.equal(made[1].task?.title, 'D');
  made[0].finish!();
  made[2].finish!();
  made[1].finish!();
  await Promise.all([a, c, d]);
  assert.equal(pool.working(), 0);
  pool.close();
  assert.ok(made.every((l) => l.closed));
  assert.equal((await pool.run({ text: 'E', from: 'user' })).ok, false); // 닫은 뒤에는 시작하지 않음
});

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-par-')));
const mission = { id: 'm', name: '시험', reviewerRoles: ['reviewer'] } as unknown as MissionConfig;
const config = { runsDir: path.join(ROOT, 'runs') } as unknown as RanoConfig;

test('현황판: 과제 여러 개가 동시에 돌면 모두 진행 중, 하나가 끝나도 리더는 일하는 중', () => {
  const t = new MissionTracker(config, mission, () => {});
  const a = t.taskStart({ title: '적정 사용량', from: 'user' });
  t.memberStart('dev', 'A 화면', a.id);
  const b = t.taskStart({ title: '3G', from: 'user' });
  t.memberStart('dev', 'B 화면', b.id); // 같은 역할이라도 과제가 다르면 따로
  let s = t.status();
  assert.equal(s.leaderState, 'working');
  assert.deepEqual(s.running?.map((x) => x.title), ['적정 사용량', '3G']);
  assert.equal(s.members.length, 2); // 두 번째 과제가 시작해도 첫 과제 팀원이 지워지지 않음
  t.taskEnd({ ok: true, report: 'A 끝' }, a.id);
  s = t.status();
  assert.equal(s.leaderState, 'working');
  assert.deepEqual(s.running?.map((x) => x.title), ['3G']);
  assert.equal(s.currentTask?.id, b.id);
  assert.equal(s.members.find((m) => m.taskId === a.id)?.state, 'done');
  assert.equal(s.members.find((m) => m.taskId === b.id)?.state, 'working');
  t.activity('앱', '반려됨: 커밋', b.id);
  t.taskEnd({ ok: true, report: 'B 끝' }, b.id);
  s = t.status();
  assert.equal(s.leaderState, 'idle');
  assert.equal(s.running?.length, 0);
  assert.equal(s.currentTask?.id, b.id);
  assert.equal(s.currentTask?.status, 'done');
  // 다음 과제가 시작하면 끝난 과제 팀원은 정리
  t.taskStart({ title: '다음', from: 'rano' });
  assert.equal(t.status().members.length, 0);
});

test('현황판: 과제 하나만 돌 때는 예전과 같다(taskId 없이 불러도 됨)', () => {
  const t = new MissionTracker({ runsDir: path.join(ROOT, 'runs2') } as unknown as RanoConfig, mission, () => {});
  t.taskStart({ title: '하나', from: 'user' });
  t.memberStart('reviewer', '검수');
  assert.equal(t.status().members[0].state, 'reviewing');
  t.memberEnd('reviewer', true);
  t.activity('앱', '반려됨: 파일 쓰기');
  t.taskEnd({ ok: true, report: '끝' });
  const s = t.status();
  assert.equal(s.leaderState, 'idle');
  assert.equal(s.currentTask?.status, 'done');
  assert.equal(s.members[0].state, 'done');
});
