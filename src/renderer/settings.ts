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
    body.appendChild(this.mobileSection(() => overlay.isConnected));
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

  // ---------- 휴대폰(텔레그램) ----------
  private mobileSection(alive: () => boolean): HTMLElement {
    const sec = el('section', 'settings-sec');
    sec.appendChild(el('h4', 'settings-title', '휴대폰 연결 (텔레그램)'));
    const host = el('div', 'mobile-box');
    sec.appendChild(host);
    let timer = 0;
    const draw = async () => {
      let m: MobileStatus;
      try {
        m = await window.rano.mobileStatus();
      } catch {
        host.replaceChildren(note('연결 상태를 읽지 못했어요.', false));
        return;
      }
      host.replaceChildren();
      const msg = el('span');
      if (!m.connected) {
        host.appendChild(el('p', 'org-hint', '휴대폰 텔레그램으로 라노와 대화하고 승인 요청을 승인·반려할 수 있어요. 맥이 텔레그램에 먼저 접속하는 방식이라 맥에 들어오는 문은 열지 않아요. 대화 내용은 텔레그램 서버를 거쳐요.'));
        const steps = el('ol', 'mobile-steps');
        for (const t of [
          '휴대폰 텔레그램에서 @BotFather 를 찾아 /newbot 을 보내요',
          '봇 이름과 아이디(…bot 으로 끝남)를 정하면 토큰(숫자:영문…)을 알려 줘요',
          '그 토큰을 아래에 붙여 넣고 [연결]을 눌러요',
        ])
          steps.appendChild(el('li', undefined, t));
        host.appendChild(steps);
        const row = el('div', 'org-row');
        const input = el('input', 'org-input');
        input.type = 'password';
        input.placeholder = '봇 토큰 붙여 넣기';
        input.autocomplete = 'off';
        const go = button('연결', 'btn btn-small btn-confirm');
        go.addEventListener('click', async () => {
          go.disabled = true;
          const r = await window.rano.mobileConnect(input.value).catch(() => ({ ok: false, message: '연결하지 못했어요' }));
          input.value = '';
          if (!r.ok) {
            msg.replaceChildren(note(r.message, false));
            go.disabled = false;
            return;
          }
          void draw();
        });
        row.append(input, go, msg);
        host.appendChild(row);
        return;
      }
      if (!m.paired) {
        host.appendChild(el('p', undefined, `@${m.botName ?? '봇'} 에 연결했어요. 이제 휴대폰과 짝을 지어요.`));
        const code = el('div', 'mobile-code');
        code.append(el('span', 'org-hint', '휴대폰 텔레그램에서 '), el('strong', undefined, `@${m.botName ?? ''}`), el('span', 'org-hint', ' 를 찾아 이 숫자를 보내 주세요'), el('span', 'mobile-code-num', m.pairCode ?? '------'));
        host.appendChild(code);
        const row = el('div', 'org-row');
        const again = button('코드 새로 받기', 'btn btn-small');
        again.addEventListener('click', async () => {
          await window.rano.mobileNewCode();
          void draw();
        });
        const off = button('연결 끊기', 'btn btn-small btn-plain');
        off.addEventListener('click', async () => {
          await window.rano.mobileDisconnect();
          void draw();
        });
        row.append(again, off);
        host.appendChild(row);
        if (m.error) host.appendChild(note(m.error, false));
        // 짝짓기를 기다리는 동안 상태를 다시 본다
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (alive()) void draw();
        }, 2500);
        return;
      }
      host.appendChild(el('p', 'org-ok', `연결됨 · ${m.pairedName || '휴대폰'} ↔ @${m.botName ?? ''}${m.running ? '' : ' (멈춤)'}`));
      for (const [key, label, on] of [
        ['allRano', '맥에서 한 대화(내 말과 라노 답)도 휴대폰으로 받기 (끄면 휴대폰에서 보낸 말의 답만)', m.allRano],
        ['approvals', '승인 요청을 휴대폰으로 받고 승인·반려하기', m.approvals],
        ['keepAwake', '휴대폰 연결 중에는 맥이 잠들지 않게 하기 (화면은 꺼져도 돼요)', m.keepAwake],
      ] as const) {
        const lab = el('label', 'org-check');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = on;
        cb.addEventListener('change', async () => {
          await window.rano.mobileOptions({ [key]: cb.checked });
          if (key === 'keepAwake') void draw();
        });
        lab.append(cb, document.createTextNode(` ${label}`));
        host.appendChild(lab);
      }
      if (m.keepAwake)
        host.appendChild(el('p', m.keepingAwake ? 'org-ok' : 'org-hint', m.keepingAwake ? '지금 맥이 잠들지 않게 막고 있어요. 덮개를 닫으면 맥은 그래도 잠들어요(전원·외부 모니터를 연결했다면 깨어 있어요). 배터리를 더 써요.' : '연결이 다시 이어지면 잠자기를 막아요.'));
      host.appendChild(el('p', 'org-hint', '맥이 켜져 있고 라노 OS 가 실행 중일 때만 답해요. 회사 일 내용도 텔레그램 서버를 거쳐요.'));
      if (m.error) host.appendChild(note(m.error, false));
      const off = button('연결 끊기', 'btn btn-small btn-plain');
      off.addEventListener('click', async () => {
        await window.rano.mobileDisconnect();
        void draw();
      });
      host.appendChild(off);
    };
    void draw();
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
