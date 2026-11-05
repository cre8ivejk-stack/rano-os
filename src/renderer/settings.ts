// 설정 창: 나에 대해 · 구역 폴더 · Claude 계정 · 데이터 폴더. 머리말의 [설정] 버튼으로 연다.
import { AccountPanel } from './account.js';
import { el } from './dom.js';
import { button, field } from './orgCommon.js';
import { updateCheckLine } from './update.js';

const ZONES: Zone[] = ['work', 'personal'];
const DEV = [
  ['none', '비개발자', '코드 대신 기능·화면 기준으로 쉬운 말로 설명받아요.'],
  ['some', '조금 알아요', '쉬운 말 위주로, 필요하면 코드도 조금 보여 줘요.'],
  ['dev', '개발자', '코드·명령어·파일 경로를 그대로 보여 줘도 돼요.'],
] as const;

/** me.md 의 개발 경험 글을 선택지로 (모르는 글이면 'keep') */
function devKey(text: string): string {
  const t = text.trim();
  if (!t) return 'none';
  if (t.startsWith('비개발자')) return 'none';
  if (t.startsWith('조금')) return 'some';
  if (t.startsWith('개발자')) return 'dev';
  return 'keep';
}

function note(text: string, ok: boolean): HTMLElement {
  return el('p', ok ? 'org-ok' : 'org-problem', text);
}

export class SettingsButton {
  constructor(host: HTMLElement) {
    const btn = el('button', 'acct-btn settings-btn', '설정');
    btn.type = 'button';
    btn.addEventListener('click', () => void this.open());
    host.appendChild(btn);
  }

  async open(): Promise<void> {
    const overlay = el('div', 'org-modal-overlay');
    const box = el('div', 'org-modal settings-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '설정');
    box.appendChild(el('h3', 'org-modal-title', '설정'));
    const body = el('div', 'org-modal-body settings-body');
    body.appendChild(el('p', 'board-note', '불러오는 중이에요…'));
    const actions = el('div', 'org-modal-actions');
    const close = button('닫기', 'btn');
    actions.appendChild(close);
    box.append(body, actions);
    overlay.appendChild(box);
    let account: AccountPanel | null = null;
    const done = () => {
      account?.dispose();
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done();
    };
    close.addEventListener('click', done);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    close.focus();

    let st: SetupStatus;
    let app: AppSettings;
    try {
      [st, app] = await Promise.all([window.rano.setupStatus(), window.rano.appSettings()]);
    } catch {
      body.replaceChildren(note('설정을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.', false));
      return;
    }
    body.replaceChildren(this.profileSection(st), this.zoneSection(st));
    const acctSec = el('section', 'settings-sec');
    acctSec.appendChild(el('h4', 'settings-title', 'Claude 계정'));
    const acctHost = el('div');
    acctSec.appendChild(acctHost);
    body.appendChild(acctSec);
    account = new AccountPanel(acctHost);
    void account.refresh();
    body.appendChild(this.dataSection(st, app));
  }

  // ---------- 나에 대해 ----------
  private profileSection(st: SetupStatus): HTMLElement {
    const sec = el('section', 'settings-sec');
    sec.appendChild(el('h4', 'settings-title', '나에 대해'));
    sec.appendChild(el('p', 'org-hint', '라노와 리더가 부르는 이름과 설명 수준을 정해요. 라노 기억(me.md)에 저장돼요.'));
    const p = { ...st.profile };
    const origDev = p.devLevel;
    let dev = devKey(p.devLevel);
    const mk = (key: 'name' | 'callName' | 'org' | 'job', label: string) => {
      const input = el('input', 'org-input');
      input.value = p[key];
      input.maxLength = 80;
      input.addEventListener('input', () => (p[key] = input.value));
      sec.appendChild(field(label, input));
    };
    mk('name', '이름 (꼭 적어야 해요)');
    mk('callName', '라노가 부를 호칭');
    mk('org', '소속');
    mk('job', '하는 일');
    const group = el('fieldset', 'org-radio-group');
    group.appendChild(el('legend', 'org-label', '개발 경험'));
    for (const [value, title, desc] of DEV) {
      const label = el('label', `org-radio${dev === value ? ' on' : ''}`);
      const input = el('input');
      input.type = 'radio';
      input.name = 'settings-dev';
      input.checked = dev === value;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        dev = value;
        group.querySelectorAll('.org-radio').forEach((l) => l.classList.toggle('on', l === label));
      });
      const text = el('span', 'org-radio-text');
      text.append(el('strong', undefined, title), el('span', 'org-hint', desc));
      label.append(input, text);
      group.appendChild(label);
    }
    if (dev === 'keep') group.appendChild(el('p', 'org-hint', `지금 적힌 내용: ${origDev}`));
    sec.appendChild(group);
    const row = el('div', 'org-row');
    const save = button('저장', 'btn btn-confirm btn-small');
    const msg = el('span');
    save.addEventListener('click', async () => {
      save.disabled = true;
      const r = await window.rano.settingsSaveProfile({ ...p, devLevel: dev === 'keep' ? origDev : dev }).catch(() => ({ ok: false, message: '저장하지 못했어요' }));
      msg.replaceChildren(note(r.message, r.ok));
      save.disabled = false;
    });
    row.append(save, msg);
    sec.appendChild(row);
    return sec;
  }

  // ---------- 구역 폴더 ----------
  private zoneSection(st: SetupStatus): HTMLElement {
    const sec = el('section', 'settings-sec');
    sec.appendChild(el('h4', 'settings-title', '구역 폴더'));
    sec.appendChild(el('p', 'org-hint', '미션의 작업 폴더는 그 구역 폴더 안에서 골라요. 미션이 있는 구역의 폴더는 바꿀 수 없어요(미션을 보관한 뒤 바꿔요).'));
    const roots: Record<Zone, string> = { work: st.zones.work.root, personal: st.zones.personal.root };
    const list = el('div', 'settings-zones');
    const draw = (checks: Partial<Record<Zone, SetupFolderCheck>>) => {
      list.replaceChildren();
      for (const z of ZONES) {
        const row = el('div', 'org-row');
        row.appendChild(el('strong', 'settings-zone-name', `${st.zones[z].label}`));
        row.appendChild(el('code', 'mono setup-path', checks[z]?.display ?? roots[z]));
        const pick = button('다른 폴더 고르기', 'btn btn-small');
        pick.addEventListener('click', async () => {
          const p = await window.rano.setupPickFolder(z, roots[z]).catch(() => null);
          if (!p) return;
          roots[z] = p;
          checks[z] = await window.rano.setupCheckFolder(z, p).catch(() => undefined);
          draw(checks);
        });
        row.appendChild(pick);
        list.appendChild(row);
        const c = checks[z];
        if (c && !c.ok) list.appendChild(note(c.problem ?? '고를 수 없는 폴더예요', false));
        else if (c && !c.exists) list.appendChild(el('p', 'org-hint', '아직 없는 폴더예요. 저장할 때 새로 만들어요.'));
      }
    };
    draw({});
    sec.appendChild(list);
    const row = el('div', 'org-row');
    const save = button('저장', 'btn btn-confirm btn-small');
    const msg = el('span');
    save.addEventListener('click', async () => {
      save.disabled = true;
      const r = await window.rano.settingsSaveZones({ ...roots }).catch(() => ({ ok: false, message: '저장하지 못했어요', needsRestart: false }));
      msg.replaceChildren(note(r.message, r.ok));
      if (r.ok && r.needsRestart) {
        const again = button('앱 다시 시작', 'btn btn-small');
        again.addEventListener('click', () => void window.rano.orgRestart());
        msg.appendChild(again);
      }
      save.disabled = false;
    });
    row.append(save, msg);
    sec.appendChild(row);
    return sec;
  }

  // ---------- 데이터 ----------
  private dataSection(st: SetupStatus, app: AppSettings): HTMLElement {
    const sec = el('section', 'settings-sec');
    sec.appendChild(el('h4', 'settings-title', '데이터와 버전'));
    const row = el('div', 'org-row');
    row.appendChild(el('code', 'mono setup-path', st.dataDir));
    const open = button('Finder에서 열기', 'btn btn-small');
    open.addEventListener('click', () => void window.rano.openDataFolder());
    row.appendChild(open);
    sec.appendChild(row);
    sec.appendChild(el('p', 'org-hint', `설정·기억·미션 기록·승인함 기록이 이 폴더에 있어요. 라노 OS ${app.version}`));
    const upRow = el('div', 'org-row');
    const up = button('새 버전 확인', 'btn btn-small');
    const result = el('div');
    up.addEventListener('click', async () => {
      up.disabled = true;
      result.replaceChildren(el('span', 'org-hint', '확인하는 중이에요…'));
      result.replaceChildren(await updateCheckLine());
      up.disabled = false;
    });
    upRow.append(up, result);
    sec.appendChild(upRow);
    return sec;
  }
}
