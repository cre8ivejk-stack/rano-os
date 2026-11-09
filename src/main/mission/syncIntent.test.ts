// 사용자가 직접 받아오기를 시켰는지. 실행: npm run build 후 node --test dist/main/mission/syncIntent.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userAskedSync } from './syncIntent.js';

test('받아오기를 시킨 말', () => {
  for (const t of [
    'pylon에서 현재 깃에 있는 버전을 pull해주기바란다.',
    'git pull 해줘',
    'PYLON 최신화 해줘',
    '원격 최신 내용 받아와',
    '깃에서 최신으로 맞춰줘',
    '서버 변경 당겨와 줘',
    '깃 풀 좀',
  ])
    assert.equal(userAskedSync(t), true, t);
});
test('받아오기가 아닌 말·막는 말', () => {
  for (const t of ['README 읽고 한 줄로 알려줘', '커밋하고 푸시해줘', '메뉴 화면 고쳐줘', 'pull 하지 마', '최신화는 말고 테스트만 돌려줘', ''])
    assert.equal(userAskedSync(t), false, t);
});
