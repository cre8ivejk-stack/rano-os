// 설정 화면의 라노·리더 모델 고르기 시험: 종류 알아보기, 저장할 이름, rano.json 저장과 켜진 앱 설정 바로 바꾸기.
// 임시 폴더에 config/rano.json 을 만들어 실제 파일로 확인한다.
// 실행: 빌드 후 `node --test dist/main/admin/modelSettings.test.js`
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MemoryServiceApi, RanoConfig } from '../../shared/types.js';
import { loadConfig, modelIdFor, modelKindOf } from '../config.js';
import { createSetup } from '../setup.js';

const fresh = (models?: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rano-models-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'rano.json'), JSON.stringify({ blocked: ['~/.ssh/**'], ...(models ? { models } : {}) }, null, 2));
  const config = loadConfig(root) as RanoConfig;
  const setup = createSetup(config, {} as MemoryServiceApi);
  const saved = () => JSON.parse(readFileSync(path.join(root, 'config', 'rano.json'), 'utf-8'));
  return { root, config, setup, saved };
};

test('모델 이름 → 종류', () => {
  assert.equal(modelKindOf('claude-opus-5-5'), 'opus');
  assert.equal(modelKindOf('claude-fable-5-2'), 'fable');
  assert.equal(modelKindOf('sonnet'), 'sonnet');
  assert.equal(modelKindOf('claude-haiku-4-5'), 'other');
  assert.equal(modelKindOf(''), 'other');
});

test('고른 종류 → 저장할 이름: 같은 종류면 지금 이름 그대로, 모르는 값은 거절', () => {
  assert.equal(modelIdFor('opus', 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(modelIdFor('fable', 'claude-opus-5-5'), 'fable');
  assert.equal(modelIdFor('fable', 'claude-fable-5-2'), 'claude-fable-5-2');
  assert.equal(modelIdFor('sonnet', 'claude-opus-5-5'), 'sonnet');
  assert.equal(modelIdFor('opus', 'fable'), 'claude-opus-5-5');
  assert.equal(modelIdFor('haiku', 'claude-opus-5-5'), null);
  assert.equal(modelIdFor('claude-opus-5-5 --x', 'fable'), null);
  assert.equal(modelIdFor(undefined, 'fable'), null);
});

test('저장하면 rano.json 과 켜진 앱 설정이 함께 바뀌고, 팀원 모델·다른 칸은 그대로', async () => {
  const { config, setup, saved } = fresh({ rano: 'claude-opus-5-5', repoLeader: 'claude-opus-5-5', member: 'claude-opus-5-5' });
  const r = await setup.saveModels({ rano: 'sonnet', repoLeader: 'fable' });
  assert.equal(r.ok, true);
  assert.equal(config.models.rano, 'sonnet');
  assert.equal(config.models.repoLeader, 'fable');
  assert.equal(config.models.member, 'claude-opus-5-5');
  const raw = saved();
  assert.deepEqual(raw.models, { rano: 'sonnet', repoLeader: 'fable', member: 'claude-opus-5-5' });
  assert.deepEqual(raw.blocked, ['~/.ssh/**']);
});

test('models 칸이 없던 설정 파일에도 세 칸 모두 적는다', async () => {
  const { setup, saved } = fresh();
  const r = await setup.saveModels({ rano: 'opus', repoLeader: 'fable' });
  assert.equal(r.ok, true);
  assert.deepEqual(saved().models, { rano: 'claude-opus-5-5', repoLeader: 'fable', member: 'claude-opus-5-5' });
});

test('바뀐 게 없으면 파일을 다시 쓰지 않는다 / keep 은 지금 이름 그대로', async () => {
  const { config, setup, saved } = fresh({ rano: 'claude-haiku-4-5', repoLeader: 'claude-opus-5-5' });
  const r = await setup.saveModels({ rano: 'keep', repoLeader: 'opus' });
  assert.equal(r.ok, true);
  assert.match(r.message, /바뀐 모델이 없어요/);
  assert.equal(saved().models.member, undefined);
  const r2 = await setup.saveModels({ rano: 'keep', repoLeader: 'sonnet' });
  assert.equal(r2.ok, true);
  assert.equal(config.models.rano, 'claude-haiku-4-5');
  assert.equal(saved().models.rano, 'claude-haiku-4-5');
  assert.equal(saved().models.repoLeader, 'sonnet');
});

test('고를 수 없는 값은 저장하지 않는다', async () => {
  const { config, setup, saved } = fresh({ rano: 'claude-opus-5-5', repoLeader: 'claude-opus-5-5' });
  for (const bad of [{ rano: 'gpt', repoLeader: 'opus' }, { rano: 'opus', repoLeader: '' }, { rano: 'opus' }, {}]) {
    const r = await setup.saveModels(bad);
    assert.equal(r.ok, false);
  }
  assert.equal(config.models.rano, 'claude-opus-5-5');
  assert.equal(saved().models.repoLeader, 'claude-opus-5-5');
});
