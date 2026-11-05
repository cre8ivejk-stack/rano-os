// 새 버전 알림: 앱을 켜고 조금 뒤, 그리고 12시간마다 확인한다. 새 버전이 있으면 머리말 아래에 띠를 띄운다.
import { el } from './dom.js';
import { button } from './orgCommon.js';

const DISMISS_KEY = 'rano.updateDismissed';

export function startUpdateNotice(): void {
  const check = async () => {
    let info: UpdateInfo;
    try {
      info = await window.rano.updateCheck();
    } catch {
      return;
    }
    if (!info.newer || !info.latest) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === info.latest) return;
    } catch {
      // 저장소를 못 쓰면 늘 보여 준다
    }
    show(info);
  };
  window.setTimeout(() => void check(), 4000);
  window.setInterval(() => void check(), 12 * 60 * 60_000);
}

function show(info: UpdateInfo): void {
  document.querySelector('.update-bar')?.remove();
  const bar = el('div', 'update-bar');
  bar.setAttribute('role', 'status');
  bar.appendChild(el('strong', undefined, `새 버전 ${info.latest} 이 나왔어요.`));
  bar.appendChild(el('span', undefined, ` 지금은 ${info.current} 이에요.`));
  const notes = el('pre', 'update-notes', info.notes || '(바뀐 내용 설명이 없어요)');
  notes.hidden = true;
  const more = button('바뀐 내용', 'btn btn-small btn-plain');
  more.addEventListener('click', () => (notes.hidden = !notes.hidden));
  const get = button('받으러 가기', 'btn btn-small btn-confirm');
  get.addEventListener('click', () => void window.rano.openReleasePage(info.url ?? ''));
  const later = button('나중에', 'btn btn-small btn-plain');
  later.addEventListener('click', () => {
    try {
      localStorage.setItem(DISMISS_KEY, info.latest ?? '');
    } catch {
      // 무시
    }
    bar.remove();
  });
  const actions = el('span', 'update-actions');
  actions.append(more, get, later);
  bar.appendChild(actions);
  bar.appendChild(notes);
  document.querySelector('.topbar')?.after(bar);
}

/** 설정 화면용: 지금 확인하고 결과 한 줄과 버튼을 돌려준다 */
export async function updateCheckLine(): Promise<HTMLElement> {
  const box = el('div', 'org-row');
  let info: UpdateInfo;
  try {
    info = await window.rano.updateCheck();
  } catch {
    box.appendChild(el('span', 'org-problem', '새 버전을 확인하지 못했어요.'));
    return box;
  }
  if (info.error) box.appendChild(el('span', 'org-hint', info.error));
  else if (info.newer) {
    box.appendChild(el('span', 'org-ok', `새 버전 ${info.latest} 이 있어요.`));
    const get = button('받으러 가기', 'btn btn-small btn-confirm');
    get.addEventListener('click', () => void window.rano.openReleasePage(info.url ?? ''));
    box.appendChild(get);
  } else box.appendChild(el('span', 'org-ok', `최신 버전이에요 (${info.current}).`));
  return box;
}
