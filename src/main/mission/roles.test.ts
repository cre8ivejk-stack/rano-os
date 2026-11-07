// 역할 파일 모델 시험. 실행: npm run build 후 `node --test dist/main/mission/roles.test.js`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RanoConfig } from '../../shared/types.js';
import { isOwnRoleFile, modelFor, normalizeRoleModel, parseRoleFile } from './roles.js';

const config = { rootDir: '/Users/x/rano', models: { rano: 'claude-opus-5-5', repoLeader: 'claude-opus-5-5', member: 'claude-opus-5-5' } } as unknown as RanoConfig;

test('model 줄 읽기', () => {
  assert.equal(parseRoleFile('---\nname: a\nmodel: sonnet\n---\nbody', 'a').model, 'sonnet');
  assert.equal(parseRoleFile('---\nname: a\nmodel: Opus\n---\nbody', 'a').model, 'opus');
  assert.equal(parseRoleFile('---\nname: a\n---\nbody', 'a').model, 'default');
  assert.equal(normalizeRoleModel('claude-sonnet-5-5'), 'sonnet');
  assert.equal(normalizeRoleModel('haiku'), 'default');
});

test('라노 데이터 폴더의 역할만 model 을 따른다', () => {
  assert.equal(isOwnRoleFile(config, '/Users/x/rano/pool/personal/w.md'), true);
  assert.equal(isOwnRoleFile(config, '/Users/x/rano/missions/personal/m/roles/w.md'), true);
  assert.equal(isOwnRoleFile(config, '/Users/x/work/.claude/agents/w.md'), false);
  assert.equal(isOwnRoleFile(config, '/Users/x/rano-other/w.md'), false);
});

test('모델 이름 바꾸기', () => {
  assert.equal(modelFor(config, 'default'), 'claude-opus-5-5');
  assert.equal(modelFor(config, 'opus'), 'claude-opus-5-5');
  assert.equal(modelFor(config, 'sonnet'), 'sonnet');
});
