// 작업 폴더·참고 폴더 후보 점검. 폴더 목록과 파일 이름만 보고, 파일 내용은 열지 않는다(~/work 는 읽기만).
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FolderInspection, RanoConfig, Zone } from '../../shared/types.js';
import { isBlockedPath } from '../engine/permissions.js';
import { exists, isInside, realOr, resolveIn, shrinkHome, zoneRoot, zoneText } from './paths.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '__pycache__', '.pytest_cache']);
const MAX_ENTRIES = 3000;
const MAX_DEPTH = 3;

// 이름만 보고 비밀로 보이는 파일·폴더
const SECRET_NAMES: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+/i,
  /^env\.[\w-]+$/i, // env.master, env.release 같은 것
  /secret/i,
  /credential/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)/i,
  /token.*\.(json|txt|ya?ml)$/i,
];

// 소스 코드 파일은 이름에 secret·credential·env 가 들어 있어도 비밀 값 파일로 보지 않는다(예: utils/env.py)
const CODE_FILE = /\.(py|pyi|js|mjs|cjs|ts|tsx|jsx|java|kt|go|rb|rs|php|cs|swift|scala|sh|sql|html|css|scss|vue|svelte)$/i;

const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.github/copilot-instructions.md'];

// push 하면 배포될 수 있다는 흔적(맨 위 폴더 기준)
const DEPLOY_HINTS = [
  'Jenkinsfile',
  'Diyfile.yaml',
  'Diyfile.yml',
  '.gitlab-ci.yml',
  '.github/workflows',
  'bitbucket-pipelines.yml',
  'azure-pipelines.yml',
  '.circleci',
  '.travis.yml',
  'buildspec.yml',
  'cloudbuild.yaml',
  'appspec.yml',
];

export interface InspectContext {
  config: RanoConfig;
  /** 지금 rano.json 의 차단 목록(절대 경로·** 패턴) */
  blocked: string[];
  /** 보관하지 않은 다른 미션들의 작업 폴더 (같은 폴더 경고용) */
  otherTargets: { id: string; name: string; target: string }[];
}

function gitBranch(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const b = String(stdout).trim();
      resolve(b || undefined);
    });
  });
}

async function findSecrets(root: string, blockedCheck: (p: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || seen >= MAX_ENTRIES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= MAX_ENTRIES) return;
      seen++;
      const full = path.join(dir, e.name);
      if (SECRET_NAMES.some((re) => re.test(e.name)) && !(e.isFile() && CODE_FILE.test(e.name))) {
        if (!blockedCheck(full)) found.push(full);
        continue; // 비밀로 보이는 폴더 안은 더 들어가지 않는다
      }
      // 심볼릭 링크는 따라가지 않는다
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
    }
  };
  await walk(root, 1);
  return found.sort();
}

export async function inspectFolder(
  ctx: InspectContext,
  absPath: string,
  purpose: 'target' | 'ref',
  zone: Zone = 'work',
): Promise<FolderInspection> {
  const input = resolveIn(ctx.config.rootDir, String(absPath ?? '').trim());
  const real = realOr(input);
  const out: FolderInspection = {
    path: real,
    display: shrinkHome(real),
    ok: false,
    problems: [],
    warnings: [],
    isGitRepo: false,
    ruleFiles: [],
    secretCandidates: [],
    deploysOnPush: false,
    deployHints: [],
  };
  if (!absPath || !String(absPath).trim()) {
    out.problems.push('폴더를 골라 주세요');
    return out;
  }
  try {
    const st = await stat(real);
    if (!st.isDirectory()) out.problems.push('파일이 아니라 폴더를 골라 주세요');
  } catch {
    out.problems.push('그 폴더를 찾을 수 없어요');
  }
  if (out.problems.length) return out;

  const root = zoneRoot(ctx.config, zone);
  const rootLabel = shrinkHome(root);
  const zoneLabel = zoneText(ctx.config)[zone].label;
  // 다른 구역 폴더도 차단으로 본다(개인 미션은 ~/work, 회사 미션은 ~/personal)
  const zoneDeny = ctx.config.zones?.[zone]?.denyRead ?? [];
  const blockedCheck = (p: string) => isBlockedPath({ ...ctx.config, blocked: [...ctx.blocked, ...zoneDeny] }, p);
  if (real === root) out.problems.push(`${rootLabel} 전체는 고를 수 없어요. 그 안의 폴더 하나를 골라 주세요`);
  else if (!isInside(real, root)) out.problems.push(`${zoneLabel} 구역은 ${rootLabel} 안의 폴더만 고를 수 있어요`);
  if (isInside(real, realOr(ctx.config.rootDir))) out.problems.push('라노 OS 폴더(~/rano)는 고를 수 없어요');
  if (!out.problems.length && blockedCheck(real)) out.problems.push('차단 목록에 걸린 폴더라 고를 수 없어요');
  if (out.problems.length) return out;

  if (purpose === 'target') {
    for (const o of ctx.otherTargets) {
      const t = realOr(o.target);
      if (t === real) out.warnings.push(`「${o.name}」 미션과 같은 폴더예요`);
      else if (isInside(real, t)) out.warnings.push(`「${o.name}」 미션의 작업 폴더 안에 있는 폴더예요`);
      else if (isInside(t, real)) out.warnings.push(`「${o.name}」 미션의 작업 폴더를 품고 있는 폴더예요`);
    }
  }

  out.isGitRepo = exists(path.join(real, '.git'));
  if (out.isGitRepo) out.branch = await gitBranch(real);
  else if (purpose === 'target') out.warnings.push('git 저장소가 아니라서 바뀐 내용을 되돌리기 어려울 수 있어요');

  out.ruleFiles = RULE_FILES.map((f) => path.join(real, f)).filter((f) => exists(f) && !blockedCheck(f));
  out.deployHints = DEPLOY_HINTS.filter((h) => exists(path.join(real, h)));
  out.deploysOnPush = out.deployHints.length > 0;
  // 배포 흔적은 deploysOnPush·deployHints 로만 알린다(warnings 에 겹쳐 넣지 않음)
  out.secretCandidates = await findSecrets(real, blockedCheck);

  out.ok = out.problems.length === 0;
  return out;
}
