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
  // 이 맥에서 포장한 새 판(라노 OS 자신을 고치는 미션): 1분마다 가볍게 본다(파일 시각만, 인터넷 안 씀)
  const local = async () => {
    try {
      const b = await window.rano.updateLocal();
      if (b) showLocal(b);
      else document.querySelector('.update-bar-local')?.remove();
    } catch {
      // 못 읽으면 넘어간다
    }
  };
  window.setTimeout(() => void local(), 6000);
  window.setInterval(() => void local(), 60_000);
}

const LOCAL_DISMISS_KEY = 'rano.localBuildDismissed';

/** 이 맥에서 포장한 새 판 띠: [바꾸고 다시 켜기] 를 누르면 본체가 확인 창을 띄운 뒤 앱을 끄고 바꿔 넣는다 */
function showLocal(b: { path: string; version: string; builtAt: number; current: string }): void {
  const key = `${b.version}:${b.builtAt}`;
  try {
    if (localStorage.getItem(LOCAL_DISMISS_KEY) === key) return;
  } catch {
    // 저장소를 못 쓰면 늘 보여 준다
  }
  const old = document.querySelector('.update-bar-local') as HTMLElement | null;
  if (old?.dataset.key === key) return;
  old?.remove();
  const bar = el('div', 'update-bar update-bar-local');
  bar.dataset.key = key;
  bar.setAttribute('role', 'status');
  bar.appendChild(el('strong', undefined, `이 맥에서 포장한 새 판(${b.version})이 있어요.`));
  bar.appendChild(el('span', undefined, ` 지금은 ${b.current} 이에요. 진행 중인 과제가 끝난 뒤 바꾸세요.`));
  const go = localInstallButton();
  const later = button('나중에', 'btn btn-small btn-plain');
  later.addEventListener('click', () => {
    try {
      localStorage.setItem(LOCAL_DISMISS_KEY, key);
    } catch {
      // 무시
    }
    bar.remove();
  });
  const actions = el('span', 'update-actions');
  actions.append(go, later);
  bar.appendChild(actions);
  document.querySelector('.topbar')?.after(bar);
}

function localInstallButton(): HTMLButtonElement {
  const go = button('바꾸고 다시 켜기', 'btn btn-small btn-confirm');
  go.addEventListener('click', async () => {
    if (go.disabled) return;
    go.disabled = true;
    try {
      await window.rano.updateInstallLocal();
    } finally {
      go.disabled = false;
    }
  });
  return go;
}

function show(info: UpdateInfo): void {
  document.querySelector('.update-bar')?.remove();
  const bar = el('div', 'update-bar');
  bar.setAttribute('role', 'status');
  bar.appendChild(el('strong', undefined, `새 버전 ${info.latest} 이 나왔어요.`));
  bar.appendChild(el('span', undefined, ` 지금은 ${info.current} 이에요.`));
  const notes = el('pre', 'update-notes', (info.notes ?? '').replace(/\*\*|`/g, '').trim() || '(바뀐 내용 설명이 없어요)');
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
  try {
    const b = await window.rano.updateLocal();
    if (b) {
      box.appendChild(el('span', 'org-ok', `이 맥에서 포장한 새 판(${b.version})이 있어요: ${b.path}`));
      box.appendChild(localInstallButton());
    }
  } catch {
    // 못 읽으면 넘어간다
  }
  return box;
}
