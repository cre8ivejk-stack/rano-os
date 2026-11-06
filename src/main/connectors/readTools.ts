// 외부 연결 도구 이름으로 읽기(바로 허용)인지 가린다. electron 없이 쓰이도록 따로 둔다.
// 이름의 단어 하나라도 쓰기 동작이면 승인함으로. 읽기 단어만 있으면 바로. 둘 다 없으면(모르는 도구) 승인함으로.
const WRITE_WORDS = new Set(['create', 'update', 'delete', 'remove', 'add', 'edit', 'move', 'upload', 'download', 'transition', 'link', 'post', 'send', 'write', 'set', 'put', 'archive', 'restore', 'assign', 'apply', 'clear', 'trigger', 'run', 'execute', 'register', 'cleanup', 'reply', 'publish', 'merge', 'close', 'approve']);
const READ_WORDS = new Set(['get', 'list', 'search', 'read', 'fetch', 'view', 'find', 'query', 'lookup', 'check', 'inspect', 'describe', 'preview', 'diff', 'validate', 'detect', 'diagnose', 'ask']);
// 조회라도 비밀·접속 정보가 보일 수 있는 것은 승인함으로 (예: 앱 환경변수, 키 관리, 저장소 내려받기 주소)
const SENSITIVE_WORDS = new Set(['env', 'vars', 'secret', 'secrets', 'kms', 'credential', 'credentials', 'password', 'token', 'tokens', 'url', 'object']);
export function isConnectorReadTool(tool: string): boolean {
  const words = tool.toLowerCase().split(/[_\-]+/);
  if (words.some((w) => WRITE_WORDS.has(w) || SENSITIVE_WORDS.has(w))) return false;
  return words.some((w) => READ_WORDS.has(w));
}
