// 대화 첨부(그림·파일): 데이터 폴더 runs/attachments/<id>.<확장자> 에 저장한다(원래 이름은 <id>.name 에).
// 라노에게는 그림·PDF·글 파일의 내용을 함께 보내고, 리더에게 넘길 때는 그 미션의 시안 폴더(runs/drafts/<미션>/_attachments)로 복사해
// 그 미션의 리더·팀원만 읽게 한다.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatAttachment, NewAttachment } from '../../shared/types.js';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** 붙일 수 있는 파일 종류(확장자). 실행 파일·스크립트는 받지 않는다 */
export const FILE_EXTS = ['pdf', 'xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'docx', 'doc', 'pptx', 'ppt', 'hwp', 'hwpx', 'txt', 'md', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log', 'zip', 'eml', 'msg'];
/** 라노에게 내용을 글로 함께 보내는 종류 */
const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log']);
export const MAX_ATTACHMENTS = 6;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PDF_TO_RANO_MAX = 8 * 1024 * 1024; // 이보다 큰 PDF 는 라노에게 내용을 보내지 않는다(리더가 읽는다)
const TEXT_TO_RANO_MAX = 30_000; // 글 파일은 이만큼(글자)만 라노에게 보낸다
const ID_RE = /^[a-f0-9]{12}$/;

function dir(runsDir: string): string {
  return path.join(runsDir, 'attachments');
}

/** 파일 이름의 확장자(소문자, 점 없음) */
export function extOfName(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name ?? '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** 그림인지 (그림이 아니면 파일) */
export function isImage(a: Pick<ChatAttachment, 'mime'>): boolean {
  return !!EXT[a.mime];
}

/** 저장할 때 쓰는 확장자: 그림은 종류로, 파일은 받을 수 있는 확장자일 때만 */
function storeExt(a: { mime: string; ext?: string }): string | null {
  if (EXT[a.mime]) return EXT[a.mime];
  const e = String(a.ext ?? '').toLowerCase();
  return FILE_EXTS.includes(e) ? e : null;
}

/** "그림 2개·파일 1개" 같은 짧은 말 */
export function attachLabel(list: Pick<ChatAttachment, 'mime'>[]): string {
  const pics = list.filter((a) => isImage(a)).length;
  const files = list.length - pics;
  return [pics ? `그림 ${pics}개` : '', files ? `파일 ${files}개` : ''].filter(Boolean).join('·');
}

/** 화면에서 받은 그림·파일을 검사하고 저장한다. 하나라도 문제가 있으면 오류 문구를 돌려준다 */
export function saveAttachments(runsDir: string, items: NewAttachment[]): { ok: true; saved: ChatAttachment[] } | { ok: false; message: string } {
  if (!Array.isArray(items) || !items.length) return { ok: true, saved: [] };
  if (items.length > MAX_ATTACHMENTS) return { ok: false, message: `그림·파일은 한 번에 ${MAX_ATTACHMENTS}개까지 보낼 수 있어요` };
  const decoded: { name: string; mime: string; ext: string; image: boolean; buf: Buffer; marked: boolean }[] = [];
  for (const it of items) {
    const mime = String(it?.mime ?? '');
    const name = String(it?.name ?? '').replace(/[\\/\n\r\t]/g, ' ').trim().slice(0, 80) || (EXT[mime] ? '그림' : '파일');
    const image = !!EXT[mime];
    const ext = image ? EXT[mime] : extOfName(name);
    if (!image && !FILE_EXTS.includes(ext)) return { ok: false, message: `${name}: 이 종류의 파일은 보낼 수 없어요 (그림, PDF, 엑셀, 워드, 한글, 파워포인트, 글 파일, zip 을 보낼 수 있어요)` };
    const buf = Buffer.from(String(it?.data ?? ''), 'base64');
    if (!buf.length) return { ok: false, message: `${name}: 읽지 못했어요 (빈 파일일 수 있어요)` };
    if (image && buf.length > MAX_BYTES) return { ok: false, message: '그림 하나는 5MB 까지 보낼 수 있어요' };
    if (!image && buf.length > MAX_FILE_BYTES) return { ok: false, message: `${name}: 파일 하나는 20MB 까지 보낼 수 있어요` };
    decoded.push({ name, mime: image ? mime : mime || 'application/octet-stream', ext, image, buf, marked: it?.marked === true });
  }
  mkdirSync(dir(runsDir), { recursive: true });
  const saved: ChatAttachment[] = [];
  for (const d of decoded) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    writeFileSync(path.join(dir(runsDir), `${id}.${d.ext}`), d.buf);
    if (!d.image) writeFileSync(path.join(dir(runsDir), `${id}.name`), d.name, 'utf-8');
    saved.push({ id, name: d.name, mime: d.mime, ...(d.image ? {} : { ext: d.ext, size: d.buf.length }), ...(d.marked ? { marked: true } : {}) });
  }
  return { ok: true, saved };
}

/** 저장된 첨부 파일 경로 (없거나 이상한 id 면 null) */
export function attachmentFile(runsDir: string, a: Pick<ChatAttachment, 'id' | 'mime' | 'ext'>): string | null {
  const ext = storeExt(a);
  if (!ID_RE.test(String(a?.id ?? '')) || !ext) return null;
  const f = path.join(dir(runsDir), `${a.id}.${ext}`);
  return existsSync(f) ? f : null;
}

/** id 만으로 찾기 (저장 폴더에서 그 id 의 파일을 찾는다. 파일이면 원래 이름도 함께) */
export function findAttachment(runsDir: string, id: string): ChatAttachment | null {
  if (!ID_RE.test(String(id ?? ''))) return null;
  let names: string[] = [];
  try {
    names = readdirSync(dir(runsDir)).filter((n) => n.startsWith(`${id}.`) && !n.endsWith('.name'));
  } catch {
    return null;
  }
  for (const n of names) {
    const ext = n.slice(id.length + 1);
    if (IMAGE_MIME[ext]) return { id, name: id, mime: IMAGE_MIME[ext] };
    if (FILE_EXTS.includes(ext)) {
      let name = `${id}.${ext}`;
      try {
        name = readFileSync(path.join(dir(runsDir), `${id}.name`), 'utf-8').trim() || name;
      } catch {
        // 이름 기록이 없으면 id 로
      }
      return { id, name, mime: 'application/octet-stream', ext };
    }
  }
  return null;
}

/** 화면 미리보기용 data URL (그림만) */
export function attachmentDataUrl(runsDir: string, a: Pick<ChatAttachment, 'id' | 'mime'>): string | null {
  if (!isImage(a)) return null;
  const f = attachmentFile(runsDir, a);
  if (!f) return null;
  return `data:${a.mime};base64,${readFileSync(f).toString('base64')}`;
}

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type DocBlock = { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };
type TextBlock = { type: 'text'; text: string };

/** 라노가 내용을 직접 볼 수 있는 첨부인지: 그림, 크지 않은 PDF, 글 파일 */
export function ranoCanSee(a: Pick<ChatAttachment, 'mime' | 'ext' | 'size'>): boolean {
  if (isImage(a)) return true;
  if (a.ext === 'pdf') return (a.size ?? 0) <= PDF_TO_RANO_MAX;
  return TEXT_EXTS.has(String(a.ext ?? ''));
}

/** 라노에게 보낼 내용 블록: 그림은 그림으로, PDF 는 문서로, 글 파일은 글로. 그 밖의 파일(엑셀·워드 등)은 넣지 않는다 */
export function inputBlocks(runsDir: string, list: ChatAttachment[]): (ImageBlock | DocBlock | TextBlock)[] {
  const out: (ImageBlock | DocBlock | TextBlock)[] = [];
  for (const a of list) {
    const f = attachmentFile(runsDir, a);
    if (!f) continue;
    if (isImage(a)) out.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: readFileSync(f).toString('base64') } });
    else if (a.ext === 'pdf') {
      const buf = readFileSync(f);
      if (buf.length <= PDF_TO_RANO_MAX) out.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: a.name });
    } else if (TEXT_EXTS.has(String(a.ext ?? ''))) {
      const buf = readFileSync(f);
      if (buf.subarray(0, 4096).includes(0)) continue; // 글이 아닌 파일
      const all = buf.toString('utf-8');
      const cut = all.length > TEXT_TO_RANO_MAX;
      out.push({ type: 'text', text: `[첨부 파일 "${a.name}" (id ${a.id}) 내용${cut ? `, 앞 ${TEXT_TO_RANO_MAX}자만` : ''}]\n${all.slice(0, TEXT_TO_RANO_MAX)}\n[첨부 파일 "${a.name}" 끝]` });
    }
  }
  return out;
}

/** 리더에게 넘길 그림·파일을 그 미션 시안 폴더로 복사하고 절대 경로를 돌려준다(그림과 파일을 나눠서도) */
export function shareWithMission(runsDir: string, missionId: string, ids: string[]): { paths: string[]; images: string[]; files: string[]; missing: string[] } {
  const target = path.join(runsDir, 'drafts', missionId, '_attachments');
  const images: string[] = [];
  const files: string[] = [];
  const missing: string[] = [];
  for (const id of ids.slice(0, MAX_ATTACHMENTS)) {
    const a = findAttachment(runsDir, id);
    const src = a ? attachmentFile(runsDir, a) : null;
    if (!a || !src) {
      missing.push(id);
      continue;
    }
    mkdirSync(target, { recursive: true });
    // 파일은 원래 이름을 살려 둔다(리더가 무슨 파일인지 알게). 앞에 id 6자를 붙여 겹치지 않게
    const safe = a.name.replace(/[^\p{L}\p{N}._ ()\-]/gu, '_').replace(/^\.+/, '').slice(0, 70);
    const dst = path.join(target, isImage(a) ? path.basename(src) : `${id.slice(0, 6)}-${safe.toLowerCase().endsWith(`.${a.ext}`) ? safe : `${safe}.${a.ext}`}`);
    if (!existsSync(dst)) copyFileSync(src, dst);
    (isImage(a) ? images : files).push(dst);
  }
  return { paths: [...images, ...files], images, files, missing };
}

/** 리더 지시에 붙이는 첨부 파일 안내(파일이 없으면 빈 글) */
export function fileNoteForLeader(files: string[]): string {
  if (!files.length) return '';
  return `\n\n[첨부 파일] 사용자가 붙인 파일이에요. 열어서 내용을 확인하고 과제에 쓰세요(팀원에게도 이 경로를 넘기세요). 이 복사본은 읽기만 하고, 고친 판이 필요하면 결과 폴더에 새로 만드세요:\n${files.map((p) => `- ${p}`).join('\n')}`;
}
