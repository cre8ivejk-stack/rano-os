// 미션 기억(진행업무) 한 줄: 보고의 "결과" 절을 남기는지. 실행: npm run build 후 node --test dist/main/mission/progressLine.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { progressLine } from './dispatcher.js';

test('반려된 일도 "했다"로 남기지 않고 결과 절을 남김', () => {
  const r = '## 보고\n\n### 1. 한 일\nREADME.md 한 파일에 직접 했습니다.\n\n### 4. 결과\nREADME.md는 고치지 않았고 원래 내용 그대로입니다.\n\n### 6. 승인이 필요한 일\n없음';
  assert.equal(progressLine(r), 'README.md는 고치지 않았고 원래 내용 그대로입니다.');
});
test('결과 제목 다음 줄·같은 줄·꾸밈 기호', () => {
  assert.equal(progressLine('1. **한 일:** 읽었어요\n\n4. **결과:**\n   - **한 줄 요약:** 시험 폴더 소개 글이에요.\n\n6. 승인: 없음'), '한 줄 요약: 시험 폴더 소개 글이에요.');
  assert.equal(progressLine('## 4) 결과: 메뉴를 3단으로 바꿨어요\n5) 결정: 없음'), '메뉴를 3단으로 바꿨어요');
});
test('결과 절이 없으면 첫 줄, "결과물" 은 결과 절이 아님', () => {
  assert.equal(progressLine('그냥 짧은 답이에요.'), '그냥 짧은 답이에요.');
  assert.equal(progressLine('2. 결과물 대조표\n- a\n4. 결과\n끝났어요'), '끝났어요');
});
