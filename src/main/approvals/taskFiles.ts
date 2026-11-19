// 과제 결과 파일(runs/drafts/<미션>/<과제>): 리더가 만든 엑셀·문서·메일 초안 등을 화면에서 바로 보고, 저장하고, 열 수 있게 한다 (0.9.18).
// 전에는 라노가 폴더 경로를 알려 주고 사용자가 Finder 에서 찾아 들어가야 했다.
import { readdirSync, statSync } from 'node:fs';
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
