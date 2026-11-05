// 리포 리더 전용 도구(MCP): request_approval — 팀 구성안·수치 변경·결정 번복·추정값·외부 게시 등을 승인함에 올린다.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { existsSync, realpathSync } from 'node:fs';
import { LEADER_MCP_NAME, type ApprovalQueueApi, type DecisionItem, type MissionConfig, type MissionTrackerApi } from '../../shared/types.js';
import type { LeaderGuard } from './leaderPermissions.js';

export const LEADER_APPROVAL_KINDS = ['teamPlan', 'decision', 'numbers', 'reverseDecision', 'estimate', 'external', 'other'] as const;

export interface LeaderToolsDeps {
  mission: MissionConfig;
  approvals?: ApprovalQueueApi;
  tracker?: MissionTrackerApi;
  guard: LeaderGuard;
  signal?: AbortSignal; // 앱이 꺼지거나 과제가 중단되면 대기를 정리
  emitActivity?: (text: string) => void;
}

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** team.md 의 "## 현재 편성" 을 승인된 구성으로 바꾸고 "## 이력" 에 한 줄 더한다. (앱이 쓰는 미션 홈 파일) */
export async function updateTeamFile(home: string, plan: { title: string; what: string; taskTitle?: string }): Promise<void> {
  const file = path.join(home, 'team.md');
  let src = '';
  try {
    src = await fs.readFile(file, 'utf-8');
  } catch {
    src = '# 팀 편성\n';
  }
  const stamp = today();
  const current = `## 현재 편성\n- 승인: ${stamp}${plan.taskTitle ? ` · 과제: ${plan.taskTitle}` : ''}\n- 구성안: ${plan.title}\n${plan.what
    .trim()
    .split('\n')
    .map((l) => (l.trim().startsWith('-') ? l.trim() : `- ${l.trim()}`))
    .filter((l) => l !== '- ')
    .join('\n')}\n`;
  const historyLine = `- ${stamp} 팀 구성안 승인: ${plan.title}${plan.taskTitle ? ` (과제: ${plan.taskTitle})` : ''}`;

  const sections = src.split(/^(?=## )/m);
  let hasCurrent = false;
  let hasHistory = false;
  const next = sections.map((sec) => {
    if (/^## 현재 편성\s*$/m.test(sec.split('\n')[0])) {
      hasCurrent = true;
      return current + '\n';
    }
    if (/^## 이력\s*$/m.test(sec.split('\n')[0])) {
      hasHistory = true;
      return `${sec.trimEnd()}\n${historyLine}\n\n`;
    }
    return sec;
  });
  let out = next.join('');
  if (!hasCurrent) out = `${out.trimEnd()}\n\n${current}`;
  if (!hasHistory) out = `${out.trimEnd()}\n\n## 이력\n${historyLine}\n`;
  out = out.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, out, 'utf-8');
  await fs.rename(tmp, file);
}

export function createLeaderMcpServer(deps: LeaderToolsDeps) {
  const { mission, guard } = deps;
  const requestApproval = tool(
    'request_approval',
    [
      '사용자 승인이 필요한 결정을 앱의 승인함에 올리고, 사용자가 결정할 때까지 기다립니다.',
      '언제 쓰나:',
      '- teamPlan: 과제를 받으면 팀원을 부르기 전에 반드시 먼저. what 에 역할별로 맡길 일, why 에 이유, recommendation 에 권장 구성.',
      '- numbers: 수치 레지스트리의 상태를 바꿀 때 / reverseDecision: 기존 결정(ADR 등)을 뒤집을 때',
      '- estimate: 확인되지 않은 추정값을 쓸 때 / external: 다른 사람 공간(Confluence 등)에 게시·수정하거나 메일·제출할 때',
      '- decision: 사용자가 골라야 할 일. items 에 항목마다 안 2~3개(key A/B/C, label 한 줄, detail 장단점)와 recommended(권장안 key)를 넣으면 사용자가 카드에서 안을 고른다.',
      '  화면·기능처럼 "기획 후 구현"인 과제는 먼저 planGate: true 로 올린다. 고르기 전에는 작업 폴더를 고칠 수 없다(앱이 막음).',
      '  안마다 시안(HTML 와이어프레임 등)을 시안 폴더에 만들고 options[].preview 에 그 파일 이름(또는 절대 경로)을 넣으면 사용자가 [시안 열기]로 본다.',
      '- other: 그 밖에 사용자 판단이 필요한 일',
      '파일 쓰기·명령 실행은 도구를 쓰면 앱이 자동으로 승인함에 올리므로 이 도구로 따로 올리지 않습니다.',
      '결과로 승인·반려·수정 요청과 사유가 돌아옵니다. 반려되면 우회하지 말고 보고에 적습니다.',
      '모든 글은 비개발자도 읽을 수 있는 쉬운 한국어로 씁니다.',
    ].join('\n'),
    {
      kind: z.enum(LEADER_APPROVAL_KINDS).describe('승인 종류'),
      title: z.string().describe('한 줄 제목 (예: "리뉴얼 설계 팀 구성안")'),
      what: z.string().describe('무엇을 하려는지. teamPlan 이면 역할별로 맡길 일을 한 줄씩'),
      why: z.string().describe('왜 하려는지'),
      recommendation: z.string().describe('권장안 한 줄'),
      detail: z.string().optional().describe('자세한 내용(근거 문서 위치 등). 비밀 값은 넣지 않습니다'),
      items: z
        .array(
          z.object({
            question: z.string().describe('무엇을 정할지'),
            options: z
              .array(
                z.object({
                  key: z.string().describe('A, B, C …'),
                  label: z.string().describe('안 한 줄 설명'),
                  detail: z.string().optional().describe('장단점'),
                  preview: z.string().optional().describe('시안 파일 이름(시안 폴더 안) 또는 절대 경로'),
                }),
              )
              .min(2)
              .max(5),
            recommended: z.string().describe('권장안 key'),
          }),
        )
        .optional()
        .describe('decision 일 때 항목별 안'),
      planGate: z.boolean().optional().describe('기획 단계 결정이면 true (승인되면 구현을 시작할 수 있음)'),
    },
    async (args, extra) => {
      const task = guard.currentTask();
      if (!deps.approvals) return text('지금은 승인함이 연결되지 않았어요. 보고에 "승인이 필요한 일"로 적어 주세요.', true);
      if (!task) return text('진행 중인 과제가 없어 승인을 올릴 수 없어요.', true);
      const extraSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      const signal = extraSignal && deps.signal ? AbortSignal.any([extraSignal, deps.signal]) : extraSignal ?? deps.signal;
      try {
        deps.tracker?.activity(guard.leaderLabel, `승인을 기다리는 중: ${args.title}`);
      } catch {
        // 무시
      }
      deps.emitActivity?.(`${guard.leaderLabel}: 승인을 기다리는 중: ${args.title}`);
      // 결정 항목 정리: 시안 파일은 이 과제의 시안 폴더 안에 실제로 있는 것만 붙인다
      let decisionItems: DecisionItem[] | undefined;
      const previewProblems: string[] = [];
      if (args.kind === 'decision' && args.items?.length) {
        const dir = guard.draftsDir(task.id);
        const realDir = dir && existsSync(dir) ? realpathSync(dir) : dir;
        decisionItems = args.items.map((it, i) => {
          const options = it.options.map((o) => {
            let preview: string | undefined;
            if (o.preview && dir && realDir) {
              const abs = path.isAbsolute(o.preview) ? o.preview : path.join(dir, o.preview);
              const real = existsSync(abs) ? realpathSync(abs) : '';
              if (real && (real === realDir || real.startsWith(realDir + path.sep))) preview = real;
              else previewProblems.push(`${o.key}안 시안 "${o.preview}" 을(를) 시안 폴더에서 찾지 못했어요`);
            }
            return { key: o.key.trim(), label: o.label.trim(), ...(o.detail ? { detail: o.detail.trim() } : {}), ...(preview ? { preview } : {}) };
          });
          const rec = options.some((o) => o.key === it.recommended) ? it.recommended : options[0].key;
          return { id: String(i + 1), question: it.question.trim(), options, recommended: rec };
        });
      }
      let d;
      try {
        d = await deps.approvals.request(
          {
            missionId: mission.id,
            taskId: task.id,
            who: guard.leaderLabel,
            kind: args.kind,
            title: args.title,
            what: args.what,
            why: args.why,
            recommendation: args.recommendation,
            detail: args.detail,
            ...(decisionItems ? { decisionItems } : {}),
            ...(args.kind === 'decision' && args.planGate ? { planGate: true } : {}),
          },
          signal,
        );
      } catch {
        return text('승인을 기다리던 중에 작업이 멈췄어요. 이 일은 하지 않았어요.', true);
      }
      const note = d.note?.trim();
      const said = d.decision === 'approve' ? '승인됨' : d.decision === 'revise' ? '수정 요청' : '반려됨';
      try {
        deps.tracker?.activity(guard.leaderLabel, `${said}: ${args.title}`);
      } catch {
        // 무시
      }
      if (d.decision === 'approve' && args.kind === 'decision') {
        if (args.planGate) guard.markPlanDecided(task.id);
        const lines = (decisionItems ?? []).map((it) => {
          const key = d.choices?.[it.id] ?? it.recommended;
          const opt = it.options.find((o) => o.key === key);
          return `- ${it.id}. ${it.question} → ${key}안 (${opt?.label ?? ''})${key === it.recommended ? '' : ' — 권장안과 다른 선택'}`;
        });
        return text(
          [
            `사용자가 결정했어요${note ? ` (메모: ${note})` : ''}.`,
            ...(lines.length ? lines : ['권장안대로 진행하세요.']),
            args.planGate ? '기획 단계가 끝났어요. 고른 안대로 구현을 시작하세요(작업 폴더 쓰기는 평소처럼 승인함을 거쳐요).' : '고른 안대로 반영하세요.',
            ...(previewProblems.length ? [`참고: ${previewProblems.join(' / ')}`] : []),
          ].join('\n'),
        );
      }
      if (d.decision === 'approve') {
        if (args.kind === 'teamPlan') {
          guard.markTeamApproved(task.id);
          let teamNote = '';
          try {
            await updateTeamFile(mission.home, { title: args.title, what: args.what, taskTitle: task.title });
          } catch {
            teamNote = ' (팀 편성 문서는 갱신하지 못했어요)';
          }
          return text(`사용자가 팀 구성안을 승인했어요${note ? `: ${note}` : ''}. 이제 승인된 역할을 불러 일을 맡기세요.${teamNote}`);
        }
        return text(`사용자가 승인했어요${note ? `: ${note}` : ''}. 승인된 범위 안에서 진행하세요.`);
      }
      if (d.decision === 'revise') {
        return text(`사용자가 수정을 요청했어요: ${note || '사유 없음'}. 반영해서 다시 올리세요.`);
      }
      return text(`사용자가 반려했어요: ${note || '사유 없음'}. 다른 방법을 찾거나 보고에 적으세요.`);
    },
  );

  return createSdkMcpServer({ name: LEADER_MCP_NAME, version: '0.1.0', tools: [requestApproval] });
}
