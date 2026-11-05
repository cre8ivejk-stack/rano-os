// 결과물함: 과제별 결과물(바뀐 파일, 검수 보고, 리포 리더 보고).
import { el, foldable, formatWhen, mustGet, renderRich, roleLabel, splitWorkPath, toDate } from './dom.js';

const STATUS_LABEL: Record<TaskOutput['status'], string> = {
  running: '진행 중',
  done: '완료',
  failed: '중단',
};
const CHANGE_LABEL: Record<TaskOutput['changedFiles'][number]['change'], string> = {
  added: '새로 만듦',
  modified: '고침',
  deleted: '지움',
};

export class OutputsView {
  private rano = window.rano;
  private items: TaskOutput[] = [];
  private loaded = false;
  private gotEvent = false;
  private failed = false;
  private fileNotes = new Map<string, { text: string; error: boolean }>(); // 파일 줄 안내(다시 그려도 유지)

  private listEl = mustGet<HTMLDivElement>('outputs-list');

  missionName: (missionId: string) => string | undefined = () => undefined;

  constructor() {
    this.render();
  }

  async load(): Promise<void> {
    try {
      const list = await this.rano.outputsList();
      if (!this.gotEvent && Array.isArray(list)) this.items = list;
    } catch {
      if (!this.gotEvent) this.failed = true;
    }
    this.loaded = true;
    this.render();
  }

  update(items: TaskOutput[]): void {
    if (!Array.isArray(items)) return;
    this.gotEvent = true;
    this.loaded = true;
    this.failed = false;
    this.items = items;
    this.render();
  }

  /** 미션 이름이 새로 알려졌을 때 */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const items = this.items
      .filter((o) => o && typeof o.taskId === 'string')
      .sort((a, b) => toDate(b.startedAt).getTime() - toDate(a.startedAt).getTime());
    if (items.length === 0) {
      const text = !this.loaded
        ? '결과물함을 불러오는 중이에요…'
        : this.failed
          ? '결과물함을 불러오지 못했어요. 앱을 다시 열어 주세요.'
          : '아직 결과물이 없어요';
      this.listEl.replaceChildren(el('p', 'board-note', text));
      return;
    }
    this.listEl.replaceChildren(...items.map((o) => this.renderCard(o)));
  }

  private renderCard(o: TaskOutput): HTMLElement {
    const card = el('article', 'out');
    const key = `${o.missionId}:${o.taskId}`;

    const top = el('div', 'out-top');
    top.appendChild(el('span', 'out-mission', this.missionName(o.missionId) ?? o.missionId));
    top.appendChild(el('span', `badge task-${o.status}`, STATUS_LABEL[o.status] ?? o.status));
    card.appendChild(top);
    card.appendChild(el('h3', 'out-title', o.title));
    const meta = [o.from === 'rano' ? '라노 배정' : '직접 지시', `시작 ${formatWhen(o.startedAt)}`];
    if (o.endedAt) meta.push(`끝남 ${formatWhen(o.endedAt)}`);
    card.appendChild(el('div', 'task-meta', meta.join(' · ')));

    // ---- 바뀐 파일 ----
    const sec = el('section', 'card-sec');
    const files = Array.isArray(o.changedFiles) ? o.changedFiles : [];
    sec.appendChild(el('h3', 'card-sec-title', files.length ? `바뀐 파일 ${files.length}개` : '바뀐 파일'));
    if (files.length === 0) {
      sec.appendChild(
        el('p', 'muted', o.status === 'running' ? '과제가 끝나면 바뀐 파일을 정리해 보여 드려요' : '바뀐 파일 없음 (읽고 정리만 한 과제)'),
      );
    } else {
      const list = el('ul', 'files');
      for (const f of files) list.appendChild(this.renderFile(key, f));
      sec.appendChild(list);
    }
    card.appendChild(sec);

    // ---- 검수 보고 ----
    const reviews = Array.isArray(o.reviewReports) ? o.reviewReports : [];
    if (reviews.length) {
      const { root, body } = foldable(`${key}:review`, `검수 보고 ${reviews.length}건`);
      for (const r of reviews) {
        const block = el('div', 'report');
        const label = roleLabel(r.role);
        block.appendChild(el('div', 'report-head', `${r.role}${label ? ` (${label})` : ''} · ${formatWhen(r.at)}`));
        const text = el('div', 'report-text');
        renderRich(text, r.text ?? '');
        block.appendChild(text);
        body.appendChild(block);
      }
      card.appendChild(root);
    }

    // ---- 리포 리더 보고 ----
    if (o.leaderReport && o.leaderReport.trim()) {
      const { root, body } = foldable(`${key}:leader`, '리포 리더 보고');
      const text = el('div', 'report-text');
      renderRich(text, o.leaderReport);
      body.appendChild(text);
      card.appendChild(root);
    }
    return card;
  }

  private renderFile(cardKey: string, f: TaskOutput['changedFiles'][number]): HTMLElement {
    const li = el('li', 'file');
    const noteKey = `${cardKey}:${f.path}`;
    // 앱 본체가 작업 폴더 기준 경로를 알려 주면 그것을 쓰고, 예전 기록이면 경로 모양으로 추정한다
    const p = f.rel ? { folder: f.folder ?? null, rel: f.rel } : splitWorkPath(f.path);

    const row = el('div', 'file-row');
    row.appendChild(el('span', `badge change-${f.change}`, CHANGE_LABEL[f.change] ?? f.change));
    const name = el('span', 'file-name');
    if (p.folder) name.appendChild(el('span', 'file-folder', `${p.folder} 작업 폴더`));
    name.appendChild(el('span', 'file-path', p.rel));
    name.title = f.path;
    row.appendChild(name);

    const note = el('div', 'file-note');
    const showNote = (text: string, error: boolean) => {
      this.fileNotes.set(noteKey, { text, error });
      note.textContent = text;
      note.className = `file-note${error ? ' file-note-error' : ''}`;
      note.hidden = false;
    };
    const saved = this.fileNotes.get(noteKey);
    if (saved) showNote(saved.text, saved.error);
    else note.hidden = true;

    if (f.change !== 'deleted') {
      const btns = el('span', 'file-btns');
      const openBtn = el('button', 'btn btn-small', '열기');
      const revealBtn = el('button', 'btn btn-small', 'Finder에서 보기');
      openBtn.type = revealBtn.type = 'button';
      const run = async (btn: HTMLButtonElement, action: (path: string) => Promise<{ ok: boolean; message?: string }>, fail: string) => {
        btn.disabled = true;
        try {
          const r = await action(f.path);
          if (r && r.ok) {
            this.fileNotes.delete(noteKey);
            note.hidden = true;
          } else {
            showNote(r?.message || fail, true);
          }
        } catch {
          showNote(fail, true);
        } finally {
          btn.disabled = false;
        }
      };
      openBtn.addEventListener('click', () => void run(openBtn, (x) => this.rano.openFile(x), '파일을 열지 못했어요.'));
      revealBtn.addEventListener('click', () => void run(revealBtn, (x) => this.rano.revealFile(x), 'Finder에서 보여 드리지 못했어요.'));
      btns.append(openBtn, revealBtn);
      row.appendChild(btns);
    }

    li.append(row, note);
    return li;
  }
}
