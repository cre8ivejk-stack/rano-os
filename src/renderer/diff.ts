// 승인함 비교 보기: 파일이 바뀌기 전·후를 줄 단위로 비교해 지운 줄은 빨강, 더한 줄은 초록으로 보여 준다.
// "한 줄로 보기"(위아래로 섞어서)와 "나란히 보기"(왼쪽 전, 오른쪽 후)를 고를 수 있다. 바뀌지 않은 긴 구간은 접는다.
import { el } from './dom.js';

type Op = { t: 'same' | 'del' | 'add'; a?: number; b?: number; text: string }; // a·b = 줄 번호(1부터)

const CONTEXT = 3; // 바뀐 곳 앞뒤로 보여 줄 줄 수
const DP_LIMIT = 4_000_000; // 이보다 크면 단순 비교(앞뒤 같은 부분만 맞춤)

export function lineDiff(beforeText: string, afterText: string): Op[] {
  // 끝의 줄바꿈 하나는 빈 줄로 세지 않는다
  const lines = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const A = lines(beforeText);
  const B = lines(afterText);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: 'same', a: i + 1, b: i + 1, text: A[i] });
  if (a.length * b.length <= DP_LIMIT) {
    // 가장 긴 공통 줄(LCS)
    const n = a.length;
    const m = b.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        ops.push({ t: 'same', a: pre + i + 1, b: pre + j + 1, text: a[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        // 지운 줄을 먼저 보여 준다
        ops.push({ t: 'del', a: pre + i + 1, text: a[i] });
        i++;
      } else {
        ops.push({ t: 'add', b: pre + j + 1, text: b[j] });
        j++;
      }
    }
  } else {
    a.forEach((text, i) => ops.push({ t: 'del', a: pre + i + 1, text }));
    b.forEach((text, j) => ops.push({ t: 'add', b: pre + j + 1, text }));
  }
  for (let k = 0; k < suf; k++) ops.push({ t: 'same', a: A.length - suf + k + 1, b: B.length - suf + k + 1, text: A[A.length - suf + k] });
  return ops;
}

/** 바뀐 곳 주변만 남기고 같은 줄 묶음은 접는다 */
function hunks(ops: Op[]): (Op | { t: 'fold'; ops: Op[] })[] {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t !== 'same') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const out: (Op | { t: 'fold'; ops: Op[] })[] = [];
  let run: Op[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length <= 2) out.push(...run);
    else out.push({ t: 'fold', ops: run });
    run = [];
  };
  ops.forEach((o, i) => {
    if (keep[i]) {
      flush();
      out.push(o);
    } else run.push(o);
  });
  flush();
  return out;
}

function num(n?: number): HTMLElement {
  return el('span', 'df-num', n ? String(n) : '');
}

function unified(ops: Op[]): HTMLElement {
  const box = el('div', 'df-body df-unified');
  const draw = (o: Op) => {
    const row = el('div', `df-row df-${o.t}`);
    row.append(num(o.a), num(o.b), el('span', 'df-mark', o.t === 'add' ? '+' : o.t === 'del' ? '−' : ''), el('span', 'df-text', o.text || ' '));
    box.appendChild(row);
  };
  for (const h of hunks(ops)) {
    if (h.t === 'fold') {
      const f = el('button', 'df-fold', `바뀌지 않은 ${h.ops.length}줄 펼치기`);
      f.type = 'button';
      f.addEventListener('click', () => {
        const frag = document.createDocumentFragment();
        const tmp = el('div');
        for (const o of h.ops) {
          const row = el('div', `df-row df-same`);
          row.append(num(o.a), num(o.b), el('span', 'df-mark', ''), el('span', 'df-text', o.text || ' '));
          tmp.appendChild(row);
        }
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        f.replaceWith(frag);
      });
      box.appendChild(f);
    } else draw(h);
  }
  return box;
}

function sideBySide(ops: Op[]): HTMLElement {
  const box = el('div', 'df-body df-split');
  const cell = (o: Op | null, side: 'a' | 'b') => {
    const c = el('div', `df-cell ${o ? `df-${o.t}` : 'df-empty'}`);
    c.append(num(o ? (side === 'a' ? o.a : o.b) : undefined), el('span', 'df-text', o ? o.text || ' ' : ''));
    return c;
  };
  const row = (l: Op | null, r: Op | null) => {
    const line = el('div', 'df-srow');
    line.append(cell(l, 'a'), cell(r, 'b'));
    box.appendChild(line);
  };
  const items = hunks(ops);
  for (let i = 0; i < items.length; i++) {
    const h = items[i];
    if (h.t === 'fold') {
      const f = el('button', 'df-fold', `바뀌지 않은 ${h.ops.length}줄 (나란히 보기에서는 접어 둠)`);
      f.type = 'button';
      f.disabled = true;
      box.appendChild(f);
      continue;
    }
    if (h.t === 'same') {
      row(h, h);
      continue;
    }
    // 지운 줄 묶음과 더한 줄 묶음을 옆으로 짝짓는다
    const dels: Op[] = [];
    const adds: Op[] = [];
    while (i < items.length && (items[i] as Op).t !== 'same' && items[i].t !== 'fold') {
      const o = items[i] as Op;
      (o.t === 'del' ? dels : adds).push(o);
      i++;
    }
    i--;
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) row(dels[k] ?? null, adds[k] ?? null);
  }
  return box;
}

/** 승인 카드에 넣을 비교 상자 */
export function changeView(c: FileChange): HTMLElement {
  const wrap = el('div', 'df');
  const ops = lineDiff(c.before, c.after);
  const added = ops.filter((o) => o.t === 'add').length;
  const removed = ops.filter((o) => o.t === 'del').length;
  const head = el('div', 'df-head');
  head.appendChild(el('strong', undefined, c.isNew ? '새 파일' : '바뀌는 부분'));
  head.appendChild(el('span', 'df-add-count', `+${added}줄`));
  if (!c.isNew) head.appendChild(el('span', 'df-del-count', `−${removed}줄`));
  if (!added && !removed) head.appendChild(el('span', 'df-note', '내용이 같아요'));
  const tabs = el('span', 'df-tabs');
  const uBtn = el('button', 'df-tab on', '한 줄로 보기');
  const sBtn = el('button', 'df-tab', '나란히 보기');
  uBtn.type = sBtn.type = 'button';
  tabs.append(uBtn, sBtn);
  if (!c.isNew) head.appendChild(tabs);
  wrap.appendChild(head);
  if (c.truncated) wrap.appendChild(el('p', 'df-note', '파일이 커서 앞부분만 비교해요.'));
  let body = unified(ops);
  wrap.appendChild(body);
  const show = (split: boolean) => {
    const next = split ? sideBySide(ops) : unified(ops);
    body.replaceWith(next);
    body = next;
    uBtn.classList.toggle('on', !split);
    sBtn.classList.toggle('on', split);
  };
  uBtn.addEventListener('click', () => show(false));
  sBtn.addEventListener('click', () => show(true));
  return wrap;
}
