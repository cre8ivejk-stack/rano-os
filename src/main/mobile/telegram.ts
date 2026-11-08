// 휴대폰에서 라노와 대화하기: 텔레그램 봇 연결.
// 맥이 텔레그램 서버에 먼저 접속해 메시지를 가져온다(긴 기다림 getUpdates). 맥에 들어오는 문(포트)은 열지 않는다.
// 짝지은 텔레그램 대화방(chat id) 하나에서 온 메시지만 받는다. 봇 열쇠(토큰)는 맥 키체인으로 암호화해 데이터 폴더에만 둔다.
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { powerSaveBlocker, safeStorage } from 'electron';
import type { ApprovalQueueApi, ApprovalRequest, MobileStatus, NewAttachment, RanoConfig, RanoUiEvent } from '../../shared/types.js';
import { MobileReplyTracker, TypingGate } from './mobileRules.js';

// 시험할 때만 가짜 텔레그램 주소(이 맥 안)로 바꿀 수 있다. 평소에는 늘 텔레그램 공식 주소
const API = process.env.RANO_TELEGRAM_TEST_API && /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.RANO_TELEGRAM_TEST_API) ? process.env.RANO_TELEGRAM_TEST_API : 'https://api.telegram.org';
const MAX_TEXT = 3800; // 텔레그램 한 메시지 한도(4096) 안쪽
const TYPING_EVERY_MS = 4500; // "입력 중" 표시는 몇 초 뒤 꺼지므로 이 간격으로 다시 보낸다
const TYPING_MAX_MS = 10 * 60_000; // 혹시 답이 오지 않아도 10분 뒤에는 멈춘다

interface Saved {
  token: string;
  chatId?: number;
  name?: string; // 짝지은 사람 이름(표시용)
  botName?: string;
  allRano?: boolean; // 라노의 답을 모두 휴대폰으로도 보내기
  approvals?: boolean; // 승인 요청 알림
  keepAwake?: boolean; // 휴대폰 연결 중에는 맥이 스스로 잠들지 않게
}

export interface MobileDeps {
  config: RanoConfig;
  approvals: ApprovalQueueApi & { list(): ApprovalRequest[] };
  sendToRano: (text: string, attachments: NewAttachment[]) => Promise<{ ok: boolean; message?: string }>; // 휴대폰에서 온 말로 보냄
  activity: (text: string) => void; // 앱 대화창에 한 줄
}

/** 텔레그램에 보낼 글: 꾸밈 기호를 빼고 쉬운 글로 */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '■ ')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .trim();
}

function chunks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT) {
    let cut = rest.lastIndexOf('\n', MAX_TEXT);
    if (cut < MAX_TEXT / 2) cut = MAX_TEXT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

export class TelegramBridge {
  private saved: Saved | null = null;
  private pairCode: string | null = null;
  private running = false;
  private abort: AbortController | null = null;
  private offset = 0;
  private lastError = '';
  private replies = new MobileReplyTracker(); // 휴대폰 말에 대한 답·오류를 휴대폰으로 보낼지, "입력 중"을 이어 갈지
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private typingGate = new TypingGate(TYPING_MAX_MS); // 10분 상한: 닿으면 목록·차례가 바뀔 때까지 다시 켜지 않음
  private sentApprovals = new Map<string, number>(); // 승인 요청 id → 텔레그램 메시지 id
  private seenAtStart = new Set<string>();
  private blockerId: number | null = null;

  /** 잠자기 막기: 짝지은 연결이 있고 켜 두었을 때만. 화면은 꺼져도 되고 맥만 깨어 있게 한다 */
  private applyKeepAwake(): void {
    const want = !!(this.running && this.saved?.chatId && this.saved.keepAwake);
    if (want && this.blockerId === null) this.blockerId = powerSaveBlocker.start('prevent-app-suspension');
    else if (!want && this.blockerId !== null) {
      if (powerSaveBlocker.isStarted(this.blockerId)) powerSaveBlocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }

  constructor(private readonly deps: MobileDeps) {
    this.saved = this.load();
  }

  // ---------- 저장 ----------
  private file(): string {
    return path.join(this.deps.config.runsDir, 'secrets', 'telegram.bin');
  }
  private load(): Saved | null {
    try {
      if (!existsSync(this.file()) || !safeStorage.isEncryptionAvailable()) return null;
      const s = JSON.parse(safeStorage.decryptString(readFileSync(this.file())));
      return typeof s?.token === 'string' ? s : null;
    } catch {
      return null;
    }
  }
  private persist(): void {
    if (!this.saved) return;
    mkdirSync(path.dirname(this.file()), { recursive: true, mode: 0o700 });
    writeFileSync(this.file(), safeStorage.encryptString(JSON.stringify(this.saved)), { mode: 0o600 });
  }

  // ---------- 텔레그램 호출 ----------
  private async call(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal, token = this.saved?.token): Promise<any> {
    if (!token) throw new Error('no token');
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!j?.ok) throw new Error(j?.description || `텔레그램 응답 ${res.status}`);
    return j.result;
  }

  private async say(text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    if (!this.saved?.chatId) return undefined;
    let id: number | undefined;
    for (const part of chunks(plain(text))) {
      try {
        const r = await this.call('sendMessage', { chat_id: this.saved.chatId, text: part, disable_web_page_preview: true, ...extra });
        id = r?.message_id;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
      }
      extra = {}; // 버튼은 마지막 조각에만 붙이지 않고 첫 조각에만
    }
    return id;
  }

  private sendTyping(): void {
    if (!this.saved?.chatId) return;
    void this.call('sendChatAction', { chat_id: this.saved.chatId, action: 'typing' }).catch(() => undefined);
  }

  /** 지금 "입력 중"을 이어 갈지: 기다리는 휴대폰 말이 있고, 상한(10분)에 닿아 멈춘 뒤 목록·차례가 그대로가 아닐 때 */
  private wantTyping(): boolean {
    return this.typingGate.shouldType(this.replies.typing && !!this.saved?.chatId, this.replies.typingKey, Date.now());
  }

  /** 휴대폰 말이 답을 기다리는 동안 "입력 중" 표시를 몇 초마다 다시 보낸다. 답이 가거나 차례가 끝나면 멈춘다.
   * 10분 상한에 닿으면 멈추고, 기다리는 말 목록이 바뀌거나 차례가 끝날 때만 다시 켤 수 있다(mobileRules.TypingGate) */
  private syncTyping(): void {
    const want = this.wantTyping();
    if (want && !this.typingTimer) {
      this.typingTimer = setInterval(() => {
        if (!this.wantTyping()) return this.stopTyping();
        this.sendTyping();
      }, TYPING_EVERY_MS);
    } else if (!want) this.stopTyping();
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  // ---------- 화면에서 쓰는 것 ----------
  status(): MobileStatus {
    return {
      connected: !!this.saved?.token,
      paired: !!this.saved?.chatId,
      running: this.running,
      botName: this.saved?.botName,
      pairedName: this.saved?.name,
      pairCode: this.saved?.chatId ? undefined : this.pairCode ?? undefined,
      allRano: this.saved?.allRano !== false,
      approvals: this.saved?.approvals !== false,
      keepAwake: !!this.saved?.keepAwake,
      keepingAwake: this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId),
      error: this.lastError || undefined,
    };
  }

  async connect(token: string): Promise<{ ok: boolean; message: string }> {
    const t = String(token ?? '').trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t)) return { ok: false, message: '텔레그램 봇 토큰 모양이 아니에요 (숫자:영문… 형태예요)' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: '이 맥에서 토큰을 안전하게 저장할 수 없어요' };
    let me: any;
    try {
      me = await this.call('getMe', {}, undefined, t);
    } catch {
      return { ok: false, message: '이 토큰으로 봇에 연결하지 못했어요. 토큰을 다시 확인해 주세요' };
    }
    this.stop();
    this.saved = { token: t, botName: me?.username, allRano: true, approvals: true };
    this.persist();
    this.pairCode = String(randomInt(100000, 999999));
    this.start();
    return { ok: true, message: `@${me?.username} 봇에 연결했어요. 휴대폰 텔레그램에서 이 봇에게 짝 코드를 보내 주세요` };
  }

  newPairCode(): void {
    if (this.saved && !this.saved.chatId) this.pairCode = String(randomInt(100000, 999999));
  }

  async disconnect(): Promise<{ ok: boolean; message: string }> {
    this.stop();
    if (this.saved?.chatId) await this.say('라노 OS 와의 연결을 끊었어요.').catch(() => undefined);
    this.saved = null;
    this.pairCode = null;
    rmSync(this.file(), { force: true });
    return { ok: true, message: '텔레그램 연결을 끊었어요' };
  }

  setOptions(o: { allRano?: boolean; approvals?: boolean; keepAwake?: boolean }): void {
    if (!this.saved) return;
    if (typeof o.keepAwake === 'boolean') this.saved.keepAwake = o.keepAwake;
    if (typeof o.allRano === 'boolean') this.saved.allRano = o.allRano;
    if (typeof o.approvals === 'boolean') this.saved.approvals = o.approvals;
    this.persist();
    this.applyKeepAwake();
  }

  // ---------- 받기 ----------
  start(): void {
    if (this.running || !this.saved?.token) return;
    this.running = true;
    // 연결 전부터 있던 승인 요청은 다시 보내지 않는다
    this.seenAtStart = new Set(this.deps.approvals.list().filter((a) => a.status === 'pending').map((a) => a.id));
    this.applyKeepAwake();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    this.stopTyping();
    this.applyKeepAwake();
  }

  private async loop(): Promise<void> {
    let backoff = 2000;
    while (this.running && this.saved?.token) {
      this.abort = new AbortController();
      try {
        const timer = setTimeout(() => this.abort?.abort(), 65_000);
        const updates: any[] = await this.call('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, this.abort.signal);
        clearTimeout(timer);
        this.lastError = '';
        backoff = 2000;
        for (const u of updates) {
          this.offset = Math.max(this.offset, (u.update_id ?? 0) + 1);
          await this.handle(u).catch((e) => console.error('[telegram] 처리 실패:', e));
        }
      } catch (e) {
        if (!this.running) break;
        this.lastError = '텔레그램에 연결하지 못했어요 (인터넷 연결을 확인해 주세요)';
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async handle(u: any): Promise<void> {
    const saved = this.saved;
    if (!saved) return;
    // 승인 버튼
    if (u.callback_query) {
      const q = u.callback_query;
      if (q.message?.chat?.id !== saved.chatId) return;
      const [act, id] = String(q.data ?? '').split(':');
      const a = this.deps.approvals.list().find((x) => x.id === id);
      let answer = '이미 처리된 요청이에요';
      if (a && a.status === 'pending') {
        if (act === 'ok') {
          this.deps.approvals.decide(id, { decision: 'approve' });
          answer = a.bundle?.length ? '모두 반영으로 승인했어요' : a.decisionItems?.length ? '권장안대로 결정했어요' : '승인했어요';
        } else if (act === 'no') {
          this.deps.approvals.decide(id, { decision: 'reject', note: '휴대폰에서 반려' });
          answer = '반려했어요';
        }
        this.deps.activity(`휴대폰에서 ${answer.replace('했어요', '')}: ${a.title}`);
      }
      await this.call('answerCallbackQuery', { callback_query_id: q.id, text: answer }).catch(() => undefined);
      return;
    }
    const m = u.message;
    if (!m?.chat?.id) return;
    // 짝짓기 전: 짝 코드만 받는다
    if (!saved.chatId) {
      const text = String(m.text ?? '').trim();
      const code = text.replace(/^\/start\s*/, '');
      if (this.pairCode && code === this.pairCode && m.chat.type === 'private') {
        saved.chatId = m.chat.id;
        saved.name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || '';
        this.persist();
        this.pairCode = null;
        this.applyKeepAwake();
        this.deps.activity(`휴대폰 텔레그램(${saved.name})과 연결했어요`);
        await this.say('라노 OS 와 연결했어요. 이제 여기서 라노에게 말을 걸 수 있어요. 승인 요청이 오면 여기서도 승인·반려할 수 있어요.');
      } else {
        await this.call('sendMessage', { chat_id: m.chat.id, text: '라노 OS 맥 앱의 설정 › 휴대폰 연결에 나온 짝 코드 6자리를 보내 주세요.' }).catch(() => undefined);
      }
      return;
    }
    if (m.chat.id !== saved.chatId) return; // 짝지은 사람 말고는 무시
    const text = String(m.text ?? m.caption ?? '').trim();
    if (text === '/start') {
      await this.say('연결돼 있어요. 라노에게 할 말을 보내 주세요.');
      return;
    }
    // 사진: 가장 큰 것 하나를 받아 라노에게 함께 보낸다
    const attachments: NewAttachment[] = [];
    const photo = Array.isArray(m.photo) ? m.photo[m.photo.length - 1] : null;
    const doc = m.document && /^image\/(png|jpeg|gif|webp)$/.test(m.document.mime_type ?? '') ? m.document : null;
    const fileId = photo?.file_id ?? doc?.file_id;
    if (fileId) {
      try {
        const f = await this.call('getFile', { file_id: fileId });
        if (f?.file_path && (f.file_size ?? 0) <= 5 * 1024 * 1024) {
          const res = await fetch(`${API}/file/bot${saved.token}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = doc?.mime_type ?? 'image/jpeg';
          attachments.push({ name: doc?.file_name ?? `휴대폰 사진.${mime === 'image/png' ? 'png' : 'jpg'}`, mime, data: buf.toString('base64') });
        }
      } catch {
        await this.say('사진을 받지 못했어요. 글로 보내 주시거나 다시 보내 주세요.');
      }
    }
    if (!text && !attachments.length) return;
    // 받자마자 "입력 중" 한 번. 이후는 이 말이 저장되면(화면 이벤트) 답이 갈 때까지 이어서 보낸다
    this.sendTyping();
    const r = await this.deps.sendToRano(text || '(사진)', attachments);
    if (!r.ok) await this.say(r.message ?? '라노에게 전하지 못했어요.');
  }

  // ---------- 앱에서 일어난 일 → 휴대폰 ----------
  // 흘려 쓰는 답(live)·진행 줄은 보내지 않는다. 마지막 답·오류·보고 카드만 (mobileRules.ts 규칙)
  onEvent(e: RanoUiEvent): void {
    if (!this.saved?.chatId) return;
    const out = this.replies.decide(e, this.saved.allRano !== false);
    if (out) void this.say(out);
    this.syncTyping();
  }

  /** 승인함이 바뀔 때: 새 요청은 버튼과 함께 보내고, 처리된 요청은 버튼을 지우고 결과를 적는다 */
  onApprovalsChanged(): void {
    if (!this.saved?.chatId || this.saved.approvals === false) return;
    const list = this.deps.approvals.list();
    for (const a of list) {
      const sent = this.sentApprovals.get(a.id);
      if (a.status === 'pending' && sent === undefined && !this.seenAtStart.has(a.id)) {
        this.sentApprovals.set(a.id, -1);
        const lines = [`🔔 승인 요청 · ${a.who}`, a.title, '', `무엇을: ${a.what}`];
        if (a.why) lines.push(`왜: ${a.why}`);
        if (a.recommendation) lines.push(`권장: ${a.recommendation}`);
        if (a.bundle?.length) lines.push('', `파일 ${a.bundle.length}개: ${a.bundle.map((f) => f.rel).join(', ')}`, '파일마다 고르려면 맥 승인함에서 해 주세요.');
        if (a.decisionItems?.length) lines.push('', ...a.decisionItems.map((it) => `${it.id}. ${it.question} → 권장 ${it.recommended}안`), '다른 안을 고르려면 맥 승인함에서 해 주세요.');
        if (a.change) lines.push('', '바뀌는 부분은 맥 승인함에서 색으로 볼 수 있어요.');
        const okLabel = a.bundle?.length ? '모두 반영' : a.decisionItems?.length ? '권장안대로' : '승인';
        void this.say(lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: `✅ ${okLabel}`, callback_data: `ok:${a.id}` }, { text: '❌ 반려', callback_data: `no:${a.id}` }]] } }).then((id) => {
          if (id) this.sentApprovals.set(a.id, id);
        });
      } else if (a.status !== 'pending' && sent !== undefined && sent > 0) {
        this.sentApprovals.delete(a.id);
        const label = a.status === 'approved' ? '✅ 승인됨' : a.status === 'rejected' ? '❌ 반려됨' : a.status === 'revise' ? '✏️ 수정 요청' : '⏹ 끝남';
        void this.call('editMessageReplyMarkup', { chat_id: this.saved.chatId, message_id: sent, reply_markup: { inline_keyboard: [] } })
          .then(() => this.call('sendMessage', { chat_id: this.saved!.chatId, text: `${label}: ${a.title}`, reply_to_message_id: sent }))
          .catch(() => undefined);
      }
    }
  }
}
