// 미션 팀원(서브에이전트) 역할 파일을 읽어 SDK 의 AgentDefinition 으로 바꾼다. 역할 파일은 읽기만 한다.
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MissionConfig, RanoConfig } from '../../shared/types.js';
import { roleSkills, skillCatalog, skillPromptFor } from '../skills/skills.js';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/** 3단계(approval)에서 팀원이 쓸 수 있는 내장 도구. 모두 앱의 권한 검사를 거친다(쓰기·실행은 승인함). */
export const APPROVAL_STAGE_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit', 'Bash'] as const;

export interface RoleFile {
  name: string;
  description: string;
  tools: string[] | null; // 적혀 있지 않으면 null
  body: string;
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
    body: body.trim(),
  };
}

const READ_ONLY_NOTE = `

## 지금 권한 (읽기 전용 미션)
- 지금은 파일을 읽고 찾는 일만 할 수 있다. 파일 쓰기·수정·명령 실행·커밋·외부 게시는 하지 않는다.
- 위 본문에 쓰기나 게시 절차가 있더라도, 지금은 초안이나 바꿀 내용을 결과 보고에 적어 리포 리더에게 넘긴다.
- 결과는 쉬운 한국어로, 근거가 된 파일 위치와 함께 보고한다.`;

const APPROVAL_NOTE = `

## 지금 권한 (승인함 미션)
- 읽기·검색은 바로 할 수 있다. 파일 쓰기·수정과 명령 실행은 앱이 파일 하나, 명령 하나까지 사용자 승인함에 올리고, 승인된 뒤에만 실행된다.
- 쓰기나 명령 직전에는 무엇을 왜 하는지 쉬운 한국어로 한두 줄 먼저 말한다. 그 말이 승인함의 "왜"로 쓰인다. 권장안이 있으면 "권장: …" 한 줄로 덧붙인다.
- 리포 리더가 "시안 폴더에 고친 파일을 만들라"고 하면 작업 폴더 대신 그 시안 폴더에 고친 뒤의 전체 내용을 쓴다(묶음 승인용, 승인 없이 쓸 수 있다).
- 확인용 임시 스크립트·결과 파일은 이 과제의 시안 폴더에 Write 로 만들거나 /tmp 에 쓴다(둘 다 승인 없음). 읽기·grep·sed -n·find 와 타입 검사·린트·시험 명령도 바로 된다. 만든 스크립트를 node·python 으로 실행하는 것은 승인함을 거치므로, 여러 번 나눠 돌리지 말고 한 스크립트에 모아 한 번에 돌린다.
- 커밋·삭제·DB·배포는 리포 리더가 따로 지시한 경우에만 시도한다. 반려되면 우회하지 말고 결과 보고에 적는다.
- 비밀 키·인증 파일, .env 계열 파일은 열지 않는다. 앱이 막는다.
- 결과는 쉬운 한국어로, 근거가 된 파일 위치와 함께 보고한다.`;

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
    }
    out[role] = {
      description: parsed.description,
      prompt: parsed.body + (readOnly ? READ_ONLY_NOTE : APPROVAL_NOTE) + (readOnly ? '' : skillPromptFor(role) + skillCatalog(roleSkills()[role] ?? [])),
      tools,
      // 역할 파일에 적힌 모델보다 라노 설정이 우선한다 (전체 모델 ID 사용 가능)
      model: config.models.member,
      // 규칙은 리포 리더가 지시에 담아 넘기므로 CLAUDE.md 를 따로 불러오지 않는다
      omitClaudeMd: true,
    };
  }
  return out;
}
