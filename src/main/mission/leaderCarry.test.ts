// 리더 "과제마다 새 대화"·"직전 과제" 묶음·리더 직접 수정 횟수·리더 지침 문구 시험.
// MissionLeader 는 Electron 을 불러오는 모듈(로그인·외부 연결)과 묶여 있어 시험에서 직접 띄우지 않고,
// 판단은 leaderCarry.ts 의 순수 함수로, 연결은 빌드된 leaderSession.js 글로 확인한다.
// 실행: 빌드 후 `node --test dist/main/mission/leaderCarry.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ApprovalRequest, ChatMessage, MissionConfig, TaskOutput } from '../../shared/types.js';
import { buildCarryBlock, CARRY_MAX, isLeaderEditTarget, lastPairs, leaderEditNote, reportSections, runTaskAttempts, userDecisionNotes } from './leaderCarry.js';
import { buildLeaderSystemPrompt, HANDOFF_FILE } from './leaderPrompt.js';
import { NOTE_APP_QUIT, NOTE_MOBILE_REJECT, NOTE_NO_PICK, NOTE_TASK_STOPPED } from '../approvals/approvalQueue.js';

const DRAFTS = '/Users/x/rano/runs/drafts/m1';
const draftsDir = (id: string) => path.join(DRAFTS, id);
const REPORT = [
  '1. 한 일: 작업 담당에게 메뉴 문서를 맡겼어요.',
  '2. 결과물 대조표: 메뉴.md → 만듦 → 맞음',
  '3. 검수: 1번, 통과',
  '4. 결과: 메뉴를 3단으로 정리했어요.',
  '   시험 키 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 는 지웠어요',
  '5. 결정이 필요한 사항: B안 확정 필요',
  '6. 승인이 필요한 일: 커밋 필요',
].join('\n');

const msg = (id: string, role: ChatMessage['role'], text: string, at: string): ChatMessage => ({ id, role, text, at });
const task = (id: string, status: TaskOutput['status'], startedAt: string, report: string, title = `과제 ${id}`) => ({
  taskId: id,
  title,
  status,
  startedAt,
  endedAt: startedAt.replace('T00', 'T01'),
  leaderReport: report,
});
const appr = (taskId: string, status: ApprovalRequest['status'], decisionNote?: string, title = '카드'): Pick<ApprovalRequest, 'missionId' | 'taskId' | 'status' | 'decisionNote' | 'title'> => ({
  missionId: 'm1',
  taskId,
  status,
  title,
  ...(decisionNote ? { decisionNote } : {}),
});

function input(over: Partial<Parameters<typeof buildCarryBlock>[0]> = {}): Parameters<typeof buildCarryBlock>[0] {
  return {
    missionId: 'm1',
    from: 'rano',
    tasks: [task('t2', 'done', '2026-11-08T00:10:00.000Z', REPORT, '메뉴 정리')],
    messages: [msg('u1', 'rano', '메뉴를 3단으로 정리해 줘. 자세한 조건은 …', '2026-11-08T00:09:59.000Z'), msg('l1', 'leader', REPORT, '2026-11-08T00:20:00.000Z')],
    approvals: [],
    draftsDir,
    handoffFile: HANDOFF_FILE,
    ...over,
  };
}

// ---- 1-B: 과제마다 새 대화 ----
test('리더는 과제마다 새 대화: 과제 시작 때 저장된 대화 번호로 이어 쓰지 않는다(빌드된 leaderSession.js 확인)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'leaderSession.js'), 'utf-8');
  assert.match(src, /runTaskAttempts\(\(resume\) => this\.attempt\(prompt, resume\), undefined, looksLikeMissingSession\)/);
  assert.ok(!/attempt\(prompt, sessionId/.test(src), '저장된 sessionId 로 attempt 하지 않음');
  assert.match(src, /buildCarryBlock\(/);
});

test('과제 안 재시도 규칙은 그대로: resume 없으면 한 번, 이어가기 실패면 새 대화로 한 번 더', async () => {
  type Res = { errorText: string | null; text: string; gotInit: boolean };
  const calls: (string | undefined)[] = [];
  const missing = (s: string) => /no conversation found/i.test(s);
  const okR: Res = { errorText: null, text: '보고', gotInit: true };
  const fail: Res = { errorText: 'No conversation found', text: '', gotInit: false };
  const cut: Res = { errorText: 'socket', text: '반쯤', gotInit: true };
  const fake = (pick: (r: string | undefined) => Res) => async (r: string | undefined): Promise<Res> => {
    calls.push(r);
    return pick(r);
  };
  const r1 = await runTaskAttempts<Res>(fake(() => okR), undefined, missing);
  assert.deepEqual(calls, [undefined]);
  assert.equal(r1.text, '보고');
  calls.length = 0;
  await runTaskAttempts<Res>(fake((r) => (r ? fail : okR)), 'sess-task', missing);
  assert.deepEqual(calls, ['sess-task', undefined]);
  calls.length = 0;
  await runTaskAttempts<Res>(fake(() => cut), 'sess-task', missing);
  assert.deepEqual(calls, ['sess-task'], '글이 나온 뒤 오류면 다시 하지 않음');
});

test('직전 과제 묶음: 직전 지시·보고의 4~6절·시안 폴더·인수 메모 경로, 비밀은 가림', () => {
  const b = buildCarryBlock(input());
  assert.ok(b.startsWith('[앱 안내] 직전 과제'));
  assert.ok(b.includes('직전 과제: 메뉴 정리 (결과: 완료'));
  assert.ok(b.includes('직전 지시(앞부분): 메뉴를 3단으로 정리해 줘.'));
  assert.ok(b.includes(`시안 폴더: ${path.join(DRAFTS, 't2')}`));
  assert.ok(b.includes(`인수 메모: ${path.join(DRAFTS, 't2', HANDOFF_FILE)}`));
  assert.ok(b.includes('4. 결과: 메뉴를 3단으로') && b.includes('5. 결정이 필요한 사항: B안') && b.includes('6. 승인이 필요한 일: 커밋 필요'));
  assert.ok(!b.includes('1. 한 일') && !b.includes('결과물 대조표'), '4~6절만');
  assert.ok(!b.includes('ghp_ABCDEFGH'), '토큰은 가림');
  assert.ok(!b.includes('직전 대화'), '라노가 맡긴 과제는 대화 쌍 없음');
  assert.equal(buildCarryBlock(input({ tasks: [], messages: [] })), '', '직전 과제가 없으면 빈 글');
  assert.equal(buildCarryBlock(input({ currentTaskId: 't2', messages: [] })), '', '이번 과제는 빼고 본다');
});

test('보고 절 뽑기: 제목 모양이 달라도(## 4) 결과, **5. …**) 찾고, 형식이 다르면 앞부분 1,500자', () => {
  const md = '## 1) 한 일\n가\n## 4) 결과\n나\n**5. 결정이 필요한 사항**\n없음';
  assert.equal(reportSections(md), '## 4) 결과\n나\n**5. 결정이 필요한 사항**\n없음');
  const free = '자유 형식 보고 '.repeat(400);
  const r = reportSections(free);
  assert.ok(r.length <= 1500 && r.startsWith('자유 형식 보고'));
  assert.ok(reportSections('2. 결과물 대조표: x\n3. 검수: 통과').startsWith('2. 결과물'), '결과물 대조표는 4절로 보지 않음 → 앞부분');
});

test('사용자 메모: 수정 요청·반려 상태이고 사용자가 쓴 말만, 앱이 쓴 메모는 빼고 최대 5건', () => {
  const items = [
    appr('t2', 'revise', '표 대신 목록으로 바꿔 주세요', '결정 카드'),
    appr('t2', 'rejected', '이 파일은 고치지 마세요 password=hunter2', '쓰기'),
    appr('t2', 'approved', '좋아요'),
    appr('t2', 'expired', NOTE_APP_QUIT),
    appr('t2', 'expired', NOTE_TASK_STOPPED),
    appr('t2', 'rejected', NOTE_NO_PICK),
    appr('t2', 'rejected', NOTE_MOBILE_REJECT),
    appr('t2', 'rejected'),
    appr('t1', 'revise', '다른 과제 메모'),
    { ...appr('t2', 'revise', '다른 미션 메모'), missionId: 'm2' },
    ...Array.from({ length: 6 }, (_, i) => appr('t2', 'revise', `메모 ${i}`)),
  ];
  const notes = userDecisionNotes(items, 'm1', ['t2']);
  assert.equal(notes.length, 5);
  assert.equal(notes[0].note, '표 대신 목록으로 바꿔 주세요');
  assert.equal(notes[1].status, 'rejected');
  assert.ok(!notes[1].note.includes('hunter2'), '비밀 가림');
  for (const bad of [NOTE_APP_QUIT, NOTE_TASK_STOPPED, NOTE_NO_PICK, NOTE_MOBILE_REJECT, '좋아요', '다른 과제', '다른 미션']) assert.ok(!notes.some((n) => n.note.includes(bad)), bad);
  const b = buildCarryBlock(input({ approvals: items }));
  assert.ok(b.includes('[수정 요청] 결정 카드: 표 대신 목록으로 바꿔 주세요'));
  assert.ok(b.includes('[반려] 쓰기: '));
  assert.ok(!b.includes('hunter2'));
});

test('비밀 가리기: 줄마다 값만 가리고, 경로가 든 지시·UUID·나머지 메모는 남긴다', () => {
  const dir = '/Users/jk/rano/runs/drafts/rano-os/1bf8ecb5-940d-4e07-8b78-a11b1c10be1d/_bundle/src/main/mission';
  const order = `${dir}/leaderCarry.ts 의 hideSecrets 를 고쳐 줘.\n시험은 token 이 든 줄도 남겨야 해.\n키: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`;
  const b = buildCarryBlock(
    input({
      messages: [msg('u1', 'rano', order, '2026-11-08T00:09:59.000Z'), msg('l1', 'leader', REPORT, '2026-11-08T00:20:00.000Z')],
      approvals: [appr('t2', 'rejected', '이 파일은 고치지 마세요 password=hunter2 그리고 표는 그대로\n둘째 줄 메모', '쓰기')],
    }),
  );
  assert.ok(b.includes(`직전 지시(앞부분): ${dir}/leaderCarry.ts 의 hideSecrets 를 고쳐 줘. 시험은 token 이 든 줄도 남겨야 해.`), b);
  assert.ok(b.includes('1bf8ecb5-940d-4e07-8b78-a11b1c10be1d'), 'UUID 남김');
  assert.ok(!b.includes('ghp_ABCDEFGH'), '토큰 모양 글은 가림');
  assert.ok(b.includes('[반려] 쓰기: 이 파일은 고치지 마세요 password=(가림) 그리고 표는 그대로 둘째 줄 메모'), b);
  assert.ok(!b.includes('hunter2'));
  const notes = userDecisionNotes(
    [appr('t2', 'revise', 'private_key: abc123 는 빼고\nclient_secret=xyz 도 빼고\n비밀번호: 1234 다음 줄은 남김\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n끝')],
    'm1',
    ['t2'],
  );
  const n = notes[0].note;
  for (const bad of ['abc123', 'xyz', '1234', 'MIIBOgIBAAJBAK']) assert.ok(!n.includes(bad), bad);
  assert.ok(n.includes('private_key: (가림) 는 빼고') && n.includes('다음 줄은 남김') && n.endsWith('끝'), n);
  assert.equal(reportSections('4. 결과: /Users/jk/a/b.md 고침\n   api_key=sk-ant-abcdefghijklmnop 는 지움'), '4. 결과: /Users/jk/a/b.md 고침\n   api_key=(가림) 는 지움');
});

test('직전 과제가 중단·실패면: "중단됨"과 그 과제 시안 폴더·인수 메모, 그 전에 성공한 과제의 보고도 함께', () => {
  const b = buildCarryBlock(
    input({
      tasks: [task('t3', 'failed', '2026-11-08T00:30:00.000Z', '앱이 꺼져 작업이 멈췄어요', '표 고치기'), task('t2', 'done', '2026-11-08T00:10:00.000Z', REPORT, '메뉴 정리')],
      messages: [
        msg('u1', 'rano', '메뉴를 3단으로 정리해 줘.', '2026-11-08T00:09:59.000Z'),
        msg('l1', 'leader', REPORT, '2026-11-08T00:20:00.000Z'),
        msg('u2', 'rano', '표를 고쳐 줘', '2026-11-08T00:29:59.000Z'),
        msg('l2', 'leader', '앱이 꺼져 작업이 멈췄어요', '2026-11-08T00:40:00.000Z'),
      ],
      approvals: [appr('t3', 'revise', '열 이름은 한국어로'), appr('t2', 'rejected', '커밋은 아직')],
    }),
  );
  assert.ok(b.includes('직전 과제: 표 고치기 (결과: 중단됨'));
  assert.ok(b.includes('직전 지시(앞부분): 표를 고쳐 줘'));
  assert.ok(b.includes(`시안 폴더: ${path.join(DRAFTS, 't3')}`) && b.includes(`인수 메모: ${path.join(DRAFTS, 't3', HANDOFF_FILE)}`));
  assert.ok(b.includes('멈춘 모습: 앱이 꺼져 작업이 멈췄어요'));
  assert.ok(b.includes('그 전에 끝난 과제: 메뉴 정리'));
  assert.ok(b.includes(`시안 폴더: ${path.join(DRAFTS, 't2')}`));
  assert.ok(b.includes('4. 결과: 메뉴를 3단으로'));
  assert.ok(b.includes('열 이름은 한국어로') && b.includes('커밋은 아직'), '두 과제의 사용자 메모');
});

test('리더 대화창 직접 지시: 직전 대화 3쌍(저장 순서 = 줄 선 순서), 라노 배정은 붙이지 않음', () => {
  const messages: ChatMessage[] = [];
  for (let i = 1; i <= 5; i++) {
    messages.push(msg(`u${i}`, i === 2 ? 'rano' : 'user', `지시 ${i}`, `2026-11-08T00:0${i}:00.000Z`));
    messages.push(msg(`l${i}`, 'leader', `답 ${i}`, `2026-11-08T00:0${i}:30.000Z`));
  }
  assert.deepEqual(
    lastPairs(messages).map((p) => [p.ask, p.answer]),
    [
      ['지시 3', '답 3'],
      ['지시 4', '답 4'],
      ['지시 5', '답 5'],
    ],
  );
  const b = buildCarryBlock(input({ from: 'user', messages }));
  assert.ok(b.includes('직전 대화 3쌍'));
  assert.ok(b.indexOf('사용자: 지시 3') < b.indexOf('사용자: 지시 5'));
  assert.ok(b.includes('리더: 답 5'));
  assert.ok(!b.includes('지시 2'));
  assert.ok(!buildCarryBlock(input({ from: 'rano', messages })).includes('직전 대화'));
  // 결과물함 기록이 없어도 직접 대화 쌍은 붙는다
  assert.ok(buildCarryBlock(input({ from: 'user', messages, tasks: [] })).includes('직전 대화 3쌍'));
});

test('묶음 상한: 지시·보고·메모·대화가 길어도 전체 약 3,000자 안, 보고는 1,500자 안', () => {
  const long = (s: string) => `${s} `.repeat(800);
  const big = `4. 결과: ${long('결과')}\n5. 결정이 필요한 사항: ${long('결정')}`;
  const messages: ChatMessage[] = [];
  for (let i = 1; i <= 4; i++) {
    messages.push(msg(`u${i}`, 'user', long(`지시${i}`), `2026-11-08T00:0${i}:00.000Z`));
    messages.push(msg(`l${i}`, 'leader', long(`답${i}`), `2026-11-08T00:0${i}:30.000Z`));
  }
  const b = buildCarryBlock(
    input({
      from: 'user',
      tasks: [task('t2', 'done', '2026-11-08T00:04:10.000Z', big)],
      messages,
      approvals: Array.from({ length: 8 }, (_, i) => appr('t2', 'revise', long(`메모${i}`))),
    }),
  );
  assert.ok(b.length <= CARRY_MAX, `길이 ${b.length}`);
  assert.ok(b.includes('직전 지시(앞부분):'));
  assert.ok(b.includes('4. 결과:'));
  assert.ok(reportSections(big).length <= 1500);
  assert.equal((b.match(/\[수정 요청\]/g) ?? []).length <= 5, true);
});

// ---- 2-A: 리더 직접 수정 횟수 ----
test('리더 직접 수정: 마지막 검수 뒤 Write/Edit 횟수와 파일 이름, 검수 전 수정은 세지 않음', () => {
  const edits = [
    { tick: 1, file: '/d/_bundle/a.md' }, // 작업 끝(1) 뒤, 검수 끝(2) 전
    { tick: 2, file: '/d/_bundle/b.md' },
    { tick: 2, file: '/d/_bundle/b.md' },
    { tick: 2, file: '/repo/src/c.ts' },
  ];
  assert.equal(leaderEditNote(edits, 2), '마지막 검수 뒤 리더가 직접 3건 고침: b.md, c.ts');
  assert.equal(leaderEditNote(edits.slice(0, 1), 2), '', '검수 전에 고친 것은 검수가 봄');
  assert.equal(leaderEditNote([{ tick: 0, file: '/d/x.md' }], 0), '리더가 직접 1건 고침: x.md', '검수 생략 과제도 횟수');
  const many = Array.from({ length: 7 }, (_, i) => ({ tick: 3, file: `/d/f${i}.md` }));
  assert.equal(leaderEditNote(many, 3), '마지막 검수 뒤 리더가 직접 7건 고침: f0.md, f1.md, f2.md, f3.md, f4.md 외 2개');
});

test('리더 직접 수정으로 세는 위치: 이 과제 시안 폴더·작업 폴더 안(시안 폴더의 인수 메모는 뺌)', () => {
  const d = '/r/drafts/m1/t9';
  const targets = ['/w/repo'];
  assert.equal(isLeaderEditTarget(`${d}/_bundle/a.md`, d, targets, HANDOFF_FILE), true);
  assert.equal(isLeaderEditTarget(`${d}/${HANDOFF_FILE}`, d, targets, HANDOFF_FILE), false);
  assert.equal(isLeaderEditTarget('/w/repo/src/a.ts', d, targets, HANDOFF_FILE), true);
  assert.equal(isLeaderEditTarget('/w/repo2/a.ts', d, targets, HANDOFF_FILE), false);
  assert.equal(isLeaderEditTarget('/home/missions/m1/memory/코드지도.md', d, targets, HANDOFF_FILE), false, '코드 지도는 세지 않음');
  assert.equal(isLeaderEditTarget('', d, targets, HANDOFF_FILE), false);
});

test('리더 지침 문구: 과제마다 새 대화, 독립된 일은 함께, 작은 수정은 리더가 직접, 보고 3번에 작은 수정', () => {
  const mission = { id: 'm1', name: '시험', zone: 'personal', targets: ['/w/repo'], readonlyRefs: [], home: '/h/m1', reviewerRoles: ['reviewer'], stagePolicy: 'approval', rulesFiles: [] } as unknown as MissionConfig;
  const p = buildLeaderSystemPrompt({ mission, rules: [], charter: '', team: '', memory: [], roles: [] });
  assert.ok(p.includes('과제마다 새 대화로 시작하고, 앞 과제는 앱이 붙이는 "직전 과제" 묶음·진행업무·결정 기록·코드 지도로 이어 간다'));
  assert.ok(!p.includes('이전 과제의 맥락을 이어간다'));
  assert.ok(p.includes('서로 독립된 일(다른 파일·다른 질문)은 팀원을 한 번에 함께 맡긴다'));
  assert.ok(p.includes('공용 인수 메모 끝에 덧붙이는 것은 같은 파일이어도 예외'));
  assert.ok(!p.includes('한 번에 하나씩 부르는 것을 기본으로'));
  assert.ok(p.includes('작은 수정(판단이 바뀌지 않는 문구·오탈자, 검수가 제안한 문장을 그대로 반영)은 리더가 시안 폴더에서 직접 고치고'));
  assert.ok(p.includes('코드·숫자·권한·결과물 형태가 바뀌는 수정은 작업 담당에게 맡기고'));
  assert.ok(!p.includes('아무리 작은 수정이라도'));
  assert.ok(p.includes('"작은 수정 n건 리더 확인"'));
});
