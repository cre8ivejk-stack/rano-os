// 라노 세션: 사용자 말을 받아 Claude Agent SDK 로 라노 답을 만들고, 저장·화면 전송·기록을 맡는다.
// 줄 세우기·차례·흘려 보이기는 ranoCore.ts, 줄 규칙은 ranoLanes.ts. 이 파일은 실제 엔진과 로그인 환경을 붙인다.
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeBinaryPath } from './claudeBinary.js';
import type { RanoConfig } from '../../shared/types.js';
import { storedApiKey } from './auth.js';
import { browsersDir, ranoPython } from '../skills/skills.js';
import { fetchPlanLimits } from './usage.js';
import { RanoCore, type QueryFn, type RanoSessionDeps } from './ranoCore.js';

// 리더 세션 등 다른 곳이 이 파일에서 가져가던 것은 그대로 내보낸다
export { appendJsonl, friendlyError, looksLikeMissingSession, type RanoSessionDeps } from './ranoCore.js';

/** SDK 에 넘길 환경변수. Max 모드면 API 키·토큰을 빼서 본인 로그인을 쓰게 한다. 라노와 리포 리더가 함께 쓴다. */
export function buildSdkEnv(config: RanoConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (config.authMethod === 'max') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  } else {
    // API 키 모드: 앱에 저장한 키(키체인 암호화)가 있으면 그것을 쓴다
    const key = storedApiKey(config);
    if (key) env.ANTHROPIC_API_KEY = key;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // 스킬이 쓰는 문서 도구 파이썬 (데이터 폴더에 설치돼 있으면)
  const py = ranoPython(config);
  if (py) env.RANO_PY = py;
  env.PLAYWRIGHT_BROWSERS_PATH = browsersDir(config); // 웹 화면 확인 브라우저도 데이터 폴더 안
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'rano-os/0.7.0';
  return env;
}

/**
 * 메시지를 보내지 않는 빈 엔진 세션(사용 한도 조회용). 구독 계정(max)일 때만 만든다. 다 쓰면 close() 로 끈다.
 * 입력을 기다리기만 하므로 모델을 부르지 않고, 도구·설정·MCP 도 불러오지 않는다
 */
export function idleEngineSession(config: RanoConfig): { q: unknown; close: () => void } | null {
  if (config.authMethod !== 'max') return null;
  let stop: () => void = () => {};
  const idle = new Promise<void>((r) => (stop = r));
  const input = (async function* (): AsyncGenerator<SDKUserMessage> {
    await idle;
  })();
  const q = query({
    prompt: input,
    options: {
      cwd: config.rootDir,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      executable: 'node',
      ...(claudeBinaryPath() ? { pathToClaudeCodeExecutable: claudeBinaryPath() } : {}),
      env: buildSdkEnv(config),
    },
  });
  return {
    q,
    close: () => {
      stop();
      q.close();
    },
  };
}

export class RanoSession extends RanoCore {
  constructor(deps: RanoSessionDeps) {
    super({
      ...deps,
      queryFn: ((args) => query(args)) as QueryFn,
      sdkEnv: () => buildSdkEnv(deps.config),
      claudePath: () => claudeBinaryPath(),
      // 구독 계정이면 사용 한도(5시간·주간 %)도 받아 둔다 (엔진의 시험 기능이라 실패해도 그냥 넘어간다. 답 확정은 기다리지 않음)
      afterResult: (q) => void fetchPlanLimits(q),
    });
  }
}
