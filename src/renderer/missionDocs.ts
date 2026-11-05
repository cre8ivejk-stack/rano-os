// 미션 기록 보기: 헌장·팀 편성·미션 기억(결정로그·진행업무 등)·결과물 목록을 읽기 좋게 보여 준다(읽기만).
import { el, formatWhen, renderRich } from './dom.js';
import { button } from './orgCommon.js';

export async function openMissionDocs(missionId: string, name: string): Promise<void> {
  const overlay = el('div', 'org-modal-overlay');
  const box = el('div', 'org-modal docs-modal');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', `${name} 미션 기록`);
  box.appendChild(el('h3', 'org-modal-title', `${name} 미션 기록`));
  const body = el('div', 'docs-body');
  body.appendChild(el('p', 'board-note', '불러오는 중이에요…'));
  const actions = el('div', 'org-modal-actions');
  const close = button('닫기', 'btn');
  actions.appendChild(close);
  box.append(body, actions);
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
  close.focus();

  let docs: MissionDoc[] = [];
  try {
    docs = await window.rano.missionDocs(missionId);
  } catch {
    docs = [];
  }
  if (!docs.length) {
    body.replaceChildren(el('p', 'org-hint', '아직 기록이 없어요.'));
    return;
  }
  const tabs = el('div', 'docs-tabs');
  tabs.setAttribute('role', 'tablist');
  const view = el('article', 'docs-view');
  const show = (i: number) => {
    const d = docs[i];
    tabs.querySelectorAll('.docs-tab').forEach((b, k) => {
      b.classList.toggle('on', k === i);
      b.setAttribute('aria-selected', String(k === i));
    });
    const content = el('div', 'docs-content');
    renderRich(content, d.content.trim() || '(비어 있어요)');
    view.replaceChildren(el('p', 'docs-meta', `${d.file}${d.updatedAt ? ` · ${formatWhen(d.updatedAt)} 고침` : ''}`), content);
    view.scrollTop = 0;
  };
  docs.forEach((d, i) => {
    const b = el('button', 'docs-tab', d.label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => show(i));
    tabs.appendChild(b);
  });
  body.replaceChildren(tabs, view);
  // 진행 중인 일(진행업무)부터, 없으면 결정로그, 그다음 헌장
  const pick = ['진행업무', '결정로그'].map((k) => docs.findIndex((d) => d.file.includes(k))).find((i) => i >= 0);
  show(pick ?? 0);
}
