// 외부 연결 도구 이름으로 읽기(바로 허용)인지 가린다. electron 없이 쓰이도록 따로 둔다.
// 이름의 단어 하나라도 쓰기 동작이면 승인함으로. 읽기 단어만 있으면 바로. 둘 다 없으면(모르는 도구) 승인함으로.
const WRITE_WORDS = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'edit', 'move', 'upload', 'download', 'transition', 'link', 'post', 'send', 'write', 'set', 'put',
  'archive', 'restore', 'assign', 'apply', 'clear', 'trigger', 'run', 'execute', 'register', 'cleanup', 'reply', 'publish', 'merge', 'close', 'approve',
  'start', 'stop', 'cancel', 'save', 'replace', 'rename', 'submit', 'insert', 'push', 'comment', 'deploy', 'rollback', 'sync', 'import', 'invoke',
  'enable', 'disable', 'report', 'feedback', 'request', 'prepare', 'finalize', 'materialize', 'configure', 'setup', 'repair', 'install', 'migrate',
  'batch', 'reset', 'kill', 'restart', 'grant', 'revoke', 'share', 'invite', 'mark', 'label', 'tag', 'lock', 'unlock', 'pin', 'unpin', 'fork', 'copy', 'smoke',
]);
const READ_WORDS = new Set(['get', 'list', 'search', 'read', 'fetch', 'view', 'find', 'query', 'lookup', 'check', 'inspect', 'describe', 'preview', 'diff', 'validate', 'detect', 'diagnose', 'ask', 'show', 'count', 'status', 'wait']);
const SENSITIVE_WORDS = new Set(['env', 'vars', 'secret', 'secrets', 'kms', 'credential', 'credentials', 'password', 'token', 'tokens', 'url', 'object']);

/**
 * 외부 연결(MCP) 도구가 읽기만 하는지. 이름의 단어로 판단한다.
 * - 쓰기·민감 단어가 하나라도 있으면 읽기가 아니다.
 * - 앞쪽 서비스 이름(예: confluence_, jira_)을 두 단어까지 건너뛴 다음 첫 동사가 읽기 동사여야 한다.
 */
export function isConnectorReadTool(tool: string): boolean {
  const words = tool.toLowerCase().split(/[_\-]+/).filter(Boolean);
  if (words.some((w) => WRITE_WORDS.has(w) || SENSITIVE_WORDS.has(w))) return false;
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    if (READ_WORDS.has(words[i])) return true;
  }
  return false;
}
