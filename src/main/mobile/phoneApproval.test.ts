// 휴대폰(텔레그램) 승인 요청 글 시험 (S2-B): 명령(가린 판)·바뀌는 파일을 적고, 글 길이 상한과 비밀 가리기를 지키며, 승인 버튼은 그대로.
// 실행: 빌드 후 `node --test dist/main/mobile/phoneApproval.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ApprovalRequest } from '../../shared/types.js';
import { canQuickApprove } from '../approvals/approvalSafety.js';
import { approvalPhoneText, PHONE_APPROVAL_MAX } from './mobileRules.js';

type Card = Parameters<typeof approvalPhoneText>[0];
const card = (over: Partial<ApprovalRequest>): Card => ({ who: 'rano-os 리더', kind: 'command', title: '명령 실행: npm', what: '시험 돌리기', why: '', recommendation: '', ...over });

test('명령 카드: 명령과 바뀌는 파일이 글에 보이고, 경고 줄은 없다', () => {
  const t = approvalPhoneText(card({ detail: '명령: npm test > ~/rano/runs/tmp/x.txt 2>&1\n실행 위치: ~/personal/app\n바뀔 수 있는 파일: ~/rano/runs/tmp/x.txt\n판단 근거: 시험' }));
  assert.match(t, /^🔔 승인 요청 · rano-os 리더\n명령 실행: npm\n/);
  assert.match(t, /\n명령: npm test > ~\/rano\/runs\/tmp\/x\.txt 2>&1\n/);
  assert.match(t, /\n바뀌는 파일: ~\/rano\/runs\/tmp\/x\.txt/);
  assert.ok(!t.includes('⚠️'));
  assert.ok(!t.includes('판단 근거'));
});

test('커밋·지우기 카드: 종류 경고 줄과 명령·파일', () => {
  const c = approvalPhoneText(card({ kind: 'commit', title: '커밋: rano-app', detail: '명령: git commit -m "고침"\n실행 위치: ~/personal/rano-app\n판단 근거: git 기록' }));
  assert.match(c, /⚠️ 커밋 요청이에요/);
  assert.match(c, /명령: git commit -m "고침"/);
  const d = approvalPhoneText(card({ kind: 'delete', title: '파일 지우기: old.txt', what: '안 쓰는 파일 정리', detail: '승인하면 이번 과제 동안 아래 위치를 지우는 명령은 다시 묻지 않아요:\n- ~/personal/app/src/old.txt' }));
  assert.match(d, /⚠️ 지우기 요청이에요/);
  assert.match(d, /바뀌는 파일: ~\/personal\/app\/src\/old\.txt/);
  const w = approvalPhoneText(card({ kind: 'write', title: '파일 쓰기', filePath: '/Users/someone/personal/app/a.ts' }));
  assert.match(w, /바뀌는 파일: ~\/personal\/app\/a\.ts/);
});

test('비밀은 가린다(리더가 쓴 자세히 글에 섞여도)', () => {
  const t = approvalPhoneText(card({ detail: "명령: curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://example.com --token tok98765secret\n실행 위치: ~" }));
  assert.ok(!t.includes('abcdefghijklmnop1234'), t);
  assert.ok(!t.includes('tok98765secret'), t);
  assert.match(t, /\(가림\)/);
  const f = approvalPhoneText(card({ detail: '명령: echo\n바뀔 수 있는 파일: /tmp/out?password=hunter2hunter2' }));
  assert.ok(!f.includes('hunter2hunter2'), f);
});

test('글 길이 상한: 아주 긴 명령·이유도 한 통 안에 들어간다', () => {
  const t = approvalPhoneText(card({ why: '가'.repeat(6000), detail: `명령: echo hello ${'b'.repeat(5000)}\n실행 위치: ~` }));
  assert.ok(t.length <= PHONE_APPROVAL_MAX, String(t.length));
  // 이유가 길어 잘려도 명령 줄은 남는다
  assert.match(t, /\n명령: echo hello /);
  assert.match(t, /나머지는 맥 승인함에서 봐 주세요\)$/);
  assert.ok(PHONE_APPROVAL_MAX <= 3800); // telegram.ts MAX_TEXT(한 통) 안쪽
  // 명령은 정해진 길이에서 잘린다
  const c = approvalPhoneText(card({ detail: `명령: echo ${'c'.repeat(5000)}\n실행 위치: ~` }));
  const line = c.split('\n').find((l) => l.startsWith('명령: ')) ?? '';
  assert.ok(line.length <= 620, String(line.length));
});

test('묶음·결정 카드는 지금처럼 파일 목록·항목을 적는다', () => {
  const b = approvalPhoneText(card({ kind: 'bundle', title: '파일 2개', bundle: [{ rel: 'a.ts', abs: '/x/a.ts', draft: '/d/a.ts' }, { rel: 'b.ts', abs: '/x/b.ts', draft: '/d/b.ts' }] }));
  assert.match(b, /파일 2개: a\.ts, b\.ts/);
  assert.ok(!b.includes('바뀌는 파일:'));
  const d = approvalPhoneText(card({ kind: 'decision', title: '결정', decisionItems: [{ id: '1', question: '어느 안', options: [], recommended: 'A' }] }));
  assert.match(d, /1\. 어느 안 → 권장 A안/);
});

test('telegram.ts: 글은 approvalPhoneText 로 만들고, 승인 버튼은 종류와 상관없이 그대로(S2-B)', () => {
  const s = readFileSync(fileURLToPath(new URL('../../../src/main/mobile/telegram.ts', import.meta.url)), 'utf-8');
  assert.match(s, /this\.say\(approvalPhoneText\(a\), \{ reply_markup: \{ inline_keyboard: \[\[\{ text: `✅ \$\{okLabel\}`, callback_data: `ok:\$\{a\.id\}` \}, \{ text: '❌ 반려', callback_data: `no:\$\{a\.id\}` \}\]\] \} \}\)/);
  assert.match(s, /if \(act === 'ok'\) \{\s*this\.deps\.approvals\.decide\(id, \{ decision: 'approve' \}\);/);
  // 휴대폰 쪽은 바로 승인 규칙으로 버튼을 막지 않는다(맥 화면과 다른 점, 사용자 결정)
  assert.ok(!s.includes('canQuickApprove'));
  assert.ok(canQuickApprove({ kind: 'command' })); // 같은 규칙 파일을 본체에서도 부를 수 있음
});
