// 조직 화면(미션 관리·인재풀)의 본체. 앱이 쓰는 곳은 ~/rano 안(config/rano.json, missions/<구역>/<id>/, pool/<구역>/, memory/missions.md)뿐이다.
// ~/work·~/personal 아래는 읽기만 한다(폴더 점검은 이름·목록만).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AdminResult,
  FolderInspection,
  MemoryServiceApi,
  MissionDraft,
  MissionSummary,
  RanoConfig,
  RoleDraft,
  RoleInfo,
  Zone,
  MissionDoc,
} from '../../shared/types.js';
import { expandHome } from '../config.js';
import { inspectFolder, type InspectContext } from './folderInspect.js';
import { cell, exists, isInside, readRaw, resolveIn, shrinkHome, today, writeRaw, zoneRoot, zoneText } from './paths.js';
import { savePoolRole, scanRoles } from './rolePool.js';
import { OUTPUTS_HEADER } from '../approvals/outputs.js';

export interface OrgAdminDeps {
  config: RanoConfig;
  memory: MemoryServiceApi;
  activeMissionIds: string[];
}

export interface OrgAdminApi {
  missions(): MissionSummary[];
  inspect(absPath: string, purpose: 'target' | 'ref', zone: Zone, editingId?: string): Promise<FolderInspection>;
  createMission(draft: MissionDraft): Promise<AdminResult>;
  updateMission(id: string, draft: MissionDraft): Promise<AdminResult>;
  archiveMission(id: string, archived: boolean): Promise<AdminResult>;
  roles(): RoleInfo[];
  role(name: string): RoleInfo | null;
  saveRole(draft: RoleDraft, originalName?: string): Promise<AdminResult>;
  missionDocs(id: string): MissionDoc[];
}

const WRITE_LABEL = { readOnly: '읽기만', approval: '승인함을 거쳐 쓰기' } as const;
const zoneOf = (z: unknown): Zone => (z === 'personal' ? 'personal' : 'work');

export function createOrgAdmin(deps: OrgAdminDeps): OrgAdminApi {
  const { config, memory } = deps;
  const ZT = zoneText(config);
  const ZONE_LABEL: Record<Zone, string> = { work: ZT.work.label, personal: ZT.personal.label };
  const rootDir = config.rootDir;
  const resolve = (p: string) => resolveIn(rootDir, p);
  const changed = new Set<string>(); // 이번 실행에서 바꾼 미션 (다시 시작해야 반영)

  // 쓰기는 하나씩 차례로 한다(rano.json 을 동시에 고치지 않게)
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const rawSync = (): any => {
    try {
      return JSON.parse(readFileSync(path.join(rootDir, 'config', 'rano.json'), 'utf-8'));
    } catch {
      return config.raw ?? {};
    }
  };
  const rawMissions = (raw: any): any[] => (Array.isArray(raw?.missions) ? raw.missions : []);
  const blockedOf = (raw: any): string[] =>
    (Array.isArray(raw?.blocked) ? raw.blocked : []).map((p: string) => (p.startsWith('**') ? p : expandHome(p)));

  const inspectCtx = (raw: any, editingId?: string): InspectContext => ({
    config,
    blocked: blockedOf(raw),
    otherTargets: rawMissions(raw)
      .filter((m) => m?.archived !== true && m?.id !== editingId && Array.isArray(m?.targets) && m.targets[0])
      .map((m) => ({ id: String(m.id), name: String(m.name ?? m.id), target: resolve(m.targets[0]) })),
  });

  /** 헌장의 '## 목표' 아래 첫 문단 (rano.json 에 goal 이 없을 때) */
  const goalFromCharter = (home: string): string | undefined => {
    try {
      const text = readFileSync(path.join(home, 'charter.md'), 'utf-8');
      const m = /(?:^|\n)##\s*목표[^\S\n]*\n+([\s\S]*?)(?=\n##\s|$)/.exec(text);
      const g = m?.[1].trim();
      return g || undefined;
    } catch {
      return undefined;
    }
  };

  const summarize = (raw: any, m: any): MissionSummary => {
    const target = m.targets?.[0] ? resolve(m.targets[0]) : '';
    const home = resolve(m.home ?? `missions/${m.zone === 'personal' ? 'personal' : 'work'}/${m.id}`);
    const archived = m.archived === true;
    return {
      id: String(m.id),
      name: String(m.name ?? m.id),
      zone: m.zone === 'personal' ? 'personal' : 'work',
      goal: typeof m.goal === 'string' && m.goal.trim() ? m.goal : goalFromCharter(home),
      target,
      readonlyRefs: (m.readonlyRefs ?? []).map(resolve),
      blocked: target ? blockedOf(raw).filter((b) => !b.startsWith('**') && isInside(b, target)) : [],
      writeMode: m.stagePolicy === 'approval' ? 'approval' : 'readOnly',
      roles: Array.isArray(m.roles) ? [...m.roles] : [],
      reviewerRoles: Array.isArray(m.reviewerRoles) ? [...m.reviewerRoles] : [],
      archived,
      home,
      active: !archived && deps.activeMissionIds.includes(String(m.id)) && !changed.has(String(m.id)),
    };
  };

  const roles = (): RoleInfo[] => scanRoles(rootDir, rawSync(), false).map((r) => r.info);

  /** 만들기·고치기 공통 검사. 통과하면 점검 결과를 돌려준다 */
  const validate = async (
    raw: any,
    draft: MissionDraft,
    editingId?: string,
  ): Promise<{ error: string } | { target: FolderInspection; refs: FolderInspection[] }> => {
    if (!draft || typeof draft !== 'object') return { error: '입력 내용을 읽지 못했어요' };
    if (!String(draft.name ?? '').trim()) return { error: '미션 이름을 적어 주세요' };
    if (draft.zone !== 'work' && draft.zone !== 'personal') return { error: '구역(회사·개인)을 골라 주세요' };
    const zone = draft.zone;
    if (editingId) {
      const cur = rawMissions(raw).find((m) => m?.id === editingId);
      if (cur && zoneOf(cur.zone) !== zone) return { error: '이미 만든 미션의 구역은 바꿀 수 없어요' };
    }
    const ctx = inspectCtx(raw, editingId);
    const target = await inspectFolder(ctx, draft.target, 'target', zone);
    if (!target.ok) return { error: `작업 폴더를 쓸 수 없어요: ${target.problems.join(', ')}` };
    if (draft.writeMode !== 'readOnly' && draft.writeMode !== 'approval') return { error: '쓰기 방식을 골라 주세요' };
    if (draft.writeMode === 'approval' && draft.writeConfirmed !== true)
      return { error: '승인함을 거쳐 쓰기를 고르려면 확인 창에서 확인해 주세요' };

    const roleList = Array.isArray(draft.roles) ? [...new Set(draft.roles.map(String))] : [];
    const reviewers = Array.isArray(draft.reviewerRoles) ? [...new Set(draft.reviewerRoles.map(String))] : [];
    if (reviewers.some((r) => !roleList.includes(r))) return { error: '검수 역할은 팀에 넣은 역할 중에서 골라 주세요' };
    if (roleList.filter((r) => !reviewers.includes(r)).length < 1) return { error: '작업을 맡을 역할을 1개 이상 넣어 주세요' };
    if (reviewers.length < 1) return { error: '검수 역할을 1개 이상 골라 주세요' };
    const all = roles();
    const known = new Set(all.map((r) => r.name));
    const missing = roleList.filter((r) => !known.has(r));
    if (missing.length) return { error: `인재풀에 없는 역할이에요: ${missing.join(', ')}` };
    const otherZone = all.filter((r) => roleList.includes(r.name) && r.zone !== zone).map((r) => r.name);
    if (otherZone.length) return { error: `${ZONE_LABEL[zone]} 구역 미션에는 ${ZONE_LABEL[zone]} 인재풀 역할만 넣을 수 있어요: ${otherZone.join(', ')}` };

    const refs: FolderInspection[] = [];
    for (const r of Array.isArray(draft.readonlyRefs) ? draft.readonlyRefs : []) {
      const ins = await inspectFolder(ctx, r, 'ref', zone);
      if (!ins.ok) return { error: `참고 폴더 ${ins.display} 를 쓸 수 없어요: ${ins.problems.join(', ')}` };
      if (ins.path === target.path) return { error: '작업 폴더를 참고 폴더로 또 넣을 수는 없어요' };
      if (!refs.some((x) => x.path === ins.path)) refs.push(ins);
    }
    for (const b of Array.isArray(draft.blocked) ? draft.blocked : []) {
      if (typeof b !== 'string' || !path.isAbsolute(expandHome(b))) return { error: '차단할 항목의 위치를 읽지 못했어요' };
    }
    return { target, refs };
  };

  /** draft.blocked 를 ~ 로 줄여 rano.json 차단 목록에 중복 없이 더한다. 더한 것만 돌려준다 */
  const addBlocked = (raw: any, list: string[] | undefined): string[] => {
    if (!Array.isArray(raw.blocked)) raw.blocked = [];
    const have = new Set(raw.blocked.map((p: string) => (p.startsWith('**') ? p : path.resolve(expandHome(p)))));
    const added: string[] = [];
    for (const b of list ?? []) {
      const abs = path.resolve(expandHome(String(b)));
      if (have.has(abs)) continue;
      have.add(abs);
      const short = shrinkHome(abs);
      raw.blocked.push(short);
      added.push(short);
    }
    return added;
  };

  const makeId = (raw: any, name: string): string => {
    const taken = new Set(rawMissions(raw).map((m) => String(m.id)));
    const free = (id: string) =>
      !taken.has(id) && !exists(path.join(rootDir, 'missions', 'work', id)) && !exists(path.join(rootDir, 'missions', 'personal', id));
    let base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/, '');
    if (!base) {
      let n = rawMissions(raw).length + 1;
      while (!free(`mission-${n}`)) n++;
      return `mission-${n}`;
    }
    if (free(base)) return base;
    let n = 2;
    while (!free(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  };

  const charterText = (
    d: MissionDraft,
    target: FolderInspection,
    refs: FolderInspection[],
    blockedShort: string[],
    roleDescs: Map<string, string>,
  ): string => {
    const lines: string[] = [];
    lines.push(`# ${d.name.trim()}${d.name.trim().endsWith('미션') ? '' : ' 미션'} 헌장`, '', '## 목표', d.goal?.trim() || '(목표를 적어 주세요)', '');
    lines.push('## 작업 대상 폴더');
    lines.push(`- 작업: ${target.display}${target.branch ? ` (브랜치 ${target.branch})` : ''}`);
    for (const r of refs) lines.push(`- 참고(읽기 전용): ${r.display}`);
    lines.push('- 규칙 파일은 고치지 않는다');
    const other = d.zone === 'personal' ? ZT.work : ZT.personal;
    lines.push(`- **${ZT[d.zone].label} 구역 미션이다.** ${other.label} 구역 폴더(${other.root})와 그 미션 기록은 읽지도 쓰지도 않는다`);
    lines.push('');
    lines.push(`## 권한 (${today()} 앱 조직 화면에서 정함)`);
    lines.push('- 읽기·검색은 바로 한다');
    if (d.writeMode === 'approval') {
      lines.push('- **쓰기는 파일 하나까지 모두 승인함에서 사용자 승인을 받은 뒤** 한다');
      lines.push('- 커밋·push·삭제·명령 실행은 승인함을 거친다');
    } else {
      lines.push('- **읽기만 한다.** 파일 쓰기·명령 실행·커밋은 하지 않고, 바꿀 내용은 보고에 적는다');
    }
    if (target.deploysOnPush)
      lines.push(
        `- **push 는 곧 배포일 수 있다.** 이 폴더에 배포 흔적(${target.deployHints.join(', ')})이 있다. push 가 필요하면 승인 요청의 "왜"에 운영에 무엇이 바뀌는지 적는다`,
      );
    lines.push(
      `- 차단: 비밀 키·인증 파일, .env 계열${blockedShort.length ? `, ${blockedShort.join(', ')}` : ''}`,
      '',
    );
    lines.push('## 팀');
    for (const r of d.roles) {
      const tag = d.reviewerRoles.includes(r) ? ' (검수)' : '';
      lines.push(`- ${r}${tag}: ${roleDescs.get(r) ?? ''}`.trimEnd());
    }
    lines.push('', '## 변경 기록', `- ${today()} 앱 조직 화면에서 만듦`, '');
    return lines.join('\n');
  };

  const teamText = (d: MissionDraft, info: Map<string, RoleInfo>): string => {
    const lines = [`# ${d.name.trim()} 팀 편성`, '', '| 역할 | 맡는 일 | 쓰는 도구 |', '|---|---|---|'];
    for (const r of d.roles) {
      const ri = info.get(r);
      const tools = !ri
        ? ''
        : [
            '읽기',
            ...(ri.canWrite ? [d.writeMode === 'approval' ? '파일 쓰기(승인함)' : '파일 쓰기(지금은 읽기만)'] : []),
            ...(ri.canRun ? [d.writeMode === 'approval' ? '명령(승인함)' : '명령(지금은 읽기만)'] : []),
          ].join(', ');
      const tag = d.reviewerRoles.includes(r) ? '[검수] ' : '';
      lines.push(`| ${r} | ${cell(tag + (ri?.description ?? ''))} | ${tools} |`);
    }
    lines.push('', '- 기본 구성: 작업 담당 1명 이상 + 검수 1명', '');
    return lines.join('\n');
  };

  const createMission = (draft: MissionDraft): Promise<AdminResult> =>
    serial(async () => {
      let raw: any;
      try {
        raw = await readRaw(rootDir);
      } catch {
        return { ok: false, message: '설정 파일(rano.json)을 읽지 못했어요' };
      }
      const v = await validate(raw, draft);
      if ('error' in v) return { ok: false, message: v.error };
      const name = draft.name.trim();
      const id = makeId(raw, name);
      const zone = draft.zone;
      const homeRel = `missions/${zone}/${id}`;
      const home = path.join(rootDir, homeRel);
      const roleInfo = new Map(roles().map((r) => [r.name, r]));
      const roleList = [...new Set(draft.roles)];
      const reviewers = [...new Set(draft.reviewerRoles)];
      const d: MissionDraft = { ...draft, name, roles: roleList, reviewerRoles: reviewers };

      const rulesFiles: string[] = [];
      // 구역 루트의 공통 규칙 파일(~/work/CLAUDE.md, ~/personal/CLAUDE.md)이 있으면 함께 읽힌다
      const globalRules = path.join(zoneRoot(config, zone), 'CLAUDE.md');
      if (exists(globalRules)) rulesFiles.push(shrinkHome(globalRules));
      for (const f of v.target.ruleFiles) {
        const s = shrinkHome(f);
        if (!rulesFiles.includes(s)) rulesFiles.push(s);
      }

      const nextRaw = JSON.parse(JSON.stringify(raw));
      const added = addBlocked(nextRaw, draft.blocked);
      if (!Array.isArray(nextRaw.missions)) nextRaw.missions = [];
      nextRaw.missions.push({
        id,
        name,
        zone,
        goal: draft.goal?.trim() ?? '',
        home: homeRel,
        targets: [shrinkHome(v.target.path)],
        readonlyRefs: v.refs.map((r) => shrinkHome(r.path)),
        rulesFiles,
        rolesDir: `${homeRel}/roles`,
        roles: roleList,
        reviewerRoles: reviewers,
        stagePolicy: draft.writeMode,
        _설명: `앱 조직 화면에서 만듦 (${today()})`,
        directWriteDirs: [],
      });

      // 미션 홈을 먼저 만들고, 성공하면 설정에 올린다
      try {
        await mkdir(path.join(home, 'memory'), { recursive: true });
        await mkdir(path.join(home, 'roles'), { recursive: true });
        const descs = new Map([...roleInfo].map(([k, r]) => [k, r.description]));
        const blockedInTarget = blockedOf(nextRaw)
          .filter((b) => !b.startsWith('**') && isInside(b, v.target.path))
          .map(shrinkHome);
        await writeFile(path.join(home, 'charter.md'), charterText(d, v.target, v.refs, blockedInTarget, descs), 'utf-8');
        await writeFile(path.join(home, 'team.md'), teamText(d, roleInfo), 'utf-8');
        await writeFile(
          path.join(home, 'outputs.md'),
          `# ${name} 결과물\n\n${OUTPUTS_HEADER}\n|---|---|---|---|---|\n`,
          'utf-8',
        );
        await writeFile(path.join(home, 'memory', '진행업무.md'), '# 진행업무\n\n', 'utf-8');
        const decision =
          draft.writeMode === 'approval' ? `- ${today()} 사용자가 앱에서 승인함을 거친 쓰기를 허용\n` : '';
        await writeFile(path.join(home, 'memory', '결정로그.md'), `# 결정로그\n\n${decision}`, 'utf-8');
        await writeFile(path.join(home, 'roles', '.gitkeep'), '', 'utf-8');
      } catch {
        return { ok: false, message: '미션 폴더를 만들지 못했어요. 잠시 뒤 다시 해 주세요' };
      }
      try {
        await writeRaw(rootDir, nextRaw);
      } catch {
        return { ok: false, message: '설정 파일(rano.json)을 저장하지 못했어요. 잠시 뒤 다시 해 주세요' };
      }
      changed.add(id);

      // 라노 기억(미션별 한 줄 현황)에 한 줄 더한다. 실패해도 미션은 만들어진 것으로 둔다
      let memNote = '';
      try {
        const cur = await memory.read('missions.md');
        const row = `| ${cell(name)} | ${ZONE_LABEL[zone]} | 등록됨 · 첫 과제 대기 (${today().slice(5).replace('-', '/')} 앱에서 만듦) | ${cell(draft.goal?.trim() || '목표 미정')} · 작업 폴더 ${v.target.display} · ${WRITE_LABEL[draft.writeMode]} |`;
        const base = cur.trim() ? cur.replace(/\s*$/, '\n') : '# 미션별 한 줄 현황 (missions.md)\n\n| 미션 | 구역 | 상태 | 한 줄 현황 |\n|---|---|---|---|\n';
        await memory.write('missions.md', base + row + '\n', `새 미션 등록: ${name}`);
      } catch {
        memNote = ' (라노 기억에 한 줄 남기지는 못했어요)';
      }
      const blockNote = added.length ? ` 차단 ${added.length}개를 더했어요.` : '';
      return {
        ok: true,
        id,
        needsRestart: true,
        message: `「${name}」을(를) 만들었어요.${blockNote} 앱을 다시 시작하면 현황판에 나타나요${memNote}`,
      };
    });

  const updateMission = (id: string, draft: MissionDraft): Promise<AdminResult> =>
    serial(async () => {
      let raw: any;
      try {
        raw = await readRaw(rootDir);
      } catch {
        return { ok: false, message: '설정 파일(rano.json)을 읽지 못했어요' };
      }
      const idx = rawMissions(raw).findIndex((m) => m?.id === id);
      if (idx < 0) return { ok: false, message: '그 미션을 찾을 수 없어요' };
      const v = await validate(raw, draft, id);
      if ('error' in v) return { ok: false, message: v.error };
      const nextRaw = JSON.parse(JSON.stringify(raw));
      const m = nextRaw.missions[idx];
      const before = summarize(raw, raw.missions[idx]);
      const name = draft.name.trim();
      const roleList = [...new Set(draft.roles)];
      const reviewers = [...new Set(draft.reviewerRoles)];
      const notes: string[] = [];

      if (before.name !== name) notes.push(`이름 ${before.name} → ${name}`);
      if ((before.goal ?? '').trim() !== (draft.goal ?? '').trim()) notes.push('목표를 바꿈');
      if (before.target !== v.target.path) {
        notes.push(`작업 폴더 ${shrinkHome(before.target)} → ${v.target.display}`);
        const rest = Array.isArray(m.targets) ? m.targets.slice(1) : [];
        m.targets = [shrinkHome(v.target.path), ...rest];
      }
      const refsNew = v.refs.map((r) => shrinkHome(r.path));
      const refsOld = before.readonlyRefs.map(shrinkHome);
      if (refsNew.join('\n') !== refsOld.join('\n'))
        notes.push(`참고 폴더 ${refsNew.length ? refsNew.join(', ') : '없음'}`);
      if (before.writeMode !== draft.writeMode)
        notes.push(`쓰기 방식 ${WRITE_LABEL[before.writeMode]} → ${WRITE_LABEL[draft.writeMode]}`);
      if (before.roles.join(',') !== roleList.join(',') || before.reviewerRoles.join(',') !== reviewers.join(','))
        notes.push(`팀 ${roleList.map((r) => (reviewers.includes(r) ? `${r}(검수)` : r)).join(', ')}`);

      m.name = name;
      m.goal = draft.goal?.trim() ?? '';
      m.readonlyRefs = refsNew;
      m.stagePolicy = draft.writeMode;
      m.roles = roleList;
      m.reviewerRoles = reviewers;
      const added = addBlocked(nextRaw, draft.blocked);
      if (added.length) notes.push(`차단 추가 ${added.join(', ')}`);
      if (!notes.length) return { ok: true, id, message: '바뀐 내용이 없어요' };

      try {
        await writeRaw(rootDir, nextRaw);
      } catch {
        return { ok: false, message: '설정 파일(rano.json)을 저장하지 못했어요. 잠시 뒤 다시 해 주세요' };
      }
      changed.add(id);

      // 미션 홈 기록: 헌장 맨 아래 '변경 기록'에 한 줄, 쓰기 허용으로 바뀌면 결정로그에 한 줄
      let homeNote = '';
      try {
        const charter = path.join(before.home, 'charter.md');
        let text = '';
        try {
          text = await readFile(charter, 'utf-8');
        } catch {
          // 헌장이 없으면 새로 시작한다
        }
        const line = `- ${today()} 앱 조직 화면에서 바꿈: ${notes.join(' · ')}\n`;
        const lead = text && !text.endsWith('\n') ? '\n' : '';
        const head = /^##\s*변경 기록\s*$/m.test(text) ? '' : `${text ? '\n' : ''}## 변경 기록\n`;
        await mkdir(before.home, { recursive: true });
        await appendFile(charter, lead + head + line, 'utf-8');
        if (before.writeMode === 'readOnly' && draft.writeMode === 'approval') {
          await mkdir(path.join(before.home, 'memory'), { recursive: true });
          const log = path.join(before.home, 'memory', '결정로그.md');
          let cur = '';
          try {
            cur = await readFile(log, 'utf-8');
          } catch {
            cur = '# 결정로그\n\n';
          }
          const sep = cur && !cur.endsWith('\n') ? '\n' : '';
          await writeFile(log, `${cur}${sep}- ${today()} 사용자가 앱에서 승인함을 거친 쓰기를 허용\n`, 'utf-8');
        }
      } catch {
        homeNote = ' (미션 헌장에 변경 기록을 남기지는 못했어요)';
      }
      return {
        ok: true,
        id,
        needsRestart: true,
        message: `「${name}」을(를) 고쳤어요. 앱을 다시 시작하면 반영돼요${homeNote}`,
      };
    });

  const archiveMission = (id: string, archived: boolean): Promise<AdminResult> =>
    serial(async () => {
      let raw: any;
      try {
        raw = await readRaw(rootDir);
      } catch {
        return { ok: false, message: '설정 파일(rano.json)을 읽지 못했어요' };
      }
      const m = rawMissions(raw).find((x) => x?.id === id);
      if (!m) return { ok: false, message: '그 미션을 찾을 수 없어요' };
      const name = String(m.name ?? id);
      if ((m.archived === true) === archived)
        return { ok: true, id, message: archived ? `「${name}」은(는) 이미 보관돼 있어요` : `「${name}」은(는) 이미 쓰는 중이에요` };
      if (archived) m.archived = true;
      else delete m.archived;
      try {
        await writeRaw(rootDir, raw);
      } catch {
        return { ok: false, message: '설정 파일(rano.json)을 저장하지 못했어요. 잠시 뒤 다시 해 주세요' };
      }
      changed.add(id);
      return {
        ok: true,
        id,
        needsRestart: true,
        message: archived
          ? `「${name}」을(를) 보관했어요. 파일은 그대로 남아 있어요. 앱을 다시 시작하면 현황판에서 빠져요`
          : `「${name}」을(를) 다시 꺼냈어요. 앱을 다시 시작하면 현황판에 나타나요`,
      };
    });

  return {
    missions: () => {
      const raw = rawSync();
      return rawMissions(raw)
        .filter((m) => m && typeof m.id === 'string')
        .map((m) => summarize(raw, m));
    },
    inspect: (absPath, purpose, zone, editingId) =>
      inspectFolder(inspectCtx(rawSync(), editingId), absPath, purpose === 'ref' ? 'ref' : 'target', zoneOf(zone)),
    createMission,
    updateMission,
    archiveMission,
    roles,
    role: (name) => scanRoles(rootDir, rawSync(), true).find((r) => r.info.name === name)?.info ?? null,
    missionDocs: (id) => {
      const m = rawMissions(rawSync()).find((x) => x?.id === id);
      if (!m) return [];
      const home = summarize(rawSync(), m).home;
      const LABEL: Record<string, string> = { 'charter.md': '헌장', 'team.md': '팀 편성', 'outputs.md': '결과물 목록' };
      const out: MissionDoc[] = [];
      const add = (rel: string, label: string) => {
        const f = path.join(home, rel);
        try {
          const st = statSync(f);
          if (!st.isFile() || st.size > 400_000) return;
          out.push({ file: rel, label, content: readFileSync(f, 'utf-8'), updatedAt: st.mtime.toISOString() });
        } catch {
          // 없는 파일은 건너뛴다
        }
      };
      for (const f of ['charter.md', 'team.md']) add(f, LABEL[f]);
      let mem: string[] = [];
      try {
        mem = readdirSync(path.join(home, 'memory')).filter((n) => n.endsWith('.md')).sort();
      } catch {
        mem = [];
      }
      for (const n of mem) add(`memory/${n}`, n.replace(/\.md$/, ''));
      add('outputs.md', LABEL['outputs.md']);
      return out;
    },
    saveRole: (draft, originalName) => serial(() => savePoolRole(rootDir, rawSync(), draft, originalName)),
  };
}
