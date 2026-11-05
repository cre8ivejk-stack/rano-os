// 조직 화면: 미션 관리와 인재풀(팀원 역할). 목록 · 미션 5단계 안내 · 역할 편집 셋 중 하나를 보여 준다.
// 글은 모두 textContent 로 넣는다.
import { el, mustGet, zoneInfo } from './dom.js';
import { Notice, SOURCE_LABEL, abilityText, button, tildify } from './orgCommon.js';
import { RoleEditor } from './orgRoles.js';
import { MissionWizard, restartBox } from './orgWizard.js';

type Mode = 'list' | 'wizard' | 'role';

export class OrgView {
  private rootEl = mustGet<HTMLDivElement>('org-root');
  private notice = new Notice(mustGet<HTMLParagraphElement>('org-notice'));
  private listRoot = el('div', 'org-list-root');
  private wizardRoot = el('div', 'org-wizard-root');
  private roleRoot = el('div', 'org-role-root');
  private wizard = new MissionWizard(this.wizardRoot, this.notice);
  private roleEditor = new RoleEditor(this.roleRoot, this.notice);

  private mode: Mode = 'list';
  private roleFromWizard = false; // 4단계에서 역할을 만들러 왔는지
  private missions: MissionSummary[] = [];
  private roles: RoleInfo[] = [];
  private loaded = false;
  private missionsFailed = false;
  private rolesFailed = false;
  private confirmArchive: string | null = null; // 보관 확인 중인 미션 id
  private busyIds = new Set<string>();

  constructor() {
    this.rootEl.append(this.listRoot, this.wizardRoot, this.roleRoot);
    this.wizard.onDone = (changed) => {
      this.setMode('list');
      if (changed) void this.load();
    };
    this.wizard.onCreateRole = () => {
      this.roleFromWizard = true;
      this.notice.clear();
      this.setMode('role');
      void this.roleEditor.open(undefined, this.wizard.currentZone);
    };
    this.roleEditor.onDone = (saved) => {
      if (this.roleFromWizard) {
        this.roleFromWizard = false;
        this.setMode('wizard');
        void this.wizard.reloadRoles();
      } else {
        this.setMode('list');
      }
      if (saved) void this.load();
    };
    this.setMode('list');
    this.render();
  }

  /** 탭을 열 때마다: 목록을 보고 있으면 새로 불러온다 */
  /** 라노의 미션 구성안으로 미션 추가 화면을 채워서 연다 */
  openProposal(p: MissionProposal): void {
    this.notice.clear();
    this.setMode('wizard');
    this.wizard.openProposal(p);
  }

  /** 새 미션 추가 화면을 연다 */
  openNewMission(): void {
    this.notice.clear();
    this.setMode('wizard');
    this.wizard.open();
  }

  shown(): void {
    if (this.mode === 'list') void this.load();
  }

  async load(): Promise<void> {
    const [m, r] = await Promise.allSettled([window.rano.orgMissions(), window.rano.orgRoles()]);
    if (m.status === 'fulfilled' && Array.isArray(m.value)) {
      this.missions = m.value;
      this.missionsFailed = false;
    } else {
      this.missionsFailed = true;
    }
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      this.roles = r.value;
      this.rolesFailed = false;
    } else {
      this.rolesFailed = true;
    }
    this.loaded = true;
    this.render();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.listRoot.hidden = mode !== 'list';
    this.wizardRoot.hidden = mode !== 'wizard';
    this.roleRoot.hidden = mode !== 'role';
    const pane = this.rootEl.closest('.pane');
    if (pane) pane.scrollTop = 0;
  }

  // ---------- 목록 ----------
  private render(): void {
    const frag = document.createDocumentFragment();

    const head = el('div', 'pane-head');
    head.appendChild(el('h2', 'pane-title', '조직'));
    head.appendChild(el('p', 'pane-sub', '미션(리포 리더가 맡는 일)과 팀원 역할을 관리해요. 바꾼 내용은 앱을 다시 시작하면 반영돼요.'));
    frag.appendChild(head);

    if (this.missions.some((m) => !m.active && !m.archived)) frag.appendChild(restartBox(this.notice));

    // ---- 미션 ----
    const mSec = el('section', 'org-section');
    mSec.setAttribute('aria-labelledby', 'org-missions-title');
    const mHead = el('div', 'org-section-head');
    const mTitle = el('h3', 'org-section-title', '미션');
    mTitle.id = 'org-missions-title';
    const addMission = button('+ 미션 추가', 'btn btn-confirm');
    addMission.addEventListener('click', () => {
      this.notice.clear();
      this.setMode('wizard');
      this.wizard.open();
    });
    mHead.append(mTitle, addMission);
    mSec.appendChild(mHead);
    const mList = el('div', 'org-cards');
    if (!this.loaded) mList.appendChild(el('p', 'board-note', '미션을 불러오는 중이에요…'));
    else if (this.missionsFailed) mList.appendChild(el('p', 'org-problem', '미션 목록을 불러오지 못했어요. 앱을 다시 열어 주세요.'));
    else if (!this.missions.length) mList.appendChild(el('p', 'board-note', '아직 미션이 없어요. [+ 미션 추가]로 시작해 보세요.'));
    else {
      const sorted = [...this.missions].sort((a, b) => Number(a.archived) - Number(b.archived));
      for (const m of sorted) mList.appendChild(this.renderMission(m));
    }
    mSec.appendChild(mList);
    frag.appendChild(mSec);

    // ---- 인재풀 ----
    const rSec = el('section', 'org-section');
    rSec.setAttribute('aria-labelledby', 'org-roles-title');
    const rHead = el('div', 'org-section-head');
    const rTitle = el('h3', 'org-section-title', '인재풀 (팀원 역할)');
    rTitle.id = 'org-roles-title';
    const addRole = button('+ 역할 만들기', 'btn btn-confirm');
    addRole.addEventListener('click', () => {
      this.notice.clear();
      this.roleFromWizard = false;
      this.setMode('role');
      void this.roleEditor.open();
    });
    rHead.append(rTitle, addRole);
    rSec.appendChild(rHead);
    const rList = el('div', 'org-roles');
    if (!this.loaded) rList.appendChild(el('p', 'board-note', '역할을 불러오는 중이에요…'));
    else if (this.rolesFailed) rList.appendChild(el('p', 'org-problem', '역할 목록을 불러오지 못했어요. 앱을 다시 열어 주세요.'));
    else if (!this.roles.length) rList.appendChild(el('p', 'board-note', '아직 역할이 없어요. [+ 역할 만들기]로 만들어 보세요.'));
    else {
      const order: Record<RoleInfo['source'], number> = { pool: 0, mission: 1, work: 2 };
      const zoneOrder = (r: RoleInfo) => (r.zone === 'personal' ? 1 : 0);
      const sorted = [...this.roles].sort((a, b) => zoneOrder(a) - zoneOrder(b) || order[a.source] - order[b.source] || a.name.localeCompare(b.name));
      for (const r of sorted) rList.appendChild(this.renderRole(r));
    }
    rSec.appendChild(rList);
    frag.appendChild(rSec);

    this.listRoot.replaceChildren(frag);
  }

  private missionName(id: string): string {
    return this.missions.find((m) => m.id === id)?.name ?? id;
  }

  private renderMission(m: MissionSummary): HTMLElement {
    const card = el('article', `org-card${m.archived ? ' archived' : ''}`);
    const top = el('div', 'org-card-top');
    top.appendChild(el('h4', 'org-card-title', m.name));
    top.appendChild(el('span', m.zone === 'work' ? 'kind' : 'kind org-zone-personal', `${zoneInfo(m.zone).label} 구역`));
    top.appendChild(el('span', m.writeMode === 'approval' ? 'kind kind-write' : 'kind', m.writeMode === 'approval' ? '승인함을 거쳐 쓰기' : '읽기 전용'));
    if (m.archived) top.appendChild(el('span', 'badge result-expired', '보관함'));
    card.appendChild(top);
    if (m.goal) card.appendChild(el('p', 'org-card-goal', m.goal));

    const rows = el('dl', 'appr-rows');
    const add = (k: string, v: string) => {
      rows.appendChild(el('dt', undefined, k));
      rows.appendChild(el('dd', undefined, v));
    };
    add('작업 폴더', tildify(m.target));
    if (m.readonlyRefs.length) add('참고 폴더', m.readonlyRefs.map(tildify).join('\n'));
    const workers = m.roles.filter((r) => !m.reviewerRoles.includes(r));
    add('팀', `역할 ${m.roles.length}개 · 작업 ${workers.join(', ') || '없음'}`);
    add('검수', m.reviewerRoles.join(', ') || '없음');
    if (m.blocked.length) add('막아 둔 것', `${m.blocked.length}개`);
    card.appendChild(rows);

    if (!m.active && !m.archived) card.appendChild(el('p', 'org-warning', '다시 시작하면 반영돼요'));
    if (!m.active && m.archived) card.appendChild(el('p', 'org-hint', '보관한 미션이에요. 다시 시작하면 현황판에서 빠져요.'));

    const actions = el('div', 'appr-actions');
    const busy = this.busyIds.has(m.id);
    if (this.confirmArchive === m.id) {
      actions.appendChild(el('span', 'org-confirm-q', m.archived ? '보관을 풀까요? 다시 시작하면 현황판에 돌아와요.' : '보관할까요? 다시 시작하면 현황판에서 빠지고, 기록은 남아요.'));
      const yes = button(m.archived ? '보관 풀기' : '보관', m.archived ? 'btn btn-confirm' : 'btn btn-reject');
      yes.disabled = busy;
      yes.addEventListener('click', () => void this.archive(m));
      const no = button('취소', 'btn btn-plain');
      no.addEventListener('click', () => {
        this.confirmArchive = null;
        this.render();
      });
      actions.append(yes, no);
    } else {
      const edit = button('고치기', 'btn');
      edit.disabled = busy || m.archived;
      if (m.archived) edit.title = '보관을 풀면 고칠 수 있어요';
      edit.addEventListener('click', () => {
        this.notice.clear();
        this.setMode('wizard');
        this.wizard.open(m);
      });
      const arch = button(m.archived ? '보관 풀기' : '보관', 'btn btn-plain');
      arch.disabled = busy;
      arch.addEventListener('click', () => {
        this.confirmArchive = m.id;
        this.render();
      });
      actions.append(edit, arch);
    }
    card.appendChild(actions);
    return card;
  }

  private async archive(m: MissionSummary): Promise<void> {
    if (this.busyIds.has(m.id)) return;
    this.busyIds.add(m.id);
    this.render();
    try {
      const res = await window.rano.orgArchiveMission(m.id, !m.archived);
      this.notice.show(res?.message || (res?.ok ? '바꿨어요.' : '바꾸지 못했어요.'), !!res?.ok);
    } catch {
      this.notice.show('보관 상태를 바꾸지 못했어요. 잠시 뒤 다시 눌러 주세요.', false);
    }
    this.busyIds.delete(m.id);
    this.confirmArchive = null;
    await this.load();
  }

  private renderRole(r: RoleInfo): HTMLElement {
    const card = el('article', 'org-role');
    const top = el('div', 'org-card-top');
    top.appendChild(el('h4', 'org-role-name', r.name));
    top.appendChild(el('span', `kind org-src-${r.source}`, SOURCE_LABEL[r.source] ?? r.source));
    if (r.zone === 'personal') top.appendChild(el('span', 'kind org-zone-personal', zoneInfo('personal').label));
    card.appendChild(top);
    card.appendChild(el('p', 'org-role-desc', r.description || '설명 없음'));
    const meta = el('p', 'org-role-meta');
    meta.appendChild(el('span', r.canWrite || r.canRun ? 'org-ability more' : 'org-ability', abilityText(r)));
    meta.appendChild(el('span', undefined, r.usedBy.length ? `쓰는 미션: ${r.usedBy.map((id) => this.missionName(id)).join(', ')}` : '쓰는 미션 없음'));
    card.appendChild(meta);
    const b = button(r.editable ? '고치기' : '보기', r.editable ? 'btn btn-small' : 'btn btn-small btn-plain');
    b.setAttribute('aria-label', `${r.name} 역할 ${r.editable ? '고치기' : '보기'}`);
    b.addEventListener('click', () => {
      this.notice.clear();
      this.roleFromWizard = false;
      this.setMode('role');
      void this.roleEditor.open(r.name);
    });
    card.appendChild(b);
    return card;
  }
}
