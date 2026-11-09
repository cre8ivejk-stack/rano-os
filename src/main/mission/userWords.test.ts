import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withUserWords } from './userWords.js';

test('사용자가 직접 쓴 말을 지시 끝에 인용으로 붙이고, 비면 그대로', () => {
  const out = withUserWords('라노 지시', '커밋하고 push 해줘\n이름은 jk');
  assert.ok(out.startsWith('라노 지시\n\n[사용자가 직접 쓴 말]'));
  assert.ok(out.includes('> 커밋하고 push 해줘\n> 이름은 jk'));
  assert.equal(withUserWords('라노 지시', '  '), '라노 지시');
  assert.ok(withUserWords('x', 'a'.repeat(2000)).includes('a'.repeat(1500) + '…'));
});
