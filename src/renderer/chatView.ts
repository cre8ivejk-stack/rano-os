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

  /** 말풍선에 마우스를 올리거나 뗐을 때: 그 말이 다룬 할 일 id (없으면 null) */
  onHoverTodos: (ids: string[] | null) => void = () => {};

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
    meta.appendChild(el('span', 'msg-time', formatTime(m.at)));

    const bubble = el('div', 'bubble');
    const text = typeof m.text === 'string' ? m.text : '';
    if (style.rich) renderRich(bubble, text);
    else bubble.textContent = text;

    row.appendChild(meta);
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
