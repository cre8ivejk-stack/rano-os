// 지난 일 찾기: 머리말 [찾기] → 라노 대화·리더 대화·결과물·승인함을 한곳에서 찾는다.
import { el, formatWhen, renderRich } from './dom.js';
import { button } from './orgCommon.js';

const KIND: Record<SearchHit['kind'], string> = { rano: '라노 대화', leader: '리더 대화', output: '결과물', approval: '승인함' };

/** 찾은 낱말을 노랗게 칠한 글 조각 */
function highlight(text: string, terms: string[]): HTMLElement {
  const span = el('span', 'search-snippet');
  if (!terms.length) {
    span.textContent = text;
    return span;
  }
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  for (const part of text.split(re)) {
    if (!part) continue;
    if (terms.some((t) => t.toLowerCase() === part.toLowerCase())) span.appendChild(el('mark', undefined, part));
    else span.appendChild(document.createTextNode(part));
  }
  return span;
}

export class SearchButton {
  /** [가서 보기]를 눌렀을 때 */
  onGo: (hit: SearchHit) => void = () => {};

  constructor(host: HTMLElement) {
    const btn = el('button', 'acct-btn search-btn', '찾기');
    btn.type = 'button';
    btn.title = '지난 대화·보고·결과물·승인 찾기 (⌘F)';
    btn.addEventListener('click', () => this.open());
    host.appendChild(btn);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !document.querySelector('.search-modal')) {
        e.preventDefault();
        this.open();
      }
    });
  }

  open(): void {
    const overlay = el('div', 'org-modal-overlay');
    const box = el('div', 'org-modal search-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '지난 일 찾기');
    const head = el('div', 'search-head');
    const input = el('input', 'org-input search-input');
    input.placeholder = '찾을 낱말 (예: ETL 테스트, 메뉴 구조) — 띄어 쓴 낱말이 모두 들어간 것을 찾아요';
    input.setAttribute('aria-label', '찾을 낱말');
    const close = button('닫기', 'btn');
    head.append(input, close);
    const info = el('p', 'org-hint search-info', '라노 대화, 리더 대화, 결과물(보고·검수), 승인함 기록에서 찾아요.');
    const list = el('div', 'search-list');
    box.append(head, info, list);
    overlay.appendChild(box);

    const done = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done();
    };
    close.addEventListener('click', done);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done();
    });
    document.addEventListener('keydown', onKey, true);

    let seq = 0;
    let timer = 0;
    const run = async () => {
      const q = input.value.trim();
      const my = ++seq;
      if (!q) {
        list.replaceChildren();
        info.textContent = '라노 대화, 리더 대화, 결과물(보고·검수), 승인함 기록에서 찾아요.';
        return;
      }
      info.textContent = '찾는 중이에요…';
      let hits: SearchHit[] = [];
      try {
        hits = await window.rano.search(q);
      } catch {
        hits = [];
      }
      if (my !== seq) return;
      const terms = q.split(/\s+/).filter(Boolean);
      info.textContent = hits.length ? `${hits.length}개 찾았어요${hits.length >= 50 ? ' (최근 50개만 보여요)' : ''}` : '찾은 것이 없어요. 다른 낱말로 찾아보세요.';
      list.replaceChildren();
      for (const h of hits) {
        const item = el('article', 'search-item');
        const top = el('div', 'search-top');
        top.appendChild(el('span', `kind search-kind-${h.kind}`, KIND[h.kind]));
        top.appendChild(el('span', 'appr-meta', [h.who, h.at ? formatWhen(h.at) : ''].filter(Boolean).join(' · ')));
        item.appendChild(top);
        item.appendChild(el('p', 'search-title', h.title));
        item.appendChild(highlight(h.snippet, terms));
        const acts = el('div', 'search-acts');
        const more = button('펼쳐 보기', 'btn btn-small btn-plain');
        const full = el('div', 'search-full');
        full.hidden = true;
        more.addEventListener('click', () => {
          if (!full.childElementCount) renderRich(full, h.text);
          full.hidden = !full.hidden;
          more.textContent = full.hidden ? '펼쳐 보기' : '접기';
        });
        const go = button('가서 보기', 'btn btn-small');
        go.addEventListener('click', () => {
          done();
          this.onGo(h);
        });
        acts.append(more, go);
        item.append(acts, full);
        list.appendChild(item);
      }
    };
    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), 300);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        window.clearTimeout(timer);
        void run();
      }
    });
    document.body.appendChild(overlay);
    input.focus();
  }
}
