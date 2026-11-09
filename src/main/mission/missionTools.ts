// 라노가 쓰는 미션 도구(MCP): assign_to_mission, get_mission_status
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MISSION_MCP_NAME, type MemberState, type MissionDispatcherApi, type MissionStatus, type RanoConfig } from '../../shared/types.js';
import { zoneText } from '../admin/paths.js';
import { shareWithMission } from '../engine/attachments.js';
import { userAskedSync } from './syncIntent.js';

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

export function createMissionMcpServer(dispatcher: MissionDispatcherApi, config: RanoConfig, userText?: () => Promise<string>) {
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
      task: z.string().describe('리포 리더에게 넘길 지시: 목적·범위·결과물 형태 포함'),
      todoId: z.string().optional().describe('이 과제와 연결할 할 일 id (할 일 목록에 있는 일이면 넘김)'),
      planFirst: z.boolean().optional().describe('화면·기능 개편처럼 "기획 후 구현"인 과제면 true: 리더가 안 2~3개와 권장안을 먼저 올려 사용자가 고른 뒤에 구현한다'),
      attachments: z.array(z.string()).optional().describe('사용자가 대화에 붙인 그림 id (앱 안내에 나온 id). 리더와 팀원이 그 그림을 열어 볼 수 있게 함께 넘긴다'),
    },
    async ({ missionId, task, todoId, planFirst, attachments }) => {
      try {
        let body = task;
        if (attachments?.length) {
          if (!config.missions.some((m) => m.id === missionId)) return text(`"${missionId}" 미션을 찾지 못했어요.`, true);
          const shared = shareWithMission(config.runsDir, missionId, attachments);
          if (shared.missing.length && !shared.paths.length) return text(`그림 id 를 찾지 못했어요: ${shared.missing.join(', ')}`, true);
          if (shared.paths.length)
            body += `\n\n[첨부 그림] 사용자가 붙인 그림이에요. Read 도구로 열어 보세요(팀원에게도 이 경로를 넘기세요). 그림 위의 빨강·파랑·노랑 펜·네모·화살표·번호는 사용자가 고치고 싶은 곳을 직접 표시한 거예요:\n${shared.paths.map((p) => `- ${p}`).join('\n')}`;
        }
        // 사용자가 직접 받아오기(pull)를 시켰으면 그 과제의 받아오기는 승인 없이(라노가 쓴 지시가 아니라 사용자가 쓴 말로 판단)
        let preSync = false;
        try {
          preSync = userText ? userAskedSync(await userText()) : false;
        } catch {
          preSync = false;
        }
        return text(await dispatcher.assign(missionId, body, todoId, planFirst, preSync));
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

  return createSdkMcpServer({ name: MISSION_MCP_NAME, version: '0.1.0', tools: [assign, status] });
}
