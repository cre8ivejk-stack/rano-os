// 조직 탭 "스킬": 문서 도구 설치, 스킬 목록·보기·지우기, 가져오기(미리 보고 승인), 역할마다 쓸 스킬 고르기.
import { el, renderRich } from './dom.js';
import { button, type Notice } from './orgCommon.js';

function modal(title: string, wide = false): { box: HTMLElement; body: HTMLElement; actions: HTMLElement; close: () => void } {
  const overlay = el('div', 'org-modal-overlay');
  const box = el('div', `org-modal${wide ? ' skill-modal' : ''}`);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  box.appendChild(el('h3', 'org-modal-title', title));
  const body = el('div', 'org-modal-body skill-modal-body');
  const actions = el('div', 'org-modal-actions');
  box.append(body, actions);
  overlay.appendChild(box);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  return { box, body, actions, close };
}

/** 스킬 내용 보기 */
export async function openSkillView(name: string): Promise<void> {
  const m = modal(`스킬 보기 · ${name}`, true);
  const close = button('닫기', 'btn');
  close.addEventListener('click', m.close);
  m.actions.appendChild(close);
  const s = await window.rano.skillRead(name).catch(() => null);
  if (!s) {
    m.body.appendChild(el('p', 'org-problem', '스킬을 읽지 못했어요.'));
    return;
  }
  m.body.appendChild(el('p', 'org-hint', s.description));
  if (s.files.length > 1) m.body.appendChild(el('p', 'org-hint', `딸린 파일: ${s.files.filter((f) => f !== 'SKILL.md').join(', ')}`));
  const view = el('div', 'docs-content skill-md');
  renderRich(view, s.body);
  m.body.appendChild(view);
}

/** 가져오기: 주소·폴더 → 미리 보기 → 승인하면 넣기 */
export function openSkillImport(onDone: () => void, initial?: string): void {
  const m = modal('스킬 가져오기', true);
  m.body.appendChild(el('p', 'org-hint', 'GitHub 의 스킬 폴더 주소(…/tree/main/skills/이름)나 이 맥의 스킬 폴더(SKILL.md 가 있는 폴더)를 넣어 주세요. 넣기 전에 파일과 내용을 먼저 보여 드려요.'));
  const row = el('div', 'org-row');
  const input = el('input', 'org-input');
  input.placeholder = '예) https://github.com/anthropics/skills/tree/main/skills/webapp-testing';
  const look = button('미리 보기', 'btn btn-small btn-confirm');
  const pick = button('폴더 고르기', 'btn btn-small');
  row.append(input, look, pick);
  m.body.appendChild(row);
  const out = el('div', 'skill-preview');
  m.body.appendChild(out);
  const cancel = button('닫기', 'btn');
  cancel.addEventListener('click', m.close);
  const install = button('이 스킬 넣기', 'btn btn-approve');
  install.hidden = true;
  m.actions.append(cancel, install);
  let token = '';
  pick.addEventListener('click', async () => {
    const p = await window.rano.orgPickFolder('ref', 'personal').catch(() => null);
    if (p) {
      input.value = p;
      look.click();
    }
  });
  look.addEventListener('click', async () => {
    look.disabled = true;
    install.hidden = true;
    out.replaceChildren(el('p', 'org-hint', '받아서 살펴보는 중이에요…'));
    const r = await window.rano.skillPreview(input.value).catch(() => ({ ok: false as const, message: '가져오지 못했어요' }));
    look.disabled = false;
    if (!r.ok) {
      out.replaceChildren(el('p', 'org-problem', r.message));
      return;
    }
    const p = r.preview;
    token = p.token;
    out.replaceChildren();
    out.appendChild(el('h4', 'settings-title', `${p.name}`));
    out.appendChild(el('p', undefined, p.description || '(설명 없음)'));
    if (p.builtin) out.appendChild(el('p', 'org-problem', '라노 OS 기본 스킬과 같은 이름이라 넣을 수 없어요.'));
    else if (p.exists) out.appendChild(el('p', 'org-warning', '같은 이름의 스킬이 이미 있어요. 넣으면 새 것으로 바뀌어요.'));
    const scripts = p.files.filter((f) => f.script);
    if (scripts.length)
      out.appendChild(el('p', 'org-warning', `실행 파일(스크립트) ${scripts.length}개가 들어 있어요: ${scripts.map((f) => f.path).join(', ')}. 팀원이 실행할 때는 승인함을 거쳐요. 내용을 확인한 뒤 넣어 주세요.`));
    const files = el('details', 'fold');
    files.appendChild(el('summary', undefined, `파일 ${p.files.length}개`));
    const ul = el('ul', 'org-plain-list');
    for (const f of p.files) ul.appendChild(el('li', f.script ? 'skill-script' : '', `${f.path} · ${Math.max(1, Math.round(f.size / 1024))}KB`));
    files.appendChild(ul);
    out.appendChild(files);
    if (p.license) {
      const lic = el('details', 'fold');
      lic.appendChild(el('summary', undefined, '라이선스'));
      lic.appendChild(el('pre', 'md-code', p.license));
      out.appendChild(lic);
      if (/All rights reserved|may not/i.test(p.license)) out.appendChild(el('p', 'org-warning', '라이선스에 복사·보관·배포 제한이 있어요. 써도 되는지 확인해 주세요.'));
    }
    const md = el('div', 'docs-content skill-md');
    renderRich(md, p.skillMd.replace(/^---\n[\s\S]*?\n---\n?/, ''));
    out.appendChild(md);
    install.hidden = p.builtin;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') look.click();
  });
  if (initial) {
    input.value = initial;
    look.click();
  }
  install.addEventListener('click', async () => {
    install.disabled = true;
    const r = await window.rano.skillInstall(token).catch(() => ({ ok: false, message: '넣지 못했어요' }));
    if (r.ok) {
      m.close();
      onDone();
    } else {
      out.prepend(el('p', 'org-problem', r.message));
      install.disabled = false;
    }
  });
  input.focus();
}

/** 조직 탭 목록의 "스킬" 칸 */
export function skillsSection(notice: Notice, roleNames: () => string[], reload: () => void): HTMLElement {
  const sec = el('section', 'org-section');
  const head = el('div', 'org-section-head');
  head.appendChild(el('h3', 'org-section-title', '스킬'));
  const add = button('+ 스킬 가져오기', 'btn btn-confirm');
  add.addEventListener('click', () => openSkillImport(reload));
  head.appendChild(add);
  sec.appendChild(head);
  sec.appendChild(el('p', 'pane-sub', '스킬은 일하는 법이에요. 리더와 팀원이 일에 맞는 스킬을 골라 쓰고, 역할 카드에서 늘 쓸 스킬을 정해 둘 수도 있어요. 엑셀·워드·파워포인트·PDF 스킬은 문서 도구가 있어야 해요.'));

  // 스스로 골라 쓰기
  const autoRow = el('label', 'org-check skill-auto');
  const autoCb = el('input');
  autoCb.type = 'checkbox';
  autoCb.disabled = true;
  autoRow.append(autoCb, document.createTextNode(' 리더와 팀원이 일에 맞는 스킬을 스스로 골라 쓰기 (끄면 역할에 체크한 스킬만 써요)'));
  sec.appendChild(autoRow);
  void window.rano.skillsAuto().then((on) => {
    autoCb.checked = on;
    autoCb.disabled = false;
  });
  autoCb.addEventListener('change', async () => {
    const r = await window.rano.setSkillsAuto(autoCb.checked);
    notice.show(r.message, r.ok);
  });

  // 문서 도구
  const tools = el('div', 'skill-tools');
  sec.appendChild(tools);
  const drawTools = async () => {
    const t = await window.rano.toolsStatus().catch(() => null);
    tools.replaceChildren();
    if (!t) return;
    if (t.installed) {
      tools.appendChild(el('span', 'org-ok', `문서 도구 설치됨 · ${t.packages.map((p) => `${p.name} ${p.version}`).join(', ')}`));
      const br = el('div', 'skill-tools-row');
      if (t.browser) br.appendChild(el('span', 'org-ok', '웹 화면 확인 도구 설치됨 (playwright·Chromium)'));
      else {
        br.appendChild(el('span', 'org-hint', t.installing ? `설치하는 중… ${t.log ?? ''}` : '웹 화면 확인 도구(webapp-testing 스킬용 브라우저)는 아직 없어요. 데이터 폴더 안에만 설치해요 (약 150MB).'));
        if (!t.installing) {
          const gb = button('웹 화면 확인 도구 설치', 'btn btn-small');
          gb.addEventListener('click', async () => {
            gb.disabled = true;
            const timer = window.setInterval(() => void drawTools(), 2000);
            const r = await window.rano.toolsInstall('browser').catch(() => ({ ok: false, message: '설치하지 못했어요' }));
            window.clearInterval(timer);
            notice.show(r.message, r.ok);
            void drawTools();
          });
          br.appendChild(gb);
        }
      }
      tools.appendChild(br);
      return;
    }
    tools.appendChild(el('span', 'org-warning', t.installing ? `설치하는 중… ${t.log ?? ''}` : '문서 도구(파이썬 openpyxl·python-docx·python-pptx·pypdf·reportlab)가 아직 없어요. 라노 데이터 폴더 안에만 설치하고, 인터넷에서 받아요.'));
    if (!t.installing) {
      const go = button('문서 도구 설치', 'btn btn-small btn-confirm');
      go.addEventListener('click', async () => {
        go.disabled = true;
        const timer = window.setInterval(() => void drawTools(), 1500);
        const r = await window.rano.toolsInstall().catch(() => ({ ok: false, message: '설치하지 못했어요' }));
        window.clearInterval(timer);
        notice.show(r.message, r.ok);
        void drawTools();
      });
      tools.appendChild(go);
    }
  };
  void drawTools();

  const list = el('div', 'org-roles');
  sec.appendChild(list);

  // 추천 스킬 (라이선스를 확인해 둔 공개 스킬 중 아직 없는 것)
  const recSec = el('div', 'skill-rec');
  sec.appendChild(recSec);
  void window.rano.skillRegistry().then((reg) => {
    const rest = reg.filter((r) => !r.installed);
    if (!rest.length) return;
    // 평소에는 접어 둔다(내가 넣은 스킬이 묻히지 않게)
    const fold = el('details', 'skill-rec-fold');
    fold.appendChild(el('summary', 'settings-title skill-rec-sum', `추천 스킬 ${rest.length}개 보기`));
    fold.appendChild(el('p', 'org-hint', '라이선스를 확인해 둔 공개 스킬이에요. 라노도 새 일을 들으면 이 중에서 맞는 것을 대화에서 추천해요.'));
    const ul = el('div', 'skill-rec-list');
    for (const r of rest) ul.appendChild(suggestionRow(r, reload));
    fold.appendChild(ul);
    recSec.appendChild(fold);
  });
  void (async () => {
    const skills = await window.rano.skillsList().catch(() => [] as SkillInfo[]);
    if (!skills.length) {
      list.appendChild(el('p', 'board-note', '스킬이 없어요.'));
      return;
    }
    for (const s of skills) {
      const card = el('article', 'org-role');
      const top = el('div', 'org-card-top');
      top.appendChild(el('h4', 'org-role-name', s.name));
      top.appendChild(el('span', `kind ${s.builtin ? 'org-src-pool' : 'org-src-mission'}`, s.builtin ? '라노 기본' : '가져옴'));
      if (s.hasScripts) top.appendChild(el('span', 'kind', '실행 파일 있음'));
      card.appendChild(top);
      card.appendChild(el('p', 'org-role-desc', s.description || '설명 없음'));
      card.appendChild(el('p', 'org-role-meta', s.usedBy.length ? `늘 쓰는 역할: ${s.usedBy.join(', ')}` : '필요할 때 리더·팀원이 골라 써요'));
      const acts = el('div', 'org-row');
      const view = button('보기', 'btn btn-small btn-plain');
      view.addEventListener('click', () => void openSkillView(s.name));
      acts.appendChild(view);
      if (!s.builtin) {
        const del = button('지우기', 'btn btn-small btn-plain');
        del.addEventListener('click', async () => {
          const r = await window.rano.skillRemove(s.name);
          notice.show(r.message, r.ok);
          reload();
        });
        acts.appendChild(del);
      }
      card.appendChild(acts);
      list.appendChild(card);
    }
    void roleNames;
  })();
  return sec;
}

/** 역할 편집 화면의 "쓸 수 있는 스킬" 고르기 (바로 저장) */
export function roleSkillPicker(role: string): HTMLElement {
  const box = el('div', 'org-field');
  box.appendChild(el('span', 'org-label', '쓸 수 있는 스킬'));
  const row = el('div', 'org-check-row skill-picks');
  const msg = el('p', 'org-hint', '고르면 바로 저장돼요. 이 역할을 부를 때 스킬 안내가 지침에 붙어요(승인함을 거쳐 쓰기 미션에서만).');
  box.append(row, msg);
  void (async () => {
    const [skills, map] = await Promise.all([window.rano.skillsList().catch(() => [] as SkillInfo[]), window.rano.roleSkills().catch(() => ({}) as Record<string, string[]>)]);
    const picked = new Set(map[role] ?? []);
    if (!skills.length) row.appendChild(el('span', 'org-hint', '스킬이 없어요'));
    for (const s of skills) {
      const lab = el('label', 'org-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = picked.has(s.name);
      cb.addEventListener('change', async () => {
        if (cb.checked) picked.add(s.name);
        else picked.delete(s.name);
        const r = await window.rano.setRoleSkills(role, [...picked]);
        msg.textContent = r.message;
        msg.className = r.ok ? 'org-ok' : 'org-problem';
      });
      lab.title = s.description;
      lab.append(cb, document.createTextNode(` ${s.name}`));
      row.appendChild(lab);
    }
  })();
  return box;
}

/** 추천 스킬 한 줄: 이름·이유·라이선스 + [미리 보고 넣기] */
export function suggestionRow(r: SkillSuggestion, onDone: () => void): HTMLElement {
  const row = el('div', 'skill-rec-row');
  const info = el('div', 'skill-rec-info');
  info.appendChild(el('strong', undefined, r.name));
  info.appendChild(el('span', 'org-hint', ` · ${r.license}`));
  info.appendChild(el('p', 'skill-rec-why', r.why + (r.matched.length ? ` (맞은 말: ${r.matched.join(', ')})` : '')));
  row.appendChild(info);
  if (r.installed) row.appendChild(el('span', 'org-ok', '넣음'));
  else {
    const b = button('미리 보고 넣기', 'btn btn-small btn-confirm');
    b.addEventListener('click', () =>
      openSkillImport(() => {
        b.replaceWith(el('span', 'org-ok', '넣음'));
        onDone();
      }, r.url),
    );
    row.appendChild(b);
  }
  return row;
}

/** 대화 속 "라노의 스킬 추천" 카드 */
export function skillSuggestCard(need: string, items: SkillSuggestion[], onDone: () => void): HTMLElement {
  const card = el('article', 'proposal-card skill-suggest');
  const head = el('div', 'proposal-head');
  head.appendChild(el('span', 'proposal-tag', '스킬 추천'));
  head.appendChild(el('span', 'proposal-name', need.length > 60 ? `${need.slice(0, 60)}…` : need));
  card.appendChild(head);
  for (const it of items) card.appendChild(suggestionRow(it, onDone));
  card.appendChild(el('p', 'proposal-note', '넣기 전에 파일·내용·라이선스를 먼저 보여 드려요. 넣은 스킬은 리더·팀원이 필요할 때 골라 써요.'));
  return card;
}
