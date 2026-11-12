// 라노가 쓰는 할 일 도구(MCP): todo_list, todo_add, todo_update, todo_remove
// 완료(done) 표시는 사용자만 한다 — 이 도구는 대기·진행 중·확인 요청까지만 받는다.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TODO_MCP_NAME, type RanoConfig, type TodoStoreApi } from '../../shared/types.js';
import { TODO_STATUS_LABEL } from './todoStore.js';

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "단계: 1.조사 → 2.초안 → 3.확인" 처럼 메모에 적힌 단계를 목록으로. 단계 글이 아니면 null */
export function stepsFromNote(note: string): string[] | null {
  const m = /^\s*(단계|마일스톤)\s*[:：]\s*(.+)$/s.exec(note);
  if (!m) return null;
  const parts = m[2]
    .split(/\s*(?:→|->|>|\/|,|\n)\s*/)
    .map((p) => p.replace(/^\s*\d+\s*[.)]\s*/, '').replace(/^✓/, '').trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : null;
}

export function createTodoMcpServer(todos: TodoStoreApi, config: RanoConfig) {
  const ids = config.missions.map((m) => `${m.id}(${m.name})`).join(', ') || '없음';

  const list = tool(
    'todo_list',
    '사용자와 함께 보는 할 일 목록을 읽습니다. 미션별로 묶어 상태(대기·진행 중·확인 요청·완료)와 id 를 돌려줍니다.',
    {},
    async () => text(todos.describe()),
    { annotations: { readOnlyHint: true } },
  );

  const add = tool(
    'todo_add',
    [
      '할 일 목록에 굵직한 일 하나를 추가합니다. 사용자가 "할 일에 넣어줘"처럼 부탁했거나, 사용자가 맡긴 큰 일이 목록에 없을 때 씁니다.',
      '작은 일회성 질문이나 잡담은 넣지 않습니다. 제목은 사용자가 알아보기 쉬운 짧은 한국어로 적습니다.',
      `missionId: 미션 id (${ids}). 미션 밖의 일이면 비웁니다.`,
    ].join('\n'),
    {
      title: z.string().describe('할 일 제목 (짧게)'),
      missionId: z.string().optional().describe('미션 id. 미션 밖의 일이면 비움'),
      steps: z.array(z.string()).optional().describe('단계(마일스톤) 3~5개. 순서대로 짧은 이름. 마지막은 사용자가 결과를 확인하는 단계(예: "확인")'),
    },
    async ({ title, missionId, steps }) => {
      try {
        let x = todos.add(missionId ?? null, title, 'rano');
        if (steps?.length) x = todos.update(x.id, { steps }, 'rano');
        return text(`할 일에 넣었어요: ${x.title} (id: ${x.id}, 상태 대기${x.steps?.length ? `, 단계 ${x.steps.map((s) => s.title).join(' → ')}` : ''})`);
      } catch (e) {
        return text(`할 일을 넣지 못했어요: ${errMsg(e)}`, true);
      }
    },
  );

  const update = tool(
    'todo_update',
    [
      '할 일의 제목·상태·메모·단계(마일스톤)를 바꿉니다. 상태는 waiting(대기), active(진행 중), review(확인 요청)만 쓸 수 있습니다.',
      '완료(done)는 사용자만 표시합니다. 일이 끝난 것 같으면 review 로 두고 사용자에게 확인해 달라고 말하세요.',
      '리더에게 배정할 때는 assign_to_mission 에 todoId 를 넘기면 앱이 진행 중·확인 요청을 알아서 바꾸므로 이 도구를 따로 쓸 필요가 없습니다.',
    ].join('\n'),
    {
      id: z.string().describe('할 일 id (todo_list 로 확인)'),
      title: z.string().optional(),
      status: z.enum(['waiting', 'active', 'review']).optional(),
      note: z.string().optional().describe('짧은 메모. 빈 글자면 메모를 지움. 단계(마일스톤)는 여기 적지 말고 steps 에 넣음'),
      steps: z.array(z.string()).optional().describe('단계(마일스톤) 목록을 새로 정함. 3~5개, 순서대로. 같은 이름의 단계는 끝남 표시가 이어짐. 빈 목록이면 단계를 지움'),
      doneSteps: z.array(z.number().int()).optional().describe('끝난 단계 번호(1부터). 마지막 단계는 사용자만 표시할 수 있음'),
      undoneSteps: z.array(z.number().int()).optional().describe('끝남 표시를 되돌릴 단계 번호(1부터)'),
    },
    async ({ id, title, status, note, steps, doneSteps, undoneSteps }) => {
      try {
        // 단계를 메모에 적어 보낸 경우("단계: 1.조사 → 2.초안 …")는 단계로 옮겨 담는다
        const fromNote = !steps && note ? stepsFromNote(note) : null;
        if (fromNote) {
          steps = fromNote;
          note = '';
        }
        const x = todos.update(id, { title, status, note, ...(steps ? { steps } : {}), ...(doneSteps ? { doneSteps } : {}), ...(undoneSteps ? { undoneSteps } : {}) }, 'rano');
        return text(`바꿨어요: ${x.title} — ${TODO_STATUS_LABEL[x.status]}${x.steps?.length ? ` (단계 ${x.steps.filter((s) => s.done).length}/${x.steps.length})` : ''}`);
      } catch (e) {
        return text(`바꾸지 못했어요: ${errMsg(e)}`, true);
      }
    },
  );

  const remove = tool(
    'todo_remove',
    '할 일 하나를 목록에서 지웁니다. 사용자가 지워 달라고 분명히 말했을 때만 씁니다.',
    { id: z.string().describe('할 일 id') },
    async ({ id }) => {
      try {
        todos.remove(id, 'rano');
        return text('지웠어요.');
      } catch (e) {
        return text(`지우지 못했어요: ${errMsg(e)}`, true);
      }
    },
  );

  return createSdkMcpServer({ name: TODO_MCP_NAME, version: '0.1.0', tools: [list, add, update, remove] });
}
