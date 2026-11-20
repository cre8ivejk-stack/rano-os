// 글 문서(.md) 보기 창 (0.9.19): 리더가 만든 마크다운 문서를 다른 프로그램으로 넘기지 않고 앱 안에서 꾸며 보여 준다.
// 제목·굵게·기울임·취소선·글자 속 코드·링크·목록(겹친 목록·체크 목록)·인용·표·코드 묶음·가로줄을 DOM 요소로 직접 만든다(HTML 을 끼워 넣지 않는다).
import { el } from './dom.js';

/** 글자 꾸밈: **굵게** · *기울임* · ~~취소선~~ · `코드` · [글](주소) · <br> */
export function mdInline(parent: HTMLElement, text: string): void {
  const re = /(`[^`\n]+`)|(\*\*\*[^*\n]+\*\*\*)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(!?\[[^\]\n]*\]\([^)\s]+(?:\s+"[^"]*")?\))|(<br\s*\/?>)|(\*[^*\s][^*\n]*\*)|((?<![A-Za-z0-9])_[^_\s][^_\n]*_(?![A-Za-z0-9]))|(<(https?:\/\/[^>\s]+)>)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (t: string) => {
    if (t) parent.appendChild(document.createTextNode(t.replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, '$1')));
  };
  while ((m = re.exec(text))) {
    plain(text.slice(last, m.index));
    last = m.index + m[0].length;
    const t = m[0];
    if (m[1]) parent.appendChild(el('code', 'doc-code-inline', t.slice(1, -1)));
    else if (m[2]) {
      const s = el('strong');
      const e = el('em');
      mdInline(e, t.slice(3, -3));
      s.appendChild(e);
      parent.appendChild(s);
    } else if (m[3] || m[4]) {
      const s = el('strong');
      mdInline(s, t.slice(2, -2));
      parent.appendChild(s);
    } else if (m[5]) {
      const s = el('del');
      mdInline(s, t.slice(2, -2));
      parent.appendChild(s);
    } else if (m[6]) {
      const mm = /^(!?)\[([^\]]*)\]\(([^)\s]+)/.exec(t)!;
      if (mm[1]) parent.appendChild(el('span', 'doc-img', `[그림: ${mm[2] || mm[3].split('/').pop() || ''}]`));
      else {
        const a = el('span', 'doc-link');
        mdInline(a, mm[2] || mm[3]);
        a.title = mm[3];
        parent.appendChild(a);
        if (/^https?:/i.test(mm[3]) && mm[2] && mm[2] !== mm[3]) parent.appendChild(el('span', 'doc-url', ` (${mm[3]})`));
      }
    } else if (m[7]) parent.appendChild(el('br'));
    else if (m[8] || m[9]) {
      const s = el('em');
      mdInline(s, t.slice(1, -1));
      parent.appendChild(s);
    } else if (m[10]) parent.appendChild(el('span', 'doc-link', m[11]));
  }
  plain(text.slice(last));
}

const cells = (row: string) => {
  let t = row.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};
const isSep = (row: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(row) && row.includes('-') && row.includes('|');
const isRow = (row: string) => row.includes('|') && row.trim().length > 1;
const indentOf = (line: string) => line.replace(/\t/g, '    ').match(/^ */)![0].length;
const LIST = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;

/** 마크다운 글을 문서 모양으로 그린다 */
export function renderMdDoc(container: HTMLElement, source: string): void {
  let text = source.replace(/\r\n?/g, '\n');
  // 맨 위 머리 정보(--- … ---)는 접어 둔다
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (fm && /^[\w가-힣 -]+:/m.test(fm[1])) {
    container.appendChild(el('pre', 'doc-front', fm[1]));
    text = text.slice(fm[0].length);
  }
  const lines = text.split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      const p = el('p', 'doc-p');
      para.forEach((l, k) => {
        if (k) p.appendChild(/ {2,}$|\\$/.test(para[k - 1]) ? el('br') : document.createTextNode(' '));
        mdInline(p, l.replace(/ {2,}$|\\$/, '').trim());
      });
      container.appendChild(p);
    }
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 코드 묶음
    const fence = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line);
    if (fence) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      const pre = el('pre', 'doc-code', buf.join('\n'));
      if (fence[2]) pre.dataset.lang = fence[2];
      container.appendChild(pre);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      // 주석은 보이지 않는다
      while (i < lines.length && !lines[i].includes('-->')) i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      container.appendChild(el('hr', 'doc-hr'));
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const tag = (`h${Math.min(h[1].length, 4)}`) as 'h1' | 'h2' | 'h3' | 'h4';
      const node = el(tag, `doc-h doc-h${h[1].length}`);
      mdInline(node, h[2]);
      container.appendChild(node);
      continue;
    }
    // 밑줄로 쓴 제목(제목\n=== · 제목\n---)
    if (para.length === 0 && i + 1 < lines.length && /^\s*(=+|-{2,})\s*$/.test(lines[i + 1]) && !isRow(line) && !LIST.test(line)) {
      const node = el(lines[i + 1].trim().startsWith('=') ? 'h1' : 'h2', `doc-h doc-h${lines[i + 1].trim().startsWith('=') ? 1 : 2}`);
      mdInline(node, line.trim());
      container.appendChild(node);
      i++;
      continue;
    }
    // 표
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const wrap = el('div', 'doc-table-wrap');
      const table = el('table', 'doc-table');
      const thead = el('thead');
      const htr = el('tr');
      head.forEach((c, k) => {
        const th = el('th');
        if (aligns[k]) th.style.textAlign = aligns[k];
        mdInline(th, c);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = el('tbody');
      while (i < lines.length && lines[i].trim() && isRow(lines[i])) {
        const row = cells(lines[i]);
        const tr = el('tr');
        for (let k = 0; k < head.length; k++) {
          const td = el('td');
          if (aligns[k]) td.style.textAlign = aligns[k];
          else if (/^[-+]?[\d,.]+\s*(%|원|kWh|곳|건|대|개|배)?$/.test(row[k] ?? '')) td.style.textAlign = 'right'; // 숫자 칸은 오른쪽으로
          mdInline(td, k === head.length - 1 ? row.slice(k).join(' | ') : (row[k] ?? ''));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i++;
      }
      i--;
      table.appendChild(tbody);
      wrap.appendChild(table);
      container.appendChild(wrap);
      continue;
    }
    // 인용
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (lines[i].trim() && buf.length && !LIST.test(lines[i]) && !/^\s*#/.test(lines[i])))) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      i--;
      const q = el('blockquote', 'doc-quote');
      renderMdDoc(q, buf.join('\n'));
      container.appendChild(q);
      continue;
    }
    // 목록(겹친 목록, 체크 목록, 이어지는 줄)
    if (LIST.test(line)) {
      flush();
      type Level = { indent: number; node: HTMLElement; li: HTMLElement | null };
      const stack: Level[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const lm = LIST.exec(cur);
        if (lm) {
          const indent = indentOf(cur);
          while (stack.length && indent < stack[stack.length - 1].indent - 1) stack.pop();
          let top = stack[stack.length - 1];
          const ordered = /\d/.test(lm[2]);
          if (!top || indent > top.indent + 1 || (stack.length === 1 && Math.abs(indent - top.indent) <= 1 && (top.node.tagName === 'OL') !== ordered)) {
            if (top && indent <= top.indent + 1) {
              // 같은 깊이에서 종류가 바뀜 → 새 목록
              stack.pop();
              top = stack[stack.length - 1];
            }
            const node = el(ordered ? 'ol' : 'ul', 'doc-list');
            if (ordered) (node as HTMLOListElement).start = Number.parseInt(lm[2], 10) || 1;
            (top?.li ?? container).appendChild(node);
            top = { indent, node, li: null };
            stack.push(top);
          }
          const li = el('li');
          const task = /^\[( |x|X)\]\s+(.*)$/.exec(lm[3]);
          if (task) {
            li.className = 'doc-task';
            li.appendChild(el('span', `doc-check${task[1] === ' ' ? '' : ' on'}`, task[1] === ' ' ? '' : '✓'));
            const s = el('span');
            mdInline(s, task[2]);
            li.appendChild(s);
          } else mdInline(li, lm[3]);
          top.node.appendChild(li);
          top.li = li;
          i++;
        } else if (cur.trim() && indentOf(cur) >= 2 && stack.length && stack[stack.length - 1].li && !/^\s*(```|~~~)/.test(cur)) {
          // 항목에 이어지는 줄
          const li = stack[stack.length - 1].li!;
          li.appendChild(el('br'));
          mdInline(li, cur.trim());
          i++;
        } else if (!cur.trim() && i + 1 < lines.length && (LIST.test(lines[i + 1]) || (lines[i + 1].trim() && indentOf(lines[i + 1]) >= 2))) {
          i++; // 항목 사이 빈 줄
        } else break;
      }
      i--;
      continue;
    }
    para.push(line);
  }
  flush();
}

export interface DocView {
  token: string;
  name: string;
  text: string;
  truncated?: boolean;
}

let open: { overlay: HTMLElement; onKey: (e: KeyboardEvent) => void } | null = null;

export function closeDoc(): void {
  if (!open) return;
  document.removeEventListener('keydown', open.onKey, true);
  open.overlay.remove();
  open = null;
}

/** 문서 보기 창을 띄운다. .md 는 꾸며서, 그 밖의 글은 글자 그대로 */
export function showDoc(doc: DocView): void {
  closeDoc();
  const overlay = el('div', 'doc-overlay');
  const box = el('div', 'doc-box');
  const head = el('div', 'doc-head');
  head.appendChild(el('span', 'doc-name', doc.name));
  const note = el('span', 'doc-note');
  const act = (label: string, title: string, a: 'save' | 'open' | 'reveal') => {
    const b = el('button', 'btn btn-small', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', () => {
      void window.rano
        .docAct(doc.token, a)
        .then((r) => {
          note.textContent = r?.message ?? (r?.ok ? '' : a === 'save' ? '' : '하지 못했어요');
        })
        .catch(() => (note.textContent = '하지 못했어요'));
    });
    return b;
  };
  const md = /\.(md|markdown)$/i.test(doc.name);
  let raw = false;
  const body = el('div', 'doc-body');
  const paint = () => {
    body.replaceChildren();
    body.classList.toggle('doc-raw', raw || !md);
    if (raw || !md) body.appendChild(el('pre', 'doc-plain', doc.text));
    else renderMdDoc(body, doc.text);
    if (doc.truncated) body.appendChild(el('p', 'doc-cut', '문서가 길어 앞부분만 보여요. 전체는 [다른 앱으로 열기]로 보세요.'));
  };
  const actions = el('div', 'doc-actions');
  actions.appendChild(note);
  if (md) {
    const toggle = el('button', 'btn btn-small', '원문 보기');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      raw = !raw;
      toggle.textContent = raw ? '꾸며 보기' : '원문 보기';
      paint();
    });
    actions.appendChild(toggle);
  }
  const copy = el('button', 'btn btn-small', '글 복사');
  copy.type = 'button';
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(doc.text).then(
      () => (note.textContent = '복사했어요'),
      () => (note.textContent = '복사하지 못했어요'),
    );
  });
  actions.append(copy, act('저장', '다운로드 폴더 등 원하는 곳에 사본을 저장해요', 'save'), act('다른 앱으로 열기', '이 맥의 기본 프로그램으로 열어요', 'open'), act('Finder', 'Finder 에서 이 파일을 보여 줘요', 'reveal'));
  const close = el('button', 'btn btn-small btn-confirm', '닫기');
  close.type = 'button';
  close.addEventListener('click', closeDoc);
  actions.appendChild(close);
  head.appendChild(actions);
  box.append(head, body);
  overlay.appendChild(box);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeDoc();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDoc();
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  open = { overlay, onKey };
  paint();
  body.scrollTop = 0;
}
