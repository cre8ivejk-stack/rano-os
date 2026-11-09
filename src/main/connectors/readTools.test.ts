import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isConnectorReadTool } from './readTools.js';

test('외부 연결: 기다리기·조회는 읽기, 실행·배포는 쓰기', () => {
  for (const t of ['wait_for_app_rollout', 'get_app_build_status', 'confluence_get_page']) {
    assert.equal(isConnectorReadTool(t), true, t);
  }
  for (const t of ['run_app_command', 'trigger_app_build', 'get_app_env_vars', 'start_app_endpoint_check']) {
    assert.equal(isConnectorReadTool(t), false, t);
  }
});
