// 승인함: 기다리는 요청을 빠르게 훑고 승인·수정 요청·반려를 고른다.
import { el, foldable, formatWhen, mustGet, roleLabel, splitWorkPath, toDate } from './dom.js';
import { changeView, lineDiff } from './diff.js';

const KIND_LABEL: Record<ApprovalKind, string> = {
  teamPlan: '팀 구성안',
  decision: '결정 필요',
  write: '문서·파일 쓰기',
  outsideWrite: '작업 폴더 밖 쓰기',
  commit: '변경 기록(커밋)',
  delete: '삭제',
  db: 'DB 쓰기',
  deploy: '배포',
  external: '외부 게시',
  numbers: '수치 변경',
  reverseDecision: '결정 번복',
  estimate: '추정값 사용',
  command: '명령 실행',
  bundle: '파일 묶음 쓰기',
  other: '기타',
};
const STATUS_LABEL: Record<ApprovalRequest['status'], string> = {
  pending: '대기',
  approved: '승인',
  rejected: '반려',
  revise: '수정 요청',
  expired: '만료',
};
const DONE_LIMIT = 30;
/** 작게 보이는 카드 종류: 고를 것·볼 것이 없는 단순 확인(누르면 펼쳐진다) */
const COMPACT_KINDS = new Set<string>(['command', 'outsideWrite', 'commit', 'delete', 'external', 'db', 'deploy']);
/** 한 번에 승인할 수 있는 종류: 명령과 폴더 밖 쓰기만(커밋·지우기·배포·DB 는 하나씩) */
const BATCH_KINDS = new Set<string>(['command', 'outsideWrite']);
/** 묶음 안에서 먼저 보일 종류(생각이 필요한 것) */
const THINK_KINDS = new Set<string>(['decision', 'teamPlan', 'bundle', 'numbers', 'reverseDecision', 'estimate', 'other']);

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

function waitedText(iso: string): string {
  const m = Math.max(0, Math.floor((Date.now() - toDate(iso).getTime()) / 60000));
  return m < 1 ? '방금 올라옴' : m < 60 ? `${m}분째 기다리는 중` : `${Math.floor(m / 60)}시간 ${m % 60}분째 기다리는 중`;
}

/**
 * 카드 앞면에 보일 핵심 사실: 실행할 명령, 커밋이면 무엇을 하는지와 커밋 메시지, 바뀌는 파일.
 * 승인 요청의 자세히 글("명령: …", "바뀔 수 있는 파일: …")에서 읽는다.
 */
export function approvalFacts(a: { kind: string; detail?: string; why?: string }): [string, string][] {
  const out: [string, string][] = [];
  const d = a.detail ?? '';
  const cmd = /^명령: ([\s\S]*?)(?:\n실행 위치:|\n바뀔 수 있는 파일:|\n판단 근거:|$)/.exec(d)?.[1]?.trim();
  if (cmd) {
    if (a.kind === 'commit') {
      const acts: string[] = [];
      if (/\bgit\s+(-\S+\s+\S+\s+)*commit\b/.test(cmd)) acts.push('변경 내용 기록(커밋)');
      if (/\bgit\s+(-\S+\s+\S+\s+)*push\b/.test(cmd)) acts.push('원격에 올리기(push)');
      if (/\bgit\s+(-\S+\s+\S+\s+)*(pull|fetch|merge)\b/.test(cmd)) acts.push('원격 최신 받아오기');
      if (/\bgit\s+(-\S+\s+\S+\s+)*(reset|revert|restore|checkout|switch|rebase|stash)\b/.test(cmd)) acts.push('되돌리기·가지 바꾸기');
      if (acts.length) out.push(['하는 일', acts.join(' + ')]);
      const msg = /-m\s+(["'])([\s\S]*?)\1/.exec(cmd)?.[2];
      if (msg) out.push(['커밋 메시지', clip(msg.replace(/\s+/g, ' '), 120)]);
    }
    out.push(['명령', clip(cmd.replace(/\s+/g, ' '), 180)]);
  }
  const files = /^바뀔 수 있는 파일: (.*)$/m.exec(d)?.[1];
  if (files) out.push(['바뀌는 파일', clip(files, 160)]);
  const why = (a.why ?? '').trim();
  if (why && !/^맡은 일:/.test(why)) out.push(['왜', clip(why.replace(/\s+/g, ' '), 160)]);
  return out;
}

function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? '기타';
}
function whoText(who: string): string {
  const label = roleLabel(who);
  return label ? `${who} (${label})` : who;
}

interface PendingCard {
  root: HTMLElement;
  sig: string; // 내용이 바뀌었는지 비교용
}

export class ApprovalsView {
  private rano = window.rano;
  private items: ApprovalRequest[] = [];
  private loaded = false;
  private gotEvent = false;
  private failed = false;
  private pendingCards = new Map<string, PendingCard>();
  private submitting = new Set<string>(); // 결정을 보낸 요청(두 번 누르기 방지)
  private openCompact = new Set<string>(); // 펼쳐 둔 작은 카드
  private doneFilter = ''; // 처리한 요청: 미션으로 거르기(빈 값 = 전체)
  private batchConfirm: string | null = null; // "모두 승인" 확인 중인 묶음

  private pendingListEl = mustGet<HTMLDivElement>('approvals-pending');
  private pendingCountEl = mustGet<HTMLSpanElement>('approvals-pending-count');
  private doneWrapEl = mustGet<HTMLDetailsElement>('approvals-done');
  private doneSummaryEl = mustGet<HTMLElement>('approvals-done-summary');
  private doneListEl = mustGet<HTMLDivElement>('approvals-done-list');

  /** 대기 건수가 바뀔 때(탭 배지용) */
  onPendingCount: (n: number) => void = () => {};
  /** 미션 이름 찾기(현황판이 알려 줌) */
  missionName: (missionId: string) => string | undefined = () => undefined;
  /** 과제 제목 찾기(현황판이 알려 줌). 모르면 undefined */
  taskTitle: (missionId: string, taskId: string) => string | undefined = () => undefined;

  constructor() {
    this.render();
    // 기다린 시간 표시를 30초마다 새로
    window.setInterval(() => {
      for (const n of Array.from(this.pendingListEl.querySelectorAll<HTMLElement>('[data-waited]'))) n.textContent = waitedText(n.dataset.waited ?? '');
    }, 30_000);
  }

  /** 다른 화면의 [자세히]로 왔을 때: 그 카드로 가서 펼치고 잠깐 강조한다 */
  focus(id: string): void {
    const card = this.pendingCards.get(id)?.root;
    if (!card) return;
    this.openCompact.add(id);
    card.classList.add('open');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('appr-flash');
    window.setTimeout(() => card.classList.remove('appr-flash'), 1800);
  }

  async load(): Promise<void> {
    try {
      const list = await this.rano.approvalsList();
      // 불러오는 사이 이벤트로 더 새 목록이 왔으면 그것을 쓴다.
      if (!this.gotEvent && Array.isArray(list)) this.items = list;
    } catch {
      if (!this.gotEvent) this.failed = true;
    }
    this.loaded = true;
    this.render();
  }

  update(items: ApprovalRequest[]): void {
    if (!Array.isArray(items)) return;
    this.gotEvent = true;
    this.loaded = true;
    this.failed = false;
    this.items = items;
    this.render();
  }

  /** 미션 이름이 새로 알려졌을 때 */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const valid = this.items.filter((a) => a && typeof a.id === 'string');
    const pending = valid
      .filter((a) => a.status === 'pending')
      .sort((a, b) => toDate(a.createdAt).getTime() - toDate(b.createdAt).getTime()); // 오래 기다린 것부터
    const done = valid
      .filter((a) => a.status !== 'pending')
      .sort((a, b) => toDate(b.decidedAt ?? b.createdAt).getTime() - toDate(a.decidedAt ?? a.createdAt).getTime())
      .slice(0, DONE_LIMIT);

    this.onPendingCount(pending.length);
    this.pendingCountEl.textContent = pending.length > 0 ? `${pending.length}건` : '';

    // ---- 기다리는 요청: 이미 그린 카드는 그대로 둔다(적던 사유·체크가 지워지지 않게) ----
    const keep = new Set(pending.map((a) => a.id));
    for (const [id, card] of this.pendingCards) {
      if (!keep.has(id)) {
        card.root.remove();
        this.pendingCards.delete(id);
        this.submitting.delete(id);
      }
    }
    this.pendingListEl.querySelector('.board-note')?.remove();
    for (const h of Array.from(this.pendingListEl.querySelectorAll('.appr-group'))) h.remove();
    // 과제별로 묶는다: 묶음은 가장 오래 기다린 카드 순, 묶음 안은 생각할 카드(결정·팀 구성안)가 먼저
    const groups = new Map<string, ApprovalRequest[]>();
    for (const a of pending) {
      const key = `${a.missionId}|${a.taskId ?? ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    }
    const ordered: ApprovalRequest[] = [];
    const headBefore = new Map<string, HTMLElement>(); // 그 카드 앞에 놓을 묶음 머리줄
    for (const [key, list] of groups) {
      list.sort((x, y) => Number(THINK_KINDS.has(y.kind)) - Number(THINK_KINDS.has(x.kind)) || toDate(x.createdAt).getTime() - toDate(y.createdAt).getTime());
      if (groups.size > 1 || list.length > 1) headBefore.set(list[0].id, this.renderGroupHead(key, list));
      ordered.push(...list);
    }
    for (const a of ordered) {
      const sig = JSON.stringify([a.title, a.what, a.why, a.recommendation, a.detail, a.filePath, a.who, a.kind, this.missionName(a.missionId)]);
      let card = this.pendingCards.get(a.id);
      if (!card || card.sig !== sig) {
        const root = this.renderPending(a);
        if (card) card.root.replaceWith(root);
        card = { root, sig };
        this.pendingCards.set(a.id, card);
      }
      const head = headBefore.get(a.id);
      if (head) this.pendingListEl.appendChild(head);
      this.pendingListEl.appendChild(card.root); // 순서 맞추기(이미 있으면 옮기기만 한다)
    }
    if (pending.length === 0) {
      const text = !this.loaded
        ? '승인함을 불러오는 중이에요…'
        : this.failed
          ? '승인함을 불러오지 못했어요. 앱을 다시 열어 주세요.'
          : '기다리는 승인 요청이 없어요';
      this.pendingListEl.appendChild(el('p', 'board-note', text));
    }

    // ---- 처리한 요청 ----
    this.doneWrapEl.hidden = done.length === 0;
    this.doneSummaryEl.textContent = `처리한 요청 ${done.length}건${done.length >= DONE_LIMIT ? ' (최근 30건)' : ''}`;
    // 처리한 요청: 한 줄 목록(누르면 펼침) + 미션으로 거르기
    const missions = [...new Set(done.map((a) => a.missionId))];
    const nodes: HTMLElement[] = [];
    if (missions.length > 1) {
      const bar = el('div', 'done-filter');
      const pick = (id: string, label: string) => {
        const b = el('button', `done-filter-btn${this.doneFilter === id ? ' on' : ''}`, label);
        b.type = 'button';
        b.addEventListener('click', () => {
          this.doneFilter = id;
          this.render();
        });
        bar.appendChild(b);
      };
      pick('', '전체');
      for (const id of missions) pick(id, this.missionName(id) ?? id);
      nodes.push(bar);
    }
    if (this.doneFilter && !missions.includes(this.doneFilter)) this.doneFilter = '';
    for (const a of done.filter((x) => !this.doneFilter || x.missionId === this.doneFilter)) nodes.push(this.renderDoneRow(a));
    this.doneListEl.replaceChildren(...nodes);
  }

  /** 묶음 머리줄: 미션 · 과제 제목 · 건수, 명령·폴더 밖 쓰기가 여러 장이면 [모두 승인] */
  private renderGroupHead(key: string, list: ApprovalRequest[]): HTMLElement {
    const first = list[0];
    const head = el('div', 'appr-group');
    const title = first.taskId ? this.taskTitle(first.missionId, first.taskId) : undefined;
    head.appendChild(el('span', 'appr-group-mission', this.missionName(first.missionId) ?? first.missionId));
    if (title) head.appendChild(el('span', 'appr-group-task', title));
    head.appendChild(el('span', 'appr-group-count', `${list.length}건`));
    const batch = list.filter((a) => BATCH_KINDS.has(a.kind) && !a.decisionItems?.length && !a.bundle?.length && !this.submitting.has(a.id));
    if (batch.length >= 2) {
      head.appendChild(el('span', 'fl-sp'));
      if (this.batchConfirm === key) {
        head.appendChild(el('span', 'appr-group-warn', '명령 내용을 하나씩 보지 않고 승인해요'));
        const yes = el('button', 'btn btn-small btn-approve', `정말 ${batch.length}건 승인`);
        yes.type = 'button';
        yes.addEventListener('click', () => {
          this.batchConfirm = null;
          for (const a of batch) {
            this.submitting.add(a.id);
            this.pendingCards.get(a.id)?.root.classList.add('appr-busy');
            void this.rano.approvalDecide(a.id, { decision: 'approve' }).catch(() => {
              this.submitting.delete(a.id);
              this.pendingCards.get(a.id)?.root.classList.remove('appr-busy');
            });
          }
          this.render();
        });
        const no = el('button', 'btn btn-small btn-plain', '취소');
        no.type = 'button';
        no.addEventListener('click', () => {
          this.batchConfirm = null;
          this.render();
        });
        head.append(yes, no);
      } else {
        const all = el('button', 'btn btn-small', `이 과제의 명령 ${batch.length}건 모두 승인`);
        all.type = 'button';
        all.title = '명령 실행·작업 폴더 밖 쓰기만 한 번에 승인해요. 커밋·지우기·배포·DB 는 하나씩 승인해요';
        all.addEventListener('click', () => {
          this.batchConfirm = key;
          this.render();
        });
        head.appendChild(all);
      }
    }
    return head;
  }

  /** 처리한 요청 한 줄. 누르면 예전 카드 내용이 펼쳐진다 */
  private renderDoneRow(a: ApprovalRequest): HTMLElement {
    const row = el('details', `done-row done-${a.status}`);
    const sum = el('summary', 'done-row-sum');
    sum.appendChild(el('span', `badge result-${a.status}`, STATUS_LABEL[a.status] ?? a.status));
    sum.appendChild(el('span', 'done-row-title', a.title));
    sum.appendChild(el('span', 'done-row-meta', [this.missionName(a.missionId), formatWhen(a.decidedAt ?? a.createdAt)].filter(Boolean).join(' · ')));
    row.appendChild(sum);
    row.addEventListener('toggle', () => {
      if (row.open && row.childElementCount === 1) row.appendChild(this.renderDone(a));
    });
    return row;
  }

  // 머리: 종류 배지 · 미션 · 누가 · 시각, 그리고 제목
  private renderHead(a: ApprovalRequest, card: HTMLElement): void {
    const top = el('div', 'appr-top');
    top.appendChild(el('span', `kind kind-${a.kind}`, kindLabel(a.kind)));
    const mission = this.missionName(a.missionId);
    const meta = [mission, whoText(a.who), formatWhen(a.createdAt)].filter(Boolean).join(' · ');
    top.appendChild(el('span', 'appr-meta', meta));
    if (a.status === 'pending') {
      const waited = el('span', 'appr-waited', waitedText(a.createdAt));
      waited.dataset.waited = a.createdAt;
      top.appendChild(waited);
    }
    card.appendChild(top);
    card.appendChild(el('h3', 'appr-title', a.title));
  }

  private renderDetail(a: ApprovalRequest, card: HTMLElement): void {
    if (!a.detail && !a.filePath && !a.change) return;
    const { root, body } = foldable(`appr:${a.id}`, '자세히');
    if (a.filePath) {
      const p = splitWorkPath(a.filePath);
      const line = el('div', 'appr-file');
      line.appendChild(el('span', 'appr-file-label', p.folder ? `${p.folder} 작업 폴더` : '파일'));
      line.appendChild(el('code', 'mono', p.rel));
      body.appendChild(line);
    }
    if (a.change && a.status !== 'pending') body.appendChild(changeView(a.change));
    if (a.detail) body.appendChild(el('pre', 'raw', a.detail));
    card.appendChild(root);
  }

  private renderPending(a: ApprovalRequest): HTMLElement {
    const compact = COMPACT_KINDS.has(a.kind) && !a.decisionItems?.length && !a.bundle?.length && !a.change;
    const card = el('article', `appr appr-pending${compact ? ' appr-compact' : ''}${compact && this.openCompact.has(a.id) ? ' open' : ''}`);
    card.dataset.id = a.id;
    this.renderHead(a, card);
    // 카드 앞면의 핵심 사실(명령·커밋 메시지·바뀌는 파일). 작은 카드에서는 이것만 보인다
    const facts = approvalFacts(a).filter(([k]) => compact || k !== '왜');
    if (facts.length) {
      const dl = el('dl', 'appr-facts');
      for (const [k, v] of facts) {
        dl.appendChild(el('dt', undefined, k));
        const dd = el('dd', k === '명령' ? 'mono' : undefined, v);
        dl.appendChild(dd);
      }
      card.appendChild(dl);
    }

    const modelPick = a.kind === 'teamPlan'; // 팀 구성안: 항목은 팀원마다 쓸 모델(리더 추천이 골라져 있음)
    const recLabel = modelPick ? ['추천대로 승인', '고른 대로 승인'] : ['권장안대로 결정', '고른 안으로 결정'];
    const approveBtn = el('button', 'btn btn-approve', a.decisionItems?.length ? recLabel[0] : '승인');
    const rows = el('dl', 'appr-rows appr-fold');
    const addRow = (label: string, text: string) => {
      if (!text) return;
      rows.appendChild(el('dt', undefined, label));
      rows.appendChild(el('dd', undefined, text));
    };
    addRow('무엇을', a.what);
    addRow('왜', a.why);
    card.appendChild(rows);

    // 파일 쓰기: 바뀌기 전·후를 색으로 비교 (지운 줄 빨강, 더한 줄 초록)
    if (a.change) card.appendChild(changeView(a.change));

    // 묶음 승인: 파일마다 고르고, 눌러서 바뀐 부분을 본다
    const picked = new Set((a.bundle ?? []).map((f) => f.rel));
    const refreshBundle = () => {
      if (!a.bundle?.length) return;
      approveBtn.textContent = picked.size === a.bundle.length ? `${picked.size}개 모두 반영` : `고른 ${picked.size}개 반영`;
      approveBtn.disabled = picked.size === 0 || this.submitting.has(a.id);
    };
    if (a.bundle?.length) {
      const list = el('div', 'bundle');
      const head = el('div', 'bundle-head');
      head.appendChild(el('strong', undefined, `파일 ${a.bundle.length}개`));
      head.appendChild(el('span', 'org-hint', '반영할 파일을 고르고, 파일 이름을 누르면 바뀐 부분을 볼 수 있어요.'));
      const all = el('button', 'btn btn-small btn-plain', '모두 고르기/풀기');
      all.type = 'button';
      head.appendChild(all);
      list.appendChild(head);
      const boxes: HTMLInputElement[] = [];
      for (const f of a.bundle) {
        const item = el('details', 'bundle-file');
        const sum = el('summary', 'bundle-sum');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.setAttribute('aria-label', `${f.rel} 반영`);
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) picked.add(f.rel);
          else picked.delete(f.rel);
          item.classList.toggle('off', !cb.checked);
          refreshBundle();
        });
        boxes.push(cb);
        sum.appendChild(cb);
        sum.appendChild(el('code', 'mono bundle-name', f.rel));
        if (f.change) {
          const ops = lineDiff(f.change.before, f.change.after);
          const add = ops.filter((o) => o.t === 'add').length;
          const del = ops.filter((o) => o.t === 'del').length;
          if (f.change.isNew) sum.appendChild(el('span', 'org-hint', '새 파일'));
          sum.appendChild(el('span', 'df-add-count', `+${add}`));
          if (!f.change.isNew) sum.appendChild(el('span', 'df-del-count', `−${del}`));
        } else sum.appendChild(el('span', 'org-hint', '(비교할 수 없는 파일)'));
        item.appendChild(sum);
        item.addEventListener('toggle', () => {
          if (item.open && f.change && item.childElementCount === 1) item.appendChild(changeView(f.change));
        });
        list.appendChild(item);
      }
      all.addEventListener('click', () => {
        const on = picked.size !== a.bundle!.length;
        for (const [i, cb] of boxes.entries()) {
          cb.checked = on;
          const rel = a.bundle![i].rel;
          if (on) picked.add(rel);
          else picked.delete(rel);
          cb.closest('details')?.classList.toggle('off', !on);
        }
        refreshBundle();
      });
      card.appendChild(list);
      refreshBundle();
    }

    // 결정 카드: 항목마다 안을 고른다 (권장안이 미리 골라져 있음)
    const choices: Record<string, string> = {};
    if (a.decisionItems?.length) {
      if (a.planGate) card.appendChild(el('p', 'appr-plan', '기획 단계 결정이에요. 고르신 안대로 구현을 시작해요. 고르기 전에는 작업 폴더를 고치지 않아요.'));
      if (modelPick) card.appendChild(el('p', 'appr-plan', '팀원마다 쓸 모델이에요. 리더가 일의 성격을 보고 추천한 것이 골라져 있어요. Opus 는 꼼꼼하지만 느리고 사용량이 많고, Sonnet 은 빠르고 가벼워요. 바꿔서 승인할 수 있어요.'));
      const box = el('div', 'dec-items');
      for (const it of a.decisionItems) {
        choices[it.id] = it.recommended;
        const fs = el('fieldset', 'dec-item');
        fs.appendChild(el('legend', 'dec-q', modelPick ? it.question : `${it.id}. ${it.question}`));
        for (const o of it.options) {
          const row = el('div', `dec-opt${o.key === it.recommended ? ' rec' : ''}`);
          const label = el('label', 'dec-opt-label');
          const radio = el('input');
          radio.type = 'radio';
          radio.name = `dec-${a.id}-${it.id}`;
          radio.value = o.key;
          radio.checked = o.key === it.recommended;
          radio.addEventListener('change', () => {
            if (radio.checked) choices[it.id] = o.key;
            approveBtn.textContent = Object.entries(choices).every(([id, k]) => a.decisionItems!.find((x) => x.id === id)?.recommended === k) ? recLabel[0] : recLabel[1];
          });
          label.appendChild(radio);
          if (!modelPick) label.appendChild(el('span', 'dec-key', `${o.key}안`));
          label.appendChild(el('span', 'dec-label', o.label));
          if (o.key === it.recommended) label.appendChild(el('span', 'dec-rec', modelPick ? '리더 추천' : '권장'));
          row.appendChild(label);
          if (o.detail) row.appendChild(el('p', 'dec-detail', o.detail));
          if (o.preview) {
            const pv = el('button', 'btn btn-small dec-preview', '시안 열기');
            pv.type = 'button';
            const pvMsg = el('span', 'dec-preview-msg');
            // 안전 확인에 막히면 이유와 함께 [폴더에서 보기](Finder 에서 위치만 보여 줌, 실행하지 않음)를 띄운다
            const reveal = el('button', 'btn btn-small dec-preview', '폴더에서 보기');
            reveal.type = 'button';
            reveal.hidden = true;
            reveal.addEventListener('click', async () => {
              try {
                const r = await this.rano.approvalRevealPreview(a.id, it.id, o.key);
                if (!r?.ok) pvMsg.textContent = r?.message ?? '폴더를 보여 주지 못했어요';
              } catch {
                pvMsg.textContent = '폴더를 보여 주지 못했어요';
              }
            });
            pv.addEventListener('click', async () => {
              try {
                const r = await this.rano.approvalOpenPreview(a.id, it.id, o.key);
                pvMsg.textContent = r?.ok ? '' : r?.message ?? '시안을 열지 못했어요';
                reveal.hidden = !!r?.ok || !r?.reveal;
              } catch {
                pvMsg.textContent = '시안을 열지 못했어요';
                reveal.hidden = true;
              }
            });
            const pvRow = el('div', 'dec-preview-row');
            pvRow.append(pv, pvMsg, reveal);
            row.appendChild(pvRow);
          }
          fs.appendChild(row);
        }
        box.appendChild(fs);
      }
      card.appendChild(box);
    }

    if (a.recommendation && a.recommendation.trim()) {
      const rec = el('div', 'appr-rec');
      rec.appendChild(el('span', 'appr-rec-label', '리더 권장안'));
      rec.appendChild(el('span', 'appr-rec-text', a.recommendation));
      card.appendChild(rec);
    }

    this.renderDetail(a, card);


    // ---- 결정 ----
    const actions = el('div', 'appr-actions');
    const reviseBtn = el('button', 'btn btn-revise', '수정 요청');
    const rejectBtn = el('button', 'btn btn-reject', '반려');
    for (const b of [approveBtn, reviseBtn, rejectBtn]) b.type = 'button';

    let remember: HTMLInputElement | null = null;
    // 명령(Bash) 요청은 체크 칸을 띄우지 않는다: 명령은 매번 묻는다 (앱 안쪽 approvalQueue.ts grantKeyFor 와 같은 기준)
    const bashRequest = a.tool === 'Bash' || !!a.rememberKey?.startsWith('bash:');
    const fileTool = a.tool === 'Write' || a.tool === 'Edit' || a.tool === 'MultiEdit' || a.tool === 'NotebookEdit';
    const rememberText = bashRequest ? '' : a.rememberLabel ?? (a.rememberKey || (fileTool && a.filePath && (a.kind === 'write' || a.kind === 'outsideWrite')) ? '이번 과제 동안 이 파일은 다시 묻지 않기' : '');
    if (rememberText && a.taskId) {
      const label = el('label', 'appr-remember');
      remember = el('input');
      remember.type = 'checkbox';
      label.appendChild(remember);
      label.appendChild(document.createTextNode(rememberText));
      if (a.kind === 'write' || a.kind === 'outsideWrite') label.title = '명령(Bash)으로 이 파일을 바꾸는 일은 이 칸과 상관없이 매번 물어요';
      actions.append(approveBtn, label, reviseBtn, rejectBtn);
    } else {
      actions.append(approveBtn, reviseBtn, rejectBtn);
    }
    if (compact) {
      const more = el('button', 'btn btn-plain appr-more', this.openCompact.has(a.id) ? '접기' : '자세히');
      more.type = 'button';
      more.addEventListener('click', () => {
        const open = card.classList.toggle('open');
        if (open) this.openCompact.add(a.id);
        else this.openCompact.delete(a.id);
        more.textContent = open ? '접기' : '자세히';
        if (open) card.querySelector('details.fold')?.setAttribute('open', ''); // 펼치면 명령 전문까지 바로 보인다
      });
      actions.appendChild(more);
    }
    card.appendChild(actions);

    // 사유 입력(수정 요청·반려)
    const noteBox = el('div', 'appr-note');
    noteBox.hidden = true;
    const noteLabel = el('label', 'appr-note-label');
    const noteInput = el('textarea', 'appr-note-input');
    noteInput.rows = 2;
    noteLabel.htmlFor = noteInput.id = `note-${a.id}`;
    const noteActions = el('div', 'appr-note-actions');
    const confirmBtn = el('button', 'btn btn-confirm', '보내기');
    const cancelBtn = el('button', 'btn btn-plain', '취소');
    confirmBtn.type = cancelBtn.type = 'button';
    noteActions.append(confirmBtn, cancelBtn);
    noteBox.append(noteLabel, noteInput, noteActions);
    card.appendChild(noteBox);

    const msg = el('p', 'appr-msg');
    msg.hidden = true;
    card.appendChild(msg);

    let mode: 'revise' | 'reject' | null = null;
    const allButtons = [approveBtn, reviseBtn, rejectBtn, confirmBtn, cancelBtn];

    const refreshConfirm = () => {
      const busy = this.submitting.has(a.id);
      confirmBtn.disabled = busy || (mode === 'revise' && !noteInput.value.trim());
    };
    const setBusy = (busy: boolean, text?: string) => {
      for (const b of allButtons) b.disabled = busy;
      if (remember) remember.disabled = busy;
      noteInput.disabled = busy;
      card.classList.toggle('appr-busy', busy);
      if (text) {
        msg.textContent = text;
        msg.className = 'appr-msg';
        msg.hidden = false;
      }
      if (!busy) refreshConfirm();
    };
    const openNote = (m: 'revise' | 'reject') => {
      mode = m;
      noteBox.hidden = false;
      noteLabel.textContent = m === 'revise' ? '무엇을 고치면 좋을지 적어 주세요 (꼭 적어야 해요)' : '반려하는 이유 (적지 않아도 돼요)';
      confirmBtn.textContent = m === 'revise' ? '수정 요청 보내기' : '반려하기';
      confirmBtn.className = `btn ${m === 'revise' ? 'btn-revise' : 'btn-reject'}`;
      reviseBtn.classList.toggle('btn-on', m === 'revise');
      rejectBtn.classList.toggle('btn-on', m === 'reject');
      refreshConfirm();
      noteInput.focus();
    };
    const closeNote = () => {
      mode = null;
      noteBox.hidden = true;
      reviseBtn.classList.remove('btn-on');
      rejectBtn.classList.remove('btn-on');
    };

    const decide = async (d: ApprovalDecision) => {
      if (this.submitting.has(a.id)) return;
      this.submitting.add(a.id);
      setBusy(true, '보내는 중이에요…');
      try {
        await this.rano.approvalDecide(a.id, d);
        // 결과는 'approvals' 이벤트로 이 카드가 '처리한 요청'으로 옮겨 가며 반영된다.
        // 혹시 한참 지나도 그대로면 다시 누를 수 있게 풀어 둔다.
        window.setTimeout(() => {
          if (this.pendingCards.get(a.id)?.root === card && this.submitting.has(a.id)) {
            this.submitting.delete(a.id);
            setBusy(false);
            msg.textContent = '아직 반영되지 않았어요. 필요하면 다시 눌러 주세요.';
            msg.className = 'appr-msg';
            msg.hidden = false;
          }
        }, 8000);
      } catch {
        this.submitting.delete(a.id);
        setBusy(false);
        msg.textContent = '결정을 전하지 못했어요. 다시 눌러 주세요.';
        msg.className = 'appr-msg appr-msg-error';
        msg.hidden = false;
      }
    };

    approveBtn.addEventListener('click', () => {
      const d: ApprovalDecision = { decision: 'approve' };
      if (remember) d.rememberFile = remember.checked;
      if (a.decisionItems?.length) d.choices = { ...choices };
      if (a.bundle?.length) {
        if (!picked.size) return;
        d.picked = [...picked];
      }
      void decide(d);
    });
    reviseBtn.addEventListener('click', () => (mode === 'revise' ? closeNote() : openNote('revise')));
    rejectBtn.addEventListener('click', () => (mode === 'reject' ? closeNote() : openNote('reject')));
    cancelBtn.addEventListener('click', closeNote);
    noteInput.addEventListener('input', refreshConfirm);
    confirmBtn.addEventListener('click', () => {
      if (!mode) return;
      const note = noteInput.value.trim();
      if (mode === 'revise' && !note) return;
      const d: ApprovalDecision = { decision: mode };
      if (note) d.note = note;
      void decide(d);
    });

    if (this.submitting.has(a.id)) setBusy(true, '보내는 중이에요…');
    return card;
  }

  private renderDone(a: ApprovalRequest): HTMLElement {
    const card = el('article', `appr appr-done done-${a.status}`);
    this.renderHead(a, card);
    const result = el('div', 'appr-result');
    result.appendChild(el('span', `badge result-${a.status}`, STATUS_LABEL[a.status] ?? a.status));
    const bits: string[] = [];
    if (a.decidedAt) bits.push(`${formatWhen(a.decidedAt)} 처리`);
    if (a.status === 'approved' && a.rememberFile) bits.push(a.rememberKey && !a.rememberKey.startsWith('file:') ? '이번 과제 동안 다시 묻지 않음' : '이번 과제 동안 이 파일은 다시 묻지 않음');
    if (a.status === 'expired') bits.push('앱이 다시 시작되어 이 요청은 끝났어요');
    if (bits.length) result.appendChild(el('span', 'appr-result-meta', bits.join(' · ')));
    card.appendChild(result);
    if (a.decisionNote) card.appendChild(el('p', 'appr-reason', `사유: ${a.decisionNote}`));
    if (a.status === 'approved' && a.decisionItems?.length) {
      const ul = el('ul', 'dec-done');
      for (const it of a.decisionItems) {
        const key = a.choices?.[it.id] ?? it.recommended;
        const o = it.options.find((x) => x.key === key);
        ul.appendChild(
          el('li', undefined, a.kind === 'teamPlan' ? `${it.question} → ${o?.label ?? key}${key === it.recommended ? ' (리더 추천)' : ' (바꿔서 승인)'}` : `${it.id}. ${it.question} → ${key}안 ${o?.label ?? ''}${key === it.recommended ? ' (권장)' : ''}`),
        );
      }
      card.appendChild(ul);
    }
    if (a.status === 'approved' && a.bundle?.length) {
      const got = new Set(a.picked ?? a.bundle.map((f) => f.rel));
      const ul = el('ul', 'dec-done');
      for (const f of a.bundle) ul.appendChild(el('li', undefined, `${got.has(f.rel) ? '반영' : '뺌'} · ${f.rel}`));
      card.appendChild(ul);
    }
    if (a.what) card.appendChild(el('p', 'appr-done-what', a.what));
    this.renderDetail(a, card);
    return card;
  }
}
