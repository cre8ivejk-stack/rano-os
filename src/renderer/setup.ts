// 처음 켰을 때 안내: 나에 대해 → 구역 폴더 → Claude 연결 → 확인. 저장하면 앱을 다시 시작해 반영한다.
import { el } from './dom.js';
import { button, field } from './orgCommon.js';
import { AccountPanel, authReady } from './account.js';

type Step = 1 | 2 | 3 | 4;
const ZONES: Zone[] = ['work', 'personal'];

export class SetupGuide {
  private overlay = el('div', 'setup-overlay');
  private step: Step = 1;
  private status!: SetupStatus;
  private profile = { name: '', callName: '', org: '', job: '', devLevel: 'none' };
  private roots: Record<Zone, string> = { work: '', personal: '' };
  private checks: Partial<Record<Zone, SetupFolderCheck>> = {};
  private error = '';
  private saving = false;
  private account: AccountPanel | null = null;
  private auth: AuthStatus | null = null;

  /** 안내가 필요하면 띄운다. 띄웠으면 true */
  async openIfNeeded(): Promise<boolean> {
    try {
      this.status = await window.rano.setupStatus();
    } catch {
      return false;
    }
    if (!this.status?.needed) return false;
    const p = this.status.profile;
    this.profile = { name: p.name, callName: p.callName, org: p.org, job: p.job, devLevel: 'none' };
    for (const z of ZONES) this.roots[z] = this.status.zones[z].root;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', '라노 OS 처음 설정');
    document.body.appendChild(this.overlay);
    await this.checkAll();
    this.render();
    return true;
  }

  private async checkAll(): Promise<void> {
    for (const z of ZONES) {
      try {
        this.checks[z] = await window.rano.setupCheckFolder(z, this.roots[z]);
      } catch {
        this.checks[z] = undefined;
      }
    }
  }

  private reason(step: Step): string {
    if (step === 1) return this.profile.name.trim() ? '' : '이름을 적어 주세요.';
    if (step === 2) {
      for (const z of ZONES) {
        const c = this.checks[z];
        if (!c) return '폴더를 확인하는 중이에요.';
        if (!c.ok) return `${this.status.zones[z].label} 폴더: ${c.problem ?? '고를 수 없는 폴더예요'}`;
      }
      if (this.checks.work!.path === this.checks.personal!.path) return '두 구역은 서로 다른 폴더여야 해요.';
    }
    return '';
  }

  private render(): void {
    const card = el('section', 'setup-card');
    const head = el('div', 'setup-head');
    head.appendChild(el('span', 'setup-badge', `처음 설정 ${this.step}/4`));
    head.appendChild(el('h2', 'setup-title', this.step === 1 ? '라노 OS에 오신 걸 환영해요' : this.step === 2 ? '일하는 폴더 정하기' : this.step === 3 ? 'Claude 계정 연결' : '이대로 시작할까요?'));
    card.appendChild(head);

    const body = el('div', 'setup-body');
    if (this.step === 1) this.renderProfile(body);
    else if (this.step === 2) this.renderZones(body);
    else if (this.step === 3) this.renderAccount(body);
    else this.renderConfirm(body);
    card.appendChild(body);

    const nav = el('div', 'setup-nav');
    const prev = button('이전', 'btn');
    prev.disabled = this.step === 1 || this.saving;
    prev.addEventListener('click', () => this.go((this.step - 1) as Step));
    const why = el('p', 'org-why', this.error || this.reason(this.step));
    why.hidden = !(this.error || this.reason(this.step));
    nav.append(prev, why);
    if (this.step < 4) {
      const next = button('다음', 'btn btn-confirm');
      next.disabled = !!this.reason(this.step);
      next.addEventListener('click', () => this.go((this.step + 1) as Step));
      nav.appendChild(next);
    } else {
      const start = button(this.saving ? '저장하는 중…' : '시작하기', 'btn btn-approve');
      start.disabled = this.saving || !!this.reason(1) || !!this.reason(2);
      start.addEventListener('click', () => void this.save());
      nav.appendChild(start);
    }
    card.appendChild(nav);
    this.overlay.replaceChildren(card);
  }

  private go(s: Step): void {
    if (this.step === 3 && s !== 3) this.account?.dispose();
    this.error = '';
    this.step = s;
    this.render();
    this.overlay.querySelector<HTMLElement>('.setup-body input')?.focus();
  }

  private refreshNav(): void {
    const next = this.overlay.querySelector<HTMLButtonElement>('.setup-nav .btn-confirm');
    const why = this.overlay.querySelector<HTMLElement>('.setup-nav .org-why');
    const r = this.reason(this.step);
    if (next) next.disabled = !!r;
    if (why) {
      why.textContent = r;
      why.hidden = !r;
    }
  }

  // ---------- 1. 나에 대해 ----------
  private renderProfile(body: HTMLElement): void {
    const intro = el('div', 'setup-intro');
    intro.appendChild(el('p', undefined, '라노 OS는 내 에이전트 조직을 운영하는 앱이에요. 내가 라노에게 일을 말하면, 라노가 미션별 리더에게 맡기고, 리더가 팀원들과 일을 나눠 해요.'));
    intro.appendChild(el('p', undefined, '파일 쓰기·커밋·삭제 같은 일은 모두 승인함에서 내가 승인한 뒤에만 실행돼요. 먼저 라노가 나를 알 수 있게 몇 가지만 알려 주세요.'));
    body.appendChild(intro);

    const mk = (key: 'name' | 'callName' | 'org' | 'job', label: string, placeholder: string, hint?: string) => {
      const input = el('input', 'org-input');
      input.value = this.profile[key];
      input.maxLength = 80;
      input.placeholder = placeholder;
      input.addEventListener('input', () => {
        this.profile[key] = input.value;
        if (key === 'name') this.refreshNav();
      });
      body.appendChild(field(label, input, hint));
    };
    mk('name', '이름 (꼭 적어야 해요)', '예) 홍길동');
    mk('callName', '라노가 부를 호칭', '예) 길동님', '비우면 "이름+님"으로 불러요.');
    mk('org', '소속', '예) ○○회사 ○○팀');
    mk('job', '하는 일', '예) 서비스 기획·운영');

    const group = el('fieldset', 'org-radio-group');
    group.appendChild(el('legend', 'org-label', '개발 경험 (설명을 얼마나 쉽게 할지 정해요)'));
    for (const [value, title, desc] of [
      ['none', '비개발자', '코드 대신 기능·화면 기준으로 쉬운 말로 설명받아요.'],
      ['some', '조금 알아요', '쉬운 말 위주로, 필요하면 코드도 조금 보여 줘요.'],
      ['dev', '개발자', '코드·명령어·파일 경로를 그대로 보여 줘도 돼요.'],
    ] as const) {
      const label = el('label', `org-radio${this.profile.devLevel === value ? ' on' : ''}`);
      const input = el('input');
      input.type = 'radio';
      input.name = 'setup-dev';
      input.value = value;
      input.checked = this.profile.devLevel === value;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.profile.devLevel = value;
        group.querySelectorAll('.org-radio').forEach((l) => l.classList.toggle('on', l === label));
      });
      const text = el('span', 'org-radio-text');
      text.append(el('strong', undefined, title), el('span', 'org-hint', desc));
      label.append(input, text);
      group.appendChild(label);
    }
    body.appendChild(group);
  }

  // ---------- 2. 구역 폴더 ----------
  private renderZones(body: HTMLElement): void {
    body.appendChild(el('p', 'pane-sub', '일은 구역 두 개로 나눠요. 미션마다 작업 폴더를 그 구역 폴더 안에서 고르고, 두 구역의 미션은 서로의 폴더를 읽지도 쓰지도 못해요.'));
    for (const z of ZONES) {
      const zinfo = this.status.zones[z];
      const box = el('div', 'setup-zone');
      box.appendChild(el('h3', 'org-sub-title', `${zinfo.label} 구역`));
      box.appendChild(el('p', 'org-hint', z === 'work' ? '회사 리포·문서가 모여 있는 폴더예요. 예) ~/work' : '개인 프로젝트·자료를 둘 폴더예요. 예) ~/personal'));
      const row = el('div', 'org-row');
      row.appendChild(el('code', 'mono setup-path', this.checks[z]?.display || this.roots[z] || '(정하지 않음)'));
      const pick = button('다른 폴더 고르기', 'btn btn-small');
      pick.addEventListener('click', () => void this.pick(z));
      row.appendChild(pick);
      box.appendChild(row);
      const c = this.checks[z];
      if (c && !c.ok) box.appendChild(el('p', 'org-problem', c.problem ?? '고를 수 없는 폴더예요'));
      else if (c && !c.exists) box.appendChild(el('p', 'org-hint', '아직 없는 폴더예요. 시작할 때 새로 만들어요.'));
      else if (c) box.appendChild(el('p', 'org-ok', '있는 폴더예요. 안의 파일은 미션을 만들 때 고른 폴더만 쓰여요.'));
      body.appendChild(box);
    }
  }

  private async pick(z: Zone): Promise<void> {
    let p: string | null = null;
    try {
      p = await window.rano.setupPickFolder(z, this.roots[z]);
    } catch {
      this.error = '폴더 선택 창을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.';
    }
    if (p) {
      this.roots[z] = p;
      this.checks[z] = await window.rano.setupCheckFolder(z, p).catch(() => undefined);
      this.error = '';
    }
    this.render();
  }

  // ---------- 3. Claude 연결 ----------
  private renderAccount(body: HTMLElement): void {
    body.appendChild(el('p', 'pane-sub', '라노와 리더·팀원은 내 Claude 계정으로 일해요. 사용량도 이 계정에서 나가요.'));
    const host = el('div');
    body.appendChild(host);
    this.account = new AccountPanel(host, (s) => {
      this.auth = s;
      const note = this.overlay.querySelector<HTMLElement>('.setup-auth-note');
      if (note) note.hidden = authReady(s);
    });
    if (this.auth) {
      this.account.render();
    }
    void this.account.refresh();
    const note = el('p', 'org-warning setup-auth-note', '아직 연결하지 않아도 다음으로 갈 수 있어요. 연결은 나중에 오른쪽 위 Claude 버튼에서 할 수 있어요.');
    note.hidden = authReady(this.auth);
    body.appendChild(note);
  }

  // ---------- 4. 확인 ----------
  private renderConfirm(body: HTMLElement): void {
    const rows = el('dl', 'appr-rows org-summary');
    const add = (k: string, v: string) => {
      rows.appendChild(el('dt', undefined, k));
      rows.appendChild(el('dd', undefined, v));
    };
    const dev: Record<string, string> = { none: '비개발자', some: '조금 알아요', dev: '개발자' };
    add('이름', this.profile.name.trim());
    add('호칭', this.profile.callName.trim() || `${this.profile.name.trim()}님`);
    add('소속', this.profile.org.trim() || '(적지 않음)');
    add('하는 일', this.profile.job.trim() || '(적지 않음)');
    add('개발 경험', dev[this.profile.devLevel] ?? this.profile.devLevel);
    for (const z of ZONES) add(`${this.status.zones[z].label} 폴더`, `${this.checks[z]?.display ?? this.roots[z]}${this.checks[z]?.exists ? '' : ' (새로 만듦)'}`);
    add('Claude', authReady(this.auth) ? (this.auth?.method === 'apiKey' ? 'API 키로 연결됨' : `연결됨${this.auth?.account?.email ? ` (${this.auth.account.email})` : ''}`) : '아직 연결 안 함 (나중에 오른쪽 위 버튼에서)');
    add('라노 데이터', `${this.status.dataDir} (설정·기억·기록이 여기 저장돼요)`);
    body.appendChild(rows);
    body.appendChild(el('p', 'org-hint', '시작하면 앱이 한 번 다시 켜져요. 그다음 라노에게 하고 싶은 일을 말하거나, 조직 탭에서 첫 미션을 만들면 돼요. 이름·호칭 같은 정보는 나중에 라노에게 말해서 바꿀 수 있어요.'));
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.error = '';
    this.render();
    try {
      const res = await window.rano.setupSave({ profile: { ...this.profile }, zones: { ...this.roots } });
      if (res?.ok) {
        this.overlay.querySelector('.setup-nav .org-why')?.replaceWith(el('p', 'org-ok', res.message));
        await window.rano.orgRestart();
        return;
      }
      this.error = res?.message || '저장하지 못했어요.';
    } catch {
      this.error = '저장하지 못했어요. 잠시 뒤 다시 눌러 주세요.';
    }
    this.saving = false;
    this.render();
  }
}
