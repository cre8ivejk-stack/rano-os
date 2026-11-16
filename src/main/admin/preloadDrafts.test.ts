// 화면 → 본체 통로(preload)가 미션·역할 초안을 넘길 때 칸을 빠뜨리지 않는지 시험한다.
// - 역할 "기본 모델"(opus·sonnet)이 저장 요청에 실려 가는지(예전에는 통로에서 빠졌음)
// - 미션 권한 "믿는 미션"(trusted)이 읽기 전용으로 바뀌지 않는지
// preload 는 샌드박스라 electron 밖 모듈을 불러올 수 없어서, 정리 함수를 따로 빼지 않고
// 빌드된 dist/preload/preload.cjs 를 가짜 electron 으로 그대로 실행해 확인한다(electron 밖 모듈을 부르면 실패).
// 실행: 빌드 후 `node --test dist/main/admin/preloadDrafts.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '..', '..', 'preload', 'preload.cjs');

type Api = Record<string, (...args: any[]) => unknown>;

function loadPreload(): { api: Api; calls: unknown[][] } {
  const calls: unknown[][] = [];
  let api: Api | null = null;
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (_name: string, value: Api) => {
        api = value;
      },
    },
    ipcRenderer: {
      invoke: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ ok: true });
      },
      on: () => undefined,
      removeListener: () => undefined,
      send: () => undefined,
    },
  };
  const fakeRequire = (id: string): unknown => {
    if (id === 'electron') return fakeElectron;
    throw new Error(`preload 가 electron 밖 모듈을 불러옴: ${id}`);
  };
  const mod = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', readFileSync(PRELOAD, 'utf8'))(fakeRequire, mod, mod.exports);
  assert.ok(api, 'preload 가 exposeInMainWorld 로 api 를 내놓아야 함');
  return { api: api as Api, calls };
}

const ROLE = { zone: 'personal', name: 'dev', description: '작업 담당', canWrite: true, canRun: false, body: '본문' };
const MISSION = {
  name: '시험 미션',
  goal: '목표',
  zone: 'personal',
  target: '/Users/x/personal/repo',
  readonlyRefs: ['/Users/x/personal/ref'],
  blocked: [],
  writeConfirmed: true,
  roles: ['dev'],
  reviewerRoles: ['reviewer'],
};

test('역할 저장: 기본 모델 opus·sonnet 이 그대로 넘어간다', async () => {
  for (const model of ['opus', 'sonnet', 'fable'] as const) {
    const { api, calls } = loadPreload();
    await api.orgSaveRole({ ...ROLE, model });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'org:save-role');
    assert.equal((calls[0][1] as any).model, model);
  }
});

test('역할 저장: 고친 역할(원래 이름 있음)에도 모델이 실린다', async () => {
  const { api, calls } = loadPreload();
  await api.orgSaveRole({ ...ROLE, model: 'opus' }, 'old-name');
  assert.deepEqual(calls[0].slice(0, 1), ['org:save-role']);
  assert.equal((calls[0][1] as any).model, 'opus');
  assert.equal(calls[0][2], 'old-name');
});

test('역할 저장: 없거나 모르는 모델 값은 default 로 바꾼다', async () => {
  for (const model of [undefined, 'default', 'gpt', 'OPUS', 1, null]) {
    const { api, calls } = loadPreload();
    await api.orgSaveRole({ ...ROLE, model });
    assert.equal((calls[0][1] as any).model, 'default', `model=${String(model)}`);
  }
});

test('역할 저장: 다른 칸 정리는 그대로다', async () => {
  const { api, calls } = loadPreload();
  await api.orgSaveRole({ zone: 'x', name: 3, canWrite: 'yes', canRun: true, body: undefined, extra: '버려져야 함', model: 'sonnet' });
  assert.deepEqual(calls[0][1], { zone: 'work', name: '3', description: '', canWrite: false, canRun: true, body: '', model: 'sonnet' });
});

test('미션 만들기·고치기: 믿는 미션(trusted)이 그대로 넘어간다', async () => {
  const a = loadPreload();
  await a.api.orgCreateMission({ ...MISSION, writeMode: 'trusted' });
  assert.equal(a.calls[0][0], 'org:create-mission');
  assert.equal((a.calls[0][1] as any).writeMode, 'trusted');
  const b = loadPreload();
  await b.api.orgUpdateMission('m1', { ...MISSION, writeMode: 'trusted' });
  assert.equal(b.calls[0][0], 'org:update-mission');
  assert.equal(b.calls[0][1], 'm1');
  assert.equal((b.calls[0][2] as any).writeMode, 'trusted');
});

test('미션 만들기: approval 은 그대로, 모르는 값은 읽기 전용', async () => {
  const cases: [unknown, string][] = [
    ['approval', 'approval'],
    ['readOnly', 'readOnly'],
    [undefined, 'readOnly'],
    ['TRUSTED', 'readOnly'],
    ['write', 'readOnly'],
  ];
  for (const [given, want] of cases) {
    const { api, calls } = loadPreload();
    await api.orgCreateMission({ ...MISSION, writeMode: given });
    assert.equal((calls[0][1] as any).writeMode, want, `writeMode=${String(given)}`);
  }
});
