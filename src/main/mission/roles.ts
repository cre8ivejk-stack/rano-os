// 미션 팀원(서브에이전트) 역할 파일을 읽어 SDK 의 AgentDefinition 으로 바꾼다. 역할 파일은 읽기만 한다.
import { dbReadGuide } from './dbRead.js';
import { PROPOSE_COMMANDS_TOOL } from './leaderPermissions.js';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MissionConfig, RanoConfig, RoleModel } from '../../shared/types.js';
import { roleSkills, skillCatalog, skillPromptFor } from '../skills/skills.js';
import { missionTmpDir } from './missionTmp.js';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/** 3단계(approval)에서 팀원이 쓸 수 있는 내장 도구. 모두 앱의 권한 검사를 거친다(쓰기·실행은 승인함). */
export const APPROVAL_STAGE_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit', 'Bash'] as const;

export interface RoleFile {
  name: string;
  description: string;
  tools: string[] | null; // 적혀 있지 않으면 null
  model: RoleModel; // frontmatter 의 model: opus · sonnet (전체 모델 ID 도 알아봄). 그 밖·없으면 'default'
  body: string;
}

/** frontmatter 의 model 값 → 'opus' · 'sonnet' · 'default' */
export function normalizeRoleModel(raw: string | undefined): RoleModel {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'sonnet' || v.startsWith('claude-sonnet')) return 'sonnet';
  if (v === 'opus' || v.startsWith('claude-opus')) return 'opus';
  return 'default';
}

/** 라노 데이터 폴더(인재풀·미션 홈) 안의 역할 파일인지. 회사 역할 폴더의 model 은 따르지 않는다(라노 설정 우선) */
export function isOwnRoleFile(config: RanoConfig, roleFile: string): boolean {
  const rel = path.relative(path.resolve(config.rootDir), path.resolve(roleFile));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 'opus' · 'sonnet' · 'default' → 실제로 넘길 모델. default 는 라노 설정(models.member) */
export function modelFor(config: RanoConfig, model: RoleModel): string {
  if (model === 'opus') return /opus/i.test(config.models.member) ? config.models.member : 'opus';
  if (model === 'sonnet') return /sonnet/i.test(config.models.member) ? config.models.member : 'sonnet';
  return config.models.member;
}

/** 역할의 기본 모델(역할 파일 기준). 과제마다 리더가 추천하고 사용자가 고른 모델이 이보다 우선한다 */
export function roleDefaultModel(config: RanoConfig, mission: MissionConfig, role: string): RoleModel {
  const found = findRoleFile(mission, role);
  if (!found || !isOwnRoleFile(config, found.file)) return 'default';
  return parseRoleFile(found.text, role).model;
}

/** 아주 단순한 frontmatter 파서: --- 사이의 `키: 값` 한 줄짜리만 읽는다. */
export function parseRoleFile(text: string, fallbackName: string): RoleFile {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fields: Record<string, string> = {};
  let body = src;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (m) {
    body = src.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      fields[kv[1]] = v;
    }
  }
  const toolsRaw = fields.tools?.replace(/^\[|\]$/g, '');
  const tools = toolsRaw
    ? toolsRaw
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    : null;
  return {
    name: fields.name || fallbackName,
    description: fields.description || `${fallbackName} 역할`,
    tools,
    model: normalizeRoleModel(fields.model),
    body: body.trim(),
  };
}

const READ_ONLY_NOTE = `

## 지금 권한 (읽기 전용 미션)
- 지금은 파일을 읽고 찾는 일만 할 수 있다. 파일 쓰기·수정·명령 실행·커밋·외부 게시는 하지 않는다.
- 위 본문에 쓰기나 게시 절차가 있더라도, 지금은 초안이나 바꿀 내용을 결과 보고에 적어 리포 리더에게 넘긴다.
- 결과는 쉬운 한국어로, 근거가 된 파일 위치와 함께 보고한다.`;

/** 승인함 미션 팀원 안내. tmpDir: 이 미션 전용 임시 폴더(경로를 글자 그대로 적어 준다) */
export function approvalNote(tmpDir: string): string {
  return `

## 지금 권한 (승인함 미션)
- 읽기·검색은 바로 할 수 있다. 파일 쓰기·수정과 명령 실행은 앱이 파일 하나, 명령 하나까지 사용자 승인함에 올리고, 승인된 뒤에만 실행된다.
- 쓰기나 명령 직전에는 무엇을 왜 하는지 쉬운 한국어로 한두 줄 먼저 말한다. 그 말이 승인함의 "왜"로 쓰인다. 권장안이 있으면 "권장: …" 한 줄로 덧붙인다.
- 리포 리더가 "시안 폴더에 고친 파일을 만들라"고 하면 작업 폴더 대신 그 시안 폴더에 고친 뒤의 전체 내용을 쓴다(묶음 승인용, 승인 없이 쓸 수 있다).
- 확인용 임시 스크립트는 이 과제의 시안 폴더에 Write 로 만든다(승인 없음. Write·Edit 도구는 시안 폴더에만 승인 없이 쓴다). 명령 결과는 이 미션 임시 폴더 ${tmpDir} 에 Bash 로 담고 읽는다(예: npm test > ${tmpDir}/test.txt 2>&1, 승인 없음). 경로는 글자 그대로 적는다. /tmp, $TMPDIR, mktemp 를 쓰면 승인함으로 간다. 읽기·grep·sed -n·find 와 타입 검사·린트·시험 명령도 바로 된다. 만든 스크립트를 node·python 으로 실행하는 것은 승인함을 거치므로, 여러 번 나눠 돌리지 말고 한 스크립트에 모아 한 번에 돌린다.
- 서로 상관없는 읽기·검색(Read·Grep·Glob·읽기 명령)은 한 번의 답에 도구를 여러 개 함께 불러 동시에 한다. 앞 결과를 봐야 정할 수 있는 것만 차례로 한다. 큰 파일은 필요한 줄 범위만 읽는다.
- 승인 없이 되는 꼴로 쓴다: 경로를 담는 변수는 소문자나 한 글자 대문자(d=…, D=…)로 쓴다(OUT=…·TMP=… 같은 긴 대문자 이름은 설정 바꾸기로 보여 승인함으로 간다). 타입 검사·시험·린트는 리포에 있는 설정 그대로(npx tsc --noEmit, npm test, npx tsx --test <리포 안 시험 파일>, npx eslint <리포 안 파일>) 돌리고, 필요 없는 오류 줄은 결과 파일에서 grep 으로 거른다. 따로 만든 tsconfig·eslint 설정을 쓰거나 시안 폴더 코드를 시험으로 돌리면 매번 승인함으로 가니, 꼭 필요하면 propose_commands 실행 목록으로 한 번에 올린다.
- 승인이 필요한 명령(스크립트 실행·개발 서버 띄우기 등)을 두 번 이상 돌려야 하면, 스크립트를 먼저 다 만든 뒤 propose_commands 도구로 돌릴 명령 목록을 한 번에 승인받는다. 승인되면 목록의 명령을 글자 그대로 같은 위치에서 실행한다(스크립트를 고치면 다시 물으니, 고칠 땐 목록을 다시 올린다).
- 시안 폴더·임시 폴더 안이라도 권한 바꾸기(chmod·chown·install)와 밖(작업 폴더 등)을 가리키는 바로가기(ln) 만들기는 승인함으로 간다.
- 커밋·삭제·DB·배포는 리포 리더가 따로 지시한 경우에만 시도한다. 반려되면 우회하지 말고 결과 보고에 적는다.
- 비밀 키·인증 파일, .env 계열 파일은 열지 않는다. 앱이 막는다.
- 결과는 쉬운 한국어로, 근거가 된 파일 위치와 함께 보고한다.`;
}

/** 믿는 미션 팀원 안내: 작업 폴더 안 고치기·시험·코드 실행은 바로 된다 */
export function trustedNote(tmpDir: string, dbGuide = ''): string {
  return `

## 지금 권한 (믿는 미션)
- 읽기·검색, 작업 폴더 안 파일 고치기·만들기(Write·Edit·Bash), 타입 검사·시험·린트, 작업 폴더 안 스크립트 실행은 승인 없이 바로 된다. 묶음 승인·실행 목록 없이 바로 고치고 바로 확인한다.
- 그대로 승인함을 거치는 일: 커밋·push·가지 바꾸기 등 git 기록 바꾸기, 지우기, DB 바꾸기, 배포, 작업 폴더 밖 쓰기, 인터넷으로 보내기(curl 등), 프로그램 끄기, 권한 바꾸기, .git·.claude 폴더 고치기. 이런 일은 리포 리더가 따로 지시한 경우에만 하고, 직전에 무엇을 왜 하는지 쉬운 한국어로 한두 줄 먼저 말한다.
- 명령 결과는 작업 폴더 안이나 이 미션 임시 폴더 ${tmpDir} 에 담는다. /tmp, $TMPDIR, mktemp 는 쓰지 않는다.
- 운영 DB·운영 서비스에 접속하는 스크립트는 만들거나 돌리지 않는다. 필요하면 결과 보고에 적는다.${dbGuide ? `\n- ${dbGuide}` : ''}
- 서로 상관없는 읽기·검색은 한 번에 여러 도구를 함께 불러 동시에 한다.
- 비밀 키·인증 파일, .env 계열 파일은 열지 않는다. 앱이 막는다.
- 결과는 쉬운 한국어로, 근거가 된 파일 위치와 함께 보고한다.`;
}

/** 역할 파일을 mission.roleDirs 앞에서부터 찾아 처음 있는 것의 경로와 내용을 돌려준다. 없으면 null. */
export function findRoleFile(mission: MissionConfig, role: string): { file: string; text: string } | null {
  const dirs = mission.roleDirs?.length ? mission.roleDirs : [mission.rolesDir];
  for (const dir of dirs) {
    const file = path.join(dir, `${role}.md`);
    try {
      return { file, text: readFileSync(file, 'utf-8') };
    } catch {
      // 다음 폴더에서 찾는다
    }
  }
  return null;
}

/** mission.roleDirs(앞에서부터)에서 mission.roles 에 있는 역할만 읽는다. 읽지 못한 역할은 건너뛴다. */
export function loadRoles(config: RanoConfig, mission: MissionConfig): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  const readOnly = mission.stagePolicy === 'readOnly';
  for (const role of mission.roles) {
    // 역할 이름으로 폴더 밖을 가리키지 못하게 한다
    if (!/^[A-Za-z0-9][\w.-]*$/.test(role)) continue;
    const found = findRoleFile(mission, role);
    if (!found) continue;
    const parsed = parseRoleFile(found.text, role);
    let tools: string[] | undefined;
    if (readOnly) {
      const kept = (parsed.tools ?? []).filter((t) => (READ_ONLY_TOOLS as readonly string[]).includes(t));
      tools = kept.length ? kept : [...READ_ONLY_TOOLS];
    } else {
      // 역할 파일에 적힌 도구를 쓰되, 이 앱이 검사할 수 있는 내장 도구만 남긴다
      // 외부 연결(MCP)은 이 미션에 켜진 연결의 도구만 남긴다. 역할 파일에 도구 목록이 없으면 켜진 연결 도구를 모두 쓴다(쓰기는 승인함)
      const allowed = APPROVAL_STAGE_TOOLS as readonly string[];
      const conns = (mission.connectors ?? []).filter((n) => config.connectors?.[n]);
      const isConn = (t: string) => conns.some((n) => t.startsWith(`mcp__${n}__`));
      const kept = parsed.tools ? parsed.tools.filter((t) => allowed.includes(t) || isConn(t)) : [...allowed];
      tools = kept.some((t) => allowed.includes(t)) ? kept : [...READ_ONLY_TOOLS, ...kept];
      if (!parsed.tools && conns.length) tools = undefined; // 리더가 가진 도구(켜진 연결 포함)를 그대로 물려받는다
      // 실행 목록 한 번에 승인 도구는 팀원도 쓴다(승인이 필요한 명령을 여러 번 돌릴 때)
      if (tools && !tools.includes(PROPOSE_COMMANDS_TOOL)) tools = [...tools, PROPOSE_COMMANDS_TOOL];
    }
    out[role] = {
      description: parsed.description,
      prompt: parsed.body + (readOnly ? READ_ONLY_NOTE : mission.trustRepo ? trustedNote(missionTmpDir(config, mission.id), dbReadGuide(mission)) : approvalNote(missionTmpDir(config, mission.id))) + (readOnly ? '' : skillPromptFor(role) + skillCatalog(roleSkills()[role] ?? [])),
      tools,
      // 라노 데이터 폴더의 역할 파일에 model: sonnet/opus 가 있으면 그 모델, 아니면 라노 설정. 과제마다 고른 모델은 팀원을 부를 때 덮어쓴다
      model: modelFor(config, isOwnRoleFile(config, found.file) ? parsed.model : 'default'),
      // 규칙은 리포 리더가 지시에 담아 넘기므로 CLAUDE.md 를 따로 불러오지 않는다
      omitClaudeMd: true,
    };
  }
  return out;
}
