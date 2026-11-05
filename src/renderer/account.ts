// Claude 계정 연결 화면: 머리말 오른쪽 버튼 + 계정 창. 처음 설정 안내에서도 같은 패널을 쓴다.
import { el } from './dom.js';
import { button } from './orgCommon.js';

const PLAN: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

function accountText(s: AuthStatus): string {
  if (s.method === 'apiKey') return s.apiKeySaved ? `API 키로 일해요 (${s.apiKeyHint ?? ''})` : 'API 키가 없어요';
  if (!s.loggedIn) return '로그인이 필요해요';
  const a = s.account;
  const plan = a?.plan ? ` · ${PLAN[a.plan] ?? a.plan}` : '';
  return `${a?.kind === 'console' ? 'Console 계정' : 'Claude 계정'}${plan}${a?.email ? ` · ${a.email}` : ''}`;
}

export function authReady(s: AuthStatus | null): boolean {
  return !!s && (s.method === 'apiKey' ? s.apiKeySaved : s.loggedIn);
}

/** 계정 패널 본문. 상태가 바뀌면 onChange 를 부른다 */
export class AccountPanel {
  private status: AuthStatus | null = null;
  private loginUrl = '';
  private loginKind: 'claudeai' | 'console' | null = null;
  private message = '';
  private messageOk = true;
  private busy = false;

  constructor(
    private root: HTMLElement,
    private onChange: (s: AuthStatus | null) => void = () => {},
  ) {}

  get current(): AuthStatus | null {
    return this.status;
  }

  async refresh(): Promise<void> {
    try {
      this.status = await window.rano.authStatus();
    } catch {
      this.status = null;
    }
    this.render();
    this.onChange(this.status);
  }

  /** 창을 닫을 때: 진행 중인 로그인을 멈춘다 */
  dispose(): void {
    if (this.loginKind) void window.rano.authCancelLogin();
    this.loginKind = null;
  }

  private say(text: string, ok: boolean): void {
    this.message = text;
    this.messageOk = ok;
  }

  private async act(fn: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const r = await fn();
      this.say(r.message, r.ok);
    } catch {
      this.say('처리하지 못했어요. 잠시 뒤 다시 해 주세요.', false);
    }
    this.busy = false;
    await this.refresh();
  }

  private async startLogin(kind: 'claudeai' | 'console'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('', true);
    this.render();
    try {
      const r = await window.rano.authStartLogin(kind);
      if (r.ok && r.url) {
        this.loginKind = kind;
        this.loginUrl = r.url;
      } else this.say(r.message ?? '로그인을 시작하지 못했어요.', false);
    } catch {
      this.say('로그인을 시작하지 못했어요.', false);
    }
    this.busy = false;
    this.render();
    this.root.querySelector<HTMLInputElement>('.acct-code')?.focus();
  }

  render(): void {
    const wrap = el('div', 'acct');
    const s = this.status;
    const now = el('div', `acct-now${authReady(s) ? ' ok' : ' warn'}`);
    now.appendChild(el('span', 'acct-dot'));
    now.appendChild(el('strong', undefined, s ? accountText(s) : '상태를 읽는 중이에요…'));
    if (s?.error) now.appendChild(el('span', 'org-hint', ` ${s.error}`));
    wrap.appendChild(now);

    // ---- Claude 계정 ----
    const sec = el('section', 'acct-sec');
    sec.appendChild(el('h3', 'org-sub-title', 'Claude 계정으로 일하기 (권장)'));
    sec.appendChild(el('p', 'org-hint', 'Claude Pro·Max 구독 계정이나 Anthropic Console 계정으로 로그인해요. 이 맥의 Claude Code 와 같은 로그인을 함께 써요.'));
    if (this.loginKind) {
      const box = el('div', 'acct-login');
      box.appendChild(el('p', undefined, '브라우저에 로그인 페이지를 열었어요. 로그인한 뒤 화면에 나온 코드를 복사해서 아래에 붙여 넣어 주세요.'));
      const row = el('div', 'org-row');
      const code = el('input', 'org-input acct-code');
      code.placeholder = '코드 붙여 넣기';
      code.autocomplete = 'off';
      code.spellcheck = false;
      const ok = button(this.busy ? '확인하는 중…' : '확인', 'btn btn-confirm');
      ok.disabled = this.busy;
      const submit = () => {
        if (!code.value.trim()) return;
        const v = code.value;
        this.loginKind = null;
        void this.act(() => window.rano.authSubmitCode(v));
      };
      ok.addEventListener('click', submit);
      code.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      row.append(code, ok);
      box.appendChild(row);
      const row2 = el('div', 'org-row');
      const reopen = button('로그인 페이지 다시 열기', 'btn btn-small');
      reopen.addEventListener('click', () => void window.rano.authOpenLoginPage(this.loginUrl));
      const cancel = button('취소', 'btn btn-small btn-plain');
      cancel.addEventListener('click', () => {
        this.dispose();
        this.render();
      });
      row2.append(reopen, cancel);
      box.appendChild(row2);
      sec.appendChild(box);
    } else {
      const row = el('div', 'org-row');
      if (s?.loggedIn) {
        if (s.method === 'apiKey') {
          const use = button('Claude 계정으로 일하기', 'btn btn-small btn-confirm');
          use.addEventListener('click', () => void this.act(() => window.rano.authUseMethod('max')));
          row.appendChild(use);
        }
        const other = button('다른 계정으로 로그인', 'btn btn-small');
        other.addEventListener('click', () => void this.startLogin('claudeai'));
        const out = button('로그아웃', 'btn btn-small btn-plain');
        out.addEventListener('click', () => void this.act(() => window.rano.authLogout()));
        row.append(other, out);
      } else {
        const sub = button('Claude 구독 계정으로 로그인', 'btn btn-confirm');
        sub.addEventListener('click', () => void this.startLogin('claudeai'));
        const con = button('Console 계정으로 로그인', 'btn');
        con.addEventListener('click', () => void this.startLogin('console'));
        row.append(sub, con);
      }
      for (const b of Array.from(row.querySelectorAll('button'))) b.disabled = this.busy;
      sec.appendChild(row);
      if (s?.loggedIn) sec.appendChild(el('p', 'org-hint', '로그아웃하면 이 맥의 Claude Code 도 함께 로그아웃돼요.'));
    }
    wrap.appendChild(sec);

    // ---- API 키 ----
    const keySec = el('section', 'acct-sec');
    keySec.appendChild(el('h3', 'org-sub-title', 'API 키로 일하기'));
    keySec.appendChild(el('p', 'org-hint', 'Anthropic API 키(사용한 만큼 요금)를 쓸 수도 있어요. 키는 맥 키체인으로 암호화해서 이 맥에만 저장하고, 화면에 다시 보여 주지 않아요.'));
    const row = el('div', 'org-row');
    const key = el('input', 'org-input');
    key.type = 'password';
    key.placeholder = s?.apiKeySaved ? `저장된 키 ${s.apiKeyHint ?? ''} · 바꾸려면 새 키 붙여 넣기` : 'sk-ant-…';
    key.autocomplete = 'off';
    const save = button('저장하고 API 키로 일하기', 'btn btn-small');
    save.addEventListener('click', () => {
      const v = key.value;
      key.value = '';
      void this.act(() => window.rano.authSaveApiKey(v));
    });
    row.append(key, save);
    keySec.appendChild(row);
    if (s?.apiKeySaved) {
      const row2 = el('div', 'org-row');
      if (s.method !== 'apiKey') {
        const use = button('저장된 키로 일하기', 'btn btn-small');
        use.addEventListener('click', () => void this.act(() => window.rano.authUseMethod('apiKey')));
        row2.appendChild(use);
      }
      const rm = button('저장된 키 지우기', 'btn btn-small btn-plain');
      rm.addEventListener('click', () => void this.act(() => window.rano.authRemoveApiKey()));
      row2.appendChild(rm);
      keySec.appendChild(row2);
    }
    for (const b of Array.from(keySec.querySelectorAll('button'))) b.disabled = this.busy;
    wrap.appendChild(keySec);

    if (this.message) wrap.appendChild(el('p', this.messageOk ? 'org-ok' : 'org-problem', this.message));
    this.root.replaceChildren(wrap);
  }
}

/** 머리말 오른쪽 계정 버튼과 계정 창 */
export class AccountButton {
  private btn = el('button', 'acct-btn');
  private panelStatus: AuthStatus | null = null;

  constructor(host: HTMLElement) {
    this.btn.type = 'button';
    this.btn.addEventListener('click', () => this.open());
    host.appendChild(this.btn);
    this.show(null);
    void this.refresh();
    // 로그인이 만료됐는지 가끔 다시 본다
    window.setInterval(() => void this.refresh(), 10 * 60_000);
  }

  async refresh(): Promise<void> {
    try {
      this.show(await window.rano.authStatus());
    } catch {
      this.show(null);
    }
  }

  private show(s: AuthStatus | null): void {
    this.panelStatus = s;
    const ok = authReady(s);
    this.btn.className = `acct-btn${s ? (ok ? ' ok' : ' warn') : ''}`;
    this.btn.replaceChildren(el('span', 'acct-dot'), el('span', undefined, !s ? 'Claude' : ok ? (s.method === 'apiKey' ? 'Claude · API 키' : `Claude · ${PLAN[s.account?.plan ?? ''] ?? '연결됨'}`) : 'Claude 로그인 필요'));
    this.btn.title = s ? accountText(s) : 'Claude 계정 연결';
  }

  open(): void {
    const overlay = el('div', 'org-modal-overlay');
    const box = el('div', 'org-modal acct-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Claude 계정 연결');
    box.appendChild(el('h3', 'org-modal-title', 'Claude 계정 연결'));
    const body = el('div', 'org-modal-body');
    const panel = new AccountPanel(body, (s) => this.show(s));
    const actions = el('div', 'org-modal-actions');
    const close = button('닫기', 'btn');
    actions.appendChild(close);
    box.append(body, actions);
    overlay.appendChild(box);
    const done = () => {
      panel.dispose();
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      void this.refresh();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done();
    };
    close.addEventListener('click', done);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    if (this.panelStatus) panel.render();
    void panel.refresh();
    close.focus();
  }
}
