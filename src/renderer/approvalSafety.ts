// 승인 카드 안전 규칙(순수 판단만, 불러오는 파일 없음). 같은 내용이 두 곳에 있다:
//   src/main/approvals/approvalSafety.ts — 휴대폰(텔레그램) 글·시험이 쓴다
//   src/renderer/approvalSafety.ts — 대화 화면 "지금" 줄·현황판 방 띠·조직 화면 다시 시작 확인 창이 쓴다
// 화면(renderer)은 main·shared 파일을 불러올 수 없어 복사해 둔다. 고칠 때는 두 파일을 글자까지 똑같이 고칠 것
// (approvalSafety.test.ts 가 두 파일이 같은지 확인한다).

/** 승인함을 열지 않고 그 자리(대화 "지금" 줄·현황판 방 띠)에서 바로 승인할 수 있는 종류: 일반 명령과 작업 폴더 밖 쓰기만. 승인함의 "모두 승인"과 같은 기준 */
export const QUICK_APPROVE_KINDS: readonly string[] = ['command', 'outsideWrite'];

/** 그 자리에서 바로 승인하지 않고 승인함에서 내용을 본 뒤 정할 종류와 빨간 표 글자(되돌리기 어렵거나 바뀌는 내용을 봐야 하는 일) */
export const CAREFUL_KIND_LABEL: Readonly<Record<string, string>> = {
  commit: '커밋',
  delete: '지우기',
  deploy: '배포',
  db: 'DB 바꾸기',
  external: '외부 게시',
  write: '파일 쓰기',
};

export interface ApprovalLike {
  kind: string;
  detail?: string;
  filePath?: string;
  decisionItems?: readonly unknown[];
  bundle?: readonly unknown[];
  change?: unknown; // 바뀌는 내용(파일 쓰기 도구의 전·후). 있으면 내용을 봐야 하는 카드
}

/** 그 자리에서 [승인]을 보여도 되는지: 바로 승인 종류이고 고를 것(결정 항목·묶음 파일)·봐야 할 바뀌는 내용(폴더 밖 파일을 도구로 쓰기)이 없을 때만 */
export function canQuickApprove(a: ApprovalLike): boolean {
  return QUICK_APPROVE_KINDS.includes(a.kind) && !a.decisionItems?.length && !a.bundle?.length && !a.change;
}

/** 조심할 종류의 이름(커밋·지우기 등). 아니면 '' */
export function carefulLabel(kind: string): string {
  return Object.prototype.hasOwnProperty.call(CAREFUL_KIND_LABEL, kind) ? CAREFUL_KIND_LABEL[kind] : '';
}

/** 빨간 표 글자: "커밋 · 승인함에서 확인". 조심할 종류가 아니면 ''. 폴더 밖 파일 쓰기(바뀌는 내용이 있는 카드)도 빨간 표 */
export function carefulTag(kind: string, a?: ApprovalLike): string {
  const label = carefulLabel(kind) || (a && kind === 'outsideWrite' && a.change ? '폴더 밖 파일 쓰기' : '');
  return label ? `${label} · 승인함에서 확인` : '';
}

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t);

/**
 * 카드 자세히 글의 "명령: …" 줄(앱이 비밀을 가린 판). 줄바꿈은 한 칸으로, 길면 max 자에서 자른다. 없으면 ''.
 * 승인함 카드 앞면(approvals.ts approvalFacts)과 같은 방식으로 읽는다.
 */
export function commandOf(detail: string | undefined, max = 180): string {
  const cmd = /^명령: ([\s\S]*?)(?:\n실행 위치:|\n바뀔 수 있는 파일:|\n판단 근거:|$)/.exec(String(detail ?? ''))?.[1]?.trim();
  return cmd ? clip(cmd.replace(/\s+/g, ' '), max) : '';
}

/**
 * 바뀌는(또는 지워지는) 파일: 자세히 글의 "바뀔 수 있는 파일: …" 줄, 없으면 카드의 파일 위치,
 * 없으면 지우기 승인 글의 "- 위치" 목록. 홈 폴더는 ~ 로 줄인다. 없으면 ''.
 */
export function filesOf(a: ApprovalLike, max = 160): string {
  const d = String(a.detail ?? '');
  const line = /^바뀔 수 있는 파일: (.*)$/m.exec(d)?.[1]?.trim();
  if (line) return clip(line, max);
  if (a.filePath) return clip(a.filePath.replace(/^\/Users\/[^/]+(?=\/|$)/, '~'), max);
  const at = d.indexOf('지우는 명령은 다시 묻지 않아요:');
  if (at >= 0) {
    const list = d
      .slice(at)
      .split('\n')
      .slice(1)
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
    if (list.length) return clip(list.join(', '), max);
  }
  return '';
}

export interface RestartTaskLike {
  title: string;
}
export interface RestartMissionLike {
  name: string;
  leaderState?: string;
  currentTask?: (RestartTaskLike & { status?: string }) | null;
  running?: readonly RestartTaskLike[];
  queued?: readonly unknown[];
}

/** 앱을 다시 시작하면 생기는 일: 멈출 진행 중 과제(미션 이름 · 과제 제목), 사라질 승인 대기 수, 다시 켠 뒤 이어 갈 줄 선 과제 수 */
export function restartImpact(
  missions: readonly RestartMissionLike[],
  approvals: readonly { status: string }[],
): { running: string[]; pending: number; queued: number } {
  const running: string[] = [];
  let queued = 0;
  for (const m of missions) {
    const list = m.running?.length ? m.running : m.leaderState === 'working' && m.currentTask?.status === 'running' ? [m.currentTask] : [];
    for (const t of list) running.push(`${m.name} · ${t.title}`);
    queued += m.queued?.length ?? 0;
  }
  return { running, pending: approvals.filter((a) => a.status === 'pending').length, queued };
}
