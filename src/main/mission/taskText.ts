// 과제 제목과 중단 보고 글 만들기(화면·알림·결과물함에 보이는 글)

/**
 * 과제 제목: 지시문에서 짧은 제목만 뽑는다(결과물함·현황판·알림에 보임).
 * 첫 문장을 쓰되 "○○님의 요청이에요" 같은 인사말, " — 뒤 설명", "목적:" 뒤는 떼어 낸다. 앞의 [종류] 표시는 남긴다.
 */
const TITLE_TAG = /^\[제목\s*[:：]\s*([^\]\n]{1,80})\]\s*/;

/** 지시문 맨 앞에 제목 표시를 붙인다(화면·알림·결과물함의 제목이 된다). 제목이 비면 그대로 */
export function withTitle(text: string, title?: string): string {
  const t = String(title ?? '').replace(/[\[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return t && !TITLE_TAG.test(text) ? `[제목: ${t}]\n\n${text}` : text;
}

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
/** 오늘 날짜·요일과 이번 주·다음 주(월~일) 범위 한 줄. 에이전트가 요일을 짐작하지 않게 차례마다 알려 준다 (0.9.19) */
export function todayLine(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const plus = (n: number) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + n);
  return `[앱 안내] 지금은 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}(${DAYS[now.getDay()]}) ${p(now.getHours())}:${p(now.getMinutes())}이에요. 이번 주는 ${md(mon)}(월)~${md(plus(6))}(일), 평일은 ${md(plus(4))}(금)까지예요. 다음 주는 ${md(plus(7))}(월)~${md(plus(13))}(일)이에요.`;
}

export function taskTitle(text: string, max = 44): string {
  let t = String(text ?? '').replace(/\r/g, '').trim();
  // 라노가 맡길 때 붙인 제목 표시([제목: …])가 있으면 그대로 쓴다 (0.9.19)
  const named = TITLE_TAG.exec(t);
  if (named) {
    const n = named[1].replace(/\s+/g, ' ').trim();
    if (n) return n.length > max ? `${n.slice(0, max)}…` : n;
    t = t.slice(named[0].length).trim();
  }
  t = t.split(/\n\s*\n|\n\[사용자가 직접 쓴 말\]|\n---/)[0].replace(/\s+/g, ' ').trim();
  const tag = /^\[[^\]]{1,16}\]\s*/.exec(t)?.[0] ?? '';
  let body = t.slice(tag.length);
  body = body.replace(/^(빠른 모드로|팀으로|혼자)\s*(해\s?주세요|진행해\s?주세요|해줘)?[.!]?\s*/u, '') || body;
  // "○○님 지시: …" · "사용자 요청: …" 같은 머리말은 뗀다. 웹 주소는 사이트 이름만 남긴다 (0.9.12)
  body = body.replace(/^\S{1,12}(님)?(의)?\s*(지시|요청)\s*[:：]\s*/u, '') || body;
  body = body.replace(/https?:\/\/([^\s\/]+)\S*/g, '$1');
  // "목적: …" · "이어지는 일: …" 같은 머리말은 떼고 그 뒤 글을 제목으로 쓴다 (0.9.19)
  body = body.replace(/^(목적|배경|이어지는 일|할 일|과제)\s*[:：]\s*/u, '') || body;
  // "지난 과제(c2226f79)에서 고친 …" 의 과제 번호와 머리말은 뗀다 (0.9.14)
  body = body.replace(/^((지난|직전|앞|이전)\s*과제)\s*\([0-9a-f]{6,}\)/u, '$1');
  body = body.replace(/^(지난|직전|앞|이전)\s*과제에서\s+(?=\S)/u, '') || body;
  body = body.split(/\s+[—–]\s+|\s+목적\s*[:：]|\s+배경\s*[:：]|\s+범위\s*[:：]/)[0];
  // 문장 끝(다. 요. 기. 등 뒤의 마침표 + 빈칸)에서 자른다. 파일 이름의 점(README.md)은 자르지 않는다
  const cut = /[.!?。](?=\s)/.exec(body);
  if (cut && cut.index >= 6) body = body.slice(0, cut.index);
  body = body.replace(/\s*\S+님(\([^)]*\))?[의이가]?\s*(요청|지시)[^.]*$/u, '').trim() || body.trim();
  const out = `${tag}${body.replace(/[.!?。]+$/, '')}`.trim() || t;
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** 중단된 과제 보고: 리더가 남긴 중간 말 가운데 한글이 있는 마지막 몇 줄만 "진행 메모"로 보인다(혼잣말·영어 메모는 뺀다) */
export function interruptedReport(reason: string, partial: string, keep = 6): string {
  const notes = partial
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p && /[가-힣]/.test(p) && (p.match(/[가-힣]/g) ?? []).length >= p.replace(/\s/g, '').length * 0.3)
    .slice(-keep)
    .map((p) => `- ${p.length > 200 ? `${p.slice(0, 200)}…` : p}`);
  return `**중간에 멈췄어요.** ${reason}${notes.length ? `\n\n**멈추기 전까지의 진행(리더가 남긴 말)**\n${notes.join('\n')}` : ''}`;
}
