// 대화 첨부 그림(스크린 캡처 등): 데이터 폴더 runs/attachments/<id>.<확장자> 에 저장한다.
// 라노에게는 그림 자체를 함께 보내고, 리더에게 넘길 때는 그 미션의 시안 폴더(runs/drafts/<미션>/_attachments)로 복사해
// 그 미션의 리더·팀원만 읽게 한다.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatAttachment, NewAttachment } from '../../shared/types.js';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_ATTACHMENTS = 6;
export const MAX_BYTES = 5 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{12}$/;

function dir(runsDir: string): string {
  return path.join(runsDir, 'attachments');
}

function fileOf(runsDir: string, id: string, mime: string): string {
  return path.join(dir(runsDir), `${id}.${EXT[mime] ?? 'png'}`);
}

/** 화면에서 받은 그림들을 검사하고 저장한다. 하나라도 문제가 있으면 오류 문구를 돌려준다 */
export function saveAttachments(runsDir: string, items: NewAttachment[]): { ok: true; saved: ChatAttachment[] } | { ok: false; message: string } {
  if (!Array.isArray(items) || !items.length) return { ok: true, saved: [] };
  if (items.length > MAX_ATTACHMENTS) return { ok: false, message: `그림은 한 번에 ${MAX_ATTACHMENTS}개까지 보낼 수 있어요` };
  const decoded: { name: string; mime: string; buf: Buffer; marked: boolean }[] = [];
  for (const it of items) {
    const mime = String(it?.mime ?? '');
    if (!EXT[mime]) return { ok: false, message: 'PNG·JPG·GIF·WEBP 그림만 보낼 수 있어요' };
    const buf = Buffer.from(String(it?.data ?? ''), 'base64');
    if (!buf.length) return { ok: false, message: '그림을 읽지 못했어요' };
    if (buf.length > MAX_BYTES) return { ok: false, message: '그림 하나는 5MB 까지 보낼 수 있어요' };
    const name = String(it?.name ?? '그림').replace(/[\\/\n\r\t]/g, ' ').trim().slice(0, 80) || '그림';
    decoded.push({ name, mime, buf, marked: it?.marked === true });
  }
  mkdirSync(dir(runsDir), { recursive: true });
  const saved: ChatAttachment[] = [];
  for (const d of decoded) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    writeFileSync(fileOf(runsDir, id, d.mime), d.buf);
    saved.push({ id, name: d.name, mime: d.mime, ...(d.marked ? { marked: true } : {}) });
  }
  return { ok: true, saved };
}

/** 저장된 첨부 파일 경로 (없거나 이상한 id 면 null) */
export function attachmentFile(runsDir: string, a: Pick<ChatAttachment, 'id' | 'mime'>): string | null {
  if (!ID_RE.test(String(a?.id ?? '')) || !EXT[a.mime]) return null;
  const f = fileOf(runsDir, a.id, a.mime);
  return existsSync(f) ? f : null;
}

/** id 만으로 찾기 (확장자를 돌며) */
export function findAttachment(runsDir: string, id: string): ChatAttachment | null {
  if (!ID_RE.test(String(id ?? ''))) return null;
  for (const [mime, ext] of Object.entries(EXT)) {
    if (existsSync(path.join(dir(runsDir), `${id}.${ext}`))) return { id, name: id, mime };
  }
  return null;
}

/** 화면 미리보기용 data URL */
export function attachmentDataUrl(runsDir: string, a: Pick<ChatAttachment, 'id' | 'mime'>): string | null {
  const f = attachmentFile(runsDir, a);
  if (!f) return null;
  return `data:${a.mime};base64,${readFileSync(f).toString('base64')}`;
}

/** 라노에게 보낼 그림 블록 */
export function imageBlocks(runsDir: string, list: ChatAttachment[]): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }[] {
  const out: { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }[] = [];
  for (const a of list) {
    const f = attachmentFile(runsDir, a);
    if (f) out.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: readFileSync(f).toString('base64') } });
  }
  return out;
}

/** 리더에게 넘길 그림을 그 미션 시안 폴더로 복사하고 절대 경로를 돌려준다 */
export function shareWithMission(runsDir: string, missionId: string, ids: string[]): { paths: string[]; missing: string[] } {
  const target = path.join(runsDir, 'drafts', missionId, '_attachments');
  const paths: string[] = [];
  const missing: string[] = [];
  for (const id of ids.slice(0, MAX_ATTACHMENTS)) {
    const a = findAttachment(runsDir, id);
    const src = a ? attachmentFile(runsDir, a) : null;
    if (!a || !src) {
      missing.push(id);
      continue;
    }
    mkdirSync(target, { recursive: true });
    const dst = path.join(target, path.basename(src));
    if (!existsSync(dst)) copyFileSync(src, dst);
    paths.push(dst);
  }
  return { paths, missing };
}
