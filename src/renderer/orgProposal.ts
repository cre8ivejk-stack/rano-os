// 대화 속 "라노의 미션 구성안" 카드. 아무것도 만들지 않고, 버튼을 누르면 조직 탭 미션 추가 화면을 채워서 연다.
import { el, zoneInfo } from './dom.js';
import { tildify } from './orgCommon.js';

export function proposalCard(p: MissionProposal, onOpen: () => void): HTMLElement {
  const card = el('article', 'proposal-card');
  card.setAttribute('aria-label', `라노의 미션 구성안: ${p.name}`);
  const head = el('div', 'proposal-head');
  head.appendChild(el('span', 'proposal-tag', '미션 구성안'));
  head.appendChild(el('span', 'proposal-name', p.name));
  card.appendChild(head);
  if (p.goal) card.appendChild(el('p', 'proposal-goal', p.goal));
  const rows = el('dl', 'appr-rows proposal-rows');
  const add = (k: string, v: string) => {
    rows.appendChild(el('dt', undefined, k));
    rows.appendChild(el('dd', undefined, v));
  };
  add('구역', `${zoneInfo(p.zone).label} (${zoneInfo(p.zone).root})`);
  add('작업 폴더', p.target ? tildify(p.target) : '정하지 않음 (화면에서 골라요)');
  if (p.targetNote) add('확인할 점', p.targetNote);
  if (p.readonlyRefs.length) add('참고 폴더', p.readonlyRefs.map(tildify).join('\n'));
  const workers = p.roles.filter((r) => !p.reviewerRoles.includes(r));
  add('작업 담당', workers.join(', ') || '없음');
  add('검수', p.reviewerRoles.join(', ') || '없음');
  if (p.newRoles.length) add('새로 만들 역할', p.newRoles.map((r) => `${r.name} — ${r.description}`).join('\n'));
  if (p.reason) add('이렇게 짠 이유', p.reason);
  card.appendChild(rows);
  card.appendChild(el('p', 'proposal-note', '아직 아무것도 만들지 않았어요. 쓰기 권한과 비밀 파일 차단은 미션 추가 화면에서 직접 정해요.'));
  const btn = el('button', 'btn btn-confirm', '조직 탭에서 이 내용으로 열기');
  btn.type = 'button';
  btn.addEventListener('click', onOpen);
  card.appendChild(btn);
  return card;
}
