// 대화 목록 하나를 그리는 부품. 라노 대화와 리포 리더 대화가 함께 쓴다.
import { dayKey, el, formatDay, formatTime, renderRich } from './dom.js';
import { messageImages } from './attach.js';

export interface SpeakerStyle {
  side: 'left' | 'right';
  name?: string; // 말풍선 위 이름 (없으면 시각만)
  className: string; // 말풍선 모양
  rich: boolean; // 간단한 마크다운 표현
}

/** 답 위 인용 한 줄에 쓸 짧은 글 */
function shortQuote(text: string, max = 30): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim() || '(그림)';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export class ChatView {
  private shownIds = new Set<string>();
  private textById = new Map<string, string>(); // 인용 한 줄용: 말 id → 글
  private lastDayKey: string | null = null;
  private ready = false;
  private todosByMsg = new Map<string, string[]>(); // 말 id → 그 말이 다룬 할 일 id (라노 답과, 그 답이 답한 내 말)
  private filterId: string | null = null;
  /** 긴 왼쪽 말(리더 보고 등)을 접어서 보일지(리더 대화 창에서 켠다) */
  clampLong = false;
  /** 말의 짧은 판을 만든다(예: 배정 말에서 앱 안내문을 뺀 글). 돌려준 글이 원문과 다르면 [전문 보기]가 붙는다 */
  shortOf: (m: ChatMessage) => string | null = () => null;

  /** 말풍선에 마우스를 올리거나 뗐을 때: 그 말이 다룬 할 일 id (없으면 null) */
  onHoverTodos: (ids: string[] | null) => void = () => {};
  /** 선택 단추를 눌렀을 때: 그 말을 보낸다. null 이면 [직접 적기](입력창으로) */
  onChoice: (text: string | null) => void = () => {};
  /** 보고 카드의 [결과물 보기] */
  onOpenOutputs: () => void = () => {};
  /** 보고 카드의 [확인 완료]: 그 할 일을 완료로. 성공하면 true */
  onConfirmTodo: (todoId: string) => Promise<boolean> = async () => false;
  /** 보고 카드 머리글에 덧붙일 글(걸린 시간·승인 카드 수). 없으면 빈 글 */
  reportMeta: (taskId: string) => string = () => '';
  /** 미션 id → 이름 */
  missionName: (id: string) => string = (id) => id;
  /** 그 할 일이 지금 확인 요청 상태인지([확인 완료] 단추를 보일지) */
  todoNeedsConfirm: (todoId: string) => boolean = () => false;

  constructor(
    private scrollEl: HTMLElement,
    private logEl: HTMLElement,
    private emptyEl: HTMLElement,
    private speaker: (role: ChatRole) => SpeakerStyle,
  ) {}

  isNearBottom(): boolean {
    return this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight < 80;
  }
  scrollToBottom(): void {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  // 기록을 다 불러온 뒤에 부른다. 그 전에는 빈 안내를 띄우지 않는다.
  setReady(ready: boolean): void {
    this.ready = ready;
    this.updateEmpty();
  }

  clear(): void {
    this.shownIds.clear();
    this.todosByMsg.clear();
    this.filterId = null;
    this.textById.clear();
    this.lastDayKey = null;
    this.ready = false;
    for (const node of Array.from(this.logEl.querySelectorAll('.item'))) node.remove();
    this.updateEmpty();
  }

  private updateEmpty(): void {
    const hasItems = this.logEl.querySelector('.item') !== null;
    this.emptyEl.hidden = hasItems || !this.ready;
  }

  private append(node: HTMLElement, at: string, forceScroll: boolean): void {
    const stick = forceScroll || this.isNearBottom();
    const key = dayKey(at);
    if (key !== this.lastDayKey) {
      this.lastDayKey = key;
      this.logEl.appendChild(el('div', 'item day', formatDay(at)));
    }
    this.logEl.appendChild(node);
    this.updateEmpty();
    if (stick) this.scrollToBottom();
  }

  /** 바로 앞(잠깐 뜨는 안내·날짜 줄은 건너뜀)에 있는 말 id */
  private previousMessageId(): string | null {
    let n = this.logEl.lastElementChild as HTMLElement | null;
    while (n && (n.classList.contains('transient') || n.classList.contains('day'))) n = n.previousElementSibling as HTMLElement | null;
    return n && n.classList.contains('msg') ? n.dataset.id ?? null : null;
  }

  addMessage(m: ChatMessage, forceScroll: boolean): void {
    if (!m || typeof m.id !== 'string' || this.shownIds.has(m.id)) return;
    this.shownIds.add(m.id);

    // 새 말이 오면 앞 답의 선택 단추는 치운다(가장 최근 라노 답에만 둔다)
    for (const old of Array.from(this.logEl.querySelectorAll('.choices'))) old.remove();
    const style = this.speaker(m.role);
    const row = el('div', `item msg ${style.side === 'right' ? 'msg-right' : 'msg-left'} ${style.className}`);
    row.dataset.id = m.id;
    const meta = el('div', 'msg-meta');
    if (style.name) meta.appendChild(el('span', 'msg-name', style.name));
    // 휴대폰(텔레그램)에서 보낸 말은 📱 아이콘으로 표시 (예전 기록의 "(휴대폰에서 보냄)" 글도 아이콘으로 바꿔 보여 줌)
    const oldMobile = /\n*\(휴대폰에서 (보냄|사진만 보냄)\)\s*$/;
    const fromPhone = m.via === 'mobile' || (m.role === 'user' && oldMobile.test(m.text ?? ''));
    if (fromPhone) {
      const icon = el('span', 'msg-via', '📱');
      icon.title = '휴대폰(텔레그램)에서 보냄';
      icon.setAttribute('aria-label', '휴대폰에서 보냄');
      meta.appendChild(icon);
      m = { ...m, text: (m.text ?? '').replace(oldMobile, '') || '(사진)' };
    }
    if (m.role === 'user' && typeof m.toMission === 'string' && m.toMission) meta.appendChild(el('span', 'msg-to', `→ ${this.missionName(m.toMission)} 리더에게`));
    meta.appendChild(el('span', 'msg-time', formatTime(m.at)));

    const text = typeof m.text === 'string' ? m.text : '';
    const form = m.role === 'rano' ? m.form : undefined;
    let bubble: HTMLElement;
    if (form === 'ack') {
      // 접수 말: 한 줄로 접고, 누르면 맡긴 내용을 펼친다
      row.classList.add('msg-ack');
      bubble = el('div', 'ack');
      const line = el('div', 'ack-line');
      line.appendChild(el('span', 'ack-text', `↳ ${m.mission ?? '미션'} 리더에게 맡김 · ${formatTime(m.at)}`));
      const more = el('button', 'ack-more', '맡긴 내용 보기');
      more.type = 'button';
      const body = el('div', 'bubble ack-body');
      body.hidden = true;
      renderRich(body, text);
      more.addEventListener('click', () => {
        body.hidden = !body.hidden;
        more.textContent = body.hidden ? '맡긴 내용 보기' : '접기';
      });
      line.appendChild(more);
      bubble.append(line, body);
    } else if (form === 'report' && m.report) {
      // 리더 보고: 카드. 요약 앞부분만 먼저 보이고 펼칠 수 있다
      row.classList.add('msg-report');
      bubble = el('div', `bubble report-card${m.report.ok ? '' : ' report-stopped'}`);
      const head = el('div', 'report-head');
      head.appendChild(el('span', `report-pill${m.report.ok ? '' : ' stopped'}`, m.report.ok ? '보고' : '중단'));
      head.appendChild(el('span', 'report-title', `${m.mission ?? '미션'} 리더 · ${m.report.title}`));
      const extra = m.report.taskId ? this.reportMeta(m.report.taskId) : '';
      if (extra) head.appendChild(el('span', 'report-meta', extra));
      const body = el('div', 'report-body');
      renderRich(body, text);
      const long = text.length > 320 || text.split('\n').length > 8;
      if (long) body.classList.add('clamped');
      const acts = el('div', 'report-acts');
      if (long) {
        const more = el('button', 'btn btn-small btn-plain', '전체 보고 펼치기');
        more.type = 'button';
        more.addEventListener('click', () => {
          const open = body.classList.toggle('clamped') === false;
          more.textContent = open ? '접기' : '전체 보고 펼치기';
        });
        acts.appendChild(more);
      }
      const out = el('button', 'btn btn-small btn-plain', '결과물 보기');
      out.type = 'button';
      out.addEventListener('click', () => this.onOpenOutputs());
      acts.appendChild(out);
      const todoId = Array.isArray(m.todoIds) ? m.todoIds[0] : undefined;
      if (m.report.ok && todoId && this.todoNeedsConfirm(todoId)) {
        const ok = el('button', 'btn btn-small report-confirm', '확인 완료');
        ok.type = 'button';
        ok.title = '결과를 확인했으면 눌러 주세요. 연결된 할 일이 완료로 바뀌어요';
        ok.addEventListener('click', () => {
          ok.disabled = true;
          void this.onConfirmTodo(todoId).then((done) => {
            ok.textContent = done ? '완료로 표시했어요' : '확인 완료';
            ok.disabled = done;
          });
        });
        acts.appendChild(ok);
      }
      bubble.append(head, body, acts);
    } else {
      bubble = el('div', 'bubble');
      const short = this.shortOf(m);
      const body = el('div', 'bubble-body');
      const put = (t: string) => {
        body.replaceChildren();
        if (style.rich) renderRich(body, t);
        else body.textContent = t;
      };
      put(short !== null && short !== text ? short : text);
      bubble.appendChild(body);
      if (short !== null && short !== text) {
        // 짧은 판과 전문을 오간다
        const more = el('button', 'bubble-more', '지시 전문 보기');
        more.type = 'button';
        let full = false;
        more.addEventListener('click', () => {
          full = !full;
          put(full ? text : short);
          more.textContent = full ? '짧게 보기' : '지시 전문 보기';
        });
        bubble.appendChild(more);
      } else if (this.clampLong && style.side === 'left' && (text.length > 600 || text.split('\n').length > 12)) {
        body.classList.add('clamped');
        const more = el('button', 'bubble-more', '전체 펼치기');
        more.type = 'button';
        more.addEventListener('click', () => {
          const open = body.classList.toggle('clamped') === false;
          more.textContent = open ? '접기' : '전체 펼치기';
        });
        bubble.appendChild(more);
      }
    }

    if (form !== 'ack') row.appendChild(meta);
    // 답이 질문 바로 아래가 아니면(그 사이 보고·다른 말이 끼었으면) 답 위에 인용 한 줄
    const replyTo = Array.isArray(m.replyTo) ? m.replyTo.filter((id) => typeof id === 'string') : [];
    if (replyTo.length) {
      const prev = this.previousMessageId();
      const firstText = this.textById.get(replyTo[0]);
      if ((!prev || !replyTo.includes(prev)) && firstText !== undefined) {
        const quote = el('div', 'msg-meta', `↪ ‘${shortQuote(firstText)}’${replyTo.length > 1 ? ` 외 ${replyTo.length - 1}개` : ''}에 대한 답`);
        quote.style.fontStyle = 'italic';
        row.appendChild(quote);
      }
    }
    // 할 일 연결: 라노 답에 적힌 할 일을 그 답과, 그 답이 답한 내 말에 잇는다
    const todoIds = Array.isArray(m.todoIds) ? m.todoIds.filter((id) => typeof id === 'string') : [];
    if (todoIds.length) {
      this.linkTodos(row, m.id, todoIds);
      for (const uid of replyTo) {
        const urow = this.logEl.querySelector<HTMLElement>(`.msg[data-id="${CSS.escape(uid)}"]`);
        if (urow) this.linkTodos(urow, uid, todoIds);
      }
    }
    row.addEventListener('mouseenter', () => {
      const ids = this.todosByMsg.get(m.id);
      if (ids?.length) this.onHoverTodos(ids);
    });
    row.addEventListener('mouseleave', () => this.onHoverTodos(null));
    row.appendChild(bubble);
    // 고를 것이 있는 답: 답 아래에 단추(가장 최근 답에만 남는다)
    const choices = m.role === 'rano' && Array.isArray(m.choices) ? m.choices.filter((c) => typeof c === 'string' && c.trim()).slice(0, 3) : [];
    if (choices.length) {
      const box = el('div', 'choices');
      choices.forEach((c, i) => {
        const b = el('button', `choice${i === 0 ? ' choice-main' : ''}`, c);
        b.type = 'button';
        b.addEventListener('click', () => {
          box.remove();
          this.onChoice(c);
        });
        box.appendChild(b);
      });
      const own = el('button', 'choice choice-own', '직접 적기');
      own.type = 'button';
      own.addEventListener('click', () => this.onChoice(null));
      box.appendChild(own);
      row.appendChild(box);
    }
    if (Array.isArray(m.attachments) && m.attachments.length) row.appendChild(messageImages(m.attachments));
    this.textById.set(m.id, text);
    this.append(row, m.at, forceScroll || style.side === 'right');
  }

  private linkTodos(row: HTMLElement, msgId: string, ids: string[]): void {
    const all = [...new Set([...(this.todosByMsg.get(msgId) ?? []), ...ids])];
    this.todosByMsg.set(msgId, all);
    row.dataset.todos = all.join(' ');
    row.classList.add('has-todo');
    if (this.filterId) row.classList.toggle('msg-dim', !all.includes(this.filterId));
  }

  /** 가장 최근 라노 답이 다룬 할 일 */
  latestTodos(): string[] {
    const rows = this.logEl.querySelectorAll<HTMLElement>('.msg.msg-left');
    const last = rows[rows.length - 1];
    return last?.dataset.todos ? last.dataset.todos.split(' ') : [];
  }

  /** 그 할 일에 관한 말만 또렷하게(나머지는 흐리게). null 이면 모두 보통으로. 돌려주는 값은 관련 말 수 */
  filterTodo(id: string | null): number {
    this.filterId = id;
    let n = 0;
    let last: HTMLElement | null = null;
    for (const row of Array.from(this.logEl.querySelectorAll<HTMLElement>('.msg'))) {
      const hit = !!id && (row.dataset.todos ?? '').split(' ').includes(id);
      row.classList.toggle('msg-dim', !!id && !hit);
      row.classList.toggle('msg-hit', hit);
      if (hit) {
        n++;
        last = row;
      }
    }
    if (last) last.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return n;
  }

  /** 대화 흐름 사이에 카드 같은 요소를 끼워 넣는다 (예: 라노의 미션 구성안) */
  addCard(node: HTMLElement, at: string): void {
    this.append(node, at, false);
  }

  /** 잠깐 뜨는 안내 줄(예: "앞 일을 마치면 바로 답해요"). 돌려준 요소를 지우면 사라진다. 인용 판단에서는 건너뛴다 */
  addTransient(text: string, at: string, side: 'left' | 'right' = 'left'): HTMLElement {
    const line = el('div', 'item activity transient');
    line.appendChild(el('span', 'activity-text', text));
    if (side === 'right') line.style.alignSelf = 'flex-end';
    this.append(line, at, true);
    return line;
  }

  addActivity(text: string, at: string): void {
    const line = el('div', 'item activity');
    line.appendChild(el('span', 'activity-text', `· ${text}`));
    line.appendChild(el('span', 'line-time', formatTime(at)));
    this.append(line, at, false);
  }

  addError(text: string, at: string): void {
    const line = el('div', 'item error');
    line.setAttribute('role', 'alert');
    line.appendChild(el('span', 'error-text', text));
    line.appendChild(el('span', 'line-time', formatTime(at)));
    this.append(line, at, true);
  }
}
