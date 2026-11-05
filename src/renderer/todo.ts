// 할 일 패널: 라노 대화 화면 오른쪽에 미션별 굵직한 일과 상태를 보여 준다.
// 사용자는 추가·제목 고치기·순서 바꾸기·삭제·상태 바꾸기(완료 포함)를 할 수 있다. 라노는 완료를 표시하지 못한다.
import { el, mustGet } from './dom.js';

const STATUS_LABEL: Record<TodoStatus, string> = {
  waiting: '대기',
  active: '진행 중',
  review: '확인 요청',
  done: '완료',
};
const STATUS_ORDER: TodoStatus[] = ['waiting', 'active', 'review', 'done'];
const NO_MISSION = '';

export class TodoView {
  private rano = window.rano;
  private items: TodoItem[] = [];
  private missions = new Map<string, MissionStatus>();
  private missionOrder: string[] = [];
  private editing: string | null = null;
  private confirmDelete: string | null = null;
  private loaded = false;

  private readonly groupsEl = mustGet<HTMLDivElement>('todo-groups');
  private readonly countEl = mustGet<HTMLSpanElement>('todo-count');
  private readonly form = mustGet<HTMLFormElement>('todo-add');
  private readonly missionSelect = mustGet<HTMLSelectElement>('todo-mission');
  private readonly titleInput = mustGet<HTMLInputElement>('todo-title');
  private readonly addBtn = mustGet<HTMLButtonElement>('todo-add-btn');

  onOpenOutputs: () => void = () => {};

  constructor() {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.add();
    });
    this.titleInput.addEventListener('input', () => this.refreshAdd());
    this.refreshAdd();
  }

  async load(): Promise<void> {
    try {
      const [items, missions] = await Promise.all([this.rano.todosList(), this.rano.missionList()]);
      if (Array.isArray(missions)) for (const m of missions) this.setMission(m);
      if (Array.isArray(items)) this.items = items;
      this.loaded = true;
    } catch {
      this.loaded = false;
    }
    this.fillMissionSelect();
    this.render();
  }

  update(items: TodoItem[]): void {
    if (!Array.isArray(items)) return;
    this.items = items;
    this.loaded = true;
    this.render();
  }

  updateMission(s: MissionStatus): void {
    if (!s || typeof s.missionId !== 'string') return;
    const isNew = !this.missions.has(s.missionId);
    this.setMission(s);
    if (isNew) this.fillMissionSelect();
    // 진행 중 항목의 한 줄 진행 상황만 바뀌므로 그 미션에 진행 중 항목이 있을 때만 다시 그린다
    if (this.items.some((x) => x.missionId === s.missionId && x.status === 'active')) this.render();
  }

  private setMission(s: MissionStatus) {
    if (!this.missionOrder.includes(s.missionId)) this.missionOrder.push(s.missionId);
    this.missions.set(s.missionId, s);
  }

  private fillMissionSelect() {
    // 처음 채울 때는 첫 미션을 고른다. 이미 사용자가 골라 둔 값이 있으면 그대로 둔다.
    const keep = this.missionSelect.options.length ? this.missionSelect.value : undefined;
    this.missionSelect.replaceChildren();
    for (const id of this.missionOrder) {
      const o = el('option', undefined, this.missions.get(id)?.name ?? id);
      o.value = id;
      this.missionSelect.appendChild(o);
    }
    const none = el('option', undefined, '미션 밖');
    none.value = NO_MISSION;
    this.missionSelect.appendChild(none);
    if (keep !== undefined && [...this.missionSelect.options].some((o) => o.value === keep)) this.missionSelect.value = keep;
  }

  private refreshAdd() {
    this.addBtn.disabled = !this.titleInput.value.trim();
  }

  private async add() {
    const title = this.titleInput.value.trim();
    if (!title) return;
    const mission = this.missionSelect.value || null;
    this.addBtn.disabled = true;
    try {
      this.update(await this.rano.todosAdd(mission, title));
      this.titleInput.value = '';
    } catch {
      // 오류 문구는 앱 본체가 대화창에 알려 준다
    }
    this.refreshAdd();
    this.titleInput.focus();
  }

  private async act(p: Promise<TodoItem[]>) {
    try {
      this.update(await p);
    } catch {
      // 오류 문구는 앱 본체가 알려 준다
    }
  }

  private missionName(id: string | null): string {
    if (!id) return '미션 밖';
    return this.missions.get(id)?.name ?? id;
  }

  // 진행 중 항목 아래에 보일 한 줄: 미션 현황판에서 가져온다
  private progressLine(x: TodoItem): string | null {
    if (x.status !== 'active') return x.note ?? null;
    if (x.queued) return '리더가 앞 과제를 마치면 시작해요';
    const s = x.missionId ? this.missions.get(x.missionId) : undefined;
    if (!s) return x.note ?? null;
    if (s.leaderState !== 'working') return x.note || '리더에게 넘겼어요';
    const parts: string[] = [];
    const working = s.members.filter((m) => m.state === 'working').length;
    const reviewing = s.members.filter((m) => m.state === 'reviewing').length;
    if (reviewing) parts.push(`검수 중`);
    else if (working) parts.push(`팀원 ${working}명 작업 중`);
    else parts.push('리더 일하는 중');
    if (s.pendingApprovals > 0) parts.push(`승인 대기 ${s.pendingApprovals}건`);
    return parts.join(' · ');
  }

  private render() {
    const open = this.items.filter((x) => x.status !== 'done').length;
    this.countEl.textContent = this.items.length ? `${open}개 남음` : '';
    this.groupsEl.replaceChildren();

    if (!this.loaded) {
      this.groupsEl.appendChild(el('p', 'todo-empty', '할 일 목록을 불러오지 못했어요.'));
      return;
    }
    if (!this.items.length) {
      const box = el('div', 'todo-empty');
      box.appendChild(el('p', undefined, '아직 할 일이 없어요.'));
      box.appendChild(el('p', 'todo-empty-ex', '아래에 직접 적거나, 라노에게 "할 일에 넣어줘"라고 말해 보세요.'));
      this.groupsEl.appendChild(box);
      return;
    }

    const keys = [...this.missionOrder];
    for (const x of this.items) {
      const k = x.missionId ?? NO_MISSION;
      if (!keys.includes(k)) keys.push(k);
    }
    if (keys.includes(NO_MISSION)) keys.push(keys.splice(keys.indexOf(NO_MISSION), 1)[0]);

    for (const key of keys) {
      const list = this.items.filter((x) => (x.missionId ?? NO_MISSION) === key);
      if (!list.length) continue;
      const group = el('section', 'todo-group');
      group.appendChild(el('h3', 'todo-group-title', this.missionName(key || null)));
      const ul = el('ul', 'todo-list');
      const notDone = list.filter((x) => x.status !== 'done');
      for (const x of notDone) ul.appendChild(this.row(x, notDone));
      group.appendChild(ul);
      const done = list.filter((x) => x.status === 'done');
      if (done.length) {
        const det = el('details', 'todo-done');
        det.appendChild(el('summary', undefined, `완료 ${done.length}개`));
        const dl = el('ul', 'todo-list');
        for (const x of done) dl.appendChild(this.row(x, done));
        det.appendChild(dl);
        group.appendChild(det);
      }
      this.groupsEl.appendChild(group);
    }
  }

  private row(x: TodoItem, siblings: TodoItem[]): HTMLLIElement {
    // 지우기 확인 중이면 도구 줄을 계속 보여 준다(다시 그리면 마우스 올림 상태가 풀리므로)
    const li = el('li', `todo-item st-${x.status}${this.confirmDelete === x.id ? ' tools-open' : ''}`);
    li.dataset.id = x.id;

    const top = el('div', 'todo-top');
    const sel = el('select', `todo-status st-${x.status}`);
    sel.setAttribute('aria-label', `${x.title} 상태`);
    for (const st of STATUS_ORDER) {
      const o = el('option', undefined, STATUS_LABEL[st]);
      o.value = st;
      sel.appendChild(o);
    }
    sel.value = x.status;
    sel.addEventListener('change', () => void this.act(this.rano.todosUpdate(x.id, { status: sel.value as TodoStatus })));
    top.appendChild(sel);

    if (this.editing === x.id) {
      const input = el('input', 'todo-edit');
      input.value = x.title;
      input.setAttribute('aria-label', '할 일 제목 고치기');
      const finish = (save: boolean) => {
        if (this.editing !== x.id) return;
        this.editing = null;
        const t = input.value.trim();
        if (save && t && t !== x.title) void this.act(this.rano.todosUpdate(x.id, { title: t }));
        else this.render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      top.appendChild(input);
      queueMicrotask(() => input.focus());
    } else {
      const title = el('span', 'todo-title', x.title);
      title.title = '두 번 눌러 제목 고치기';
      title.addEventListener('dblclick', () => {
        this.editing = x.id;
        this.render();
      });
      top.appendChild(title);
    }

    const tools = el('div', 'todo-tools');
    const idx = siblings.indexOf(x);
    const up = el('button', 'todo-tool', '↑');
    up.type = 'button';
    up.title = '위로';
    up.disabled = idx <= 0;
    up.addEventListener('click', () => void this.act(this.rano.todosMove(x.id, -1)));
    const down = el('button', 'todo-tool', '↓');
    down.type = 'button';
    down.title = '아래로';
    down.disabled = idx < 0 || idx >= siblings.length - 1;
    down.addEventListener('click', () => void this.act(this.rano.todosMove(x.id, 1)));
    const edit = el('button', 'todo-tool', '고치기');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      this.editing = x.id;
      this.render();
    });
    tools.append(up, down, edit);
    if (this.confirmDelete === x.id) {
      const yes = el('button', 'todo-tool todo-del-yes', '정말 지우기');
      yes.type = 'button';
      yes.addEventListener('click', () => {
        this.confirmDelete = null;
        void this.act(this.rano.todosRemove(x.id));
      });
      const no = el('button', 'todo-tool', '취소');
      no.type = 'button';
      no.addEventListener('click', () => {
        this.confirmDelete = null;
        this.render();
      });
      tools.append(yes, no);
    } else {
      const del = el('button', 'todo-tool', '지우기');
      del.type = 'button';
      del.addEventListener('click', () => {
        this.confirmDelete = x.id;
        this.render();
      });
      tools.append(del);
    }
    li.appendChild(top);

    const line = this.progressLine(x);
    if (line || (x.status === 'review' && x.missionId)) {
      const sub = el('div', 'todo-sub');
      if (line) sub.appendChild(el('span', undefined, line));
      if (x.status === 'review' && x.missionId) {
        const look = el('button', 'todo-link', '결과물 보기');
        look.type = 'button';
        look.addEventListener('click', () => this.onOpenOutputs());
        sub.appendChild(look);
      }
      li.appendChild(sub);
    }
    li.appendChild(tools);
    return li;
  }
}
