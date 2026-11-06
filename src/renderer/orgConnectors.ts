// 조직 탭 "외부 연결": Confluence 같은 사내 서비스(MCP 서버)를 가져와 미션마다 켜고 끈다.
// 글은 모두 textContent 로 넣는다.
import { el } from './dom.js';
import { button, type Notice } from './orgCommon.js';

export function connectorsSection(notice: Notice, missions: () => { id: string; name: string; archived?: boolean }[], reload: () => void): HTMLElement {
  const sec = el('section', 'org-section');
  const head = el('div', 'org-section-head');
  head.appendChild(el('h3', 'org-section-title', '외부 연결'));
  sec.appendChild(head);
  sec.appendChild(
    el('p', 'pane-sub', 'Confluence·Jira 처럼 회사 서비스에 연결하는 도구예요. 켠 미션의 리더와 팀원만 써요. 검색·조회는 바로 하고, 만들기·고치기·실행·배포 같은 쓰기와 비밀이 보일 수 있는 조회는 늘 승인함을 거쳐요. 키는 사람마다 달라서 이 맥 사용자가 직접 넣고, 키체인에 암호화해 둬요.'),
  );
  const list = el('div', 'connector-list');
  const cands = el('div', 'connector-cands');
  sec.append(list, cands);

  const draw = async () => {
    const [have, found] = await Promise.all([window.rano.connectorsList().catch(() => []), window.rano.connectorCandidates().catch(() => [])]);
    list.replaceChildren();
    if (!have.length) list.appendChild(el('p', 'board-note', '아직 가져온 연결이 없어요.'));
    for (const c of have) {
      const card = el('div', 'connector-card');
      const top = el('div', 'connector-top');
      top.appendChild(el('strong', '', c.label));
      const where = c.transport === 'stdio' ? '이 맥에서 실행' : `주소 접속 ${c.url ? new URL(c.url).host : ''}`;
      top.appendChild(el('span', 'org-hint', ` · ${c.name} · ${where}`));
      const rm = button('지우기', 'btn btn-small');
      rm.addEventListener('click', async () => {
        if (!window.confirm(`${c.label} 연결을 지울까요? 이 연결을 쓰던 미션에서도 빠져요.`)) return;
        const r = await window.rano.connectorRemove(c.name);
        notice.show(r.message, r.ok);
        void draw();
        reload();
      });
      top.appendChild(rm);
      card.appendChild(top);
      // 사람마다 다른 키: 이 맥 사용자가 직접 넣는다(키체인 암호화, 화면에 다시 보이지 않음)
      const keys = el('div', 'connector-keys');
      const keyHint = c.secretEnv.length
        ? c.missingSecrets.length
          ? `아직 넣지 않은 키: ${c.missingSecrets.join(', ')} — 이 연결을 쓰려면 본인 값을 넣어 주세요`
          : `키 ${c.secretEnv.length}개가 이 맥 키체인에 암호화돼 있어요 (${c.secretEnv.join(', ')})`
        : c.transport === 'stdio'
          ? '따로 넣은 키가 없어요. 로그인은 이 맥의 연결 프로그램이 본인 계정으로 해요.'
          : '따로 넣은 키가 없어요. 로그인이 필요하면 이 맥의 Claude Code 에서 한 로그인을 써요.';
      keys.appendChild(el('p', c.missingSecrets.length ? 'org-problem' : 'org-hint', keyHint));
      const keyRow = el('div', 'connector-key-row');
      const keyName = el('input', 'org-input');
      keyName.placeholder = c.transport === 'stdio' ? '이름 (예: CONFLUENCE_TOKEN)' : '이름 (예: Authorization)';
      keyName.value = c.missingSecrets[0] ?? '';
      const keyVal = el('input', 'org-input');
      keyVal.type = 'password';
      keyVal.placeholder = '값 (비우고 저장하면 지움)';
      keyVal.autocomplete = 'off';
      const keySave = button('키 저장', 'btn btn-small');
      keySave.addEventListener('click', async () => {
        const r = await window.rano.connectorSetSecret(c.name, keyName.value.trim(), keyVal.value);
        keyVal.value = '';
        notice.show(r.message, r.ok);
        if (r.ok) void draw();
      });
      keyRow.append(keyName, keyVal, keySave);
      keys.appendChild(keyRow);
      card.appendChild(keys);
      const ms = missions().filter((m) => !m.archived);
      if (!ms.length) card.appendChild(el('p', 'org-hint', '켤 미션이 아직 없어요.'));
      else {
        card.appendChild(el('p', 'org-hint', '이 연결을 쓸 미션 (다음 과제부터 반영)'));
        const row = el('div', 'connector-missions');
        for (const m of ms) {
          const lab = el('label', 'org-check');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = c.usedBy.includes(m.id);
          cb.dataset.mission = m.id;
          cb.addEventListener('change', async () => {
            const cur = (await window.rano.connectorsList().catch(() => [])).filter((x) => x.usedBy.includes(m.id)).map((x) => x.name);
            const next = cb.checked ? [...new Set([...cur, c.name])] : cur.filter((n) => n !== c.name);
            const r = await window.rano.setMissionConnectors(m.id, next);
            notice.show(r.message, r.ok);
          });
          lab.append(cb, document.createTextNode(` ${m.name}`));
          row.appendChild(lab);
        }
        card.appendChild(row);
      }
      list.appendChild(card);
    }
    cands.replaceChildren();
    const fresh = found.filter((f) => !f.imported);
    if (fresh.length) {
      cands.appendChild(el('p', 'org-hint', '이 맥의 Claude Code 에 등록된 연결이에요. 가져오면 라노 OS 에서도 쓸 수 있어요.'));
      for (const f of fresh) {
        const row = el('div', 'connector-cand');
        row.appendChild(el('span', '', `${f.name} — ${f.transport === 'stdio' ? `이 맥에서 실행 (${f.command.split('/').pop()})` : `주소 접속 (${f.url ? new URL(f.url).host : ''})`}`));
        const imp = button('가져오기', 'btn btn-small btn-confirm');
        imp.addEventListener('click', async () => {
          imp.disabled = true;
          const r = await window.rano.connectorImport(f.name);
          notice.show(r.message, r.ok);
          void draw();
          reload();
        });
        row.appendChild(imp);
        cands.appendChild(row);
      }
    }
  };
  void draw();
  return sec;
}
