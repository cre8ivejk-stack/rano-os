// 라노가 쓰는 기억 도구(MCP): read_memory, update_memory
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MEMORY_MCP_NAME, type MemoryServiceApi } from '../../shared/types.js';

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createMemoryMcpServer(memory: MemoryServiceApi) {
  const readMemory = tool(
    'read_memory',
    [
      '라노의 전역 기억 파일을 읽습니다.',
      '기억 파일: me.md(사용자에 대해 알게 된 것), priorities.md(지금의 우선순위), missions.md(미션 목록과 상태).',
      'name 을 비우면 모든 기억 파일을 한 번에 돌려주고, name 을 주면 그 파일만 돌려줍니다.',
      '기억을 고치기(update_memory) 전에는 반드시 이 도구로 현재 내용을 먼저 읽으세요.',
    ].join('\n'),
    { name: z.string().optional().describe('읽을 기억 파일 이름 (예: me.md). 비우면 전체') },
    async ({ name }) => {
      try {
        if (name) return text(await memory.read(name));
        const all = await memory.readAll();
        return text(all.map((f) => `### ${f.name}\n${f.content}`).join('\n\n'));
      } catch (e) {
        return text(`기억을 읽지 못했습니다: ${errMsg(e)}`, true);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const updateMemory = tool(
    'update_memory',
    [
      '라노의 전역 기억 파일 하나를 새 내용으로 통째로 바꿔 씁니다.',
      '언제 쓰나: 사용자에 대해 새로 알게 된 사실, 바뀐 우선순위, 미션 상태 변화처럼 다음 대화에서도 기억해야 할 것이 생겼을 때.',
      '주의: content 는 파일 전체 내용입니다. 덧붙이는 기능이 아니므로, 먼저 read_memory 로 현재 내용을 읽고 기존 내용을 그대로 살린 채 바뀐 부분만 반영한 전체 내용을 넘기세요. 빠뜨린 내용은 지워집니다.',
      'reason 에는 무엇을 왜 바꾸는지 한 줄로 적습니다(저장 기록에 남습니다).',
    ].join('\n'),
    {
      name: z.string().describe('바꿀 기억 파일 이름: me.md, priorities.md, missions.md 중 하나'),
      content: z.string().describe('파일의 새 전체 내용 (기존 내용 보존 필수)'),
      reason: z.string().describe('무엇을 왜 바꾸는지 한 줄'),
    },
    async ({ name, content, reason }) => {
      try {
        const r = await memory.write(name, content, reason);
        const tail = r.committed ? '자동 저장 기록도 남겼습니다.' : r.note ? `자동 저장 기록은 남기지 않았습니다(${r.note}).` : '';
        return text(`${name} 을(를) 저장했습니다. ${tail}`.trim());
      } catch (e) {
        return text(`기억을 저장하지 못했습니다: ${errMsg(e)}`, true);
      }
    },
  );

  return createSdkMcpServer({ name: MEMORY_MCP_NAME, version: '0.1.0', tools: [readMemory, updateMemory] });
}
