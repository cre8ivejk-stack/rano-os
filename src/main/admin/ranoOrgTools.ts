// 라노가 쓰는 조직 도구(MCP): org_overview, propose_mission, open_mission_proposal
// 라노는 미션을 직접 만들지 않는다. 구성안만 만들고, 사용자가 동의하면 조직 탭 미션 추가 화면을 그 내용으로 채워서 연다.
// 쓰기 권한과 비밀 파일 차단은 사용자가 그 화면에서 직접 정한다.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ORG_MCP_NAME, type Emit, type MissionProposal, type RanoConfig, type RoleDraft, type Zone } from '../../shared/types.js';
import type { OrgAdminApi } from './orgAdmin.js';
import { shrinkHome, zonePath, zoneRoot, zoneText } from './paths.js';

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

const ROLE_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;
const KEEP = 20; // 기억해 둘 구성안 수
const ZONES: Zone[] = ['work', 'personal'];

export function createOrgMcpServer(org: OrgAdminApi, emit: Emit, config: RanoConfig) {
  const ZT = zoneText(config);
  const ZONE_LABEL: Record<Zone, string> = { work: ZT.work.label, personal: ZT.personal.label };
  const proposals = new Map<string, MissionProposal>();

  const overview = tool(
    'org_overview',
    [
      '새 미션 구성안을 만들기 전에 지금 조직을 확인합니다: 등록된 미션(이름·구역·작업 폴더), 구역별 인재풀 역할(이름·설명·할 수 있는 일),',
      `구역 루트(${ZT.work.label} ${ZT.work.root}, ${ZT.personal.label} ${ZT.personal.root}) 바로 아래 폴더 이름 목록(이미 미션이 쓰는 폴더 표시). 폴더 안의 파일은 보지 않습니다.`,
    ].join('\n'),
    {},
    async () => {
      const missions = org.missions();
      const used = new Map(missions.filter((m) => !m.archived).map((m) => [m.target, m.name] as const));
      const out: string[] = ['## 미션'];
      for (const m of missions) out.push(`- ${m.name} (id ${m.id}, ${ZONE_LABEL[m.zone]} 구역)${m.archived ? ' [보관]' : ''}: ${shrinkHome(m.target)} · ${m.writeMode === 'approval' ? '승인함 쓰기' : '읽기 전용'} · 역할 ${m.roles.join(', ')}`);
      const roles = org.roles();
      for (const z of ZONES) {
        out.push('', `## ${ZONE_LABEL[z]} 인재풀 역할 (${ZONE_LABEL[z]} 구역 미션만 쓸 수 있음)`);
        const list = roles.filter((r) => r.zone === z);
        if (!list.length) out.push('- (없음)');
        for (const r of list) {
          const can = ['읽기', r.canWrite ? '파일 쓰기' : '', r.canRun ? '명령 실행' : ''].filter(Boolean).join('·');
          out.push(`- ${r.name}: ${r.description} (${can}${r.usedBy.length ? ` · 쓰는 미션 ${r.usedBy.join(', ')}` : ''})`);
        }
      }
      for (const z of ZONES) {
        const root = zoneRoot(config, z);
        let folders: string[] = [];
        try {
          folders = readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
            .map((d) => d.name)
            .sort();
        } catch {
          folders = [];
        }
        out.push('', `## ${ZONE_LABEL[z]} 구역 폴더 (${shrinkHome(root)} 아래)`);
        if (!folders.length) out.push('- (없음)');
        for (const f of folders) {
          const abs = path.join(root, f);
          out.push(`- ${shrinkHome(abs)}${used.has(abs) ? ` (이미 「${used.get(abs)}」 미션이 씀)` : ''}`);
        }
      }
      return text(out.join('\n'));
    },
    { annotations: { readOnlyHint: true } },
  );

  const propose = tool(
    'propose_mission',
    [
      '사용자가 말한 일이 등록된 어떤 미션에도 맞지 않을 때, 새 미션 구성안을 만듭니다. 아무것도 만들거나 쓰지 않고 대화에 구성안 카드만 보여 줍니다.',
      '먼저 org_overview 로 기존 역할과 폴더를 확인하세요. 역할은 기존 것을 우선 쓰고, 꼭 필요할 때만 newRoles 로 새 역할 초안을 넣으세요.',
      `구역: 회사 일이면 work(${ZT.work.label}, 작업 폴더 ${ZT.work.root} 아래), 개인 일이면 personal(${ZT.personal.label}, 작업 폴더 ${ZT.personal.root} 아래). 역할은 같은 구역 인재풀 것만 쓸 수 있습니다.`,
      '팀은 작업 담당(검수 아닌 역할) 1개 이상 + 검수 역할 1개 이상이어야 합니다. 작업 폴더를 모르면 비우고 사용자에게 물어보세요.',
      '쓰기 권한과 비밀 파일 차단은 넣지 않습니다(사용자가 화면에서 직접 정함). 결과로 받은 구성안 id 를 기억했다가, 사용자가 동의하면 open_mission_proposal 로 여세요.',
    ].join('\n'),
    {
      name: z.string().describe('미션 이름 (짧게)'),
      goal: z.string().describe('미션 목표 한두 문장'),
      zone: z.enum(['work', 'personal']).describe(`work = ${ZT.work.label} 구역(${ZT.work.root}), personal = ${ZT.personal.label} 구역(${ZT.personal.root})`),
      target: z.string().optional().describe('작업 폴더 절대 경로 또는 구역 루트 기준 폴더 이름 (모르면 비움)'),
      readonlyRefs: z.array(z.string()).optional().describe('참고(읽기 전용) 폴더'),
      roles: z.array(z.string()).describe('팀 역할 이름들 (기존 역할 + newRoles 이름)'),
      reviewerRoles: z.array(z.string()).describe('roles 중 검수 역할'),
      newRoles: z
        .array(
          z.object({
            name: z.string().describe('영문 소문자·숫자·- (예: report-writer)'),
            description: z.string(),
            canWrite: z.boolean(),
            canRun: z.boolean(),
            body: z.string().describe('지침 3~6줄: 할 일, 하지 않을 일(비밀 파일 열지 않기, 커밋·push 는 리더 지시 때만), 보고 방식'),
          }),
        )
        .optional(),
      reason: z.string().describe('이렇게 짠 이유 한두 줄'),
    },
    async (a) => {
      const problems: string[] = [];
      const name = a.name.trim();
      if (!name) problems.push('미션 이름이 비었어요');
      const zone: Zone = a.zone === 'personal' ? 'personal' : 'work';
      const allRoles = org.roles();
      const existing = new Set(allRoles.map((r) => r.name));
      const zoneRoles = new Set(allRoles.filter((r) => r.zone === zone).map((r) => r.name));
      const newRoles: RoleDraft[] = [];
      for (const r of a.newRoles ?? []) {
        if (!ROLE_NAME.test(r.name)) problems.push(`새 역할 이름 "${r.name}" 은 영문 소문자·숫자·- 만 쓸 수 있어요`);
        else if (existing.has(r.name)) problems.push(`"${r.name}" 은 이미 있는 역할이에요. newRoles 에서 빼고 그대로 쓰세요`);
        else newRoles.push({ zone, name: r.name, description: r.description.trim(), canWrite: !!r.canWrite, canRun: !!r.canRun, body: r.body.trim() });
      }
      const known = new Set([...zoneRoles, ...newRoles.map((r) => r.name)]);
      const roles = [...new Set(a.roles)];
      for (const r of roles) {
        if (known.has(r)) continue;
        if (existing.has(r)) problems.push(`"${r}" 역할은 다른 구역 인재풀 역할이라 ${ZONE_LABEL[zone]} 구역 미션에 넣을 수 없어요. 같은 구역 역할을 고르거나 newRoles 에 새 이름으로 초안을 넣으세요`);
        else problems.push(`"${r}" 역할이 인재풀에 없어요. newRoles 에 초안을 넣거나 다른 역할을 고르세요`);
      }
      const reviewers = [...new Set(a.reviewerRoles)].filter((r) => roles.includes(r));
      if (!roles.some((r) => !reviewers.includes(r))) problems.push('작업 담당(검수 아닌 역할)이 1개 이상 필요해요');
      if (!reviewers.length) problems.push('검수 역할이 1개 이상 필요해요');
      if (problems.length) return text(`구성안을 만들지 못했어요:\n- ${problems.join('\n- ')}`, true);

      let target: string | undefined;
      let targetNote: string | undefined;
      if (a.target?.trim()) {
        const f = await org.inspect(zonePath(config, zone, a.target), 'target', zone);
        target = f.path;
        const notes = [...f.problems, ...f.warnings, ...(f.deploysOnPush ? [`push 하면 배포될 수 있음(${f.deployHints.join(', ')})`] : [])];
        if (notes.length) targetNote = notes.join(' · ');
      }
      const refs: string[] = [];
      for (const r of a.readonlyRefs ?? []) {
        if (!r.trim()) continue;
        const f = await org.inspect(zonePath(config, zone, r), 'ref', zone);
        if (f.ok) refs.push(f.path);
      }
      const p: MissionProposal = {
        id: randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        name,
        goal: a.goal.trim(),
        zone,
        ...(target ? { target } : {}),
        ...(targetNote ? { targetNote } : {}),
        readonlyRefs: refs,
        roles,
        reviewerRoles: reviewers,
        newRoles,
        reason: a.reason.trim(),
      };
      proposals.set(p.id, p);
      if (proposals.size > KEEP) proposals.delete(proposals.keys().next().value as string);
      emit({ kind: 'orgProposal', proposal: p, at: p.createdAt });
      return text(
        [
          `구성안을 대화에 카드로 보여 줬어요 (id: ${p.id}, ${ZONE_LABEL[zone]} 구역). 아직 아무것도 만들지 않았어요.`,
          target ? `작업 폴더: ${shrinkHome(target)}${targetNote ? ` — 확인 필요: ${targetNote}` : ''}` : '작업 폴더: 정하지 않음 (사용자가 화면에서 고름)',
          '사용자에게 구성안을 쉬운 말로 요약하고, "조직 탭에서 이 내용으로 열까요?" 라고 물어보세요. 쓰기 권한·비밀 파일은 그 화면에서 직접 정한다고 알려 주세요.',
        ].join('\n'),
      );
    },
  );

  const open = tool(
    'open_mission_proposal',
    '사용자가 구성안에 동의하면, 조직 탭의 미션 추가 화면을 그 구성안으로 채워서 엽니다. 미션은 사용자가 그 화면에서 확인하고 직접 만듭니다.',
    { id: z.string().describe('propose_mission 이 돌려준 구성안 id') },
    async ({ id }) => {
      const p = proposals.get(id);
      if (!p) return text('그 구성안을 찾지 못했어요. 앱을 다시 켰다면 propose_mission 으로 다시 만들어 주세요.', true);
      emit({ kind: 'orgOpenProposal', proposal: p });
      return text('조직 탭에 미션 추가 화면을 채워서 열었어요. 사용자가 확인하고 [미션 만들기]를 누르면 만들어져요. 앱 다시 시작 뒤 현황판에 나타나요.');
    },
  );

  return createSdkMcpServer({ name: ORG_MCP_NAME, version: '0.1.0', tools: [overview, propose, open] });
}
