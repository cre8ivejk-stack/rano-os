// 조직 화면: 미션 추가·고치기 5단계 안내 (이름·목표 → 작업 폴더 → 권한 → 팀 → 확인).
// 폴더 점검은 본체가 하고(이름·목록만 봄), 화면은 그 결과를 보여 주고 고르게만 한다.
import { el, zoneInfo } from './dom.js';
import { SOURCE_LABEL, abilityText, button, checkbox, field, openModal, tildify, type Notice } from './orgCommon.js';

type Step = 1 | 2 | 3 | 4 | 5;
const STEP_LABELS: Record<Step, string> = { 1: '이름·목표', 2: '작업 폴더', 3: '권한', 4: '팀', 5: '확인' };
const STEPS: Step[] = [1, 2, 3, 4, 5];

interface RefFolder {
  path: string;
  display: string;
  warnings: string[];
}

export class MissionWizard {
  /** 목록으로 돌아갈 때. changed=true 면 목록을 새로 불러온다 */
  onDone: (changed: boolean) => void = () => {};
  /** 4단계에서 [+ 역할 만들기] 를 눌렀을 때 */
  onCreateRole: () => void = () => {};

  private editing: MissionSummary | null = null;
  private step: Step = 1;
  private zone: Zone = 'work';
  private name = '';
  private goal = '';
  private targetPath = '';
  private target: FolderInspection | null = null;
  private inspecting = false;
  private blockOptions: string[] = [];
  private blocked = new Set<string>();
  private refs: RefFolder[] = [];
  private refProblem = '';
  private writeMode: 'readOnly' | 'approval' = 'readOnly';
  private writeConfirmed = false;
  private roles = new Set<string>();
  private reviewers = new Set<string>();
  private allRoles: RoleInfo[] = [];
  private rolesFailed = false;
  private submitting = false;
  private result: AdminResult | null = null;
  private proposal: MissionProposal | null = null; // 라노의 구성안으로 채웠는지
  private pendingRoles = new Map<string, RoleDraft>(); // 미션을 만들 때 인재풀에 함께 만들 새 역할

  constructor(
    private root: HTMLElement,
    private notice: Notice,
  ) {}

  /** 새 미션이면 m 없이, 고치기면 그 미션 요약으로 */
  open(m?: MissionSummary): void {
    this.editing = m ?? null;
    this.step = 1;
    this.zone = m?.zone ?? 'work';
    this.name = m?.name ?? '';
    this.goal = m?.goal ?? '';
    this.targetPath = m?.target ?? '';
    this.target = null;
    this.blockOptions = m ? [...m.blocked] : [];
    this.blocked = new Set(m?.blocked ?? []);
    this.refs = (m?.readonlyRefs ?? []).map((p) => ({ path: p, display: tildify(p), warnings: [] }));
    this.refProblem = '';
    this.writeMode = m?.writeMode ?? 'readOnly';
    // 이미 "승인함을 거쳐 쓰기"로 확인을 받은 미션은 그대로 두면 다시 묻지 않는다.
    this.writeConfirmed = m?.writeMode === 'approval';
    this.roles = new Set(m?.roles ?? []);
    this.reviewers = new Set(m?.reviewerRoles ?? []);
    this.submitting = false;
    this.result = null;
    this.proposal = null;
    this.pendingRoles = new Map();
    this.render();
    void this.reloadRoles();
    if (m?.target) void this.inspectTarget(m.target, false);
  }

  /** 라노의 구성안으로 새 미션 화면을 채워서 연다. 쓰기 권한은 읽기 전용에서 시작하고, 비밀 파일 차단은 폴더 점검 결과로 고른다. */
  openProposal(p: MissionProposal): void {
    this.open();
    this.proposal = p;
    this.zone = p.zone === 'personal' ? 'personal' : 'work';
    this.name = p.name;
    this.goal = p.goal;
    this.roles = new Set(p.roles);
    this.reviewers = new Set(p.reviewerRoles.filter((r) => this.roles.has(r)));
    this.pendingRoles = new Map(p.newRoles.map((r) => [r.name, r]));
    this.render();
    if (p.target) {
      this.targetPath = p.target;
      void this.inspectTarget(p.target, true);
    }
    for (const ref of p.readonlyRefs) {
      void window.rano.orgInspect(ref, 'ref', this.zone).then((f) => {
        if (f?.ok && !this.refs.some((r) => r.path === f.path)) {
          this.refs.push({ path: f.path, display: f.display, warnings: f.warnings ?? [] });
          if (this.step === 2) this.render();
        }
      });
    }
  }

  /** 역할 목록 새로 불러오기 (역할을 만든 뒤에도 부른다) */
  async reloadRoles(): Promise<void> {
    try {
      const list = await window.rano.orgRoles();
      this.allRoles = Array.isArray(list) ? list : [];
      this.rolesFailed = false;
    } catch {
      this.rolesFailed = true;
    }
    if (this.step === 4 || this.step === 5) this.render();
  }

  /** 지금 고른 구역 (역할 만들기 화면이 같은 구역으로 열리게) */
  get currentZone(): Zone {
    return this.zone;
  }

  /** 이 구역 미션이 쓸 수 있는 역할 */
  private zoneRoles(): RoleInfo[] {
    return this.allRoles.filter((r) => r.zone === this.zone);
  }

  // ---------- 단계 검사 ----------
  private blockReason(step: Step): string {
    if (step === 1) return this.name.trim() ? '' : '미션 이름을 적어 주세요.';
    if (step === 2) {
      if (this.inspecting) return '폴더를 살펴보는 중이에요.';
      if (!this.target) return this.targetPath ? '작업 폴더를 확인하는 중이에요.' : '작업 폴더를 골라 주세요.';
      if (!this.target.ok) return '이 폴더는 고를 수 없어요. 다른 폴더를 골라 주세요.';
      return '';
    }
    if (step === 3) return this.writeMode === 'approval' && !this.writeConfirmed ? '"승인함을 거쳐 쓰기"는 확인 창에서 허용해야 해요.' : '';
    if (step === 4) {
      const picked = [...this.roles];
      const usable = new Set([...this.zoneRoles().map((r) => r.name), ...this.pendingRoles.keys()]);
      const foreign = picked.filter((r) => !usable.has(r));
      if (foreign.length && !this.rolesFailed && this.allRoles.length)
        return `${zoneInfo(this.zone).label} 구역 인재풀에 없는 역할은 빼 주세요: ${foreign.join(', ')}`;
      const workers = picked.filter((r) => !this.reviewers.has(r));
      const reviewers = picked.filter((r) => this.reviewers.has(r));
      if (workers.length === 0 && reviewers.length === 0) return '팀원 역할을 골라 주세요. 작업 담당 1개 이상과 검수 1개 이상이 필요해요.';
      if (workers.length === 0) return '작업 담당(검수가 아닌 역할)을 1개 이상 골라 주세요.';
      if (reviewers.length === 0) return '검수 역할을 1개 이상 정해 주세요. 고른 역할 옆의 "검수"를 켜면 돼요.';
      return '';
    }
    return '';
  }

  private draft(): MissionDraft {
    const roles = [...this.roles];
    return {
      name: this.name.trim(),
      goal: this.goal.trim(),
      zone: this.zone,
      target: this.target?.path ?? this.targetPath,
      readonlyRefs: this.refs.map((r) => r.path),
      blocked: [...this.blocked],
      writeMode: this.writeMode,
      writeConfirmed: this.writeMode === 'approval' && this.writeConfirmed,
      roles,
      reviewerRoles: roles.filter((r) => this.reviewers.has(r)),
    };
  }

  // ---------- 그리기 ----------
  private render(): void {
    const wrap = el('section', 'org-editor');
    const head = el('div', 'org-editor-head');
    head.appendChild(el('h2', 'pane-title', this.editing ? `미션 고치기 · ${this.editing.name}` : '미션 추가'));
    const back = button('목록으로', 'btn btn-plain');
    back.addEventListener('click', () => this.onDone(!!this.result?.ok));
    head.appendChild(back);
    wrap.appendChild(head);

    // 단계 표시
    const steps = el('ol', 'org-steps');
    steps.setAttribute('aria-label', '단계');
    for (const s of STEPS) {
      const li = el('li', `org-step${s === this.step ? ' on' : ''}${s < this.step ? ' done' : ''}`);
      const b = button(`${s}. ${STEP_LABELS[s]}`, 'org-step-btn');
      if (s === this.step) b.setAttribute('aria-current', 'step');
      // 앞 단계로는 언제든 돌아갈 수 있다. 결과가 나온 뒤에는 움직이지 않는다.
      b.disabled = s > this.step || !!this.result?.ok;
      b.addEventListener('click', () => this.go(s));
      li.appendChild(b);
      steps.appendChild(li);
    }
    wrap.appendChild(steps);
    if (this.proposal && !this.result?.ok) {
      const b = el('div', 'org-proposal-banner');
      b.appendChild(el('strong', undefined, '라노의 구성안으로 채웠어요. '));
      b.appendChild(el('span', undefined, `단계마다 확인하고 고쳐 주세요. 쓰기 권한(기본: 읽기 전용)과 비밀 파일 차단은 직접 정해요.${this.proposal.reason ? ` · 라노가 이렇게 짠 이유: ${this.proposal.reason}` : ''}`));
      wrap.appendChild(b);
    }

    const body = el('div', 'org-step-body');
    if (this.step === 1) this.renderStep1(body);
    else if (this.step === 2) this.renderStep2(body);
    else if (this.step === 3) this.renderStep3(body);
    else if (this.step === 4) this.renderStep4(body);
    else this.renderStep5(body);
    wrap.appendChild(body);

    if (!this.result?.ok) wrap.appendChild(this.renderNav());
    this.root.replaceChildren(wrap);
  }

  private go(s: Step): void {
    this.step = s;
    this.render();
    this.root.querySelector<HTMLElement>('.org-step-body input, .org-step-body button')?.focus();
  }

  private renderNav(): HTMLElement {
    const nav = el('div', 'org-nav');
    const reason = this.blockReason(this.step);
    const why = el('p', 'org-why', reason);
    why.hidden = !reason;
    const prev = button('이전', 'btn');
    prev.disabled = this.step === 1 || this.submitting;
    prev.addEventListener('click', () => this.go((this.step - 1) as Step));
    nav.appendChild(prev);
    nav.appendChild(why);
    if (this.step < 5) {
      const next = button('다음', 'btn btn-confirm');
      next.disabled = !!reason;
      next.addEventListener('click', () => {
        if (!this.blockReason(this.step)) this.go((this.step + 1) as Step);
      });
      nav.appendChild(next);
    } else {
      const submit = button(this.submitting ? '보내는 중…' : this.editing ? '저장' : '미션 만들기', 'btn btn-approve');
      submit.disabled = this.submitting || STEPS.some((s) => s < 5 && !!this.blockReason(s));
      submit.addEventListener('click', () => void this.submit());
      nav.appendChild(submit);
    }
    return nav;
  }

  /** 다음 버튼·이유만 다시 그린다 (입력 중에 포커스를 잃지 않게) */
  private refreshNav(): void {
    const old = this.root.querySelector('.org-nav');
    if (old) old.replaceWith(this.renderNav());
  }

  // ---------- 1. 이름·목표 ----------
  private renderStep1(body: HTMLElement): void {
    body.appendChild(el('p', 'pane-sub', '미션은 리포 리더 한 명이 팀원들과 맡는 일이에요. 이름과 목표를 적어 주세요.'));
    const nameInput = el('input', 'org-input');
    nameInput.value = this.name;
    nameInput.maxLength = 60;
    nameInput.placeholder = '예) 회사 홈페이지';
    nameInput.addEventListener('input', () => {
      this.name = nameInput.value;
      this.refreshNav();
    });
    body.appendChild(field('이름 (꼭 적어야 해요)', nameInput));

    const goalInput = el('textarea', 'org-input org-textarea');
    goalInput.rows = 3;
    goalInput.value = this.goal;
    goalInput.maxLength = 600;
    goalInput.placeholder = '예) 홈페이지 문서와 화면을 최신으로 유지하고, 고칠 곳을 찾아 고친다.';
    goalInput.addEventListener('input', () => {
      this.goal = goalInput.value;
    });
    body.appendChild(field('목표 (한두 줄)', goalInput, '리포 리더가 일할 때 늘 보는 헌장에 들어가요.'));

    const group = el('fieldset', 'org-radio-group');
    group.appendChild(el('legend', 'org-label', '구역'));
    const mk = (value: Zone, title: string, desc: string) => {
      const label = el('label', `org-radio${this.zone === value ? ' on' : ''}`);
      const input = el('input');
      input.type = 'radio';
      input.name = 'org-zone';
      input.value = value;
      input.checked = this.zone === value;
      input.disabled = !!this.editing;
      label.appendChild(input);
      const text = el('span', 'org-radio-text');
      text.appendChild(el('strong', undefined, title));
      text.appendChild(el('span', 'org-hint', desc));
      label.appendChild(text);
      input.addEventListener('change', () => {
        if (input.checked) this.setZone(value);
      });
      group.appendChild(label);
    };
    const w = zoneInfo('work'), p = zoneInfo('personal');
    mk('work', w.label, `작업 폴더는 ${w.root} 안에서 골라요. ${w.label} 인재풀 역할을 써요.`);
    mk('personal', p.label, `작업 폴더는 ${p.root} 안에서 골라요. ${p.label} 인재풀 역할만 쓰고, ${w.label} 폴더는 읽지도 쓰지도 않아요.`);
    body.appendChild(group);
    if (this.editing) body.appendChild(el('p', 'org-hint', '이미 만든 미션의 구역은 바꿀 수 없어요.'));
  }

  /** 구역을 바꾸면 그 구역에 맞지 않는 폴더·역할을 비운다 */
  private setZone(z: Zone): void {
    if (this.editing || z === this.zone) return;
    this.zone = z;
    this.targetPath = '';
    this.target = null;
    this.blockOptions = [];
    this.blocked = new Set();
    this.refs = [];
    this.refProblem = '';
    this.writeConfirmed = false;
    const usable = new Set([...this.zoneRoles().map((r) => r.name), ...this.pendingRoles.keys()]);
    for (const r of [...this.roles]) if (!usable.has(r)) {
      this.roles.delete(r);
      this.reviewers.delete(r);
    }
    this.render();
  }

  // ---------- 2. 작업 폴더 ----------
  private renderStep2(body: HTMLElement): void {
    body.appendChild(el('p', 'pane-sub', `리포 리더와 팀원이 일할 폴더를 ${zoneInfo(this.zone).root} 안에서 골라 주세요. 라노는 폴더 이름과 목록만 살펴봐요.`));

    const row = el('div', 'org-row');
    const pick = button(this.targetPath ? '다른 폴더 고르기' : '폴더 고르기', 'btn btn-confirm');
    pick.disabled = this.inspecting;
    pick.addEventListener('click', () => void this.pickTarget());
    row.appendChild(pick);
    if (this.inspecting) row.appendChild(el('span', 'org-hint', '폴더를 살펴보는 중이에요…'));
    body.appendChild(row);

    if (this.target) body.appendChild(this.renderInspection(this.target));
    else if (this.targetPath && !this.inspecting) body.appendChild(el('p', 'org-hint', `지금 작업 폴더: ${tildify(this.targetPath)}`));

    // 참고 폴더
    const refSec = el('div', 'org-sub');
    refSec.appendChild(el('h3', 'org-sub-title', '참고 폴더 (읽기 전용)'));
    refSec.appendChild(el('p', 'org-hint', '팀원이 읽기만 하는 폴더예요. 없어도 괜찮아요.'));
    const list = el('ul', 'org-plain-list');
    for (const r of this.refs) {
      const li = el('li', 'org-ref');
      li.appendChild(el('code', 'mono', r.display));
      const del = button('지우기', 'btn btn-small btn-plain');
      del.setAttribute('aria-label', `${r.display} 참고 폴더 지우기`);
      del.addEventListener('click', () => {
        this.refs = this.refs.filter((x) => x.path !== r.path);
        this.render();
      });
      li.appendChild(del);
      for (const w of r.warnings) li.appendChild(el('p', 'org-warning', w));
      list.appendChild(li);
    }
    if (this.refs.length) refSec.appendChild(list);
    const addRef = button('+ 참고 폴더 추가', 'btn btn-small');
    addRef.disabled = this.inspecting;
    addRef.addEventListener('click', () => void this.pickRef());
    refSec.appendChild(addRef);
    if (this.refProblem) refSec.appendChild(el('p', 'org-problem', this.refProblem));
    body.appendChild(refSec);
  }

  private renderInspection(f: FolderInspection): HTMLElement {
    const box = el('div', `org-inspect${f.ok ? '' : ' bad'}`);
    const rows = el('dl', 'appr-rows');
    const add = (k: string, v: string) => {
      rows.appendChild(el('dt', undefined, k));
      rows.appendChild(el('dd', undefined, v));
    };
    add('폴더', f.display || tildify(f.path));
    add('git 리포', f.isGitRepo ? `맞아요${f.branch ? ` · 지금 브랜치 ${f.branch}` : ''}` : '아니에요');
    add('규칙 파일', f.ruleFiles.length ? f.ruleFiles.map((p) => p.split('/').pop() ?? p).join(', ') : '없어요');
    box.appendChild(rows);

    if (f.deploysOnPush) {
      const hint = f.deployHints.length ? ` (${f.deployHints.join(', ')})` : '';
      box.appendChild(el('p', 'org-deploy', `이 리포는 push 하면 배포될 수 있어요${hint}`));
    }
    for (const p of f.problems) box.appendChild(el('p', 'org-problem', p));
    // 배포 흔적은 위의 빨간 경고로 이미 보여 주므로 같은 뜻의 주황 줄은 뺀다.
    for (const w of f.warnings) if (!(f.deploysOnPush && w.includes('배포'))) box.appendChild(el('p', 'org-warning', w));

    if (f.ok && this.blockOptions.length) {
      const sec = el('fieldset', 'org-secret');
      sec.appendChild(el('legend', 'org-sub-title', '비밀로 보이는 파일 · 폴더'));
      sec.appendChild(el('p', 'org-hint', '체크한 것은 팀원이 열 수 없게 막아 둬요. 그대로 두는 것을 권해요.'));
      for (const p of this.blockOptions) {
        const c = checkbox(tildify(p), this.blocked.has(p), 'org-check mono');
        c.input.addEventListener('change', () => {
          if (c.input.checked) this.blocked.add(p);
          else this.blocked.delete(p);
        });
        sec.appendChild(c.label);
      }
      box.appendChild(sec);
    } else if (f.ok) {
      box.appendChild(el('p', 'org-hint', '새로 막을 비밀 파일은 없어요. (이미 막아 둔 파일은 빼고 보여 드려요)'));
    }
    return box;
  }

  private async pickTarget(): Promise<void> {
    let path: string | null = null;
    try {
      path = await window.rano.orgPickFolder('target', this.zone);
    } catch {
      this.notice.show('폴더 선택 창을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.', false);
      return;
    }
    if (!path) return;
    await this.inspectTarget(path, true);
  }

  /** fresh=true 면 새로 고른 폴더: 비밀 후보를 모두 체크하고, 쓰기 확인을 다시 받는다 */
  private async inspectTarget(path: string, fresh: boolean): Promise<void> {
    this.inspecting = true;
    if (this.step === 2) this.render();
    try {
      const f = await window.rano.orgInspect(path, 'target', this.zone, this.editing?.id);
      if (fresh) {
        const changed = f.path !== (this.target?.path ?? this.targetPath);
        this.targetPath = f.path;
        this.target = f;
        this.blockOptions = [...f.secretCandidates];
        this.blocked = new Set(f.secretCandidates);
        if (changed && this.writeMode === 'approval') this.writeConfirmed = false;
      } else {
        // 고치기: 이미 막아 둔 것 + 새로 보이는 후보를 함께 보여 준다(이미 막은 것만 체크).
        this.target = f;
        for (const p of f.secretCandidates) if (!this.blockOptions.includes(p)) this.blockOptions.push(p);
      }
    } catch {
      this.notice.show('폴더를 살펴보지 못했어요. 잠시 뒤 다시 골라 주세요.', false);
    }
    this.inspecting = false;
    if (this.step === 2) this.render();
    else this.refreshNav();
  }

  private async pickRef(): Promise<void> {
    this.refProblem = '';
    let path: string | null = null;
    try {
      path = await window.rano.orgPickFolder('ref', this.zone);
    } catch {
      this.notice.show('폴더 선택 창을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.', false);
      return;
    }
    if (!path) return;
    this.inspecting = true;
    this.render();
    try {
      const f = await window.rano.orgInspect(path, 'ref', this.zone, this.editing?.id);
      if (!f.ok) {
        this.refProblem = `${f.display || tildify(f.path)}: ${f.problems.join(' ') || '이 폴더는 참고 폴더로 고를 수 없어요.'}`;
      } else if (this.refs.some((r) => r.path === f.path)) {
        this.refProblem = '이미 넣은 참고 폴더예요.';
      } else {
        this.refs.push({ path: f.path, display: f.display || tildify(f.path), warnings: f.warnings });
      }
    } catch {
      this.refProblem = '폴더를 살펴보지 못했어요. 잠시 뒤 다시 골라 주세요.';
    }
    this.inspecting = false;
    this.render();
  }

  // ---------- 3. 권한 ----------
  private renderStep3(body: HTMLElement): void {
    body.appendChild(el('p', 'pane-sub', '팀원이 작업 폴더에서 무엇을 할 수 있는지 정해요.'));
    const group = el('fieldset', 'org-radio-group');
    group.appendChild(el('legend', 'org-label', '쓰기 방식'));
    const mk = (value: 'readOnly' | 'approval', title: string, desc: string) => {
      const label = el('label', `org-radio${this.writeMode === value ? ' on' : ''}`);
      const input = el('input');
      input.type = 'radio';
      input.name = 'org-write-mode';
      input.value = value;
      input.checked = this.writeMode === value;
      label.appendChild(input);
      const text = el('span', 'org-radio-text');
      text.appendChild(el('strong', undefined, title));
      text.appendChild(el('span', 'org-hint', desc));
      label.appendChild(text);
      input.addEventListener('change', () => {
        if (!input.checked) return;
        if (value === 'readOnly') {
          this.writeMode = 'readOnly';
          this.writeConfirmed = false;
          this.render();
        } else {
          void this.confirmWrite();
        }
      });
      group.appendChild(label);
    };
    mk('readOnly', '읽기 전용 (권장)', '팀원은 파일을 읽고 보고만 해요. 아무것도 바꾸지 않아요.');
    mk('approval', '승인함을 거쳐 쓰기', '파일 하나를 바꿀 때마다 승인함에서 내 승인을 받은 뒤에만 바꿔요.');
    body.appendChild(group);

    if (this.writeMode === 'approval') {
      if (this.writeConfirmed) {
        body.appendChild(el('p', 'org-ok', '쓰기를 허용했어요. 모든 쓰기·커밋·push·삭제는 승인함을 거쳐요.'));
      } else {
        const again = button('확인 창 열기', 'btn');
        again.addEventListener('click', () => void this.confirmWrite());
        body.appendChild(el('p', 'org-warning', '쓰기는 확인 창에서 허용해야 쓸 수 있어요.'));
        body.appendChild(again);
      }
    }
  }

  private async confirmWrite(): Promise<void> {
    const t = this.target;
    const ok = await openModal({
      title: '승인함을 거쳐 쓰기를 허용할까요?',
      okText: '허용',
      okInitiallyEnabled: false,
      build: (body, setOk) => {
        body.appendChild(el('p', undefined, `작업 폴더: ${t ? t.display || tildify(t.path) : tildify(this.targetPath)}`));
        const ul = el('ul', 'org-plain-list org-bullets');
        for (const line of [
          '팀원이 파일을 바꾸려면 파일 하나마다 승인함에서 승인을 받아야 해요.',
          '커밋, push, 삭제도 모두 승인함을 거쳐요.',
          '승인하지 않은 쓰기는 실행되지 않아요.',
          '막아 둔 비밀 파일은 승인해도 열 수 없어요.',
        ])
          ul.appendChild(el('li', undefined, line));
        body.appendChild(ul);
        if (t?.deploysOnPush) {
          const hint = t.deployHints.length ? ` (${t.deployHints.join(', ')})` : '';
          body.appendChild(el('p', 'org-deploy', `이 리포는 push 하면 배포될 수 있어요${hint}. push 승인은 배포 승인과 같아요.`));
        }
        const c = checkbox('이해했어요', false, 'org-check org-understood');
        c.input.addEventListener('change', () => setOk(c.input.checked));
        body.appendChild(c.label);
      },
    });
    if (ok) {
      this.writeMode = 'approval';
      this.writeConfirmed = true;
    } else {
      this.writeMode = 'readOnly';
      this.writeConfirmed = false;
    }
    this.render();
  }

  // ---------- 4. 팀 ----------
  private renderStep4(body: HTMLElement): void {
    body.appendChild(el('p', 'pane-sub', `이 미션에서 일할 팀원 역할을 ${zoneInfo(this.zone).label} 인재풀에서 골라 주세요. 작업 담당 1개 이상, 검수 1개 이상이 필요해요.`));
    const tools = el('div', 'org-row');
    const create = button('+ 역할 만들기', 'btn btn-small');
    create.addEventListener('click', () => this.onCreateRole());
    const reload = button('목록 새로고침', 'btn btn-small btn-plain');
    reload.addEventListener('click', () => void this.reloadRoles().then(() => this.render()));
    tools.append(create, reload);
    body.appendChild(tools);

    if (this.rolesFailed) {
      body.appendChild(el('p', 'org-problem', '역할 목록을 불러오지 못했어요. [목록 새로고침]을 눌러 주세요.'));
      return;
    }
    // 고른 역할 중 목록에 없는 것(지워졌거나 다른 구역)도 빼지 않고 보여 준다.
    const zoneRoles = this.zoneRoles();
    const names = new Set(zoneRoles.map((r) => r.name));
    const missing = [...this.roles].filter((r) => !names.has(r));
    const list = el('ul', 'org-team');
    const rowFor = (n: string): HTMLElement => {
      const r = zoneRoles.find((x) => x.name === n);
      if (r) return this.renderTeamRow(r.name, `${r.description || '설명 없음'}\n할 수 있는 일: ${abilityText(r)} · ${SOURCE_LABEL[r.source] ?? r.source}`);
      const draft = this.pendingRoles.get(n);
      const can = draft ? ['읽기', draft.canWrite ? '파일 쓰기' : '', draft.canRun ? '명령 실행' : ''].filter(Boolean).join('·') : '';
      const other = this.allRoles.some((x) => x.name === n);
      return this.renderTeamRow(n, draft ? `라노가 제안한 새 역할 — 미션을 만들 때 ${zoneInfo(this.zone).label} 인재풀에 함께 만들어요\n${draft.description || '설명 없음'} · 할 수 있는 일: ${can}` : other ? '다른 구역 인재풀 역할이라 이 미션에 넣을 수 없어요. 체크를 풀어 주세요' : '목록에서 찾지 못한 역할이에요');
    };
    // 고른 역할(라노가 제안한 새 역할 포함)을 맨 위에, 나머지는 아래에
    const picked = [...this.roles];
    const pendingOnly = [...this.pendingRoles.keys()].filter((n) => !this.roles.has(n) && !names.has(n));
    for (const n of [...picked, ...pendingOnly]) list.appendChild(rowFor(n));
    if (picked.length || pendingOnly.length) list.appendChild(el('li', 'org-team-divider', '다른 역할'));
    for (const r of zoneRoles) if (!this.roles.has(r.name)) list.appendChild(rowFor(r.name));
    if (!zoneRoles.length && !missing.length && !pendingOnly.length) body.appendChild(el('p', 'board-note', `${zoneInfo(this.zone).label} 인재풀에 아직 역할이 없어요. [+ 역할 만들기]로 만들어 주세요.`));
    else body.appendChild(list);
  }

  private renderTeamRow(name: string, desc: string): HTMLElement {
    const li = el('li', `org-team-row${this.roles.has(name) ? ' on' : ''}`);
    const pick = checkbox(name, this.roles.has(name), 'org-check org-team-pick');
    const info = el('span', 'org-hint', desc);
    const rev = checkbox('검수', this.reviewers.has(name), 'org-check org-team-rev');
    rev.input.disabled = !this.roles.has(name);
    rev.label.title = '검수 역할은 작업 담당이 한 일을 확인해요';
    pick.input.addEventListener('change', () => {
      if (pick.input.checked) this.roles.add(name);
      else {
        this.roles.delete(name);
        this.reviewers.delete(name);
        rev.input.checked = false;
      }
      rev.input.disabled = !pick.input.checked;
      li.classList.toggle('on', pick.input.checked);
      this.refreshNav();
    });
    rev.input.addEventListener('change', () => {
      if (rev.input.checked) this.reviewers.add(name);
      else this.reviewers.delete(name);
      this.refreshNav();
    });
    const main = el('div', 'org-team-main');
    main.append(pick.label, info);
    li.append(main, rev.label);
    return li;
  }

  // ---------- 5. 확인 ----------
  private renderStep5(body: HTMLElement): void {
    const d = this.draft();
    if (!this.result?.ok) body.appendChild(el('p', 'pane-sub', '아래 내용으로 미션을 ' + (this.editing ? '저장해요.' : '만들어요.')));
    const rows = el('dl', 'appr-rows org-summary');
    const add = (k: string, v: string) => {
      rows.appendChild(el('dt', undefined, k));
      rows.appendChild(el('dd', undefined, v));
    };
    add('이름', d.name);
    add('목표', d.goal || '(적지 않음)');
    add('구역', `${zoneInfo(this.zone).label} 구역`);
    add('작업 폴더', this.target?.display || tildify(d.target));
    add('참고 폴더', d.readonlyRefs.length ? d.readonlyRefs.map(tildify).join('\n') : '없음');
    add('막아 둘 파일', d.blocked.length ? d.blocked.map(tildify).join('\n') : '없음');
    add('쓰기 방식', d.writeMode === 'approval' ? '승인함을 거쳐 쓰기' : '읽기 전용');
    const workers = d.roles.filter((r) => !d.reviewerRoles.includes(r));
    add('작업 담당', workers.join(', ') || '없음');
    add('검수', d.reviewerRoles.join(', ') || '없음');
    body.appendChild(rows);
    if (this.target?.deploysOnPush && d.writeMode === 'approval') {
      body.appendChild(el('p', 'org-deploy', '이 리포는 push 하면 배포될 수 있어요. push 승인은 신중하게 해 주세요.'));
    }

    if (this.result) {
      // 성공 문구는 위 알림 줄에 나온다. 실패만 여기에도 남긴다.
      if (!this.result.ok) body.appendChild(el('p', 'org-problem', this.result.message));
      if (this.result.ok) {
        const after = el('div', 'org-actions');
        if (this.result.needsRestart) after.appendChild(restartBox(this.notice));
        const done = button('목록으로', 'btn');
        done.addEventListener('click', () => this.onDone(true));
        after.appendChild(done);
        body.appendChild(after);
      }
    }
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    this.result = null;
    this.render();
    try {
      // 라노가 제안한 새 역할 중 팀에 남아 있고 아직 없는 것은 먼저 인재풀에 만든다
      const have = new Set(this.allRoles.map((r) => r.name));
      for (const [name, draft] of this.pendingRoles) {
        if (!this.roles.has(name) || have.has(name)) continue;
        const r = await window.rano.orgSaveRole({ ...draft, zone: this.zone });
        if (!r?.ok) {
          this.result = { ok: false, message: `새 역할 "${name}"을(를) 만들지 못했어요: ${r?.message ?? '알 수 없는 이유'}` };
          this.notice.show(this.result.message, false);
          this.submitting = false;
          this.render();
          return;
        }
      }
      if (this.pendingRoles.size) await this.reloadRoles();
      const d = this.draft();
      const res = this.editing ? await window.rano.orgUpdateMission(this.editing.id, d) : await window.rano.orgCreateMission(d);
      this.result = { ok: !!res?.ok, message: res?.message || (res?.ok ? '저장했어요.' : '저장하지 못했어요.'), id: res?.id, needsRestart: !!res?.needsRestart };
      this.notice.show(this.result.message, this.result.ok);
    } catch {
      this.result = { ok: false, message: '미션을 저장하지 못했어요. 잠시 뒤 다시 눌러 주세요.' };
      this.notice.show(this.result.message, false);
    }
    this.submitting = false;
    this.render();
  }
}

/** [앱 다시 시작] 버튼과 안내 */
export function restartBox(notice: Notice): HTMLElement {
  const box = el('div', 'org-restart');
  box.appendChild(el('p', undefined, '다시 시작하면 현황판 사무실에 새 방이 생겨요. 기다리던 과제는 이어서 진행돼요.'));
  const b = button('앱 다시 시작', 'btn btn-confirm');
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = '다시 시작하는 중…';
    try {
      await window.rano.orgRestart();
    } catch {
      notice.show('앱을 다시 시작하지 못했어요. 앱을 직접 닫았다가 열어 주세요.', false);
      b.disabled = false;
      b.textContent = '앱 다시 시작';
    }
  });
  box.appendChild(b);
  return box;
}
