// 결정 카드의 [시안 열기] 안전 확인. 맥의 다른 프로그램(브라우저·미리보기 등)에 넘기기 전에 매번 다시 본다.
// - 승인 기록의 미션·과제로 그 과제의 시안 폴더(runs/drafts/<미션>/<과제>)를 다시 계산한다. 과제 정보를 확인할 수 없으면(옛 카드·이상한 이름) 열지 않는다
// - 링크를 푼 실제 경로가 그 시안 폴더 안이어야 한다(바로가기로 밖을 가리키면 열지 않음)
// - 보통 파일이어야 한다(폴더·.app 같은 묶음은 열지 않음)
// - 확장자(소문자로 바꿔서)가 허용 목록에 있어야 한다
// - 실행 권한이 붙어 있으면 열지 않는다
// 확인을 마친 실제 경로를 그대로 돌려주고, 여는 쪽은 그 경로만 연다.
// 남는 빈틈: 확인한 순간과 실제로 열리는 순간 사이(아주 짧음)의 바꿔치기는 막지 못한다.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** 열어도 되는 시안 형식(웹 문서·그림·PDF·글·표·오피스 문서). 매크로가 든 오피스 형식(.docm 등)은 넣지 않는다 */
export const PREVIEW_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf',
  '.txt', '.md', '.csv', '.json', '.rtf', '.docx', '.xlsx', '.pptx',
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 승인 기록의 미션·과제로 그 과제의 시안 폴더를 계산한다. 과제 정보가 없거나 모양이 이상하면 null */
export function taskDraftsDir(runsDir: string, missionId: unknown, taskId: unknown): string | null {
  if (typeof missionId !== 'string' || typeof taskId !== 'string') return null;
  if (!ID_RE.test(missionId) || !ID_RE.test(taskId) || missionId.includes('..') || taskId.includes('..')) return null;
  return path.join(runsDir, 'drafts', missionId, taskId);
}

export type PreviewCheck =
  | { ok: true; path: string } // 열어도 되는 실제 경로
  | { ok: false; message: string; reveal?: string }; // reveal: [폴더에서 보기]로 보여 줄 위치(실행하지 않음)

function inside(p: string, dir: string): boolean {
  return p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** 막혔을 때 Finder 에서 보여 줄 위치: 파일(또는 바로가기 자체)이 시안 폴더 안에 있으면 그것, 아니면 시안 폴더 */
function revealFor(file: string, realDir: string): string {
  try {
    const parent = realpathSync.native(path.dirname(file));
    if (parent === realDir || inside(parent, realDir)) return path.join(parent, path.basename(file));
  } catch {
    // 부모 폴더가 없으면 시안 폴더를 보여 준다
  }
  return realDir;
}

/** 시안 파일을 열어도 되는지 확인한다. draftsDir 는 taskDraftsDir 로 계산한 그 과제의 시안 폴더 */
export function checkPreviewFile(file: unknown, draftsDir: string | null): PreviewCheck {
  // 과제 정보가 없는 옛 카드이거나, 미션·과제 이름 모양이 이상해 시안 폴더를 계산하지 못한 경우
  if (!draftsDir) return { ok: false, message: '과제 정보를 확인할 수 없어 안전을 위해 시안을 열지 않아요' };
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, message: '시안 파일을 찾지 못했어요' };
  let realDir: string;
  try {
    realDir = realpathSync.native(draftsDir);
  } catch {
    return { ok: false, message: '이 과제의 시안 폴더를 찾지 못했어요' };
  }
  let real: string;
  try {
    real = realpathSync.native(file);
  } catch {
    return { ok: false, message: '시안 파일을 찾지 못했어요' };
  }
  const reveal = revealFor(file, realDir);
  if (!inside(real, realDir)) {
    return { ok: false, message: '이 시안은 이 과제의 시안 폴더 밖에 있거나 밖을 가리키는 바로가기라서 안전을 위해 열지 않아요', reveal };
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, message: '시안 파일을 찾지 못했어요' };
  }
  if (!st.isFile()) return { ok: false, message: '폴더나 앱 묶음(.app 등)은 안전을 위해 열지 않아요', reveal };
  const ext = path.extname(real).toLowerCase();
  if (!PREVIEW_EXTS.has(ext)) {
    return { ok: false, message: `이 형식(${ext || '확장자 없음'})은 안전을 위해 열지 않아요`, reveal };
  }
  if ((st.mode & 0o111) !== 0) return { ok: false, message: '실행 권한이 붙은 파일이라 안전을 위해 열지 않아요', reveal };
  return { ok: true, path: real };
}
