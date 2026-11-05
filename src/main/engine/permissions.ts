// 라노가 도구를 쓸 때 허용/거절을 정하는 문지기. 모든 결정은 log 로 남긴다.
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import path from 'node:path';
import { MEMORY_MCP_NAME, MISSION_MCP_NAME, ORG_MCP_NAME, TODO_MCP_NAME, type PermissionLogEntry, type RanoConfig } from '../../shared/types.js';

const APP_SERVERS = [MEMORY_MCP_NAME, MISSION_MCP_NAME, TODO_MCP_NAME, ORG_MCP_NAME];

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

function normalize(p: string): string {
  return path.resolve(expandHome(p.trim()));
}

// glob 패턴(*, **, ?)을 정규식으로 바꾼다. ** 는 폴더 여러 단계, * 는 한 단계 안의 글자.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // **/ = 0개 이상의 폴더
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // 패턴에 맞는 경로 그 아래 전부도 막는다
  return new RegExp(`^${re}(?:/.*)?$`);
}

function hasGlob(p: string): boolean {
  return /[*?]/.test(p);
}

/** 경로 p 가 config.blocked 에 걸리면 true. 폴더 경로는 그 아래 전부를 포함한다. */
export function isBlockedPath(config: RanoConfig, p: string): boolean {
  if (!p) return false;
  const target = normalize(p);
  for (const raw of config.blocked) {
    if (!raw) continue;
    if (hasGlob(raw)) {
      // '**' 로 시작하면 어느 위치든 맞으면 막고, 그 밖의 패턴은 절대 경로로 풀어서 비교한다
      const pattern = raw.startsWith('**') ? `/${raw}` : normalizeGlob(raw);
      if (globToRegExp(pattern).test(target)) return true;
    } else {
      const base = normalize(raw);
      if (target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return true;
    }
  }
  return false;
}

// 글롭 문자가 든 경로의 ~ 와 상대 경로만 풀고, 글롭 문자는 그대로 둔다.
function normalizeGlob(p: string): string {
  const e = expandHome(p.trim());
  return path.isAbsolute(e) ? path.normalize(e) : path.join(process.cwd(), e);
}

/** 라노의 규칙: 앱이 등록한 기억 도구(mcp__rano-memory__*)와 미션 도구(mcp__rano-mission__*)만 허용하고 나머지는 모두 거절한다. */
export function createPermissionGate(config: RanoConfig, log: (line: PermissionLogEntry) => void): CanUseTool {
  void config; // 3단계에서 isBlockedPath 와 함께 쓴다
  return async (toolName, _input, options) => {
    const at = new Date().toISOString();
    const server = APP_SERVERS.find((name) => toolName.startsWith(`mcp__${name}__`));
    // SDK 안내대로 이름이 아니라 출처(source)로 신뢰를 판단한다. 출처가 없으면(구버전) 이름만 본다.
    const fromApp = !!server && (!options.mcpServer || (options.mcpServer.source === 'sdk' && options.mcpServer.name === server));
    if (server && fromApp) {
      const reason = server === MEMORY_MCP_NAME ? '기억 도구는 허용' : server === TODO_MCP_NAME ? '할 일 도구는 허용' : server === ORG_MCP_NAME ? '조직 도구는 허용' : '미션 도구는 허용';
      log({ at, agent: 'rano', tool: toolName, decision: 'allow', reason });
      return { behavior: 'allow' };
    }
    const reason = server ? '앱이 등록하지 않은 도구 서버라서 거절' : '라노는 기억·미션 도구만 쓸 수 있어서 거절';
    log({ at, agent: 'rano', tool: toolName, decision: 'deny', reason });
    return {
      behavior: 'deny',
      message: '라노는 직접 일하지 않고 기억을 정리하거나 미션 리더에게 일을 맡기는 것만 할 수 있어요. 이 일은 리포 리더에게 배정해 주세요.',
    };
  };
}
