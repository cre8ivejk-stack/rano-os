// 라노가 쓰는 미션 도구(MCP): assign_to_mission, get_mission_status
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MISSION_MCP_NAME, type MemberState, type MissionDispatcherApi, type MissionStatus, type RanoConfig } from '../../shared/types.js';
import { zoneText } from '../admin/paths.js';
import { shareWithMission } from '../engine/attachments.js';
import { userAskedSync } from './syncIntent.js';
import { withUserWords } from './userWords.js';
import { taskTitle, withTitle } from './taskText.js';
import { shareTaskFiles } from '../approvals/taskFiles.js';
import { cleanWorkName, type WorkStore, type WorkTurn } from '../engine/works.js';

const STATE_LABEL: Record<MemberState, string> = { idle: '대기', working: '작업 중', reviewing: '검수 중', done: '완료' };
const TASK_LABEL = { running: '진행 중', done: '완료', failed: '중단' } as const;

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function describeStatus(s: MissionStatus): string {
  const out: string[] = [`## ${s.name} (${s.missionId}) — 리더 ${s.leaderState === 'working' ? '일하는 중' : '쉬는 중'}`];
  const t = s.currentTask;
  if (t) {
    out.push(`과제: ${t.title} [${TASK_LABEL[t.status]}] · ${t.from === 'rano' ? '라노 배정' : '사용자 직접 지시'} · 시작 ${hhmm(t.startedAt)}${t.endedAt ? ` · 끝 ${hhmm(t.endedAt)}` : ''}`);
  } else {
    out.push('과제: 아직 없음');
  }
  if (s.members.length) {
    out.push('팀원:');
    for (const m of s.members) out.push(`- ${m.role}: ${STATE_LABEL[m.state]}${m.task ? ` — ${m.task}` : ''}`);
  } else {
    out.push('팀원: 이번 과제에 부른 팀원 없음');
  }
  out.push(`승인 대기: ${s.pendingApprovals}건`);
  if (s.recent.length) {
    out.push('최근 활동:');
    for (const a of s.recent) out.push(`- ${hhmm(a.at)} ${a.who}: ${a.text}`);
  }
  return out.join('\n');
}

export function createMissionMcpServer(
  dispatcher: MissionDispatcherApi,
  config: RanoConfig,
  userText?: () => Promise<string>,
  terminalText?: (missionId?: string) => string,
  works?: { store: WorkStore; turn: WorkTurn; lead?: (turnIds: string[]) => Promise<string[]> },
  peek?: { cards: (missionId?: string) => string; file: (taskId: string, name?: string) => { ok: boolean; text: string } },
) {
  const list = config.missions.map((m) => `- ${m.id}: ${m.name} (${zoneText(config)[m.zone].label} 구역)`).join('\n') || '- (등록된 미션 없음)';

  const assign = tool(
    'assign_to_mission',
    [
      '미션의 리포 리더에게 과제를 배정합니다. 리포 리더가 팀원을 불러 일을 하고, 끝나면 "[앱 알림] … 리더 보고" 로 결과가 도착합니다.',
      '이 도구는 기다리지 않고 바로 "배정했어요" 접수 문구를 돌려줍니다. 결과를 지어내지 말고 보고가 올 때까지 기다리세요.',
      '사용자가 미션 관련 일을 맡기면 이 도구로 배정합니다. task 에는 리포 리더가 따로 묻지 않아도 이해하도록',
      '목적(왜), 범위(무엇을, 어디까지), 결과물 형태(어떤 문서·목록·보고로)를 분명히 적어 넘기세요.',
      '등록된 미션 id:',
      list,
    ].join('\n'),
    {
      missionId: z.string().describe('미션 id (예: homepage)'),
      title: z.string().describe('과제 제목: 화면·알림·결과물함에 보이는 짧은 이름. 20자 안팎의 명사구로 무엇을 하는 일인지만(예: "주간 업무 페이지 갱신", "로그인 화면 구현"). "목적:"·"○○님이…" 같은 머리말이나 문장을 쓰지 않는다'),
      task: z.string().describe('리포 리더에게 넘길 지시: 목적·범위·결과물 형태 포함'),
      shareFrom: z.array(z.string()).optional().describe('함께 넘길 앞 과제의 id 들(리더 보고에 적힌 과제 id, 앞 8자도 됨). 다른 미션이 만든 결과 파일(보고서·엑셀·그림)이 이 과제에 필요할 때 넣는다. 앱이 그 결과 파일을 받는 미션이 읽을 수 있는 곳으로 복사해 경로를 지시에 붙인다(미션끼리는 서로의 결과 폴더를 읽지 못한다)'),
      todoId: z.string().optional().describe('이 과제와 연결할 할 일 id (할 일 목록에 있는 일이면 넘김)'),
      planFirst: z.boolean().optional().describe('화면·기능 개편처럼 "기획 후 구현"인 과제면 true: 리더가 안 2~3개와 권장안을 먼저 올려 사용자가 고른 뒤에 구현한다'),
      attachments: z.array(z.string()).optional().describe('사용자가 대화에 붙인 그림 id (앱 안내에 나온 id). 리더와 팀원이 그 그림을 열어 볼 수 있게 함께 넘긴다'),
      workId: z.string().optional().describe('이어지는 일이면 그 업무의 id (앱 안내·업무 목록에 나온 w_… 값). 같은 일의 다음 단계·고치기·되묻기는 반드시 같은 업무로'),
      workName: z.string().optional().describe('새 일이면 업무 이름: 사용자가 한눈에 알아볼 짧은 이름, 12자 안팎의 명사구(예: "메뉴 문서 정리", "로그인 오류", "○○님 답장"). 문장·지시문·"○○님이…" 같은 머리말을 쓰지 않는다'),
    },
    async ({ missionId, title, task, todoId, planFirst, attachments, workId, workName, shareFrom }) => {
      try {
        let body = task;
        if (shareFrom?.length) {
          if (!config.missions.some((m) => m.id === missionId)) return text(`"${missionId}" 미션을 찾지 못했어요.`, true);
          const got: string[] = [];
          for (const id of shareFrom.slice(0, 5)) {
            const r = shareTaskFiles(config.runsDir, missionId, id.trim());
            if (!r.ok) return text(`아직 맡기지 않았어요. ${r.note}`, true);
            got.push(...r.paths);
          }
          if (got.length)
            body += `\n\n[앞 과제 결과 파일] 앱이 이 미션이 읽을 수 있는 곳으로 복사해 둔 파일이에요. Read 도구로 열어 보세요(원본은 다른 미션의 결과 폴더라 읽지 못해요. 이 복사본을 쓰세요):\n${got.map((p) => `- ${p}`).join('\n')}`;
        }
        if (attachments?.length) {
          if (!config.missions.some((m) => m.id === missionId)) return text(`"${missionId}" 미션을 찾지 못했어요.`, true);
          const shared = shareWithMission(config.runsDir, missionId, attachments);
          if (shared.missing.length && !shared.paths.length) return text(`그림 id 를 찾지 못했어요: ${shared.missing.join(', ')}`, true);
          if (shared.paths.length)
            body += `\n\n[첨부 그림] 사용자가 붙인 그림이에요. Read 도구로 열어 보세요(팀원에게도 이 경로를 넘기세요). 그림 위의 빨강·파랑·노랑 펜·네모·화살표·번호는 사용자가 고치고 싶은 곳을 직접 표시한 거예요:\n${shared.paths.map((p) => `- ${p}`).join('\n')}`;
        }
        // 사용자가 직접 받아오기(pull)를 시켰으면 그 과제의 받아오기는 승인 없이(라노가 쓴 지시가 아니라 사용자가 쓴 말로 판단)
        // 사용자가 직접 쓴 말을 지시에 함께 붙인다(리더가 범위를 이 말로 판단)
        let preSync = false;
        try {
          const words = userText ? await userText() : '';
          preSync = userAskedSync(words);
          body = withUserWords(body, words);
        } catch {
          preSync = false;
        }
        // 업무(대화 방): 준 id·이름 → 이번 차례의 방 → 지시문으로 지은 이름 순서로 정한다. 없는 미션이면 업무를 만들지 않는다
        let work: { id: string; name: string } | undefined;
        if (works && config.missions.some((m) => m.id === missionId) && task.trim()) {
          // 업무를 정하지 않고 맡기면 한 번 되돌려 이름을 받는다(지시문 앞머리로 지은 이름은 사용자가 알아보기 어렵다)
          if (!works.store.get(workId?.trim()) && !cleanWorkName(workName) && !works.store.get(works.turn.workId))
            return text('아직 맡기지 않았어요. 이 일이 달릴 업무를 정해서 다시 불러 주세요: 새 일이면 workName 에 사용자가 한눈에 알아볼 짧은 이름(12자 안팎의 명사구, 예: "메뉴 문서 정리")을, 앞서 하던 일에 이어지면 workId 에 그 업무 id 를 넣으세요.', true);
          work = works.store.resolve({ workId, workName, missionId, fallbackId: works.turn.workId, title: taskTitle(withTitle(task, title)) });
          const made = works.store.get(work.id);
          const fresh = !!made && !made.taskIds.length && !made.msgIds.length; // 방금 생긴 업무
          if (!works.turn.assigned.includes(work.id)) works.turn.assigned.push(work.id);
          works.store.linkMsgs(work.id, works.turn.userIds); // 이 일을 시킨 내 말도 그 업무 방에 보이게
          // 새 업무면 맡기기 직전에 나눈 배경 설명도 그 방에 보이게 한다
          if (fresh && works.lead) {
            try {
              works.store.linkMsgs(work.id, await works.lead(works.turn.userIds));
            } catch {
              // 못 찾아도 맡기는 일은 그대로
            }
          }
        }
        const said = await dispatcher.assign(missionId, withTitle(body, title), todoId, planFirst, preSync, work?.id);
        return text(work ? `${said}\n(업무 「${work.name}」 · workId ${work.id} 에 달았어요. 이 일에 이어지는 과제는 같은 workId 로 맡기세요.)` : said);
      } catch (e) {
        return text(`배정하지 못했어요: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  const status = tool(
    'get_mission_status',
    [
      '미션 현황판 내용을 읽습니다: 진행 중(또는 가장 최근) 과제, 팀원별 상태(대기·작업 중·검수 중·완료), 승인 대기 건수, 최근 활동.',
      '사용자가 진행 상황을 물으면 이 도구로 확인한 뒤 답하세요. missionId 를 비우면 모든 미션을 돌려줍니다.',
      '등록된 미션 id:',
      list,
    ].join('\n'),
    { missionId: z.string().optional().describe('미션 id (예: homepage). 비우면 전체') },
    async ({ missionId }) => {
      const all = dispatcher.statuses();
      const picked = missionId ? all.filter((s) => s.missionId === missionId) : all;
      if (!picked.length) {
        return text(missionId ? `"${missionId}" 미션을 찾지 못했어요. 등록된 미션:\n${list}` : '등록된 미션이 없어요.', !!missionId);
      }
      return text(picked.map(describeStatus).join('\n\n'));
    },
    { annotations: { readOnlyHint: true } },
  );

  const terminal = tool(
    'get_terminal_sessions',
    [
      '사용자가 앱 밖 터미널(Claude Code)에서 미션 작업 폴더로 따로 진행한 최근 세션을 읽습니다: 세션 제목, 마지막 시각, 사용자가 친 말 가운데 마지막 몇 줄.',
      '도구 결과나 코드는 읽지 않습니다. 맡기려는 일이 터미널에서 이미 진행 중인지 확인하거나, 사용자가 터미널에서 하던 일을 물을 때 쓰세요. missionId 를 비우면 모든 미션.',
    ].join('\n'),
    { missionId: z.string().optional().describe('미션 id. 비우면 전체') },
    async ({ missionId }) => text(terminalText ? terminalText(missionId) : '(터미널 세션을 읽을 수 없어요)'),
    { annotations: { readOnlyHint: true } },
  );

  const tell = tool(
    'tell_running_task',
    [
      '지금 진행 중인 과제의 리더에게 사용자의 말을 덧붙여 전합니다(새 과제를 만들지 않음). 리더는 지금 하는 단계를 마치는 대로 읽고 반영합니다.',
      '사용자가 진행 중인 과제의 방향을 바꾸거나 조건·정보를 덧붙일 때 씁니다(예: "dev 말고 운영 기준으로 봐", "그 파일은 건드리지 마"). 사용자가 한 말을 그대로, 필요한 만큼만 풀어서 적습니다.',
      '진행 중인 과제가 없으면 실패를 돌려주니 그때는 assign_to_mission 으로 새로 맡기세요. 완전히 다른 새 일은 이 도구가 아니라 assign_to_mission 입니다.',
      '등록된 미션 id:',
      list,
    ].join('\n'),
    {
      missionId: z.string().describe('미션 id'),
      text: z.string().describe('리더에게 전할 말: 사용자가 덧붙인 내용 그대로(쉬운 한국어)'),
      taskId: z.string().optional().describe('같은 미션에 진행 중인 과제가 둘 이상일 때 전할 과제 id. 비우면 진행 중인 과제 모두'),
    },
    async ({ missionId, text: body, taskId }) => {
      if (!dispatcher.note) return text('이 앱에서는 진행 중인 과제에 말을 전할 수 없어요.', true);
      const r = dispatcher.note(missionId, body, taskId);
      return text(r.message, !r.ok);
    },
  );

  const cards = tool(
    'get_pending_cards',
    [
      '사용자의 답을 기다리는 승인·결정 카드의 내용을 읽습니다: 제목, 무엇을·왜, 리더 권장, 결정 카드면 항목마다 안(A·B·C)의 설명과 권장안.',
      '사용자가 카드에 대해 물으면("A안과 C안이 뭐가 달라?", "이 카드 승인해도 돼?") 리더에게 다시 묻지 말고 이 도구로 읽어 바로 답하세요. 카드를 대신 승인하거나 고르지는 못합니다.',
    ].join('\n'),
    { missionId: z.string().optional().describe('미션 id. 비우면 전체') },
    async ({ missionId }) => text(peek ? peek.cards(missionId) : '(카드를 읽을 수 없어요)'),
    { annotations: { readOnlyHint: true } },
  );

  const taskFile = tool(
    'read_task_file',
    [
      '리더가 과제 결과 폴더에 만들어 둔 글 파일(메일 초안, 기획서, 문의 글 등)을 읽습니다. name 을 비우면 파일 목록을 돌려줍니다.',
      '사용자가 "메일 내용 보여 줘", "기획서에 뭐라고 썼어?"처럼 이미 만들어진 글을 보고 싶어 하면 새 과제를 맡기지 말고 이 도구로 읽어 그대로(요약하지 말고) 보여 주세요.',
      'taskId 는 리더 보고 알림에 적힌 과제 id 입니다(앞 8자만 줘도 됨).',
    ].join('\n'),
    { taskId: z.string().describe('과제 id (앞 8자 이상)'), name: z.string().optional().describe('읽을 파일 이름. 비우면 목록') },
    async ({ taskId, name }) => {
      if (!peek) return text('(과제 파일을 읽을 수 없어요)', true);
      const r = peek.file(taskId, name);
      return text(r.text, !r.ok);
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({ name: MISSION_MCP_NAME, version: '0.1.0', tools: [assign, status, terminal, tell, cards, taskFile] });
}
