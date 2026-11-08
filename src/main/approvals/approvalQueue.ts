// 승인함: 에이전트의 승인 요청을 모아 두고, 사용자가 결정할 때까지 그 에이전트를 기다리게 한다.
// runs/approvals.json 에 원자적으로 저장하고, 바뀔 때마다 화면 알림·onChange·runs/events.jsonl 기록을 한다.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ApprovalDecision, ApprovalQueueApi, ApprovalRequest, Emit, RanoConfig } from '../../shared/types.js';

const KEEP = 200; // 파일에 보관
const SHOW = 100; // list() 로 보여 줌


/** 파일 승인 범위 키 */
export function fileKey(filePath: string): string {
  return `file:${path.resolve(filePath)}`;
}

/**
 * 이 요청을 승인할 때 "이번 과제 동안 다시 묻지 않기"로 기억할 범위. 없으면 undefined.
 * 명령(Bash) 요청은 어떤 종류든 기억하지 않는다(예전 bash: 범위도). 화면 체크 칸(renderer/approvals.ts)도 같은 기준.
 * rememberKey 없이 filePath 로 파일 열쇠를 만드는 대체 규칙은 파일 고치기 도구(Write·Edit·NotebookEdit) 요청에만 쓴다
 * (지금 문지기는 이 도구들 요청에 rememberKey 를 늘 붙이므로, 도구 표시가 없는 요청은 기억하지 않는 쪽이 안전하다)
 */
export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export function grantKeyFor(item: Pick<ApprovalRequest, 'tool' | 'rememberKey' | 'filePath' | 'kind'>): string | undefined {
  if (item.tool === 'Bash' || item.rememberKey?.startsWith('bash:')) return undefined;
  if (item.rememberKey) return item.rememberKey;
  return item.filePath && item.tool && FILE_TOOLS.has(item.tool) && (item.kind === 'write' || item.kind === 'outsideWrite') ? fileKey(item.filePath) : undefined;
}

export interface ApprovalQueueDeps {
  config: RanoConfig;
  emit: Emit;
  onChange?: () => void;
  notify?: (title: string, body: string) => void;
}

type NewRequest = Omit<ApprovalRequest, 'id' | 'status' | 'createdAt' | 'decidedAt' | 'decisionNote' | 'rememberFile' | 'choices' | 'picked'>;
type Waiter = { resolve: (d: ApprovalDecision & { id: string }) => void; reject: (e: Error) => void; cleanup: () => void };

const STATUS_OF: Record<ApprovalDecision['decision'], ApprovalRequest['status']> = {
  approve: 'approved',
  reject: 'rejected',
  revise: 'revise',
};

function short(text: string, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class ApprovalQueue implements ApprovalQueueApi {
  private items: ApprovalRequest[] = []; // 최신순
  private readonly waiters = new Map<string, Waiter>();
  private readonly grants = new Map<string, Set<string>>(); // taskId → 다시 묻지 않을 범위(file:경로 · ext:도구). 명령(Bash)은 기억하지 않는다. 메모리에만 둔다
  private readonly file: string;
  private readonly eventsFile: string;

  constructor(private readonly deps: ApprovalQueueDeps) {
    this.file = path.join(deps.config.runsDir, 'approvals.json');
    this.eventsFile = path.join(deps.config.runsDir, 'events.jsonl');
    this.items = this.load();

    // 앱이 꺼지면서 요청한 에이전트가 사라졌으므로 남은 대기 건은 만료 처리
    const now = new Date().toISOString();
    const stale = this.items.filter((r) => r.status === 'pending');
    for (const r of stale) Object.assign(r, { status: 'expired', decidedAt: now, decisionNote: '앱이 꺼져 요청이 사라졌어요' });
    if (stale.length) {
      this.save();
      for (const r of stale) this.log('expire', r);
    }
  }

  private load(): ApprovalRequest[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
      return Array.isArray(raw) ? (raw as ApprovalRequest[]).slice(0, KEEP) : [];
    } catch {
      return [];
    }
  }

  request(req: NewRequest, signal?: AbortSignal): Promise<ApprovalDecision & { id: string }> {
    if (signal?.aborted) return Promise.reject(new Error('승인 요청 전에 작업이 멈췄어요'));

    const item: ApprovalRequest = {
      ...req,
      title: short(req.title, 120),
      ...(req.filePath ? { filePath: path.resolve(req.filePath) } : {}),
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.items.unshift(item);
    if (this.items.length > KEEP) this.items.length = KEEP;

    const promise = new Promise<ApprovalDecision & { id: string }>((resolve, reject) => {
      const onAbort = () => {
        if (item.status !== 'pending') return;
        Object.assign(item, { status: 'expired', decidedAt: new Date().toISOString(), decisionNote: '요청한 작업이 멈춰 요청이 사라졌어요' });
        this.waiters.delete(item.id);
        this.changed('expire', item);
        reject(new Error('승인 요청이 취소됐어요(작업이 멈춤)'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(item.id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) });
    });

    this.changed('request', item);
    try {
      this.deps.notify?.(`승인 요청: ${item.title}`, `${item.who} · ${short(item.what, 80)}`);
    } catch (e) {
      console.error('[approvals] 맥 알림 실패:', e);
    }
    return promise;
  }

  decide(id: string, d: ApprovalDecision): void {
    const item = this.items.find((r) => r.id === id);
    if (!item || item.status !== 'pending') return;
    let status = STATUS_OF[d?.decision];
    if (!status) return;
    // 묶음 승인: 고른 파일만 반영. 하나도 고르지 않았으면 반려로 본다
    let picked: string[] | undefined;
    if (d.decision === 'approve' && item.bundle?.length) {
      const rels = new Set(item.bundle.map((f) => f.rel));
      picked = Array.isArray(d.picked) ? [...new Set(d.picked.filter((r) => rels.has(r)))] : [...rels];
      if (!picked.length) {
        status = STATUS_OF.reject;
        d = { ...d, decision: 'reject', note: d.note || '반영할 파일을 고르지 않았어요' };
        picked = undefined;
      }
    }

    const note = typeof d.note === 'string' && d.note.trim() ? d.note.trim() : undefined;
    const grantKey = grantKeyFor(item);
    const remember = d.decision === 'approve' && !!d.rememberFile && !!grantKey && !!item.taskId;
    // 결정 카드: 항목마다 고른 안. 없거나 잘못된 값이면 권장안으로 채운다(승인 때만)
    let choices: Record<string, string> | undefined;
    if (d.decision === 'approve' && item.decisionItems?.length) {
      choices = {};
      for (const it of item.decisionItems) {
        const picked = d.choices && typeof d.choices[it.id] === 'string' ? d.choices[it.id] : undefined;
        choices[it.id] = picked && it.options.some((o) => o.key === picked) ? picked : it.recommended;
      }
    }
    Object.assign(item, {
      ...(choices ? { choices } : {}),
      ...(picked ? { picked } : {}),
      status,
      decidedAt: new Date().toISOString(),
      ...(note ? { decisionNote: note } : {}),
      ...(remember ? { rememberFile: true } : {}),
    });
    if (remember) {
      let set = this.grants.get(item.taskId!);
      if (!set) this.grants.set(item.taskId!, (set = new Set()));
      set.add(grantKey!);
    }

    const w = this.waiters.get(id);
    this.waiters.delete(id);
    this.changed('decide', item);
    if (w) {
      w.cleanup();
      const n2 = typeof d.note === 'string' && d.note.trim() ? d.note.trim() : undefined;
      w.resolve({ id, decision: d.decision, ...(n2 ? { note: n2 } : {}), ...(remember ? { rememberFile: true } : {}), ...(choices ? { choices } : {}), ...(picked ? { picked } : {}) });
    }
  }

  list(): ApprovalRequest[] {
    const pending = this.items.filter((r) => r.status === 'pending');
    const rest = this.items.filter((r) => r.status !== 'pending');
    return [...pending, ...rest].slice(0, SHOW).map((r) => ({ ...r }));
  }

  pendingCount(missionId?: string): number {
    return this.items.filter((r) => r.status === 'pending' && (!missionId || r.missionId === missionId)).length;
  }

  isFileGranted(taskId: string, filePath: string): boolean {
    if (!taskId || !filePath) return false;
    return this.isGranted(taskId, fileKey(filePath));
  }

  isGranted(taskId: string, key: string): boolean {
    if (!taskId || !key) return false;
    return this.grants.get(taskId)?.has(key) ?? false;
  }

  // ---- 내부 ----
  private changed(action: 'request' | 'decide' | 'expire', item: ApprovalRequest) {
    this.save();
    this.log(action, item);
    try {
      this.deps.emit({ kind: 'approvals', items: this.list() });
    } catch (e) {
      console.error('[approvals] 화면 알림 실패:', e);
    }
    try {
      this.deps.onChange?.();
    } catch (e) {
      console.error('[approvals] onChange 실패:', e);
    }
  }

  private save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf-8');
        renameSync(tmp, this.file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } catch (e) {
      console.error('[approvals] 저장 실패:', e);
    }
  }

  // 비밀이 섞일 수 있는 what/why/detail 본문은 남기지 않고, 누가·무엇(제목)·결정만 남긴다
  private log(action: 'request' | 'decide' | 'expire', r: ApprovalRequest) {
    try {
      mkdirSync(path.dirname(this.eventsFile), { recursive: true });
      const line = {
        at: new Date().toISOString(),
        kind: 'approval',
        action,
        id: r.id,
        missionId: r.missionId,
        taskId: r.taskId,
        who: r.who,
        approvalKind: r.kind,
        title: r.title,
        filePath: r.filePath,
        status: r.status,
        rememberFile: r.rememberFile,
        rememberKey: r.rememberKey,
      };
      appendFileSync(this.eventsFile, JSON.stringify(line) + '\n', 'utf-8');
    } catch (e) {
      console.error('[approvals] 이벤트 기록 실패:', e);
    }
  }
}
