// 과제 결과 파일 줄 (0.9.18): 리더가 만든 엑셀·문서·메일 초안을 보고 카드와 결과물함에서 바로 보고·저장·연다.
import { el } from './dom.js';

const ICON: Record<TaskFile['kind'], string> = { sheet: '표', doc: '문서', web: '화면', image: '그림', text: '글', other: '파일' };
const cache = new Map<string, TaskFile[]>();

function sizeText(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 그 과제의 결과 파일 목록을 다시 읽게 한다(과제가 끝났을 때) */
export function forgetTaskFiles(taskId?: string): void {
  if (taskId) cache.delete(taskId);
  else cache.clear();
}

function fill(box: HTMLElement, taskId: string, files: TaskFile[]): void {
  box.replaceChildren();
  box.hidden = !files.length;
  if (!files.length) return;
  const head = el('div', 'tfiles-head');
  head.appendChild(el('span', 'tfiles-title', `결과 파일 ${files.length}개`));
  const folder = el('button', 'tfiles-link', '폴더 열기');
  folder.type = 'button';
  folder.title = 'Finder 에서 이 과제의 결과 폴더를 열어요';
  const note = el('span', 'tfiles-note');
  const say = (r: { ok: boolean; message?: string } | undefined, fail: string) => {
    note.textContent = r?.message ?? (r?.ok === false && r.message === undefined ? '' : r?.ok ? '' : fail);
    note.classList.toggle('bad', r?.ok === false && !!note.textContent);
    if (note.textContent) setTimeout(() => (note.textContent = ''), 5000);
  };
  const act = (rel: string, a: TaskFileAct, fail: string) => {
    void window.rano
      .taskFileAct(taskId, rel, a)
      .then((r) => say(r, fail))
      .catch(() => say({ ok: false, message: fail }, fail));
  };
  folder.addEventListener('click', () => act('', 'folder', '폴더를 열지 못했어요'));
  head.append(folder, note);
  box.appendChild(head);
  const list = el('ul', 'tfiles-list');
  for (const f of files) {
    const li = el('li', 'tfile');
    const main = el('button', 'tfile-main');
    main.type = 'button';
    main.title = '앱 안에서 바로 봐요';
    main.appendChild(el('span', `tfile-kind tfile-${f.kind}`, ICON[f.kind]));
    main.appendChild(el('span', 'tfile-name', f.rel));
    main.appendChild(el('span', 'tfile-size', sizeText(f.size)));
    main.addEventListener('click', () => act(f.rel, 'peek', '보여 드리지 못했어요'));
    li.appendChild(main);
    const btn = (label: string, title: string, a: TaskFileAct, fail: string) => {
      const b = el('button', 'tfile-btn', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', () => act(f.rel, a, fail));
      return b;
    };
    li.append(
      btn('바로 보기', '앱 안에서 바로 봐요', 'peek', '보여 드리지 못했어요'),
      btn('저장', '다운로드 폴더 등 원하는 곳에 사본을 저장해요', 'save', '저장하지 못했어요'),
      btn('열기', '엑셀·워드 같은 기본 프로그램으로 열어요', 'open', '열지 못했어요'),
    );
    list.appendChild(li);
  }
  box.appendChild(list);
}

/** 결과 파일 줄. 파일이 없으면 보이지 않는다 */
export function taskFilesBox(taskId: string | undefined): HTMLElement {
  const box = el('div', 'tfiles');
  box.hidden = true;
  if (!taskId) return box;
  const have = cache.get(taskId);
  if (have) {
    fill(box, taskId, have);
    return box;
  }
  void window.rano
    .taskFiles(taskId)
    .then((files) => {
      const list = Array.isArray(files) ? files : [];
      cache.set(taskId, list);
      fill(box, taskId, list);
    })
    .catch(() => undefined);
  return box;
}
