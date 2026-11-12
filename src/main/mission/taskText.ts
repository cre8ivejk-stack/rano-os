// 과제 제목과 중단 보고 글 만들기(화면·알림·결과물함에 보이는 글)

/**
 * 과제 제목: 지시문에서 짧은 제목만 뽑는다(결과물함·현황판·알림에 보임).
 * 첫 문장을 쓰되 "○○님의 요청이에요" 같은 인사말, " — 뒤 설명", "목적:" 뒤는 떼어 낸다. 앞의 [종류] 표시는 남긴다.
 */
export function taskTitle(text: string, max = 44): string {
  let t = String(text ?? '').replace(/\r/g, '').trim();
  t = t.split(/\n\s*\n|\n\[사용자가 직접 쓴 말\]|\n---/)[0].replace(/\s+/g, ' ').trim();
  const tag = /^\[[^\]]{1,16}\]\s*/.exec(t)?.[0] ?? '';
  let body = t.slice(tag.length);
  body = body.replace(/^(빠른 모드로|팀으로|혼자)\s*(해\s?주세요|진행해\s?주세요|해줘)?[.!]?\s*/u, '') || body;
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
