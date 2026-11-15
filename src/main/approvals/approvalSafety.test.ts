// 승인 카드 안전 규칙 시험 (S1-C·T2·S3-A): 바로 승인 종류, 빨간 표, 명령·파일 읽기, 다시 시작 때 멈출 일 세기.
// 화면 쪽 복사본(src/renderer/approvalSafety.ts)이 이 파일과 글자까지 같은지, 화면 코드가 이 규칙을 쓰는지도 본다.
// 실행: 빌드 후 `node --test dist/main/approvals/approvalSafety.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ApprovalKind } from '../../shared/types.js';
import { CAREFUL_KIND_LABEL, QUICK_APPROVE_KINDS, canQuickApprove, carefulLabel, carefulTag, commandOf, filesOf, restartImpact } from './approvalSafety.js';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url)), 'utf-8');

const ALL_KINDS: ApprovalKind[] = ['teamPlan', 'decision', 'write', 'outsideWrite', 'commit', 'delete', 'db', 'deploy', 'external', 'numbers', 'reverseDecision', 'estimate', 'command', 'bundle', 'other'];

test('화면 복사본과 본체 판이 글자까지 같다(같은 규칙)', () => {
  assert.equal(src('renderer/approvalSafety.ts'), src('main/approvals/approvalSafety.ts'));
});

test('바로 승인은 일반 명령·폴더 밖 쓰기만', () => {
  assert.deepEqual([...QUICK_APPROVE_KINDS].sort(), ['command', 'outsideWrite']);
  for (const kind of ALL_KINDS) assert.equal(canQuickApprove({ kind }), kind === 'command' || kind === 'outsideWrite', kind);
  // 고를 것이 붙은 카드는 종류와 상관없이 바로 승인 안 함
  assert.equal(canQuickApprove({ kind: 'command', decisionItems: [{}] }), false);
  assert.equal(canQuickApprove({ kind: 'outsideWrite', bundle: [{}] }), false);
  assert.equal(canQuickApprove({ kind: 'command', decisionItems: [], bundle: [] }), true);
});

test('커밋·지우기·배포·DB·외부 게시·파일 쓰기는 빨간 표, 바로 승인 종류와 겹치지 않음', () => {
  for (const kind of ['commit', 'delete', 'deploy', 'db', 'external', 'write']) {
    assert.ok(carefulLabel(kind), kind);
    assert.match(carefulTag(kind), / · 승인함에서 확인$/, kind);
    assert.equal(canQuickApprove({ kind }), false, kind);
  }
  assert.equal(carefulTag('commit'), '커밋 · 승인함에서 확인');
  assert.equal(carefulTag('delete'), '지우기 · 승인함에서 확인');
  assert.equal(carefulTag('command'), '');
  assert.equal(carefulTag('outsideWrite'), '');
  assert.equal(carefulTag('decision'), '');
  // 객체 기본 이름으로 표가 생기지 않음
  assert.equal(carefulTag('constructor'), '');
  assert.equal(carefulTag('toString'), '');
  for (const k of Object.keys(CAREFUL_KIND_LABEL)) assert.ok(!QUICK_APPROVE_KINDS.includes(k), k);
  // 모든 종류는 바로 승인 / 빨간 표 / 승인함에서 고르기 셋 중 하나
  for (const kind of ALL_KINDS) {
    const quick = canQuickApprove({ kind });
    const careful = !!carefulLabel(kind);
    assert.ok(!(quick && careful), kind);
  }
});

test('승인함 "모두 승인" 종류(approvals.ts BATCH_KINDS)와 바로 승인 종류가 같다', () => {
  const m = /const BATCH_KINDS = new Set<string>\(\[([^\]]*)\]\)/.exec(src('renderer/approvals.ts'));
  assert.ok(m, 'BATCH_KINDS 를 찾지 못함');
  const batch = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(batch, [...QUICK_APPROVE_KINDS].sort());
});

test('대화 "지금" 줄·현황판 방 띠는 이 규칙으로 [승인]을 정하고, 옛 목록(SIMPLE_APPROVALS)은 없다', () => {
  for (const f of ['renderer/chatNow.ts', 'renderer/floor.ts']) {
    const s = src(f);
    assert.match(s, /from '\.\/approvalSafety\.js'/, f);
    assert.match(s, /const simple = canQuickApprove\(a\);/, f);
    assert.match(s, /carefulTag\(a\.kind\)/, f);
    assert.match(s, /commandOf\(a\.detail/, f);
    assert.ok(!s.includes('SIMPLE_APPROVALS'), f);
    // [승인] 단추는 simple 일 때만 만든다
    assert.match(s, /if \(simple\) \{\s*const ok = el\('button', 'now-btn now-btn-main', '승인'\)/, f);
  }
  assert.ok(!/SIMPLE_APPROVALS/.test(src('renderer/chatNow.ts') + src('renderer/floor.ts') + src('renderer/renderer.ts')));
});

test('명령 줄 읽기: 앱이 만든 자세히 글(명령·실행 위치·바뀔 수 있는 파일·판단 근거)', () => {
  const detail = '명령: npm run lint > ~/rano/runs/tmp/rano-os/lint.txt 2>&1\n실행 위치: ~/personal/rano-app\n바뀔 수 있는 파일: ~/rano/runs/tmp/rano-os/lint.txt\n판단 근거: 확인 명령';
  assert.equal(commandOf(detail), 'npm run lint > ~/rano/runs/tmp/rano-os/lint.txt 2>&1');
  assert.equal(filesOf({ kind: 'command', detail }), '~/rano/runs/tmp/rano-os/lint.txt');
  // 여러 줄 명령은 한 줄로
  assert.equal(commandOf('명령: git add a &&\n  git commit -m "x"\n실행 위치: ~/x'), 'git add a && git commit -m "x"');
  // 길면 자름
  const long = commandOf(`명령: echo ${'a'.repeat(400)}\n실행 위치: ~`, 50);
  assert.equal(long.length, 51);
  assert.ok(long.endsWith('…'));
  // 명령 줄이 없으면 빈 글
  assert.equal(commandOf(undefined), '');
  assert.equal(commandOf('승인하면 이번 과제 동안 아래 명령은 …\n\n1. 명령: npm test'), '');
});

test('파일 읽기: 파일 위치(~ 로 줄임), 지우기 승인 목록', () => {
  assert.equal(filesOf({ kind: 'outsideWrite', filePath: '/Users/someone/rano/runs/x.txt' }), '~/rano/runs/x.txt');
  assert.equal(filesOf({ kind: 'write', filePath: '/opt/a.txt' }), '/opt/a.txt');
  const del = '안 쓰는 파일 정리\n\n승인하면 이번 과제 동안 아래 위치를 지우는 명령은 다시 묻지 않아요:\n- ~/personal/app/old.txt\n- ~/personal/app/tmp';
  assert.equal(filesOf({ kind: 'delete', detail: del }), '~/personal/app/old.txt, ~/personal/app/tmp');
  assert.equal(filesOf({ kind: 'commit', detail: '그냥 설명' }), '');
});

test('다시 시작 때 멈출 일: 진행 중 과제·승인 대기·줄 선 과제', () => {
  const none = restartImpact([], []);
  assert.deepEqual(none, { running: [], pending: 0, queued: 0 });
  const r = restartImpact(
    [
      { name: '앱', leaderState: 'working', currentTask: { title: '첫 과제', status: 'running' }, running: [{ title: '첫 과제' }, { title: '둘째' }], queued: [{}] },
      { name: '홈페이지', leaderState: 'working', currentTask: { title: '옛 판 과제', status: 'running' } }, // running 칸이 없는 옛 판
      { name: '쉬는 방', leaderState: 'idle', currentTask: { title: '끝난 과제', status: 'done' } },
    ],
    [{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }, { status: 'expired' }],
  );
  assert.deepEqual(r.running, ['앱 · 첫 과제', '앱 · 둘째', '홈페이지 · 옛 판 과제']);
  assert.equal(r.pending, 2);
  assert.equal(r.queued, 1);
});

test('조직 화면 [앱 다시 시작]: 확인 창을 거치고, 안내 문구가 사실대로', () => {
  const s = src('renderer/orgWizard.ts');
  assert.match(s, /if \(!\(await confirmRestart\(\)\)\)/);
  assert.match(s, /restartImpact\(/);
  assert.match(s, /window\.rano\.missionList\(\), window\.rano\.approvalsList\(\)/);
  assert.match(s, /진행 중인 과제는 멈추고, 기다리던 승인 카드는 사라져요/);
  assert.ok(!s.includes('기다리던 과제는 이어서 진행돼요'));
  // 확인 창 다음에만 다시 시작을 부른다
  assert.ok(s.indexOf('confirmRestart()))') < s.indexOf('window.rano.orgRestart()'));
});

test('믿는 미션 확인 창: 세 칸이고 틀린 두 문장이 없다', () => {
  const s = src('renderer/orgWizard.ts');
  for (const t of ['묻지 않고 바로 해요', '승인함에서 물어요', '앱이 보지 못해요 (조심)', 'org-trust-blind']) assert.ok(s.includes(t), t);
  assert.ok(!s.includes("'커밋, push, 삭제, DB 바꾸기, 배포, 작업 폴더 밖 쓰기, 인터넷으로 보내기는 승인함을 거쳐요.'"));
  assert.ok(!s.includes("'막아 둔 비밀 파일은 열 수 없어요.'"));
});
