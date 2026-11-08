// 리포 리더 전용 도구(MCP): request_approval — 팀 구성안·수치 변경·결정 번복·추정값·외부 게시 등을 승인함에 올린다.
// propose_changes — 여러 파일 고치기를 한 장의 승인 카드로 올리고, 사용자가 고른 파일만 앱이 반영한다.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { LEADER_MCP_NAME, type ApprovalQueueApi, type BundleFile, type DecisionItem, type MissionConfig, type MissionTrackerApi } from '../../shared/types.js';
import { fileChangeFor, type LeaderGuard } from './leaderPermissions.js';
import { checkPreviewFile, PREVIEW_EXTS } from '../approvals/previewSafety.js';

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
      '  understanding 에 과제 이해(목적·결과를 쓰는 사람·완료 기준), memberModels 에 역할마다 추천 모델(opus/sonnet)과 이유, 검수가 필요 없으면 skipReview 에 이유를 넣는다. 사용자가 카드에서 모델·검수를 바꿔 승인할 수 있다.',
      '  읽고 조사·정리만 하는 과제면 readOnly: true 를 붙인다(묻지 않고 바로 시작, 추천 모델·검수대로, 이 과제 동안 바꾸는 일은 앱이 막음).',
      '- 지우기 확인: kind other 로 올리고 deletePaths 에 지울 위치를 넣으면, 승인 뒤 그 위치만 지우는 명령은 다시 묻지 않는다.',
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
      readOnly: z
        .boolean()
        .optional()
        .describe('teamPlan 일 때만: 이번 과제가 읽고 조사·정리만 하면 true. 사용자에게 묻지 않고 바로 시작하고, 이 과제 동안 작업 폴더 쓰기·삭제·커밋·외부 쓰기는 앱이 막는다'),
      understanding: z
        .string()
        .optional()
        .describe('teamPlan 일 때: 과제 이해 1~3줄 — 사용자가 왜 이 일을 시키는지(목적), 결과를 누가 어디에 쓰는지, 무엇이면 끝인지(완료 기준). 팀 구성과 모델은 이 판단에 맞춘다'),
      memberModels: z
        .array(
          z.object({
            role: z.string().describe('팀 편성에 있는 역할 이름'),
            model: z.enum(['opus', 'sonnet']).describe('추천 모델'),
            reason: z.string().describe('이 일에 이 모델을 추천하는 이유 한 줄'),
          }),
        )
        .optional()
        .describe('teamPlan 일 때: 부를 역할마다 추천 모델. 판단·설계·코드 변경·검수처럼 틀리면 안 되는 일은 opus, 자료 읽기·정리·문서 초안·단순 반복은 sonnet'),
      skipReview: z
        .string()
        .optional()
        .describe('teamPlan 일 때: 검수 없이 진행하자고 추천하면 그 이유 한 줄(예: 이미 검수받은 결과의 단순 후속 수정). 비우면 검수를 받는 것으로 추천한다'),
      deletePaths: z
        .array(z.string())
        .max(20)
        .optional()
        .describe('지우기를 확인받을 때: 지울 파일·폴더(작업 폴더 기준 경로 또는 절대 경로). 승인되면 이 과제 동안 이 위치만 지우는 명령은 다시 묻지 않는다'),
    },
    async (args, extra) => {
      const task = guard.currentTask();
      if (!deps.approvals) return text('지금은 승인함이 연결되지 않았어요. 보고에 "승인이 필요한 일"로 적어 주세요.', true);
      if (!task) return text('진행 중인 과제가 없어 승인을 올릴 수 없어요.', true);
      // 팀 구성안의 과제 이해와 역할별 추천 모델
      const understanding = args.kind === 'teamPlan' ? (args.understanding ?? '').trim() : '';
      const recModels = new Map<string, { model: 'opus' | 'sonnet'; reason: string }>();
      if (args.kind === 'teamPlan') {
        for (const m of args.memberModels ?? []) {
          if (!mission.roles.includes(m.role)) return text(`"${m.role}" 은(는) 이 미션 팀에 없는 역할이에요. 팀 편성에 있는 역할(${mission.roles.join(', ')})만 넣어 주세요.`, true);
          recModels.set(m.role, { model: m.model, reason: m.reason.trim() });
        }
      }
      const recSkip = args.kind === 'teamPlan' ? (args.skipReview ?? '').trim() : '';
      const planWhat = understanding ? `과제 이해: ${understanding}\n\n${args.what}` : args.what;
      const modelLine = (r: string, m: 'opus' | 'sonnet') => `- ${r}: ${m === 'opus' ? 'Opus' : 'Sonnet'}${recModels.get(r)?.reason ? ` — ${recModels.get(r)!.reason}` : ''}`;
      // 읽고 정리만 하는 과제의 팀 구성: 묻지 않고 바로 시작한다(바꾸는 일은 이 과제 동안 앱이 막음). 모델은 리더 추천대로
      if (args.kind === 'teamPlan' && args.readOnly) {
        guard.markTeamApproved(task.id);
        guard.markReadOnly(task.id, true);
        if (recModels.size) guard.setMemberModels(task.id, Object.fromEntries([...recModels].map(([r, v]) => [r, v.model])));
        guard.setReviewSkipped(task.id, !!recSkip);
        let teamNote = '';
        try {
          await updateTeamFile(mission.home, {
            title: `${args.title} (읽기만, 자동 승인)`,
            what: [planWhat, ...[...recModels].map(([r, v]) => modelLine(r, v.model)), ...(recSkip ? [`- 검수 생략: ${recSkip}`] : [])].join('\n'),
            taskTitle: task.title,
          });
        } catch {
          teamNote = ' (팀 편성 문서는 갱신하지 못했어요)';
        }
        try {
          deps.tracker?.activity(guard.leaderLabel, `팀 구성(읽기만) 바로 시작: ${args.title}`);
        } catch {
          // 무시
        }
        deps.emitActivity?.(
          `${guard.leaderLabel}: 읽고 정리만 하는 과제라 팀 구성은 묻지 않고 바로 시작해요 (${args.title}${recModels.size ? ` · ${[...recModels].map(([r, v]) => `${r} ${v.model === 'opus' ? 'Opus' : 'Sonnet'}`).join(', ')}` : ''})`,
        );
        return text(
          `읽고 정리만 하는 과제라 팀 구성안을 사용자에게 묻지 않고 바로 시작해요.${teamNote} 승인된 역할을 불러 일을 맡기세요. 이 과제 동안 작업 폴더 쓰기·삭제·커밋·외부 쓰기는 막혀요. 바꾸는 일이 필요해지면 팀 구성안을 readOnly 없이 다시 올리세요.`,
        );
      }
      // 지우기 확인: 지울 위치를 미리 검사해 카드에 보여 주고, 승인되면 그 위치를 지우는 명령은 다시 묻지 않는다
      const deleteAbs: string[] = [];
      if (args.deletePaths?.length) {
        const root = mission.targets[0] ?? mission.home;
        const problems: string[] = [];
        for (const raw of args.deletePaths) {
          const abs = path.resolve(root, raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
          const bad = guard.deleteTargetProblem(abs);
          if (bad) problems.push(`${raw}: ${bad}`);
          else deleteAbs.push(abs);
        }
        if (problems.length) return text(`지울 위치에 문제가 있어 올리지 않았어요:\n- ${problems.join('\n- ')}`, true);
      }
      const home = process.env.HOME ?? '';
      const deleteNote = deleteAbs.length
        ? `${args.detail ? '\n\n' : ''}승인하면 이번 과제 동안 아래 위치를 지우는 명령은 다시 묻지 않아요:\n${deleteAbs.map((p) => `- ${home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p}`).join('\n')}`
        : '';
      const extraSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      const signal = extraSignal && deps.signal ? AbortSignal.any([extraSignal, deps.signal]) : extraSignal ?? deps.signal;
      try {
        deps.tracker?.activity(guard.leaderLabel, `승인을 기다리는 중: ${args.title}`);
      } catch {
        // 무시
      }
      deps.emitActivity?.(`${guard.leaderLabel}: 승인을 기다리는 중: ${args.title}`);
      // 결정 항목 정리: 시안 파일은 이 과제의 시안 폴더 안에 실제로 있고, [시안 열기]로 열 수 있는 것(허용 형식의 보통 파일, 실행 권한 없음)만 붙인다.
      // 사용자가 누를 때 앱이 같은 확인(previewSafety.ts)을 다시 한다
      let decisionItems: DecisionItem[] | undefined;
      const previewProblems: string[] = [];
      if (args.kind === 'decision' && args.items?.length) {
        const dir = guard.draftsDir(task.id);
        decisionItems = args.items.map((it, i) => {
          const options = it.options.map((o) => {
            let preview: string | undefined;
            if (o.preview && dir) {
              const abs = path.isAbsolute(o.preview) ? o.preview : path.join(dir, o.preview);
              const c = checkPreviewFile(abs, dir);
              if (c.ok) preview = c.path;
              else previewProblems.push(`${o.key}안 시안 "${o.preview}" 을(를) 붙이지 못했어요: ${c.message} (허용 형식: ${[...PREVIEW_EXTS].join(' ')})`);
            }
            return { key: o.key.trim(), label: o.label.trim(), ...(o.detail ? { detail: o.detail.trim() } : {}), ...(preview ? { preview } : {}) };
          });
          const rec = options.some((o) => o.key === it.recommended) ? it.recommended : options[0].key;
          return { id: String(i + 1), question: it.question.trim(), options, recommended: rec };
        });
      }
      if (args.kind === 'teamPlan') {
        decisionItems = [...recModels].map(([role, v], i) => ({
          id: String(i + 1),
          question: `${role}${v.reason ? ` — ${v.reason}` : ''}`,
          options: [
            { key: 'opus', label: 'Opus · 꼼꼼하고 깊게 (느리고 사용량 많음)' },
            { key: 'sonnet', label: 'Sonnet · 빠르고 가볍게 (자료 정리·초안·단순 작업에 충분)' },
          ],
          recommended: v.model,
        }));
        // 검수 방식: 리더 추천(skipReview)이 골라져 있고 사용자가 바꿀 수 있다
        decisionItems.push({
          id: 'review',
          question: `검수${recSkip ? ` — 리더 추천: 생략 (${recSkip})` : ''}`,
          options: [
            { key: 'review', label: '검수 받기 · 최종본을 검수 담당이 확인한 뒤 보고' },
            { key: 'skip', label: '검수 생략 · 리더가 직접 확인하고 보고 (단순·반복 수정)' },
          ],
          recommended: recSkip ? 'skip' : 'review',
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
            what: planWhat,
            why: args.why,
            recommendation: args.recommendation,
            detail: (args.detail ?? '') + deleteNote || undefined,
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
      if (d.decision === 'approve' && deleteAbs.length) guard.grantDeletes(task.id, deleteAbs);
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
          guard.markReadOnly(task.id, false); // 바꾸는 일까지 하는 구성으로 다시 승인받음
          // 사용자가 고른 모델(바꾸지 않았으면 리더 추천)을 이 과제 동안 적용한다
          const picked: Record<string, 'opus' | 'sonnet'> = {};
          for (const it of decisionItems ?? []) {
            const role = [...recModels.keys()][Number(it.id) - 1];
            const key = d.choices?.[it.id] ?? it.recommended;
            if (role && (key === 'opus' || key === 'sonnet')) picked[role] = key;
          }
          if (Object.keys(picked).length) guard.setMemberModels(task.id, picked);
          const reviewItem = decisionItems?.find((it) => it.id === 'review');
          const skip = (d.choices?.review ?? reviewItem?.recommended) === 'skip';
          guard.setReviewSkipped(task.id, skip);
          const reviewNote = reviewItem
            ? skip
              ? '\n검수: 생략하기로 했어요. 검수 역할을 부르지 말고, 결과를 직접 확인한 뒤 보고에 "검수 생략(승인됨)"이라고 적으세요.'
              : `\n검수: 받기로 했어요. 최종본은 검수 역할의 확인을 받은 뒤 보고하세요.${recSkip ? ' (리더는 생략을 추천했지만 사용자가 검수를 골랐어요)' : ''}`
            : '';
          const changed = Object.entries(picked).filter(([r, m]) => recModels.get(r)?.model !== m);
          const modelNote = Object.keys(picked).length
            ? `\n팀원 모델: ${Object.entries(picked).map(([r, m]) => `${r} ${m === 'opus' ? 'Opus' : 'Sonnet'}`).join(', ')}${changed.length ? ` (사용자가 바꿈: ${changed.map(([r]) => r).join(', ')})` : ''}. 앱이 팀원을 부를 때 이 모델을 넣어요.`
            : '';
          let teamNote = '';
          try {
            await updateTeamFile(mission.home, {
              title: args.title,
              what: [planWhat, ...Object.entries(picked).map(([r, m]) => modelLine(r, m)), ...(skip ? ['- 검수 생략'] : [])].join('\n'),
              taskTitle: task.title,
            });
          } catch {
            teamNote = ' (팀 편성 문서는 갱신하지 못했어요)';
          }
          return text(`사용자가 팀 구성안을 승인했어요${note ? `: ${note}` : ''}. 이제 승인된 역할을 불러 일을 맡기세요.${teamNote}${modelNote}${reviewNote}`);
        }
        return text(`사용자가 승인했어요${note ? `: ${note}` : ''}. 승인된 범위 안에서 진행하세요.`);
      }
      if (d.decision === 'revise') {
        return text(`사용자가 수정을 요청했어요: ${note || '사유 없음'}. 반영해서 다시 올리세요.`);
      }
      return text(`사용자가 반려했어요: ${note || '사유 없음'}. 다른 방법을 찾거나 보고에 적으세요.`);
    },
  );

  // 묶음 승인: 고친 파일들을 시안 폴더에 만든 뒤 한 장의 승인 카드로 올리고, 사용자가 고른 파일만 앱이 반영한다
  const proposeChanges = tool(
    'propose_changes',
    [
      '작업 폴더의 파일 여러 개(2개 이상)를 고칠 때 한 번에 승인받는 도구입니다. 파일 하나만 고치면 평소처럼 Edit·Write 를 쓰세요.',
      '방법: ① 고친 뒤의 "전체 내용"을 이 과제의 시안 폴더에 파일로 만듭니다(시안 폴더 쓰기는 승인이 필요 없어요. 팀원에게도 시안 폴더에 쓰라고 지시할 수 있어요).',
      '② files 에 [작업 폴더 기준 경로(target), 시안 폴더의 새 내용 파일(draft)] 짝을 넣어 이 도구를 부릅니다.',
      '사용자는 카드에서 파일마다 바뀐 부분을 보고 골라서 승인합니다. 고른 파일만 앱이 작업 폴더에 반영하고, 결과로 반영한 파일과 빠진 파일을 알려 줍니다. 빠진 파일은 다시 시도하지 말고 보고에 적으세요.',
      '커밋은 하지 않습니다(필요하면 따로 승인). 비밀 값은 넣지 않습니다.',
    ].join('\n'),
    {
      title: z.string().describe('한 줄 제목 (예: "리뉴얼 문서 4개 고치기")'),
      why: z.string().describe('왜 고치는지'),
      recommendation: z.string().describe('권장안 한 줄 (예: "모두 반영")'),
      files: z
        .array(
          z.object({
            target: z.string().describe('반영할 파일: 작업 폴더 기준 경로 (예: docs/menu.md) 또는 절대 경로'),
            draft: z.string().describe('고친 뒤 전체 내용이 든 파일: 시안 폴더 안 파일 이름(또는 절대 경로)'),
          }),
        )
        .min(1)
        .max(30),
    },
    async (args, extra) => {
      const task = guard.currentTask();
      if (!deps.approvals) return text('지금은 승인함이 연결되지 않았어요. 보고에 "승인이 필요한 일"로 적어 주세요.', true);
      if (!task) return text('진행 중인 과제가 없어 승인을 올릴 수 없어요.', true);
      if (guard.planBlocked()) return text('"기획 먼저" 과제라 안을 고르기 전에는 작업 폴더를 고칠 수 없어요.', true);
      const root = mission.targets[0];
      const dir = guard.draftsDir(task.id);
      if (!root || !dir) return text('작업 폴더나 시안 폴더를 찾지 못했어요.', true);
      const realDir = existsSync(dir) ? realpathSync(dir) : dir;
      const problems: string[] = [];
      const files: BundleFile[] = [];
      for (const f of args.files) {
        const abs = path.resolve(root, f.target.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
        const draftRaw = path.isAbsolute(f.draft) ? f.draft : path.join(dir, f.draft);
        let draft = '';
        try {
          draft = realpathSync(draftRaw);
        } catch {
          problems.push(`${f.target}: 시안 파일(${f.draft})이 없어요`);
          continue;
        }
        if (!(draft === realDir || draft.startsWith(realDir + path.sep))) {
          problems.push(`${f.target}: 새 내용 파일은 이 과제의 시안 폴더 안에 있어야 해요`);
          continue;
        }
        const bad = guard.bundleTargetProblem(abs);
        if (bad) {
          problems.push(`${f.target}: ${bad}`);
          continue;
        }
        if (files.some((x) => x.abs === abs)) continue;
        let content: string;
        try {
          content = readFileSync(draft, 'utf-8');
        } catch {
          problems.push(`${f.target}: 시안 파일을 읽지 못했어요`);
          continue;
        }
        const change = fileChangeFor('Write', { content }, abs);
        files.push({ rel: path.relative(root, abs) || path.basename(abs), abs, draft, ...(change ? { change } : {}) });
      }
      if (!files.length) return text(`올릴 파일이 없어요:\n- ${problems.join('\n- ')}`, true);
      const extraSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      const signal = extraSignal && deps.signal ? AbortSignal.any([extraSignal, deps.signal]) : extraSignal ?? deps.signal;
      deps.emitActivity?.(`${guard.leaderLabel}: 승인을 기다리는 중: ${args.title} (파일 ${files.length}개)`);
      try {
        deps.tracker?.activity(guard.leaderLabel, `승인을 기다리는 중: ${args.title}`);
      } catch {
        // 무시
      }
      let d;
      try {
        d = await deps.approvals.request(
          {
            missionId: mission.id,
            taskId: task.id,
            who: guard.leaderLabel,
            kind: 'bundle',
            title: args.title,
            what: `${mission.name} 리포 파일 ${files.length}개를 한 번에 ${files.some((f) => f.change?.isNew) ? '만들거나 ' : ''}고쳐요: ${files.map((f) => f.rel).join(', ')}`,
            why: args.why,
            recommendation: args.recommendation,
            detail: files.map((f) => `- ${f.rel}${f.change?.isNew ? ' (새 파일)' : ''}`).join('\n') + (problems.length ? `\n\n올리지 못한 파일:\n- ${problems.join('\n- ')}` : ''),
            bundle: files,
          },
          signal,
        );
      } catch {
        return text('승인을 기다리던 중에 작업이 멈췄어요. 아무 파일도 바꾸지 않았어요.', true);
      }
      const note = d.note?.trim();
      if (d.decision !== 'approve') {
        const said = d.decision === 'revise' ? '수정 요청' : '반려됨';
        try {
          deps.tracker?.activity(guard.leaderLabel, `${said}: ${args.title}`);
        } catch {
          // 무시
        }
        return text(d.decision === 'revise' ? `사용자가 수정을 요청했어요: ${note || '사유 없음'}. 시안을 고쳐 다시 올리세요.` : `사용자가 반려했어요: ${note || '사유 없음'}. 아무 파일도 바꾸지 않았어요.`);
      }
      // 고른 파일만 반영 (그 사이에 시안이 바뀌었으면 승인한 내용과 달라지므로 다시 읽어 비교)
      const picked = new Set(d.picked ?? files.map((f) => f.rel));
      const done: string[] = [];
      const failed: string[] = [];
      for (const f of files) {
        if (!picked.has(f.rel)) continue;
        try {
          const content = readFileSync(f.draft, 'utf-8');
          const again = fileChangeFor('Write', { content }, f.abs);
          if (f.change && again && again.after !== f.change.after) {
            failed.push(`${f.rel} (승인한 뒤 시안이 바뀜)`);
            continue;
          }
          await fs.mkdir(path.dirname(f.abs), { recursive: true });
          const tmp = `${f.abs}.${process.pid}.${Date.now()}.tmp`;
          await fs.writeFile(tmp, content, 'utf-8');
          await fs.rename(tmp, f.abs);
          done.push(f.rel);
        } catch {
          failed.push(`${f.rel} (쓰지 못함)`);
        }
      }
      const skipped = files.filter((f) => !picked.has(f.rel)).map((f) => f.rel);
      try {
        deps.tracker?.activity(guard.leaderLabel, `승인됨: ${args.title} (반영 ${done.length}개)`);
      } catch {
        // 무시
      }
      deps.emitActivity?.(`${guard.leaderLabel}: 묶음 승인 반영 ${done.length}개${skipped.length ? `, 빠짐 ${skipped.length}개` : ''}`);
      return text(
        [
          `사용자가 승인했어요${note ? ` (메모: ${note})` : ''}. 앱이 작업 폴더에 반영했어요.`,
          `- 반영한 파일: ${done.join(', ') || '없음'}`,
          ...(skipped.length ? [`- 사용자가 빼서 반영하지 않은 파일: ${skipped.join(', ')} (다시 시도하지 말고 보고에 적으세요)`] : []),
          ...(failed.length ? [`- 반영하지 못한 파일: ${failed.join(', ')}`] : []),
          ...(problems.length ? [`- 처음부터 올리지 못한 파일: ${problems.join(' / ')}`] : []),
        ].join('\n'),
      );
    },
  );

  return createSdkMcpServer({ name: LEADER_MCP_NAME, version: '0.1.0', tools: [requestApproval, proposeChanges] });
}
