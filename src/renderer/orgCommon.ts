// 조직 화면 공통 도구: 알림 줄, 경로 줄이기, 역할 설명, 앱 안 확인 창.
import { el } from './dom.js';

/** 홈 폴더를 ~ 로 줄인다 */
export function tildify(abs: string): string {
  return String(abs ?? '').replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

/** 할 수 있는 일: 읽기만 / 파일 쓰기 / 명령 실행 */
export function abilityText(r: { canWrite: boolean; canRun: boolean }): string {
  const bits: string[] = [];
  if (r.canWrite) bits.push('파일 쓰기');
  if (r.canRun) bits.push('명령 실행');
  return bits.length ? `읽기 + ${bits.join(' + ')}` : '읽기만';
}

export const SOURCE_LABEL: Record<RoleInfo['source'], string> = {
  work: '외부 역할 폴더 · 읽기만',
  pool: '라노 인재풀',
  mission: '미션 전용',
};

export const ROLE_NAME_RULE = /^[a-z0-9][a-z0-9-]*$/;

/** 화면 위 알림 줄. ok=false 면 빨간색 */
export class Notice {
  constructor(private node: HTMLElement) {}
  show(text: string, ok = true): void {
    this.node.textContent = text;
    this.node.classList.toggle('org-notice-error', !ok);
    this.node.hidden = !text;
  }
  clear(): void {
    this.node.hidden = true;
    this.node.textContent = '';
  }
}

/** 라벨이 붙은 체크박스 하나 */
export function checkbox(labelText: string, checked: boolean, className = 'org-check'): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = el('label', className);
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  label.appendChild(input);
  label.appendChild(el('span', undefined, labelText));
  return { label, input };
}

export function button(text: string, className = 'btn'): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
}

let fieldSeq = 0;
/** 라벨과 입력칸을 이어 준다 */
export function field<T extends HTMLInputElement | HTMLTextAreaElement>(labelText: string, input: T, hint?: string): HTMLDivElement {
  const box = el('div', 'org-field');
  const label = el('label', 'org-label', labelText);
  input.id = `org-f-${++fieldSeq}`;
  label.htmlFor = input.id;
  box.append(label, input);
  if (hint) box.appendChild(el('p', 'org-hint', hint));
  return box;
}

/**
 * 앱 안 확인 창. body 를 채워 넣고, okButton 을 누르면 true, 취소·Esc 면 false.
 * okEnabled 로 [허용] 버튼을 켜고 끌 수 있다(예: "이해했어요" 체크).
 */
export function openModal(opts: {
  title: string;
  build: (body: HTMLDivElement, setOkEnabled: (on: boolean) => void) => void;
  okText: string;
  cancelText?: string;
  okInitiallyEnabled?: boolean;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const overlay = el('div', 'org-modal-overlay');
    const box = el('div', 'org-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const title = el('h3', 'org-modal-title', opts.title);
    title.id = `org-modal-title-${++fieldSeq}`;
    box.setAttribute('aria-labelledby', title.id);
    const body = el('div', 'org-modal-body');
    const actions = el('div', 'org-modal-actions');
    const cancel = button(opts.cancelText ?? '취소', 'btn btn-plain');
    const ok = button(opts.okText, opts.danger ? 'btn btn-reject' : 'btn btn-confirm');
    ok.disabled = opts.okInitiallyEnabled === false;
    actions.append(cancel, ok);
    box.append(title, body, actions);
    overlay.appendChild(box);
    opts.build(body, (on) => {
      ok.disabled = !on;
    });

    const close = (result: boolean) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Tab') {
        // 창 안에서만 맴돌게 한다.
        const items = Array.from(box.querySelectorAll<HTMLElement>('button, input, textarea, select')).filter((n) => !(n as HTMLButtonElement).disabled);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => {
      if (!ok.disabled) close(true);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    (box.querySelector<HTMLElement>('input, button.btn-plain') ?? cancel).focus();
  });
}
