// 사용 가이드: 머리말 [가이드] → 앱에 같이 넣은 GUIDE.md 를 목차와 함께 보여 준다(인터넷 없이 열림).
// 글은 모두 textContent 로 넣는다(renderRich).
import { el, renderRich } from './dom.js';

const SHOW_AFTER_SETUP = 'rano.showGuideAfterSetup';

/** 처음 설정을 마치면 앱이 다시 켜진 뒤 가이드를 한 번 연다 */
export function markGuideAfterSetup(): void {
  try {
    localStorage.setItem(SHOW_AFTER_SETUP, '1');
  } catch {
    // 무시
  }
}

export function openGuideIfMarked(): void {
  try {
    if (localStorage.getItem(SHOW_AFTER_SETUP) !== '1') return;
    localStorage.removeItem(SHOW_AFTER_SETUP);
  } catch {
    return;
  }
  void openGuide();
}

/** GitHub 용 글을 앱 화면에 맞게 다듬는다: 목차 링크 줄 빼기, [글](주소) → 글, `코드` → 코드, > 인용 표시 빼기 */
function tidy(md: string): string {
  return md
    .split('\n')
    .filter((l) => !/^\s*-\s*\[[^\]]+\]\(#[^)]*\)\s*$/.test(l))
    .map((l) => l.replace(/^\s*>\s?/, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1').replace(/`([^`]+)`/g, '$1'))
    .join('\n');
}

interface Section {
  title: string;
  body: string;
}

function split(md: string): { intro: string; sections: Section[] } {
  const parts = md.split(/^## /m);
  const intro = parts.shift() ?? '';
  return {
    intro,
    sections: parts.map((p) => {
      const nl = p.indexOf('\n');
      return { title: (nl < 0 ? p : p.slice(0, nl)).trim(), body: nl < 0 ? '' : p.slice(nl + 1) };
    }),
  };
}

export async function openGuide(): Promise<void> {
  if (document.querySelector('.guide-modal')) return;
  const overlay = el('div', 'org-modal-overlay');
  const box = el('div', 'org-modal guide-modal');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '사용 가이드');
  box.appendChild(el('h3', 'org-modal-title', '사용 가이드'));
  const wrap = el('div', 'guide-wrap');
  const toc = el('nav', 'guide-toc');
  toc.setAttribute('aria-label', '가이드 목차');
  const content = el('div', 'guide-content docs-content');
  wrap.append(toc, content);
  const actions = el('div', 'org-modal-actions');
  const web = el('button', 'btn', 'GitHub에서 보기');
  web.type = 'button';
  web.hidden = true;
  const close = el('button', 'btn btn-confirm', '닫기');
  close.type = 'button';
  actions.append(web, close);
  box.append(wrap, actions);
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
  document.body.appendChild(overlay);

  const g = await window.rano.guideRead().catch(() => ({ ok: false, text: '' }) as { ok: boolean; text: string; url?: string });
  if (!g.ok || !g.text.trim()) {
    content.appendChild(el('p', 'org-problem', '가이드를 읽지 못했어요.'));
    return;
  }
  if (g.url) {
    web.hidden = false;
    web.addEventListener('click', () => void window.rano.openReleasePage(g.url!));
  }
  const { intro, sections } = split(tidy(g.text));
  const introEl = el('div', 'guide-intro');
  renderRich(introEl, intro.replace(/^#\s+.*\n/, '').replace(/^---\s*$/gm, ''));
  const buttons: HTMLButtonElement[] = [];
  const show = (i: number) => {
    content.replaceChildren();
    if (i === 0) content.appendChild(introEl);
    content.appendChild(el('h4', 'guide-title', sections[i].title));
    const body = el('div');
    renderRich(body, sections[i].body.replace(/^---\s*$/gm, ''));
    content.appendChild(body);
    const nav = el('div', 'guide-nav');
    if (i > 0) {
      const prev = el('button', 'btn btn-small', `← ${sections[i - 1].title}`);
      prev.type = 'button';
      prev.addEventListener('click', () => show(i - 1));
      nav.appendChild(prev);
    }
    if (i < sections.length - 1) {
      const next = el('button', 'btn btn-small btn-confirm', `${sections[i + 1].title} →`);
      next.type = 'button';
      next.addEventListener('click', () => show(i + 1));
      nav.appendChild(next);
    }
    content.appendChild(nav);
    content.scrollTop = 0;
    buttons.forEach((b, k) => b.classList.toggle('guide-toc-active', k === i));
  };
  sections.forEach((s, i) => {
    const b = el('button', 'guide-toc-item', s.title);
    b.type = 'button';
    b.addEventListener('click', () => show(i));
    buttons.push(b);
    toc.appendChild(b);
  });
  if (sections.length) show(0);
  else content.appendChild(introEl);
}

export class GuideButton {
  constructor(host: HTMLElement) {
    const btn = el('button', 'acct-btn guide-btn', '가이드');
    btn.type = 'button';
    btn.title = '라노 OS 사용 가이드';
    btn.addEventListener('click', () => void openGuide());
    host.appendChild(btn);
  }
}
