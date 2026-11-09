// 사용자가 직접 "원격 최신 받아오기(pull)"를 시켰는지. 시켰으면 그 과제 동안 받아오기(fetch·pull --ff-only·보관·되살리기)는
// 승인 없이 한다(지시가 곧 승인, 2026-11-09 사용자 결정). 라노가 다시 쓴 지시가 아니라 사용자가 쓴 말로만 판단한다.

const SYNC_WORDS = [
  /\bgit\s+(pull|fetch)\b/i,
  /\bpull\b/i,
  /깃\s*풀/,
  /풀\s*(해|받|하|좀)/,
  /최신화/,
  /최신(\s*(버전|상태|내용|코드))?\s*(으로|을|를)?\s*(맞|받|가져|당겨|업데이트)/,
  /(원격|서버|깃|git)\S*\s*(최신|내용|기록|변경)?\S*\s*(받아|가져|당겨)/i,
  /받아\s*(와|오|줘)/,
  /당겨\s*(와|오|줘)/,
];
// "pull 하지 마" 처럼 막는 말이 있으면 미리 승인하지 않는다
const NEGATION = /(pull|풀|받아오|당겨|최신화)[^.\n]{0,12}(하지\s*마|말고|금지|안\s*돼|하면\s*안)/i;

export function userAskedSync(text: string): boolean {
  const t = String(text ?? '');
  if (!t.trim() || NEGATION.test(t)) return false;
  return SYNC_WORDS.some((re) => re.test(t));
}
