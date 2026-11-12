// 라노 답과 할 일 잇기: 라노가 답 맨 끝에 〔할일 id, id〕 표시를 붙이면 앱이 떼어 내 그 답이 다룬 할 일로 기록한다.
// 화면·휴대폰·저장되는 글에는 표시가 남지 않는다.

const ID = /[0-9a-f]{8}/g;
const MARKER = /\s*〔\s*할\s?일\s*[:：]?\s*([^〕]*)〕\s*$/;
/** 쓰는 중인 글 끝의 표시(아직 닫히지 않은 것 포함) */
const TAIL = /\s*〔[^〕]*〕?\s*$/;

/** 답 글에서 끝의 할 일 표시를 떼어 낸다 */
export function splitTodoMarker(text: string): { text: string; ids: string[] } {
  const m = MARKER.exec(text);
  if (!m) return { text, ids: [] };
  return { text: text.slice(0, m.index).trimEnd(), ids: [...new Set(m[1].match(ID) ?? [])] };
}

/** 흘려 보이는 글에서 끝의 표시를 가린다(쓰는 중이라 닫히지 않았어도) */
export function hideTodoMarker(text: string): string {
  const m = TAIL.exec(text);
  if (!m) return text;
  const tail = text.slice(m.index).trim();
  return /^〔\s*(할\s?(일.*)?)?$/.test(tail.replace(/〕$/, '')) || MARKER.test(tail) ? text.slice(0, m.index) : text;
}

/** 라노가 이번 차례에 부른 도구에서 다룬 할 일 id (고치기·지우기·맡기기) */
export function todoIdsFromTool(name: string, input: unknown): string[] {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{8}$/.test(v) ? [v] : []);
  if (/todo_(update|remove)$/.test(name)) return pick(i.id);
  if (/assign_to_mission$/.test(name)) return pick(i.todoId);
  return [];
}

const norm = (t: string) => t.toLowerCase().replace(/[\s"'“”‘’「」『』〔〕()\[\]{}.,:;!?·~\-_/]/g, '');

/**
 * 라노가 표시를 붙이지 않았을 때의 안전망: 주고받은 글에 할 일 제목이 그대로 나오면 그 할 일로 본다.
 * 제목이 너무 짧으면(4자 미만) 우연히 맞을 수 있어 보지 않는다. 끝난 일은 뺀다. 많아도 3개까지.
 */
export function matchTodosByTitle(items: { id: string; title: string; status: string }[], texts: string[]): string[] {
  const hay = norm(texts.join(' '));
  if (!hay) return [];
  const out: string[] = [];
  for (const x of items) {
    if (x.status === 'done') continue;
    const t = norm(x.title);
    if (t.length >= 4 && hay.includes(t)) out.push(x.id);
    if (out.length >= 3) break;
  }
  return out;
}
