// 과제 결과 파일(runs/drafts/<미션>/<과제>): 리더가 만든 엑셀·문서·메일 초안 등을 화면에서 바로 보고, 저장하고, 열 수 있게 한다 (0.9.18).
// 전에는 라노가 폴더 경로를 알려 주고 사용자가 Finder 에서 찾아 들어가야 했다.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { TaskFile } from '../../shared/types.js';

/** 목록에서 빼는 것: 리더·팀원끼리 쓰는 인수 메모, 만드는 데 쓴 스크립트 */
const WORK_ONLY = new Set(['.py', '.js', '.cjs', '.mjs', '.ts', '.sh', '.sql', '.log', '.tmp']);
const HIDE_NAMES = new Set(['인수메모.md']);
const KIND: Record<string, TaskFile['kind']> = {
  '.xlsx': 'sheet', '.csv': 'sheet', '.docx': 'doc', '.pptx': 'doc', '.pdf': 'doc', '.rtf': 'doc',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.html': 'web', '.htm': 'web',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 그 과제의 결과 폴더. 과제 id 는 온전한 꼴만 받는다 */
export function findTaskDir(runsDir: string, taskId: unknown): string | null {
  if (typeof taskId !== 'string' || !UUID.test(taskId)) return null;
  const root = path.join(runsDir, 'drafts');
  let missions: string[] = [];
  try {
    missions = readdirSync(root);
  } catch {
    return null;
  }
  for (const m of missions) {
    const dir = path.join(root, m, taskId);
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // 다음 미션 폴더를 본다
    }
  }
  return null;
}

/** 결과 폴더의 파일 목록(문서·표·그림·글). 숨김 파일·바로가기·스크립트·인수 메모는 뺀다. 두 단계 아래까지, 40개까지 */
export function listTaskFiles(dir: string | null): TaskFile[] {
  if (!dir) return [];
  const out: TaskFile[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 40) return;
      if (e.name.startsWith('.') || e.name.startsWith('~$') || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && !e.name.endsWith('.app')) walk(p, depth + 1);
        continue;
      }
      if (!e.isFile() || HIDE_NAMES.has(e.name)) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (WORK_ONLY.has(ext)) continue;
      let size = 0;
      let at = '';
      try {
        const st = statSync(p);
        size = st.size;
        at = st.mtime.toISOString();
      } catch {
        continue;
      }
      out.push({ rel: path.relative(dir, p), name: e.name, size, at, kind: KIND[ext] ?? 'other' });
    }
  };
  walk(dir, 0);
  const rank: Record<TaskFile['kind'], number> = { sheet: 0, doc: 0, web: 1, image: 1, text: 2, other: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name, 'ko'));
}

/** 목록에 있는 파일의 절대 경로. 목록에 없는 이름(폴더 밖·숨긴 파일)은 null */
export function taskFilePath(dir: string | null, rel: unknown): string | null {
  if (!dir || typeof rel !== 'string') return null;
  const hit = listTaskFiles(dir).find((f) => f.rel === rel);
  return hit ? path.join(dir, hit.rel) : null;
}

/** 과제 id 앞 8자 이상으로 결과 폴더를 찾는다(온전한 id 도 됨). 둘 이상 걸리면 null */
export function findTaskDirByPrefix(runsDir: string, idOrPrefix: unknown): { dir: string; taskId: string; missionId: string } | null {
  if (typeof idOrPrefix !== 'string' || !/^[0-9a-f-]{8,36}$/.test(idOrPrefix)) return null;
  const root = path.join(runsDir, 'drafts');
  const hits: { dir: string; taskId: string; missionId: string }[] = [];
  let missions: string[] = [];
  try {
    missions = readdirSync(root);
  } catch {
    return null;
  }
  for (const m of missions) {
    let names: string[] = [];
    try {
      names = readdirSync(path.join(root, m));
    } catch {
      continue;
    }
    for (const n of names) if (UUID.test(n) && n.startsWith(idOrPrefix)) hits.push({ dir: path.join(root, m, n), taskId: n, missionId: m });
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 다른 과제의 결과 파일을 받는 미션의 시안 폴더(runs/drafts/<미션>/_received/<과제 앞 8자>)로 복사한다 (0.9.19).
 * 미션끼리는 서로의 결과 폴더를 읽지 못해서, 라노가 맡길 때 앱이 넘겨 준다. 화면의 "결과 파일" 목록에 보이는 파일만(스크립트·인수 메모·숨김 파일 제외).
 */
export function shareTaskFiles(runsDir: string, toMissionId: string, idOrPrefix: string): { ok: boolean; paths: string[]; note: string } {
  const src = findTaskDirByPrefix(runsDir, idOrPrefix);
  if (!src) return { ok: false, paths: [], note: `과제 "${idOrPrefix}" 의 결과 폴더를 찾지 못했어요. 리더 보고에 적힌 과제 id 를 확인하세요.` };
  const files = listTaskFiles(src.dir);
  if (!files.length) return { ok: false, paths: [], note: `과제 ${src.taskId.slice(0, 8)} 의 결과 폴더에 넘길 파일이 없어요.` };
  if (src.missionId === toMissionId) return { ok: true, paths: files.map((f) => path.join(src.dir, f.rel)), note: '' }; // 같은 미션은 그대로 읽을 수 있다
  const target = path.join(runsDir, 'drafts', toMissionId, '_received', src.taskId.slice(0, 8));
  const paths: string[] = [];
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) continue;
    const dst = path.join(target, f.rel);
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(path.join(src.dir, f.rel), dst);
      paths.push(dst);
    } catch {
      // 못 옮긴 파일은 건너뛴다
    }
  }
  return paths.length ? { ok: true, paths, note: '' } : { ok: false, paths: [], note: '결과 파일을 복사하지 못했어요.' };
}
