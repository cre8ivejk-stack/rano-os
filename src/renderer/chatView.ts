// 대화 목록 하나를 그리는 부품. 라노 대화와 리포 리더 대화가 함께 쓴다.
import { dayKey, el, formatDay, formatTime, renderRich } from './dom.js';
import { messageImages } from './attach.js';

export interface SpeakerStyle {
  side: 'left' | 'right';
  name?: string; // 말풍선 위 이름 (없으면 시각만)
  className: string; // 말풍선 모양
  rich: boolean; // 간단한 마크다운 표현
}

export class ChatView {
  private shownIds = new Set<string>();
  private lastDayKey: string | null = null;
  private ready = false;

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

  addMessage(m: ChatMessage, forceScroll: boolean): void {
    if (!m || typeof m.id !== 'string' || this.shownIds.has(m.id)) return;
    this.shownIds.add(m.id);

    const style = this.speaker(m.role);
    const row = el('div', `item msg ${style.side === 'right' ? 'msg-right' : 'msg-left'} ${style.className}`);
    const meta = el('div', 'msg-meta');
    if (style.name) meta.appendChild(el('span', 'msg-name', style.name));
    meta.appendChild(el('span', 'msg-time', formatTime(m.at)));

    const bubble = el('div', 'bubble');
    const text = typeof m.text === 'string' ? m.text : '';
    if (style.rich) renderRich(bubble, text);
    else bubble.textContent = text;

    row.appendChild(meta);
    row.appendChild(bubble);
    if (Array.isArray(m.attachments) && m.attachments.length) row.appendChild(messageImages(m.attachments));
    this.append(row, m.at, forceScroll || style.side === 'right');
  }

  /** 대화 흐름 사이에 카드 같은 요소를 끼워 넣는다 (예: 라노의 미션 구성안) */
  addCard(node: HTMLElement, at: string): void {
    this.append(node, at, false);
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
