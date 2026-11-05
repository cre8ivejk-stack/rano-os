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

  private pendingListEl = mustGet<HTMLDivElement>('approvals-pending');
  private pendingCountEl = mustGet<HTMLSpanElement>('approvals-pending-count');
  private doneWrapEl = mustGet<HTMLDetailsElement>('approvals-done');
  private doneSummaryEl = mustGet<HTMLElement>('approvals-done-summary');
  private doneListEl = mustGet<HTMLDivElement>('approvals-done-list');

  /** 대기 건수가 바뀔 때(탭 배지용) */
  onPendingCount: (n: number) => void = () => {};
  /** 미션 이름 찾기(현황판이 알려 줌) */
  missionName: (missionId: string) => string | undefined = () => undefined;

  constructor() {
    this.render();
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
    for (const a of pending) {
      const sig = JSON.stringify([a.title, a.what, a.why, a.recommendation, a.detail, a.filePath, a.who, a.kind, this.missionName(a.missionId)]);
      let card = this.pendingCards.get(a.id);
      if (!card || card.sig !== sig) {
        const root = this.renderPending(a);
        if (card) card.root.replaceWith(root);
        card = { root, sig };
        this.pendingCards.set(a.id, card);
      }
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
    this.doneListEl.replaceChildren(...done.map((a) => this.renderDone(a)));
  }

  // 머리: 종류 배지 · 미션 · 누가 · 시각, 그리고 제목
  private renderHead(a: ApprovalRequest, card: HTMLElement): void {
    const top = el('div', 'appr-top');
    top.appendChild(el('span', `kind kind-${a.kind}`, kindLabel(a.kind)));
    const mission = this.missionName(a.missionId);
    const meta = [mission, whoText(a.who), formatWhen(a.createdAt)].filter(Boolean).join(' · ');
    top.appendChild(el('span', 'appr-meta', meta));
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
    const card = el('article', 'appr appr-pending');
    card.dataset.id = a.id;
    this.renderHead(a, card);

    const approveBtn = el('button', 'btn btn-approve', a.decisionItems?.length ? '권장안대로 결정' : '승인');
    const rows = el('dl', 'appr-rows');
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
      const box = el('div', 'dec-items');
      for (const it of a.decisionItems) {
        choices[it.id] = it.recommended;
        const fs = el('fieldset', 'dec-item');
        fs.appendChild(el('legend', 'dec-q', `${it.id}. ${it.question}`));
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
            approveBtn.textContent = Object.entries(choices).every(([id, k]) => a.decisionItems!.find((x) => x.id === id)?.recommended === k) ? '권장안대로 결정' : '고른 안으로 결정';
          });
          label.appendChild(radio);
          label.appendChild(el('span', 'dec-key', `${o.key}안`));
          label.appendChild(el('span', 'dec-label', o.label));
          if (o.key === it.recommended) label.appendChild(el('span', 'dec-rec', '권장'));
          row.appendChild(label);
          if (o.detail) row.appendChild(el('p', 'dec-detail', o.detail));
          if (o.preview) {
            const pv = el('button', 'btn btn-small dec-preview', '시안 열기');
            pv.type = 'button';
            const pvMsg = el('span', 'dec-preview-msg');
            pv.addEventListener('click', async () => {
              try {
                const r = await this.rano.approvalOpenPreview(a.id, it.id, o.key);
                pvMsg.textContent = r?.ok ? '' : r?.message ?? '시안을 열지 못했어요';
              } catch {
                pvMsg.textContent = '시안을 열지 못했어요';
              }
            });
            const pvRow = el('div', 'dec-preview-row');
            pvRow.append(pv, pvMsg);
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
      rec.appendChild(el('span', 'appr-rec-label', '리포 리더 권장안'));
      rec.appendChild(el('span', 'appr-rec-text', a.recommendation));
      card.appendChild(rec);
    }

    this.renderDetail(a, card);

    card.appendChild(el('p', 'appr-wait', `이 요청이 처리될 때까지 ${a.who}는 기다리고 있어요`));

    // ---- 결정 ----
    const actions = el('div', 'appr-actions');
    const reviseBtn = el('button', 'btn btn-revise', '수정 요청');
    const rejectBtn = el('button', 'btn btn-reject', '반려');
    for (const b of [approveBtn, reviseBtn, rejectBtn]) b.type = 'button';

    let remember: HTMLInputElement | null = null;
    if (a.kind === 'write' || a.kind === 'outsideWrite') {
      const label = el('label', 'appr-remember');
      remember = el('input');
      remember.type = 'checkbox';
      label.appendChild(remember);
      label.appendChild(document.createTextNode('이번 과제 동안 이 파일은 다시 묻지 않기'));
      actions.append(approveBtn, label, reviseBtn, rejectBtn);
    } else {
      actions.append(approveBtn, reviseBtn, rejectBtn);
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
    if (a.status === 'approved' && a.rememberFile) bits.push('이번 과제 동안 이 파일은 다시 묻지 않음');
    if (a.status === 'expired') bits.push('앱이 다시 시작되어 이 요청은 끝났어요');
    if (bits.length) result.appendChild(el('span', 'appr-result-meta', bits.join(' · ')));
    card.appendChild(result);
    if (a.decisionNote) card.appendChild(el('p', 'appr-reason', `사유: ${a.decisionNote}`));
    if (a.status === 'approved' && a.decisionItems?.length) {
      const ul = el('ul', 'dec-done');
      for (const it of a.decisionItems) {
        const key = a.choices?.[it.id] ?? it.recommended;
        const o = it.options.find((x) => x.key === key);
        ul.appendChild(el('li', undefined, `${it.id}. ${it.question} → ${key}안 ${o?.label ?? ''}${key === it.recommended ? ' (권장)' : ''}`));
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
