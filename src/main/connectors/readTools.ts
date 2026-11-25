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

const STATUS_VERBS = new Set(['get', 'check', 'list', 'show']);
const STATUS_NOUNS = new Set(['deploy', 'run', 'sync', 'import', 'migrate', 'rollback', 'publish', 'install', 'batch', 'restart', 'request']);

/**
 * 외부 연결(MCP) 도구가 읽기만 하는지. 이름의 단어로 판단한다.
 * - 쓰기·민감 단어가 하나라도 있으면 읽기가 아니다.
 * - 앞쪽 서비스 이름(예: confluence_, jira_)을 두 단어까지 건너뛴 다음 첫 동사가 읽기 동사여야 한다.
 */
export function isConnectorReadTool(tool: string): boolean {
  const words = tool.toLowerCase().split(/[_\-]+/).filter(Boolean);
  // 상태 보기(get_app_deploy_status · get_build_status 등): 조회 동사로 시작하고 status 로 끝나면, 가운데의 deploy·build·run 같은 말은 대상 이름이다 (0.9.14)
  if (words.length >= 3 && STATUS_VERBS.has(words[0]) && words[words.length - 1] === 'status' && !words.some((w) => SENSITIVE_WORDS.has(w)) && words.slice(1, -1).every((w) => !WRITE_WORDS.has(w) || STATUS_NOUNS.has(w)))
    return true;
  if (words.some((w) => WRITE_WORDS.has(w) || SENSITIVE_WORDS.has(w))) return false;
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    if (READ_WORDS.has(words[i])) return true;
  }
  return false;
}

/** 이름은 읽기 동사로 시작하는데 민감한 것(환경 변수·비밀·주소 등)을 읽어서 묻는 도구인지. 쓰기 단어가 있으면 아니다 */
export function isConnectorSensitiveRead(tool: string): boolean {
  const words = tool.toLowerCase().split(/[_\-]+/).filter(Boolean);
  if (words.some((w) => WRITE_WORDS.has(w)) || !words.some((w) => SENSITIVE_WORDS.has(w))) return false;
  return words.slice(0, 3).some((w) => READ_WORDS.has(w));
}
