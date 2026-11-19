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

/** 이보다 긴 파일은 통째로 다시 쓰기를 받지 않는다(줄여 정리할 때만) */
const REWRITE_LIMIT = 3000;
/** 이보다 길면 줄이라고 알려 준다 */
const LONG_FILE = 8000;

/** 기억 파일 한 군데 고치기. old 가 비면 끝에 덧붙이고, 있으면 한 번만 나오는 그 글을 new 로 바꾼다 */
export function applyMemoryEdit(now: string, old: string, next: string): { ok: true; content: string } | { ok: false; message: string } {
  if (!old) {
    if (!next.trim()) return { ok: false, message: '넣을 글(new)이 비어 있어요.' };
    return { ok: true, content: `${now.replace(/\s+$/, '')}${now.trim() ? '\n' : ''}${next.replace(/\s+$/, '')}\n` };
  }
  const n = now.split(old).length - 1;
  if (n === 0) return { ok: false, message: 'old 의 글이 지금 파일에 없어요. read_memory 로 지금 내용을 보고, 있는 글 그대로의 짧은 한 구절을 넣으세요.' };
  if (n > 1) return { ok: false, message: `old 의 글이 파일에 ${n}번 나와요. 한 번만 나오도록 앞뒤 글을 조금 더 넣으세요.` };
  return { ok: true, content: now.replace(old, () => next) };
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
        // 긴 파일을 거의 그대로 다시 쓰는 것은 받지 않는다: 몇 분이 걸리고 값이 크다. 바뀐 부분만 edit_memory 로 고치게 한다 (0.9.18)
        const now = await memory.read(name);
        if (now.length > REWRITE_LIMIT && content.length > now.length * 0.8)
          return text(`${name} 은(는) 길어서(${now.length.toLocaleString()}자) 통째로 다시 쓰지 않아요. 바뀐 부분만 edit_memory 로 고치세요(old 에 지금 글의 짧은 한 구절, new 에 바꿀 글. old 를 비우면 끝에 덧붙임). 통째로 쓰기는 파일을 지금의 80% 아래로 줄여 정리할 때만 돼요.`, true);
        const r = await memory.write(name, content, reason);
        const tail = r.committed ? '자동 저장 기록도 남겼습니다.' : r.note ? `자동 저장 기록은 남기지 않았습니다(${r.note}).` : '';
        return text(`${name} 을(를) 저장했습니다. ${tail}`.trim());
      } catch (e) {
        return text(`기억을 저장하지 못했습니다: ${errMsg(e)}`, true);
      }
    },
  );

  const editMemory = tool(
    'edit_memory',
    [
      '라노의 전역 기억 파일에서 바뀐 부분만 고칩니다(파일 전체를 다시 쓰지 않아 빠릅니다). 기억을 고칠 때는 보통 이 도구를 씁니다.',
      'old: 지금 파일에 있는 글 그대로의 한 구절(파일에 한 번만 나오는 만큼만, 짧게). new: 그 자리에 넣을 글. old 를 비우면 new 를 파일 끝에 새 줄로 덧붙입니다. new 를 비우면 old 를 지웁니다.',
      'reason 에는 무엇을 왜 바꾸는지 한 줄로 적습니다.',
    ].join('\n'),
    {
      name: z.string().describe('고칠 기억 파일 이름: me.md, priorities.md, missions.md 중 하나'),
      old: z.string().optional().describe('바꿀 글(지금 파일에 있는 그대로, 한 번만 나오는 구절). 비우면 끝에 덧붙임'),
      new: z.string().describe('넣을 글. 비우면 old 를 지움'),
      reason: z.string().describe('무엇을 왜 바꾸는지 한 줄'),
    },
    async (args) => {
      try {
        const now = await memory.read(args.name);
        const r = applyMemoryEdit(now, args.old ?? '', args.new);
        if (!r.ok) return text(r.message, true);
        const w = await memory.write(args.name, r.content, args.reason);
        const long = r.content.length > LONG_FILE ? ` 이 파일이 길어요(${r.content.length.toLocaleString()}자). 라노가 말할 때마다 읽는 글이라 값이 들어요. 한가할 때 update_memory 로 지난 경과를 덜어 내고 지금 상태만 짧게 정리하세요.` : '';
        return text(`${args.name} 을(를) 고쳤습니다.${w.committed ? ' 자동 저장 기록도 남겼습니다.' : ''}${long}`);
      } catch (e) {
        return text(`기억을 고치지 못했습니다: ${errMsg(e)}`, true);
      }
    },
  );

  return createSdkMcpServer({ name: MEMORY_MCP_NAME, version: '0.1.0', tools: [readMemory, updateMemory, editMemory] });
}
