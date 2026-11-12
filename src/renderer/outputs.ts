// 결과물함: 과제별 결과물. 결과 요약 → 정하실 것·다음 할 일 → 확인 완료 → 보고서 전체 → 바뀐 파일 → 검수 보고 순서로 보여 준다.
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

/** 크게 펼쳐 보일 최근 과제 수(그보다 오래된 것은 한 줄로 접는다) */
const BIG_RECENT = 5;

export class OutputsView {
  private rano = window.rano;
  private items: TaskOutput[] = [];
  private loaded = false;
  private gotEvent = false;
  private failed = false;
  private fileNotes = new Map<string, { text: string; error: boolean }>(); // 파일 줄 안내(다시 그려도 유지)
  private todos: TodoItem[] = []; // 결과물과 이어진 할 일(확인 완료 버튼)
  private doneErrors = new Map<string, string>(); // 할 일 id → 확인 완료 실패 안내
  // 거르기: 미션 · 상태 · 기간
  private fMission = '';
  private fStatus: '' | 'review' | 'done' | 'failed' = '';
  private fPeriod: 'all' | 'today' | 'week' = 'all';
  private openMini = new Set<string>(); // 펼쳐 둔 작은 과제 줄
  private filterEl = el('div', 'out-filter');
  /** [이어서 시키기]: 그 과제에 이어서 리더에게 시킬 말을 적으러 간다 */
  onFollowUp: (o: TaskOutput, title: string) => void = () => {};

  private listEl = mustGet<HTMLDivElement>('outputs-list');

  missionName: (missionId: string) => string | undefined = () => undefined;

  constructor() {
    this.listEl.before(this.filterEl);
    this.render();
  }

  /** 새 결과물 수가 바뀔 때 (결과물함 탭 배지) */
  onUnseen: (n: number) => void = () => {};
  private static SEEN_KEY = 'rano.outputsSeen';

  /** 아직 보지 않은 끝난 결과물 수 */
  unseen(): number {
    let seen = '';
    try {
      seen = localStorage.getItem(OutputsView.SEEN_KEY) ?? '';
    } catch {
      seen = '';
    }
    // 처음 쓰는 경우: 지금까지 것은 본 것으로 둔다
    if (!seen) {
      this.markSeen();
      return 0;
    }
    return this.items.filter((o) => o && o.status !== 'running' && (o.endedAt ?? '') > seen).length;
  }

  /** 결과물함을 봤을 때 */
  markSeen(): void {
    const latest = this.items.reduce((m, o) => ((o?.endedAt ?? '') > m ? (o.endedAt as string) : m), '');
    try {
      localStorage.setItem(OutputsView.SEEN_KEY, latest || new Date().toISOString());
    } catch {
      // 무시
    }
    this.onUnseen(0);
  }

  async load(): Promise<void> {
    try {
      const [list, todos] = await Promise.all([this.rano.outputsList(), this.rano.todosList().catch(() => [] as TodoItem[])]);
      if (!this.gotEvent && Array.isArray(list)) this.items = list;
      if (Array.isArray(todos) && !this.todos.length) this.todos = todos;
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

  /** 할 일 목록이 바뀌었을 때(확인 완료 버튼 상태) */
  setTodos(items: TodoItem[]): void {
    if (!Array.isArray(items)) return;
    this.todos = items;
    this.render();
  }

  /** 이 결과물과 이어진 할 일. 예전 기록은 같은 미션의 "리더 보고 도착 MM-DD HH:mm" 메모가 끝난 시각과 맞는 것 */
  private todoFor(o: TaskOutput): TodoItem | undefined {
    const linked = this.todos.find((t) => t.taskId === o.taskId);
    if (linked || !o.endedAt) return linked;
    const end = toDate(o.endedAt).getTime();
    const stamps = [0, 60_000].map((dt) => {
      const d = new Date(end + dt);
      const p = (n: number) => String(n).padStart(2, '0');
      return `리더 보고 도착 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    return this.todos.find((t) => !t.taskId && t.missionId === o.missionId && stamps.some((x) => (t.note ?? '').includes(x)));
  }

  private async markDone(t: TodoItem, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const list = await this.rano.todosUpdate(t.id, { status: 'done' });
      this.doneErrors.delete(t.id);
      this.setTodos(list);
    } catch {
      this.doneErrors.set(t.id, '완료로 바꾸지 못했어요. 할 일 탭에서 다시 해 주세요.');
      btn.disabled = false;
      this.render();
    }
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
      this.onUnseen(0);
      return;
    }
    this.renderFilter(items);
    // 거르기
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = dayStart - ((now.getDay() + 6) % 7) * 86_400_000; // 이번 주 월요일
    const shown = items.filter((o) => {
      if (this.fMission && o.missionId !== this.fMission) return false;
      if (this.fStatus === 'failed' && o.status !== 'failed') return false;
      if (this.fStatus === 'done' && o.status !== 'done') return false;
      if (this.fStatus === 'review' && this.todoFor(o)?.status !== 'review') return false;
      const at = toDate(o.endedAt ?? o.startedAt).getTime();
      if (this.fPeriod === 'today' && at < dayStart) return false;
      if (this.fPeriod === 'week' && at < weekStart) return false;
      return true;
    });
    if (!shown.length) {
      this.listEl.replaceChildren(el('p', 'board-note', '이 조건에 맞는 결과물이 없어요'));
      this.onUnseen(this.unseen());
      return;
    }
    // 크게 보일 카드: 진행 중, 확인이 필요한 것, 그리고 가장 최근에 끝난 다섯 건(자잘한 과제는 빼고). 나머지는 한 줄
    const big = new Set<string>();
    let recent = 0;
    for (const o of shown) {
      if (o.status === 'running' || this.todoFor(o)?.status === 'review') big.add(o.taskId);
      else if (recent < BIG_RECENT && !this.isMini(o)) {
        big.add(o.taskId);
        recent++;
      }
    }
    // 날짜별로 묶는다: 오늘 · 어제 · M월 D일 (요일)
    const nodes: HTMLElement[] = [];
    let lastDay = '';
    for (const o of shown) {
      const d = toDate(o.endedAt ?? o.startedAt);
      const key = d.toDateString();
      if (key !== lastDay) {
        lastDay = key;
        const diff = Math.round((dayStart - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
        const label = diff === 0 ? '오늘' : diff === 1 ? '어제' : `${d.getMonth() + 1}월 ${d.getDate()}일 (${'일월화수목금토'[d.getDay()]})`;
        const n = shown.filter((x) => toDate(x.endedAt ?? x.startedAt).toDateString() === key).length;
        nodes.push(el('div', 'out-day', `${label} · ${n}건`));
      }
      nodes.push(big.has(o.taskId) ? this.renderCard(o) : this.renderMini(o));
    }
    this.listEl.replaceChildren(...nodes);
    this.onUnseen(this.unseen());
  }

  private renderFilter(items: TaskOutput[]): void {
    const bar = this.filterEl;
    bar.replaceChildren();
    const group = (label: string, opts: [string, string][], cur: string, set: (v: string) => void) => {
      const g = el('div', 'out-filter-group');
      g.appendChild(el('span', 'out-filter-label', label));
      for (const [v, text] of opts) {
        const b = el('button', `done-filter-btn${cur === v ? ' on' : ''}`, text);
        b.type = 'button';
        b.addEventListener('click', () => {
          set(v);
          this.render();
        });
        g.appendChild(b);
      }
      bar.appendChild(g);
    };
    const missions = [...new Set(items.map((o) => o.missionId))];
    if (this.fMission && !missions.includes(this.fMission)) this.fMission = '';
    if (missions.length > 1) group('미션', [['', '전체'], ...missions.map((id) => [id, this.missionName(id) ?? id] as [string, string])], this.fMission, (v) => (this.fMission = v));
    const review = items.filter((o) => this.todoFor(o)?.status === 'review').length;
    group('상태', [['', '전체'], ['review', `확인 필요${review ? ` ${review}` : ''}`], ['done', '완료'], ['failed', '중단']], this.fStatus, (v) => (this.fStatus = v as typeof this.fStatus));
    group('기간', [['today', '오늘'], ['week', '이번 주'], ['all', '전체']], this.fPeriod, (v) => (this.fPeriod = v as typeof this.fPeriod));
  }

  /** 한 줄로 접어 보일 과제: 중단된 과제, 또는 1분 안에 끝났고 바뀐 파일·이어진 할 일·정하실 것이 없는 과제 */
  private isMini(o: TaskOutput): boolean {
    if (o.status === 'running') return false;
    if (this.todoFor(o)?.status === 'review') return false;
    if (o.status === 'failed') return true;
    const ms = o.endedAt ? toDate(o.endedAt).getTime() - toDate(o.startedAt).getTime() : Infinity;
    return ms < 60_000 && !(o.changedFiles?.length) && !this.todoFor(o) && !nextSteps(o.leaderReport ?? '').length;
  }

  private renderMini(o: TaskOutput): HTMLElement {
    const key = `${o.missionId}:${o.taskId}`;
    const row = el('details', `out-mini out-mini-${o.status}`);
    row.open = this.openMini.has(key);
    const sum = el('summary', 'out-mini-sum');
    sum.appendChild(el('span', `badge task-${o.status}`, o.stoppedByUser ? '내가 멈춤' : STATUS_LABEL[o.status] ?? o.status));
    sum.appendChild(el('span', 'out-mini-title', outputTitle(o).title));
    sum.appendChild(el('span', 'out-mini-meta', [this.missionName(o.missionId) ?? o.missionId, formatWhen(o.endedAt ?? o.startedAt)].join(' · ')));
    row.appendChild(sum);
    const fill = () => {
      if (row.childElementCount === 1) row.appendChild(this.renderCard(o));
    };
    if (row.open) fill();
    row.addEventListener('toggle', () => {
      if (row.open) {
        this.openMini.add(key);
        fill();
      } else this.openMini.delete(key);
    });
    return row;
  }

  private renderCard(o: TaskOutput): HTMLElement {
    const card = el('article', 'out');
    const key = `${o.missionId}:${o.taskId}`;

    const top = el('div', 'out-top');
    top.appendChild(el('span', 'out-mission', this.missionName(o.missionId) ?? o.missionId));
    top.appendChild(el('span', `badge task-${o.status}`, STATUS_LABEL[o.status] ?? o.status));
    card.appendChild(top);
    const t = outputTitle(o);
    card.appendChild(el('h3', 'out-title', t.title));
    const meta = [o.from === 'rano' ? '라노 배정' : '직접 지시', `시작 ${formatWhen(o.startedAt)}`];
    if (o.endedAt) meta.push(`끝남 ${formatWhen(o.endedAt)}`);
    // 과제에 든 것: 걸린 시간 · 승인 카드 · 사용량
    if (o.endedAt) {
      const min = Math.max(0, (new Date(o.endedAt).getTime() - new Date(o.startedAt).getTime()) / 60000);
      meta.push(min < 1 ? `걸린 시간 ${Math.max(1, Math.round(min * 60))}초` : min < 60 ? `걸린 시간 ${Math.round(min)}분` : `걸린 시간 ${Math.floor(min / 60)}시간 ${Math.round(min % 60)}분`);
    }
    if (o.stats) {
      if (typeof o.stats.cards === 'number') meta.push(`승인 카드 ${o.stats.cards}장`);
      if (o.stats.tokens) {
        const amount = o.stats.tokens >= 10000 ? `${Math.round(o.stats.tokens / 10000).toLocaleString()}만` : o.stats.tokens.toLocaleString();
        meta.push(`사용량 ${amount} 토큰${o.stats.costUsd ? ` (약 $${o.stats.costUsd.toFixed(2)} 상당)` : ''}`);
      }
    }
    if (o.stoppedByUser) meta.push('내가 멈춤');
    card.appendChild(el('div', 'task-meta', meta.join(' · ')));
    if (t.task) card.appendChild(el('p', 'out-task', `맡긴 일: ${t.task}`));

    // ---- 결과 요약: 리더 보고 첫 부분을 바로 보여 준다 ----
    const report = o.leaderReport ?? '';
    const summary = resultSummary(report);
    if (summary) {
      const box = el('div', 'out-summary');
      box.appendChild(el('span', 'out-summary-label', '결과'));
      const txt = el('div', 'out-summary-text');
      renderRich(txt, summary);
      box.appendChild(txt);
      card.appendChild(box);
    }

    // ---- 정하실 것·다음 할 일: 보고 속 해당 부분을 꺼내 바로 보여 준다 ----
    const next = nextSteps(report);
    if (next.length) {
      const box = el('div', 'out-next');
      box.appendChild(el('div', 'out-next-label', '정하실 것 · 다음 할 일'));
      for (const sct of next) {
        box.appendChild(el('div', 'out-next-head', sct.heading));
        const txt = el('div', 'out-next-text');
        renderRich(txt, sct.body);
        box.appendChild(txt);
      }
      card.appendChild(box);
    }

    // ---- 확인 완료: 이어진 할 일이 "확인 요청"이면 여기서 끝낼 수 있다 ----
    const todo = o.status === 'running' ? undefined : this.todoFor(o);
    if (todo) {
      const row = el('div', 'out-actions');
      if (todo.status === 'done') {
        row.appendChild(el('span', 'out-done', `✓ 확인 완료${todo.doneAt ? ` · ${formatWhen(todo.doneAt)}` : ''}`));
      } else if (todo.status === 'review') {
        const btn = el('button', 'btn btn-confirm', '확인 완료');
        btn.type = 'button';
        btn.addEventListener('click', () => void this.markDone(todo, btn));
        row.appendChild(btn);
        row.appendChild(el('span', 'muted out-actions-note', `할 일 "${todo.title}"을(를) 완료로 바꿔요`));
      }
      const err = this.doneErrors.get(todo.id);
      if (err) row.appendChild(el('span', 'file-note file-note-error', err));
      if (row.childElementCount) card.appendChild(row);
    }
    // ---- 이어서 시키기: 이 과제에 이어서 같은 미션 리더에게 다음 일을 시킨다 ----
    if (o.status !== 'running') {
      const row = el('div', 'out-follow');
      const go = el('button', 'btn btn-small', '이어서 시키기');
      go.type = 'button';
      go.title = '대화 화면으로 가서 이 미션 리더에게 이어서 시킬 일을 적어요';
      go.addEventListener('click', () => this.onFollowUp(o, t.title));
      row.appendChild(go);
      card.appendChild(row);
    }

    // ---- 보고서 전체 ----
    if (report.trim()) {
      const { root, body } = foldable(`${key}:leader`, '보고서 전체 보기');
      const text = el('div', 'report-text');
      renderRich(text, report);
      body.appendChild(text);
      card.appendChild(root);
    }

    // ---- 바뀐 파일: 있을 때만 목록, 없으면 한 줄 ----
    const files = Array.isArray(o.changedFiles) ? o.changedFiles : [];
    if (files.length) {
      const sec = el('section', 'card-sec');
      sec.appendChild(el('h3', 'card-sec-title', `바뀐 파일 ${files.length}개`));
      const list = el('ul', 'files');
      for (const f of files) list.appendChild(this.renderFile(key, f));
      sec.appendChild(list);
      card.appendChild(sec);
    } else {
      card.appendChild(
        el('p', 'muted out-nofiles', o.status === 'running' ? '과제가 끝나면 바뀐 파일을 정리해 보여 드려요' : '바뀐 파일 없음 (읽고 정리한 과제예요)'),
      );
    }

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

/** 결과물 제목: 리더 보고의 큰 제목(#) → 지시의 [제목] → 지시 앞부분. task 는 맡긴 일 한 줄 */
export function outputTitle(o: TaskOutput): { title: string; task?: string } {
  const report = o.leaderReport ?? '';
  // 보고의 큰 제목(#)만 쓴다. 소제목(##)은 보고 안의 한 부분이라 카드 제목으로 쓰면 헷갈린다
  const h = /^\s*#\s+(.+)$/m.exec(report);
  const bracket = /^\s*\[([^\]]{2,40})\]/.exec(o.title ?? '');
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
  const task = clip((o.title ?? '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim(), 90);
  if (h) return { title: clip(h[1].replace(/^보고\s*[:：]\s*/, '').replace(/\*\*/g, '').trim(), 70), task };
  if (bracket) return { title: bracket[1], task };
  return { title: clip(o.title ?? '과제', 70) };
}

const SECTION_START = /^\s*(?:#{1,6}\s+|\*\*\s*\d+[.)]|\d+[.)]\s+\*\*|\*\*[^*\n]{2,24}\*\*\s*:?\s*$)/;

/**
 * 카드에 보일 요약: 보고의 "결과" 부분("4. 결과", "**결과**", "## 결과")을 먼저 쓴다(결과물 대조표는 아님).
 * 없으면 보고 첫 문단(reportSummary). 600자까지
 */
export function resultSummary(report: string): string {
  const lines = report.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^\s*(?:#{1,6}\s+)?(?:\*\*)?\s*(?:\d+[.)]\s*)?(?:\*\*)?\s*결과(?!물)\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?/.test(l));
  if (at < 0) return reportSummary(report);
  const first = lines[at].replace(/^\s*(?:#{1,6}\s+)?(?:\*\*)?\s*(?:\d+[.)]\s*)?(?:\*\*)?\s*결과\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*/, '').trim();
  const out: string[] = first ? [first] : [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (SECTION_START.test(l) || /^\s*\(앱 확인:/.test(l)) break;
    out.push(l);
  }
  const s = out.join('\n').trim();
  if (!s) return reportSummary(report);
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

/** 보고 요약: 첫 제목 뒤 첫 문단(과 바로 이어지는 목록)을 600자까지 */
export function reportSummary(report: string): string {
  const lines = report.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let started = false;
  for (const l of lines) {
    if (/^\s*#{1,6}\s/.test(l)) {
      if (started) break;
      continue;
    }
    if (!l.trim()) {
      if (started && out.length) break;
      continue;
    }
    started = true;
    out.push(l);
  }
  const s = out.join('\n').trim();
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

// 보고에서 "정하실 것·다음 할 일"로 보여 줄 부분의 제목
const NEXT_HEADING = /(결정|승인이\s*필요|정해|정하실|다음|남은\s*일|후속|이어서|해\s*주실|권장\s*순서)/;

/** 보고에서 결정·승인이 필요한 일, 다음 할 일 부분(## 또는 ### 제목 아래)을 꺼낸다. 부분마다 900자까지 */
export function nextSteps(report: string): { heading: string; body: string }[] {
  const lines = report.replace(/\r\n?/g, '\n').split('\n');
  const out: { heading: string; body: string }[] = [];
  let cur: { heading: string; level: number; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').trim();
    if (body) out.push({ heading: cur.heading, body: body.length > 900 ? `${body.slice(0, 900)}… (보고서 전체에서 이어 보기)` : body });
    cur = null;
  };
  for (const l of lines) {
    const h = /^\s*(#{2,3})\s+(.+)$/.exec(l);
    if (h) {
      const level = h[1].length;
      if (cur && level > cur.level) {
        cur.lines.push(l); // 하위 제목은 본문에 포함
        continue;
      }
      flush();
      const heading = h[2].replace(/\*\*/g, '').replace(/^\d+[.)]\s*/, '').trim();
      if (NEXT_HEADING.test(heading)) cur = { heading, level, lines: [] };
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      flush(); // 가로줄(---) 뒤는 다른 이야기
      continue;
    }
    if (cur) cur.lines.push(l);
  }
  flush();
  return out.slice(0, 3);
}
