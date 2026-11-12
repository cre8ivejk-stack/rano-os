// 0.9.4 사용성 시험: 할 일 표시 떼기, 과제 제목, 중단 보고, 지금 현황 글, 터미널 세션 읽기, 과제 멈추기
// 실행: npm run build 후 `node --test dist/main/mission/usability094.test.js`
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MissionStatus, MissionTask } from '../../shared/types.js';
import { buildStatusNote } from '../engine/ranoStatus.js';
import { fallbackChoices, hideMarkers, hideTodoMarker, matchTodosByTitle, parseDirectNotice, parseReportNotice, splitMarkers, splitTodoMarker, todoIdsFromTool } from '../engine/todoLink.js';
import { findUnanswered } from '../engine/ranoLanes.js';
import { MissionLeaderPool, type PoolLeader } from './leaderPool.js';
import { interruptedReport, taskTitle } from './taskText.js';
import { describeTerminalSessions, listTerminalSessions, projectDirName } from './terminalSessions.js';

test('할 일 표시: 답 끝의 〔할일 id〕 를 떼어 내고 id 를 돌려준다', () => {
  assert.deepEqual(splitTodoMarker('정리했어요.\n\n〔할일 ab12cd34〕'), { text: '정리했어요.', ids: ['ab12cd34'] });
  assert.deepEqual(splitTodoMarker('두 가지예요.\n〔할일: ab12cd34, 00ff00ff〕\n'), { text: '두 가지예요.', ids: ['ab12cd34', '00ff00ff'] });
  assert.deepEqual(splitTodoMarker('표시 없는 답'), { text: '표시 없는 답', ids: [] });
  // 본문 가운데 있는 괄호는 건드리지 않는다
  assert.deepEqual(splitTodoMarker('〔참고〕 이건 본문이에요'), { text: '〔참고〕 이건 본문이에요', ids: [] });
  assert.deepEqual(splitTodoMarker('답\n〔할일 없는id〕').ids, []);
});

test('할 일 표시: 쓰는 중인 글에서는 끝의 표시(닫히지 않은 것 포함)를 가린다', () => {
  assert.equal(hideTodoMarker('정리했어요.\n\n〔할일 ab12cd34〕'), '정리했어요.');
  assert.equal(hideTodoMarker('정리했어요.\n\n〔할일 ab12'), '정리했어요.');
  assert.equal(hideTodoMarker('정리했어요.\n\n〔할'), '정리했어요.');
  assert.equal(hideTodoMarker('정리했어요.\n\n〔'), '정리했어요.');
  assert.equal(hideTodoMarker('본문 〔참고 자료'), '본문 〔참고 자료'); // 다른 괄호는 그대로
  assert.equal(hideTodoMarker('그냥 글'), '그냥 글');
});

test('할 일 표시: 라노가 부른 도구에서 다룬 할 일 id', () => {
  assert.deepEqual(todoIdsFromTool('mcp__rano-todo__todo_update', { id: 'ab12cd34', status: 'active' }), ['ab12cd34']);
  assert.deepEqual(todoIdsFromTool('mcp__rano-mission__assign_to_mission', { missionId: 'm', task: 'x', todoId: '00ff00ff' }), ['00ff00ff']);
  assert.deepEqual(todoIdsFromTool('mcp__rano-mission__assign_to_mission', { missionId: 'm', task: 'x' }), []);
  assert.deepEqual(todoIdsFromTool('mcp__rano-todo__todo_list', {}), []);
});

test('과제 제목: 지시문에서 짧은 제목만 뽑는다', () => {
  assert.equal(taskTitle('[자료 수집] 전국 지사 팩스번호 목록 만들기. 사용자님(비개발자)의 요청이에요.\n\n목적: 공문을 보내야 해요.'), '[자료 수집] 전국 지사 팩스번호 목록 만들기');
  assert.equal(taskTitle('[마무리] 지사 팩스번호 목록 — 직전 과제가 마지막 단계에서 중단됐어요. 이어서 마무리하고 보고만 해 주세요.'), '[마무리] 지사 팩스번호 목록');
  assert.equal(taskTitle('README.md 를 읽고 세 줄로 요약한 다음, menu.txt 맨 아래에 "k" 한 줄을 추가해 주세요. 커밋은 하지 마세요.'), 'README.md 를 읽고 세 줄로 요약한 다음, menu.txt 맨 아래에 "…');
  assert.equal(taskTitle('빠른 모드로 해 주세요. 로그인 화면 문구를 고쳐 주세요.'), '로그인 화면 문구를 고쳐 주세요');
  assert.equal(taskTitle('pull 해 줘'), 'pull 해 줘');
  assert.equal(taskTitle('화면 개편 목적: 메뉴를 줄인다'), '화면 개편');
});

test('중단 보고: 사유와 한글 진행 메모 마지막 몇 줄만 보인다(영어 혼잣말은 뺀다)', () => {
  const partial = ['Let me write the handoff memo first, then launch both members in parallel.', '공식 페이지를 받아올게요. 권장: 승인', 'Now rebuild, and copy the raw source files.', '재검수는 조건부 통과예요. 문구를 고칠게요.'].join('\n\n');
  const r = interruptedReport('사용자가 [멈추기]를 눌러 과제를 멈췄어요.', partial);
  assert.match(r, /^\*\*중간에 멈췄어요\.\*\* 사용자가 \[멈추기\]/);
  assert.match(r, /- 공식 페이지를 받아올게요/);
  assert.match(r, /- 재검수는 조건부 통과예요/);
  assert.doesNotMatch(r, /Let me write|Now rebuild/);
  assert.equal(interruptedReport('연결에 문제가 생겼어요.', ''), '**중간에 멈췄어요.** 연결에 문제가 생겼어요.');
});

const task = (title: string, extra: Partial<MissionTask> = {}): MissionTask => ({ id: `t-${title}`, title, from: 'rano', status: 'running', startedAt: '2026-11-12T06:13:52.000Z', ...extra });
const status = (extra: Partial<MissionStatus>): MissionStatus => ({ missionId: 'm1', name: '홈페이지', leaderState: 'idle', currentTask: null, members: [], pendingApprovals: 0, recent: [], ...extra });

test('지금 현황: 진행 중 과제·승인 대기·터미널 세션을 한 묶음으로', () => {
  const t = task('메뉴 개편');
  const note = buildStatusNote({
    missions: [
      status({ leaderState: 'working', currentTask: t, running: [t], members: [{ role: 'reviewer', state: 'reviewing', taskId: t.id } as never] }),
      status({ missionId: 'm2', name: '회의록', currentTask: task('주간 확인', { status: 'done', endedAt: '2026-11-12T06:23:50.000Z' }) }),
    ],
    pending: [{ missionId: 'm1', title: '인터넷으로 보내기·받기: example.com' }],
    terminal: [{ missionName: '홈페이지', text: '- 「화면 수정」 (마지막 11. 12. 14:07)' }, { missionName: '회의록', text: '' }],
  });
  assert.match(note, /\[앱 안내 — 지금 현황/);
  assert.match(note, /홈페이지: 진행 중 「메뉴 개편」/);
  assert.match(note, /일하는 팀원: reviewer\(검수 중\)/);
  assert.match(note, /사용자 승인을 기다리는 카드 1장: 「인터넷으로 보내기·받기: example.com」/);
  assert.match(note, /회의록: 쉬는 중 \(마지막 과제 「주간 확인」 끝남/);
  assert.match(note, /터미널\(Claude Code\)에서 따로 진행한 최근 세션/);
  assert.match(note, /「화면 수정」/);
  // 터미널 세션이 없으면 그 묶음은 붙이지 않는다
  assert.doesNotMatch(buildStatusNote({ missions: [status({})], pending: [] }), /터미널/);
});

test('터미널 세션: 작업 폴더에서 터미널로 연 세션만, 사용자가 친 말만 짧게, 비밀은 가림', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-term-')));
  const target = path.join(root, 'work', 'site');
  const projects = path.join(root, 'projects');
  const dir = path.join(projects, projectDirName(target));
  mkdirSync(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  // 터미널에서 연 세션
  writeFileSync(
    path.join(dir, 'aaaa.jsonl'),
    [
      line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: '메뉴 화면 글자를 키워 줘' } }),
      line({ type: 'assistant', entrypoint: 'cli', message: { role: 'assistant', content: [{ type: 'text', text: '고쳤어요' }] } }),
      line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'secret output' }] } }),
      line({ type: 'user', entrypoint: 'cli', isMeta: true, message: { role: 'user', content: '<system-reminder>무시</system-reminder>' } }),
      line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'api_key=abcdefghijklmnopqrstuvwxyz0123456789 로 불러 줘' } }),
      line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: '색도 조금 진하게 해 줘' } }),
      line({ type: 'ai-title', aiTitle: '메뉴 화면 글자 크기' }),
      line({ type: 'custom-title', customTitle: '메뉴 손보기' }),
    ].join('\n'),
  );
  // 앱(SDK)이 돌린 세션: 빼야 한다
  writeFileSync(path.join(dir, 'bbbb.jsonl'), [line({ type: 'user', entrypoint: 'sdk-ts', message: { role: 'user', content: '리더 과제' } }), line({ type: 'ai-title', aiTitle: '앱이 돌린 과제' })].join('\n'));
  const list = listTerminalSessions([target], Date.now() - 86_400_000, 8, projects);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '메뉴 손보기');
  assert.deepEqual(list[0].prompts, ['메뉴 화면 글자를 키워 줘', '색도 조금 진하게 해 줘']);
  const text = describeTerminalSessions(list, true);
  assert.match(text, /「메뉴 손보기」/);
  assert.doesNotMatch(text, /abcdefghijklmnop|secret output|system-reminder/);
  // 오래된 세션은 빼고, 세션이 없으면 안내 글
  assert.equal(listTerminalSessions([target], Date.now() + 1000, 8, projects).length, 0);
  assert.equal(describeTerminalSessions([]), '(최근 터미널 세션 없음)');
});

test('과제 멈추기: 리더 묶음이 그 과제를 맡은 리더만 멈춘다', async () => {
  const stopped: string[] = [];
  class Fake implements PoolLeader {
    task: MissionTask | null = null;
    done: (() => void) | null = null;
    busy() {
      return !!this.task;
    }
    current() {
      return this.task;
    }
    stop(taskId?: string) {
      if (!this.task || (taskId && this.task.id !== taskId)) return false;
      stopped.push(this.task.id);
      this.done?.();
      return true;
    }
    run(t: { text: string }) {
      this.task = task(t.text);
      return new Promise<{ ok: boolean; report: string }>((resolve) => {
        this.done = () => {
          this.task = null;
          resolve({ ok: false, report: '멈춤' });
        };
      });
    }
  }
  const pool = new MissionLeaderPool(() => new Fake());
  const a = pool.run({ text: 'A', from: 'user' });
  const b = pool.run({ text: 'B', from: 'user' });
  assert.equal(pool.stop('t-없는과제'), false);
  assert.equal(pool.stop('t-B'), true);
  assert.deepEqual(stopped, ['t-B']);
  assert.equal((await b).ok, false);
  assert.equal(pool.working(), 1);
  assert.equal(pool.stop(), true); // 과제를 정하지 않으면 진행 중인 것 모두
  await a;
  assert.equal(pool.working(), 0);
});

test('할 일 잇기 안전망: 주고받은 글에 제목이 그대로 나오면 그 할 일로 본다', () => {
  const items = [
    { id: 'aaaaaaaa', title: '메뉴 파일 줄 수 정리표 만들기', status: 'waiting' },
    { id: 'bbbbbbbb', title: '보고', status: 'waiting' }, // 너무 짧아 보지 않는다
    { id: 'cccccccc', title: '월간 자료 만들기', status: 'done' }, // 끝난 일은 뺀다
    { id: 'dddddddd', title: '주간 업무 정리', status: 'active' },
  ];
  assert.deepEqual(matchTodosByTitle(items, ['할 일에 있는 "메뉴 파일 줄수 정리표 만들기"는 어떻게 해?', '']), ['aaaaaaaa']);
  assert.deepEqual(matchTodosByTitle(items, ['보고 좀 해 줘', '월간 자료 만들기는 끝났어요']), []);
  assert.deepEqual(matchTodosByTitle(items, ['', '주간 업무 정리와 메뉴 파일 줄 수 정리표 만들기를 같이 볼게요']), ['aaaaaaaa', 'dddddddd']);
  assert.deepEqual(matchTodosByTitle(items, ['', '']), []);
});

test('답 끝 표시: 할 일과 선택을 순서와 상관없이 떼어 낸다', () => {
  assert.deepEqual(splitMarkers('두 가지를 정해 주세요.\n〔선택 권장대로 진행 | 1번만 권장대로〕\n〔할일 ab12cd34〕'), { text: '두 가지를 정해 주세요.', ids: ['ab12cd34'], choices: ['권장대로 진행', '1번만 권장대로'] });
  assert.deepEqual(splitMarkers('정해 주세요.\n〔할일 ab12cd34〕\n〔선택: 예 | 아니오 | 나중에 | 넷째는 버림〕'), { text: '정해 주세요.', ids: ['ab12cd34'], choices: ['예', '아니오', '나중에'] });
  assert.deepEqual(splitMarkers('표시 없는 답'), { text: '표시 없는 답', ids: [], choices: [] });
  // 너무 긴 선택지는 버린다
  assert.deepEqual(splitMarkers('답\n〔선택 짧게 | 이 선택지는 서른 글자를 훌쩍 넘어서 단추로 쓰기에는 너무 길어요 정말로요〕').choices, ['짧게']);
});

test('답 끝 표시: 쓰는 중인 글에서는 가린다', () => {
  assert.equal(hideMarkers('정해 주세요.\n〔선택 권장대로 진행 | 1번만〕\n〔할일 ab12cd34〕'), '정해 주세요.');
  assert.equal(hideMarkers('정해 주세요.\n〔선택 권장대로 진행 | 1번'), '정해 주세요.');
  assert.equal(hideMarkers('정해 주세요.\n〔선'), '정해 주세요.');
  assert.equal(hideMarkers('정해 주세요.\n〔선택 예 | 아니오〕\n〔할'), '정해 주세요.');
  assert.equal(hideMarkers('본문 〔참고 자료'), '본문 〔참고 자료');
});

test('알림 머리글 읽기: 보고(미션·제목·결과·과제 id)와 직접 지시(미션)', () => {
  assert.deepEqual(parseReportNotice('[앱 알림] 홈페이지 리더 보고 (과제: [자료 수집] 메뉴 목록 만들기, 결과: 완료, 연결된 할 일 id: ab12cd34, 과제 id: 15990f9d-993c-4369-9bb9-7145e050898b)\n\n보고 본문'), {
    mission: '홈페이지',
    title: '[자료 수집] 메뉴 목록 만들기',
    ok: true,
    taskId: '15990f9d-993c-4369-9bb9-7145e050898b',
  });
  assert.deepEqual(parseReportNotice('[앱 알림] 홈페이지 리더 보고 (과제: 문구 고치기, 결과: 중단)\n\n멈춤'), { mission: '홈페이지', title: '문구 고치기', ok: false });
  assert.equal(parseReportNotice('[앱 알림] 다른 알림'), null);
  assert.equal(parseDirectNotice('[앱 알림] 사용자가 홈페이지 리더에게 직접 지시했습니다: 문구 고쳐 줘'), '홈페이지');
  assert.equal(parseDirectNotice('[앱 알림] 홈페이지 리더 보고 (과제: x, 결과: 완료)'), null);
  assert.deepEqual(fallbackChoices('"권장대로"라고 말씀해 주시면 전할게요.'), ['권장대로 진행']);
  assert.deepEqual(fallbackChoices('끝났어요.'), []);
  // 번호 목록의 안 가운데 고르기: 권장이 먼저
  const alt = ['어떻게 정리할지 정해 주세요.', '', '1. **알파벳 순으로 유지하기**: 새 항목을 자리에 끼워 넣어요.', '2. **지금 순서 그대로 두기 (권장)**: 맨 아래에 덧붙여요.', '', '어느 쪽으로 할까요?'].join('\n');
  assert.deepEqual(fallbackChoices(alt), ['2번 · 지금 순서 그대로 두기', '1번 · 알파벳 순으로 유지하기']);
  // 항목마다 권장이 있는 여러 결정
  const multi = ['정해 주실 것이 두 가지예요.', '1. 묶음 이름. 권장은 A안이에요.', '2. 옛 주소 처리. 권장은 보내 주는 거예요.', '말씀해 주세요.'].join('\n');
  assert.deepEqual(fallbackChoices(multi), ['권장대로 진행']);
  // 묻지 않는 번호 목록(순서 설명)은 단추를 만들지 않는다
  assert.deepEqual(fallbackChoices(['이렇게 하면 돼요.', '1. 먼저 커밋을 마무리해요.', '2. 그다음 리더에게 맡겨요.'].join('\n')), []);
});

test('리더에게 직접 보낸 말은 답을 기다리는 말로 치지 않는다', () => {
  const at = '2026-11-12T00:00:00.000Z';
  const msgs = [
    { id: 'u1', role: 'user' as const, text: '안녕', at },
    { id: 'r1', role: 'rano' as const, text: '네', at, replyTo: ['u1'] },
    { id: 'u2', role: 'user' as const, text: '문구 고쳐 줘', at, toMission: 'm1' },
    { id: 'u3', role: 'user' as const, text: '라노야', at },
  ];
  assert.deepEqual(findUnanswered(msgs), ['u3']);
});
