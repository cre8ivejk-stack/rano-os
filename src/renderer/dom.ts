// 화면 공통 도구: 요소 만들기, 시각 표시, 간단한 마크다운, 입력창 규칙.
// 글은 모두 textContent / 텍스트 노드로만 넣는다(innerHTML 쓰지 않음).

export function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`화면 요소를 찾지 못했습니다: ${id}`);
  return node as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- 시각 ----------
export function toDate(at: string): Date {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
export function formatTime(at: string): string {
  return toDate(at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
}
export function dayKey(at: string): string {
  const d = toDate(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
export function formatDay(at: string): string {
  return toDate(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
}
// 오늘이면 "오후 4:51", 다른 날이면 "11월 3일 오후 4:51"
export function formatWhen(at: string): string {
  if (dayKey(at) === dayKey(new Date().toISOString())) return formatTime(at);
  const d = toDate(at);
  return `${d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })} ${formatTime(at)}`;
}

// ---------- 간단한 마크다운 ----------
// 굵게(**글**)만 안전하게 표현한다.
export function appendInline(parent: HTMLElement, text: string): void {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      parent.appendChild(el('strong', undefined, part.slice(2, -2)));
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

// # 제목, - 목록, 1. 목록, **굵게** 를 DOM 요소로 직접 만든다.
export function renderRich(container: HTMLElement, text: string): void {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: HTMLUListElement | HTMLOListElement | null = null;

  const flushPara = () => {
    while (para.length && !para[0].trim()) para.shift();
    while (para.length && !para[para.length - 1].trim()) para.pop();
    if (para.length) {
      const p = el('p', 'md-p');
      appendInline(p, para.join('\n'));
      container.appendChild(p);
    }
    para = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);

    if (heading) {
      flushPara();
      list = null;
      const h = el('div', heading[1].length <= 1 ? 'md-h1' : 'md-h2');
      appendInline(h, heading[2]);
      container.appendChild(h);
    } else if (bullet || ordered) {
      flushPara();
      const wantTag = bullet ? 'UL' : 'OL';
      if (!list || list.tagName !== wantTag) {
        if (bullet) {
          list = el('ul', 'md-list');
        } else {
          const ol = el('ol', 'md-list');
          ol.start = Number(ordered![1]) || 1;
          list = ol;
        }
        container.appendChild(list);
      }
      const li = el('li');
      appendInline(li, bullet ? bullet[1] : ordered![2]);
      list.appendChild(li);
    } else if (!line.trim()) {
      // 빈 줄: 목록은 끝내고, 문단 안에서는 간격으로 남긴다.
      if (list) list = null;
      else para.push(line);
    } else {
      list = null;
      para.push(line);
    }
  }
  flushPara();
}

// ---------- 입력창 ----------
// Enter 보내기 · Shift+Enter 줄바꿈 · 한글 조합 중 Enter 무시 · 내용에 맞춰 높이 조절
export function bindComposer(opts: {
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  onSubmit: () => void;
  onInput?: () => void;
}): { autosize: () => void } {
  const { form, input, onSubmit, onInput } = opts;
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    // 한글 조합 중 Enter 는 글자 확정용이므로 무시한다(마지막 글자가 두 번 가는 문제 방지).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey) return;
    e.preventDefault();
    onSubmit();
  });
  input.addEventListener('input', () => {
    autosize();
    onInput?.();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit();
  });
  return { autosize };
}

// ---------- 역할 이름 쉬운 설명 ----------
// 데이터 폴더 설정(rano.json roleLabels)에서 앱을 켤 때 불러온다.
let ROLE_LABELS: Record<string, string> = {};
export function setRoleLabels(map: Record<string, string>): void {
  ROLE_LABELS = map && typeof map === 'object' ? { ...map } : {};
}
// 구역 이름·폴더 (rano.json zones)
let ZONES: Record<Zone, { label: string; root: string }> = { work: { label: '회사', root: '~/work' }, personal: { label: '개인', root: '~/personal' } };
export function setZoneInfo(z: Record<Zone, { label: string; root: string }>): void {
  if (z?.work?.root && z?.personal?.root) ZONES = { work: { ...z.work }, personal: { ...z.personal } };
}
export function zoneInfo(z: Zone): { label: string; root: string } {
  return ZONES[z];
}

export function roleLabel(role: string): string | undefined {
  return ROLE_LABELS[role];
}

// ---------- 경로 ----------
// 구역 폴더(~/work/<폴더>/…, ~/personal/<폴더>/…) 아래면 { folder: '<폴더>', rel: '…' }, 아니면 홈을 ~ 로 줄인 전체 경로.
// 화면은 미션의 작업 폴더 목록을 받지 않으므로 경로 모양으로 판단한다.
export function splitWorkPath(abs: string): { folder: string | null; rel: string } {
  const m = /^\/Users\/[^/]+\/(?:work|personal)\/([^/]+)\/(.+)$/.exec(abs);
  if (m) return { folder: m[1], rel: m[2] };
  return { folder: null, rel: abs.replace(/^\/Users\/[^/]+(?=\/|$)/, '~') };
}

// ---------- 접기 영역 ----------
// 다시 그려도 펼친 상태가 유지되도록 key 별로 기억한다.
const openDetails = new Set<string>();
export function foldable(key: string, summary: string, className = 'fold'): { root: HTMLDetailsElement; body: HTMLDivElement } {
  const root = el('details', className);
  root.open = openDetails.has(key);
  root.appendChild(el('summary', 'fold-summary', summary));
  const body = el('div', 'fold-body');
  root.appendChild(body);
  root.addEventListener('toggle', () => {
    if (root.open) openDetails.add(key);
    else openDetails.delete(key);
  });
  return { root, body };
}
