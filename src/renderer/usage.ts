// 현황판 "사용량" 보기: 구독 사용 한도(엔진이 알려 준 최신값)와 이번 주·오늘 미션별 사용량, 최근 7일 막대.
import { el } from './dom.js';

const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5시간 한도',
  seven_day: '주간 한도',
  seven_day_opus: '주간 한도 (Opus)',
  seven_day_sonnet: '주간 한도 (Sonnet)',
  overage: '추가 사용',
};

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
function usd(n: number): string {
  return n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}
function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export class UsageView {
  readonly root = el('div', 'usage');

  async load(): Promise<void> {
    this.root.replaceChildren(el('p', 'board-note', '사용량을 불러오는 중이에요…'));
    let s: UsageSummary;
    try {
      s = await window.rano.usageSummary();
    } catch {
      this.root.replaceChildren(el('p', 'org-problem', '사용량을 불러오지 못했어요.'));
      return;
    }
    const wrap = el('div', 'usage-wrap');

    // 구독 사용 한도
    const lim = el('section', 'usage-sec');
    lim.appendChild(el('h3', 'usage-title', 'Claude 사용 한도'));
    if (!s.limits.length) {
      lim.appendChild(el('p', 'org-hint', '아직 한도 정보가 없어요. 라노나 리더가 일을 하면 Claude 가 알려 주는 값으로 채워져요 (API 키로 쓰면 한도 대신 사용한 만큼 요금이 나가요).'));
    } else {
      for (const l of s.limits) {
        const row = el('div', 'usage-limit');
        row.appendChild(el('span', 'usage-limit-name', LIMIT_LABEL[l.type] ?? l.type));
        const pct = typeof l.utilization === 'number' ? Math.round(l.utilization <= 1 ? l.utilization * 100 : l.utilization) : null;
        const bar = el('span', 'usage-bar');
        const warn = l.status === 'allowed_warning' || (pct ?? 0) >= 80;
        const fill = el('span', `usage-fill${l.status === 'rejected' ? ' over' : warn ? ' warn' : ''}`);
        fill.style.width = `${Math.min(100, pct ?? (l.status === 'rejected' ? 100 : 0))}%`;
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el('span', 'usage-pct', pct !== null ? `${pct}%` : l.status === 'rejected' ? '한도 도달' : l.status === 'allowed_warning' ? '거의 다 씀' : '여유'));
        row.appendChild(el('span', 'org-hint', [l.resetsAt ? `${when(l.resetsAt)} 다시 채워짐` : '', l.at ? `${when(l.at)} 확인` : ''].filter(Boolean).join(' · ')));
        lim.appendChild(row);
      }
    }
    wrap.appendChild(lim);

    // 이번 주 미션별
    const wk = el('section', 'usage-sec');
    const ws = new Date(s.weekStart).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
    wk.appendChild(el('h3', 'usage-title', `이번 주 사용량 (${ws} 월요일부터)`));
    if (!s.rows.length) wk.appendChild(el('p', 'org-hint', '이번 주에는 아직 기록이 없어요. 이 기능을 넣은 뒤부터 일한 양이 쌓여요.'));
    else {
      const table = el('table', 'usage-table');
      const head = el('tr');
      for (const h of ['누가', '주간 일', '주간 사용', 'API 예상', '오늘 일', '오늘 사용']) head.appendChild(el('th', undefined, h));
      table.appendChild(head);
      const total = s.rows.reduce((t, r) => t + r.weekTokens, 0) || 1;
      for (const r of s.rows) {
        const tr = el('tr');
        const who = el('td');
        who.appendChild(el('span', undefined, r.name));
        const share = el('span', 'usage-share');
        share.style.width = `${Math.round((r.weekTokens / total) * 100)}%`;
        who.appendChild(share);
        tr.append(who, el('td', undefined, `${r.weekRuns}번`), el('td', undefined, tokens(r.weekTokens)), el('td', undefined, usd(r.weekCost)), el('td', undefined, `${r.todayRuns}번`), el('td', undefined, tokens(r.todayTokens)));
        table.appendChild(tr);
      }
      wk.appendChild(table);
      wk.appendChild(el('p', 'org-hint', '사용은 Claude 가 읽고 쓴 양(토큰)이에요. "API 기준 예상"은 API 요금으로 쳤을 때의 값이고, 구독 계정이면 실제로 따로 나가는 돈은 없어요.'));
    }
    wrap.appendChild(wk);

    // 최근 7일
    const dsec = el('section', 'usage-sec');
    dsec.appendChild(el('h3', 'usage-title', '최근 7일'));
    const max = Math.max(1, ...s.days.map((d) => d.tokens));
    const chart = el('div', 'usage-days');
    for (const d of s.days) {
      const col = el('div', 'usage-day');
      const b = el('span', 'usage-day-bar');
      b.style.height = `${Math.max(2, Math.round((d.tokens / max) * 80))}px`;
      b.title = `${d.date}: ${tokens(d.tokens)}`;
      const label = new Date(`${d.date}T00:00:00`).toLocaleDateString('ko-KR', { weekday: 'short', day: 'numeric' });
      col.append(el('span', 'usage-day-val', d.tokens ? tokens(d.tokens) : ''), b, el('span', 'usage-day-date', label));
      chart.appendChild(col);
    }
    dsec.appendChild(chart);
    wrap.appendChild(dsec);

    const again = el('button', 'btn btn-small', '새로 보기');
    again.type = 'button';
    again.addEventListener('click', () => void this.load());
    wrap.appendChild(again);
    this.root.replaceChildren(wrap);
  }
}
