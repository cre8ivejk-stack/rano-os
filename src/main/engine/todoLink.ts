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

const CHOICE_MARKER = /\s*〔\s*선택\s*[:：]?\s*([^〕]*)〕\s*$/;

/**
 * 답 끝의 표시들을 떼어 낸다: 〔할일 id, id〕 와 〔선택 A | B〕 (순서는 상관없음).
 * 선택은 사용자가 눌러 답할 짧은 말 2~3개. 화면이 답 아래 단추로 보인다.
 */
export function splitMarkers(text: string): { text: string; ids: string[]; choices: string[] } {
  let rest = text;
  let ids: string[] = [];
  let choices: string[] = [];
  for (let n = 0; n < 3; n++) {
    const c = CHOICE_MARKER.exec(rest);
    if (c) {
      choices = c[1]
        .split('|')
        .map((x) => x.replace(/\s+/g, ' ').trim())
        .filter((x) => x && x.length <= 30)
        .slice(0, 3);
      rest = rest.slice(0, c.index).trimEnd();
      continue;
    }
    const t = splitTodoMarker(rest);
    if (t.text !== rest) {
      ids = [...new Set([...t.ids, ...ids])];
      rest = t.text;
      continue;
    }
    break;
  }
  return { text: rest, ids, choices };
}

/** 흘려 보이는 글에서 끝의 표시들(할 일·선택, 쓰는 중인 것 포함)을 가린다 */
export function hideMarkers(text: string): string {
  let out = text;
  for (let n = 0; n < 3; n++) {
    const c = CHOICE_MARKER.exec(out);
    let next = c ? out.slice(0, c.index) : hideTodoMarker(out);
    if (next === out) {
      // 쓰는 중인 선택 표시: "〔선", "〔선택 권장대로 |"
      const m = /\s*〔\s*(선(택[^〕]*)?)?$/.exec(out);
      next = m && m[0].includes('〔') ? out.slice(0, m.index) : out;
    }
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 리더 보고 알림의 머리글에서 미션 이름·과제 제목·결과·과제 id 를 읽는다 */
export function parseReportNotice(text: string): { mission: string; title: string; ok: boolean; taskId?: string } | null {
  const head = text.slice(0, 600);
  const m = /^\[앱 알림\] (.+?) 리더 보고 \(과제: (.*?), 결과: (완료|중단)/.exec(head);
  if (!m) return null;
  const task = /과제 id: ([0-9a-f-]{8,40})/.exec(head)?.[1];
  return { mission: m[1], title: m[2], ok: m[3] === '완료', ...(task ? { taskId: task } : {}) };
}

/** 사용자가 리더에게 직접 지시했다는 알림에서 미션 이름을 읽는다 */
export function parseDirectNotice(text: string): string | null {
  return /^\[앱 알림\] 사용자가 (.+?) 리더에게 직접 지시했습니다/.exec(text.slice(0, 300))?.[1] ?? null;
}

const ASKS = /정해 주|어느 쪽|어떤 쪽|골라 주|고르시|할까요\?|하실래요|말씀해 주|알려 주세요|어떻게 할지/;

/**
 * 라노가 선택 표시를 붙이지 않았을 때의 안전망. 답이 사용자에게 묻고 있을 때만 단추를 만든다.
 * - 번호 목록의 안 가운데 하나를 고르는 꼴(굵은 제목, 하나에 "(권장)"): "1번 · 제목" 단추들(권장이 먼저)
 * - 항목마다 권장이 적힌 여러 결정, 또는 "권장대로"라고 말해 달라는 꼴: [권장대로 진행]
 */
export function fallbackChoices(text: string): string[] {
  if (!ASKS.test(text) && !/["“'‘]권장(안)?대로["”'’]/.test(text)) return [];
  const items: { n: string; label: string; rec: boolean; line: string }[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d)[.)]\s+(?:\*\*(.+?)\*\*|([^:：.]{2,40}))\s*[:：.]?/.exec(line);
    if (!m) continue;
    const raw = (m[2] ?? m[3] ?? '').trim();
    items.push({ n: m[1], label: raw.replace(/\s*\(권장[^)]*\)\s*/g, '').replace(/[:：.]$/, '').trim(), rec: /\(권장/.test(raw) || /\(권장/.test(line.slice(0, 60)), line });
  }
  const recInside = items.filter((x) => /권장(안)?은|권장\s*[:：]/.test(x.line)).length;
  if (items.length >= 2 && items.length <= 4 && recInside === 0) {
    const ordered = [...items.filter((x) => x.rec), ...items.filter((x) => !x.rec)].slice(0, 3);
    return ordered.map((x) => {
      const full = `${x.n}번 · ${x.label}`;
      return full.length <= 30 ? full : `${x.n}번으로`;
    });
  }
  if (recInside >= 1 || /["“'‘]권장(안)?대로["”'’]/.test(text) || /권장(안)?대로/.test(text)) return ['권장대로 진행'];
  return [];
}
