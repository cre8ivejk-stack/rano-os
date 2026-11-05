// 대화창 그림 첨부: 붙여 넣기(⌘V)·끌어다 놓기·📎 버튼. 보내기 전 미리보기와 지우기. 보낸 말풍선의 그림 보기.
import { el } from './dom.js';
import { annotateImage } from './annotate.js';

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX = 6;
const MAX_BYTES = 5 * 1024 * 1024;

interface Pending extends NewAttachment {
  url: string; // 미리보기 data URL
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export class ImageTray {
  private list: Pending[] = [];
  private tray = el('div', 'attach-tray');
  private note = el('p', 'attach-note');
  private fileInput = el('input');
  /** 그림이 바뀔 때 (보내기 버튼 상태를 다시 계산) */
  onChange: () => void = () => {};

  constructor(
    form: HTMLElement,
    input: HTMLTextAreaElement,
    dropZone: HTMLElement,
  ) {
    this.tray.hidden = true;
    this.note.hidden = true;
    form.before(this.tray);
    this.tray.after(this.note);
    this.fileInput.type = 'file';
    this.fileInput.accept = TYPES.join(',');
    this.fileInput.multiple = true;
    this.fileInput.hidden = true;
    const btn = el('button', 'attach-btn', '📎');
    btn.type = 'button';
    btn.title = '그림 붙이기 (캡처는 ⌘V 로 붙여 넣어도 돼요)';
    btn.setAttribute('aria-label', '그림 붙이기');
    btn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      void this.addFiles(Array.from(this.fileInput.files ?? []));
      this.fileInput.value = '';
    });
    form.prepend(btn, this.fileInput);

    input.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) {
        e.preventDefault();
        void this.addFiles(files);
      }
    });
    dropZone.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')) {
        e.preventDefault();
        dropZone.classList.add('drop-on');
      }
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop-on'));
    dropZone.addEventListener('drop', (e) => {
      dropZone.classList.remove('drop-on');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void this.addFiles(files);
    });
  }

  get count(): number {
    return this.list.length;
  }

  items(): NewAttachment[] {
    return this.list.map(({ name, mime, data, marked }) => ({ name, mime, data, ...(marked ? { marked: true } : {}) }));
  }

  clear(): void {
    this.list = [];
    this.say('');
    this.render();
  }

  /** 보내지 못했을 때 되돌려 놓기 */
  restore(items: NewAttachment[]): void {
    if (this.list.length) return;
    this.list = items.map((x) => ({ ...x, url: `data:${x.mime};base64,${x.data}` }));
    this.render();
  }

  private say(text: string): void {
    this.note.textContent = text;
    this.note.hidden = !text;
  }

  private async addFiles(files: File[]): Promise<void> {
    const problems: string[] = [];
    for (const f of files) {
      if (this.list.length >= MAX) {
        problems.push(`그림은 한 번에 ${MAX}개까지 붙일 수 있어요`);
        break;
      }
      if (!TYPES.includes(f.type)) {
        problems.push(`${f.name || '파일'}: PNG·JPG·GIF·WEBP 그림만 붙일 수 있어요`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        problems.push(`${f.name || '그림'}: 5MB 까지 붙일 수 있어요`);
        continue;
      }
      try {
        const url = await readAsDataUrl(f);
        const data = url.slice(url.indexOf(',') + 1);
        const name = f.name && f.name !== 'image.png' ? f.name : `캡처 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}.png`;
        this.list.push({ name, mime: f.type, data, url });
      } catch {
        problems.push(`${f.name || '그림'}: 읽지 못했어요`);
      }
    }
    if (problems.length) this.say(problems.join(" · "));
    this.render();
  }

  /** i 번째 그림에 표시하기 */
  private async mark(i: number): Promise<void> {
    const p = this.list[i];
    if (!p) return;
    const url = await annotateImage(p.url, p.name);
    if (!url || this.list[i] !== p) return;
    const mime = url.slice(5, url.indexOf(';'));
    const data = url.slice(url.indexOf(',') + 1);
    const base = p.name.replace(/\.(png|jpe?g|gif|webp)$/i, '').replace(/ \(표시함\)$/, '');
    this.list[i] = { name: `${base} (표시함).${mime === 'image/jpeg' ? 'jpg' : 'png'}`, mime, data, url, marked: true };
    this.render();
  }

  private render(): void {
    this.tray.replaceChildren();
    this.tray.hidden = !this.list.length;
    this.list.forEach((p, i) => {
      const item = el('div', 'attach-item');
      const img = el('img');
      img.src = p.url;
      img.alt = p.name;
      img.addEventListener('click', () => void this.mark(i));
      const pen = el('button', 'attach-pen', '✏️');
      pen.type = 'button';
      pen.title = '캡처에 표시하기 (펜·네모·화살표·번호)';
      pen.setAttribute('aria-label', `${p.name}에 표시하기`);
      pen.addEventListener('click', () => void this.mark(i));
      if (p.marked) item.appendChild(el('span', 'attach-marked', '표시함'));
      item.appendChild(pen);
      const del = el('button', 'attach-del', '×');
      del.type = 'button';
      del.setAttribute('aria-label', `${p.name} 빼기`);
      del.addEventListener('click', () => {
        this.list.splice(i, 1);
        this.render();
      });
      item.append(img, del);
      item.title = p.name;
      this.tray.appendChild(item);
    });
    this.onChange();
  }
}

/** 말풍선 아래 그림 미리보기. 누르면 크게 본다 */
export function messageImages(list: ChatAttachment[]): HTMLElement {
  const box = el('div', 'msg-images');
  for (const a of list) {
    const btn = el('button', 'msg-image');
    btn.type = 'button';
    btn.title = a.name;
    btn.setAttribute('aria-label', `${a.name} 크게 보기`);
    const img = el('img');
    img.alt = a.name;
    btn.appendChild(img);
    void window.rano.attachmentData(a).then((url) => {
      if (url) img.src = url;
      else btn.replaceChildren(el('span', 'msg-image-missing', '그림 없음'));
    });
    btn.addEventListener('click', () => {
      if (!img.src) return;
      const overlay = el('div', 'image-viewer');
      const big = el('img');
      big.src = img.src;
      big.alt = a.name;
      overlay.appendChild(big);
      overlay.appendChild(el('p', 'image-viewer-name', `${a.name} · 누르거나 Esc 로 닫기`));
      const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') close();
      };
      overlay.addEventListener('click', close);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
    });
    box.appendChild(btn);
  }
  return box;
}
