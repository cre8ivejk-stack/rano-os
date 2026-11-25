// 파일 첨부 시험: 받을 수 있는 종류, 저장·이름, 라노에게 보내는 내용, 리더에게 넘기는 복사본, 안내 글.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachLabel, fileNoteForLeader, findAttachment, inputBlocks, saveAttachments, shareWithMission } from './attachments.js';
import { imageNote } from './ranoLanes.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('파일 첨부: 문서는 받고 실행 파일은 받지 않는다', () => {
  const runs = mkdtempSync(path.join(os.tmpdir(), 'att-'));
  const ok = saveAttachments(runs, [
    { name: '회의 메모.md', mime: 'text/markdown', data: b64('# 메모\n사과 3개') },
    { name: '표.xlsx', mime: '', data: b64('PK-not-really') },
    { name: '캡처.png', mime: 'image/png', data: PNG },
  ]);
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.deepEqual(ok.saved.map((a) => a.ext), ['md', 'xlsx', undefined]);
  assert.equal(attachLabel(ok.saved), '그림 1개·파일 2개');
  assert.equal(findAttachment(runs, ok.saved[1].id)?.name, '표.xlsx');
  for (const bad of ['run.sh', 'a.command', 'app.exe', '이름없음']) {
    const r = saveAttachments(runs, [{ name: bad, mime: '', data: b64('x') }]);
    assert.equal(r.ok, false, bad);
  }
});

test('파일 첨부: 라노에게는 글 파일·PDF 내용만 보내고, 리더에게는 원래 이름으로 복사한다', () => {
  const runs = mkdtempSync(path.join(os.tmpdir(), 'att-'));
  const r = saveAttachments(runs, [
    { name: '메모.txt', mime: 'text/plain', data: b64('사과 3개') },
    { name: '안내문.pdf', mime: 'application/pdf', data: b64('%PDF-1.4 x') },
    { name: '표 (최종).xlsx', mime: '', data: b64('PK') },
  ]);
  assert.ok(r.ok);
  if (!r.ok) return;
  const blocks = inputBlocks(runs, r.saved);
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'document']);
  assert.ok(blocks[0].type === 'text' && blocks[0].text.includes('사과 3개') && blocks[0].text.includes('메모.txt'));
  const note = imageNote(r.saved);
  assert.match(note, /파일 3개를 붙였어요/);
  assert.match(note, /표 \(최종\)\.xlsx 은\(는\) 네가 내용을 열 수 없는 종류/);
  assert.ok(!note.includes('그림'));
  const shared = shareWithMission(runs, 'm1', r.saved.map((a) => a.id));
  assert.equal(shared.files.length, 3);
  assert.equal(shared.images.length, 0);
  const x = shared.files.find((p) => p.endsWith('.xlsx'))!;
  assert.ok(path.basename(x).endsWith('-표 (최종).xlsx') && existsSync(x));
  assert.equal(readFileSync(x, 'utf-8'), 'PK');
  assert.ok(x.startsWith(path.join(runs, 'drafts', 'm1', '_attachments')));
  assert.match(fileNoteForLeader(shared.files), /\[첨부 파일\]/);
  assert.equal(fileNoteForLeader([]), '');
});

test('파일 첨부: 이름에 경로 글자가 있어도 폴더 밖으로 나가지 않는다', () => {
  const runs = mkdtempSync(path.join(os.tmpdir(), 'att-'));
  const r = saveAttachments(runs, [{ name: '../../밖.txt', mime: '', data: b64('x') }]);
  assert.ok(r.ok);
  if (!r.ok) return;
  const shared = shareWithMission(runs, 'm1', [r.saved[0].id]);
  assert.equal(path.dirname(shared.files[0]), path.join(runs, 'drafts', 'm1', '_attachments'));
});
