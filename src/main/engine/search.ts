// 지난 일 찾기: 라노 대화, 리더 대화, 결과물(리더 보고·검수 결과), 승인함 기록을 한곳에서 찾는다(읽기만).
// 띄어 쓴 낱말이 모두 들어간 것만 찾고, 최근 것부터 50개까지 돌려준다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RanoConfig, SearchHit } from '../../shared/types.js';

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

const MAX = 50;

export function searchAll(config: RanoConfig, query: string): SearchHit[] {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return [];
  const match = (text: string) => {
    const t = text.toLowerCase();
    return terms.every((w) => t.includes(w));
  };
  const snippet = (text: string) => {
    const t = text.replace(/\*\*|`|^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
    const i = t.toLowerCase().indexOf(terms[0]);
    const start = Math.max(0, i - 50);
    return (start > 0 ? '…' : '') + t.slice(start, start + 180) + (start + 180 < t.length ? '…' : '');
  };
  const names = new Map(config.missions.map((m) => [m.id, m.name] as const));
  const hits: SearchHit[] = [];

  // 라노 대화
  const rano = readJson(path.join(config.runsDir, 'rano', 'conversation.json'));
  for (const m of Array.isArray(rano?.messages) ? rano.messages : []) {
    if (typeof m?.text === 'string' && match(m.text))
      hits.push({ kind: 'rano', who: m.role === 'user' ? '나 → 라노' : '라노', title: m.role === 'user' ? '라노에게 한 말' : '라노의 답', snippet: snippet(m.text), text: m.text, at: m.at });
  }
  for (const mission of config.missions) {
    const name = mission.name;
    // 리더 대화
    const conv = readJson(path.join(config.runsDir, 'missions', mission.id, 'conversation.json'));
    for (const m of Array.isArray(conv?.messages) ? conv.messages : []) {
      if (typeof m?.text === 'string' && match(m.text)) {
        const who = m.role === 'user' ? `나 → ${name} 리더` : m.role === 'rano' ? `라노 → ${name} 리더` : `${name} 리더`;
        hits.push({ kind: 'leader', missionId: mission.id, missionName: name, who, title: m.role === 'leader' ? '리더 보고·답' : '리더에게 맡긴 일', snippet: snippet(m.text), text: m.text, at: m.at });
      }
    }
    // 결과물
    const outs = readJson(path.join(config.runsDir, 'missions', mission.id, 'outputs.json'));
    for (const o of Array.isArray(outs) ? outs : []) {
      const parts = [o?.title ?? '', o?.leaderReport ?? '', ...(Array.isArray(o?.reviewReports) ? o.reviewReports.map((r: any) => r?.text ?? '') : []), ...(Array.isArray(o?.changedFiles) ? o.changedFiles.map((f: any) => f?.rel ?? f?.path ?? '') : [])];
      const all = parts.join('\n');
      if (all.trim() && match(all))
        hits.push({ kind: 'output', missionId: mission.id, missionName: name, who: `${name} 결과물`, title: String(o?.title ?? '과제'), snippet: snippet(o?.leaderReport || all), text: all, at: o?.endedAt ?? o?.startedAt });
    }
  }
  // 승인함
  const appr = readJson(path.join(config.runsDir, 'approvals.json'));
  const list = Array.isArray(appr) ? appr : Array.isArray(appr?.items) ? appr.items : [];
  for (const a of list) {
    const all = [a?.title, a?.what, a?.why, a?.recommendation, a?.decisionNote].filter(Boolean).join('\n');
    if (all && match(all))
      hits.push({ kind: 'approval', missionId: a.missionId, missionName: names.get(a.missionId) ?? a.missionId, who: a.who ?? '', title: String(a.title ?? '승인 요청'), snippet: snippet(all), text: all, at: a.decidedAt ?? a.createdAt });
  }
  hits.sort((x, y) => String(y.at ?? '').localeCompare(String(x.at ?? '')));
  return hits.slice(0, MAX).map((h) => ({ ...h, text: h.text.slice(0, 20_000) }));
}
