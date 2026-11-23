// 0.9.19 시험: 실사용 다섯째 날(2026-11-20) 검토에서 나온 것
// 과제 제목, 날짜·요일 안내, 카드 가림(본문이 통째로 가려지던 것), 외부 연결 미리보기, 결과 파일 넘기기, 지난 보고 읽기, 할 일 자동 만들기
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MissionConfig, MissionLeaderApi, RanoConfig, TaskOutput } from '../../shared/types.js';
import { shareTaskFiles } from '../approvals/taskFiles.js';
import { TodoStore } from '../todo/todoStore.js';
import { classifyBash, type BashContext } from './bashRules.js';
import { MissionDispatcher } from './dispatcher.js';
import { connectorPreview, maskLineSoft, redactCommand, redactPreview } from './leaderPermissions.js';
import { describePastReports } from './leaderTools.js';
import { taskTitle, todayLine, withTitle } from './taskText.js';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'rano-0919-')));

test('과제 제목: 라노가 붙인 제목 표시를 쓰고, 없으면 "목적:" 머리말을 뗀다', () => {
  const body = '목적: 사용자의 위키 페이지 pageId 1234567(주간 업무)를 이번 주 내용으로 갱신한다.\n\n범위: …';
  assert.equal(taskTitle(withTitle(body, '주간 업무 페이지 갱신')), '주간 업무 페이지 갱신');
  assert.ok(withTitle(body, '주간 업무 페이지 갱신').includes(body)); // 지시문은 그대로
  assert.equal(withTitle(body, '  '), body);
  assert.ok(!taskTitle(body).startsWith('목적'), taskTitle(body));
  assert.ok(taskTitle(body).startsWith('사용자의 위키'));
  assert.equal(taskTitle('[제목: 대괄호 [안] 제목]\n\n본문'), taskTitle('[제목: 대괄호 [안] 제목]\n\n본문')); // 깨지지 않는다
  assert.equal(taskTitle(withTitle('본문', '줄\n바꿈 [표시]')), '줄 바꿈 표시');
});

test('날짜 안내: 요일과 이번 주·다음 주 범위를 알려 준다', () => {
  const line = todayLine(new Date(2026, 10, 20, 15, 42)); // 2026-11-20 금요일
  assert.ok(line.includes('2026-11-20(금) 15:42'), line);
  assert.ok(line.includes('이번 주는 11/16(월)~11/22(일)'), line);
  assert.ok(line.includes('평일은 11/20(금)까지'), line);
  assert.ok(line.includes('다음 주는 11/23(월)~11/29(일)'), line);
  // 일요일은 그 주의 마지막 날, 달이 넘어가도 맞는다
  const sun = todayLine(new Date(2026, 10, 29, 9, 0));
  assert.ok(sun.includes('(일)') && sun.includes('이번 주는 11/23(월)~11/29(일)') && sun.includes('다음 주는 11/30(월)~12/6(일)'), sun);
});

test('카드 가림: 긴 덩어리가 든 줄은 그 값만 가리고 글은 보인다', () => {
  const tok = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const out = maskLineSoft(`"content": "<h2>이번 주 한 일</h2><p>배포 확인 ${tok} 끝</p>"`);
  assert.ok(out.includes('이번 주 한 일') && out.includes('배포 확인'), out);
  assert.ok(!out.includes(tok), out);
  // 비밀스러운 이름이 든 짧은 줄은 전처럼 통째로
  assert.equal(maskLineSoft('API_TOKEN=abc123'), '(비밀로 보여 가림)');
  // 아주 긴 줄에 비밀스러운 이름이 있으면 그 값만
  const long = `{"title": "${'가'.repeat(320)}", "password": "hunter2-secret", "note": "끝"}`;
  const m = maskLineSoft(long);
  assert.ok(!m.includes('hunter2') && m.includes('가가가') && m.includes('끝'), m.slice(-120));
  assert.equal(maskLineSoft(`${'가'.repeat(320)} -----BEGIN RSA PRIVATE KEY-----`), '(비밀로 보여 가림)');
  assert.equal(maskLineSoft('보통 글 한 줄'), '보통 글 한 줄');
});

test('명령 가림: find -path · perl -pe · Co-Authored-By 는 그대로, mysql -p비번 은 가린다', () => {
  const find = 'find . -name "*.xlsx" -not -path "./node_modules/*"';
  assert.equal(redactCommand(find), find);
  assert.equal(redactCommand("perl -pe 's/a/b/' x.txt"), "perl -pe 's/a/b/' x.txt");
  const co = 'git commit -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"';
  assert.equal(redactCommand(co), co);
  assert.ok(!redactCommand('mysql -uroot -pS3cretPw db').includes('S3cretPw'));
  assert.ok(!redactCommand('curl -H "X-Auth-Token: abcd1234" https://example.com').includes('abcd1234'));
  assert.ok(!redactCommand('tool --password=S3cretPw').includes('S3cretPw'));
});

test('외부 연결 미리보기: 긴 본문은 따로 꺼내 꼬리표를 걷고 줄을 살린다', () => {
  const html = `<h2>이번 주 한 일</h2><ul><li>배포 확인</li><li>가격표 화면</li></ul><table><tr><th>항목</th><th>상태</th></tr><tr><td>점검 칸</td><td>완료</td></tr></table><p>링크 https://example.com/pages/viewpage.action?pageId=1234567</p>${'<p>채우는 글</p>'.repeat(20)}`;
  const shown = connectorPreview({ page_id: '1234567', title: '주간 업무', content: html, version_comment: '갱신' });
  assert.ok(shown.includes('"page_id": "1234567"'), shown.slice(0, 200));
  assert.ok(shown.includes('[content]') && shown.includes('- 배포 확인') && shown.includes('점검 칸 | 완료'), shown.slice(0, 600));
  assert.ok(!shown.includes('<li>'));
  const card = redactPreview(shown, 160, 8000);
  assert.ok(card.includes('이번 주 한 일') && card.includes('가격표 화면'), card.slice(0, 400));
  assert.ok(!card.includes('(비밀로 보여 가림)'), card.slice(0, 600));
  // 명령 같은 여러 줄 글은 줄바꿈 그대로, 비밀 줄만 가림
  const cmd = connectorPreview({ app_name: 'web', command: 'export TOKEN=abc\nnode q.js\necho 끝' });
  const c2 = redactPreview(cmd, 160, 8000);
  assert.ok(c2.includes('node q.js') && c2.includes('echo 끝') && !c2.includes('TOKEN=abc'), c2);
});

test('결과 파일 넘기기: 다른 미션의 결과 파일을 받는 미션 쪽으로 복사한다(스크립트·인수 메모는 뺌)', () => {
  const runs = path.join(ROOT, 'runs-share');
  const id = '11111111-2222-4333-8444-555555555555';
  const src = path.join(runs, 'drafts', 'alpha', id);
  mkdirSync(path.join(src, 'sub'), { recursive: true });
  writeFileSync(path.join(src, '보고서.md'), '# 보고');
  writeFileSync(path.join(src, 'sub', '그림.svg'), '<svg/>');
  writeFileSync(path.join(src, 'make.py'), 'print(1)');
  writeFileSync(path.join(src, '인수메모.md'), '메모');
  const r = shareTaskFiles(runs, 'beta', id.slice(0, 8));
  assert.equal(r.ok, true);
  const base = path.join(runs, 'drafts', 'beta', '_received', '11111111');
  assert.deepEqual(r.paths.sort(), [path.join(base, 'sub', '그림.svg'), path.join(base, '보고서.md')].sort());
  assert.equal(readFileSync(path.join(base, '보고서.md'), 'utf-8'), '# 보고');
  assert.ok(!existsSync(path.join(base, 'make.py')) && !existsSync(path.join(base, '인수메모.md')));
  // 같은 미션이면 복사하지 않고 원래 경로
  const same = shareTaskFiles(runs, 'alpha', id);
  assert.ok(same.ok && same.paths.every((p) => p.startsWith(src)));
  assert.equal(shareTaskFiles(runs, 'beta', 'deadbeef').ok, false);
  assert.equal(shareTaskFiles(runs, 'beta', '../../etc').ok, false);
});

test('지난 보고 읽기: 목록·추리기·전문, 지금 과제와 진행 중 과제는 뺀다', () => {
  const o = (taskId: string, title: string, report: string, status: TaskOutput['status'] = 'done', startedAt = '2026-11-20T01:00:00.000Z') =>
    ({ taskId, missionId: 'm', title, status, startedAt, from: 'rano', leaderReport: report, reviewReports: [], changedFiles: [] }) as unknown as TaskOutput;
  const all = [
    o('aaaaaaaa-0000-4000-8000-000000000001', '메뉴 개편 검토', '# 보고\n1. 한 일: 후보 3곳 정리', 'done', '2026-11-19T08:00:00.000Z'),
    o('bbbbbbbb-0000-4000-8000-000000000002', '가격표 화면', '화면을 만들었어요. token=abcd'),
    o('cccccccc-0000-4000-8000-000000000003', '지금 과제', '', 'running'),
    o('dddddddd-0000-4000-8000-000000000004', '돌고 있는 다른 과제', '', 'running'),
  ];
  const list = describePastReports(all, 'cccccccc-0000-4000-8000-000000000003');
  assert.ok(list.includes('bbbbbbbb') && list.includes('aaaaaaaa') && !list.includes('cccccccc') && !list.includes('dddddddd'), list);
  assert.ok(list.indexOf('bbbbbbbb') < list.indexOf('aaaaaaaa')); // 최신순
  const q = describePastReports(all, undefined, undefined, '메뉴 개편');
  assert.ok(q.includes('aaaaaaaa') && !q.includes('bbbbbbbb'), q);
  const full = describePastReports(all, undefined, 'aaaaaaaa');
  assert.ok(full.includes('후보 3곳 정리'), full);
  assert.ok(!describePastReports(all, undefined, 'bbbbbbbb').includes('token=abcd')); // 비밀 줄은 가림
  assert.ok(describePastReports(all, undefined, 'zzzzzzzz').includes('찾지 못했어요'));
});

test('읽기 명령: paste 는 아는 읽기 명령', () => {
  writeFileSync(path.join(ROOT, 'targets.tsv'), 'a\tb\n');
  const ctx: BashContext = { cwd: ROOT, targets: [ROOT], readRoots: [ROOT], isBlocked: () => false, secretsUnder: () => [], allowChecks: true };
  const r = JSON.stringify(classifyBash('cut -f2 targets.tsv | tail -n +2 | paste -sd, -', ctx));
  assert.ok(!r.includes('판단이 필요한 명령'), r.slice(0, 300));
});

test('할 일 자동 만들기: 업무에 살아 있는 할 일이 없으면 앱이 만들고, 보고가 오면 확인 요청으로', async () => {
  const root = path.join(ROOT, 'disp');
  const mission = { id: 'm1', name: '시험', zone: 'work', home: path.join(root, 'home'), targets: [root], stagePolicy: 'approval' } as unknown as MissionConfig;
  mkdirSync(path.join(mission.home, 'memory'), { recursive: true });
  const config = { rootDir: root, runsDir: path.join(root, 'runs'), memoryDir: path.join(root, 'memory'), missions: [mission], autoCommit: false, blocked: [], raw: {} } as unknown as RanoConfig;
  mkdirSync(config.memoryDir, { recursive: true });
  const todos = new TodoStore(config, () => {});
  let finish: (r: { ok: boolean; report: string; taskId?: string }) => void = () => {};
  const leader: MissionLeaderApi = {
    run: (task) => {
      task.onStart?.();
      task.onTask?.('t-1');
      return new Promise((res) => (finish = res));
    },
    busy: () => false,
  };
  const works = new Map([['w_1', { id: 'w_1', name: '메뉴 개편 대응' }]]);
  const notices: string[] = [];
  const d = new MissionDispatcher({
    config,
    leaders: new Map([['m1', leader]]),
    trackers: new Map(),
    notifyRano: async (t) => void notices.push(t),
    todos,
    works: { linkTask: () => {}, byTask: () => undefined, get: (id) => (id ? works.get(id) : undefined) },
  });
  // 사용자가 끝낸 할 일이 달린 업무에 새 일을 맡긴다
  const old = todos.add('m1', '메뉴 개편 방안 기획', 'rano');
  todos.update(old.id, { workId: 'w_1' }, 'app');
  todos.update(old.id, { status: 'done' }, 'user');
  await d.assign('m1', withTitle('가격 합계를 계산해 주세요', '가격 합계 계산'), undefined, false, false, 'w_1');
  const live = todos.list().filter((x) => x.workId === 'w_1' && x.status !== 'done');
  assert.equal(live.length, 1);
  assert.equal(live[0].title, '메뉴 개편 대응');
  assert.equal(live[0].status, 'active');
  assert.equal(todos.get(old.id)?.status, 'done'); // 끝낸 일은 그대로
  finish({ ok: true, report: '끝났어요', taskId: 't-1' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(todos.get(live[0].id)?.status, 'review');
  assert.ok(notices.some((n) => n.includes('과제: 가격 합계 계산')), notices.join('|').slice(0, 200));
  // 같은 업무에 또 맡기면 새로 만들지 않고 그 할 일을 다시 진행 중으로
  await d.assign('m1', '이어서 표로 정리', undefined, false, false, 'w_1');
  assert.equal(todos.list().filter((x) => x.workId === 'w_1' && x.status !== 'done').length, 1);
  assert.equal(todos.get(live[0].id)?.status, 'active');
  finish({ ok: true, report: '끝', taskId: 't-2' });
  await new Promise((r) => setTimeout(r, 50));
});

test('보고 첫 줄: 번호만 붙은 절 머리는 건너뛰고 내용을 쓴다', async () => {
  const { reportFirstLine } = await import('./dispatcher.js');
  assert.equal(reportFirstLine('**1. 한 일**\n- 단추 두 개를 작은 그림으로 바꿨어요.\n\n2. 결과\n잘 됨'), '단추 두 개를 작은 그림으로 바꿨어요.');
  assert.equal(reportFirstLine('1. 한 일: 단추를 바꿨어요'), '1. 한 일: 단추를 바꿨어요');
  assert.equal(reportFirstLine('1. 한 일'), '1. 한 일');
});
