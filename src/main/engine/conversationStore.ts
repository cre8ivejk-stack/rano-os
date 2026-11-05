// 대화 기록을 저장한다. 기본은 runs/rano/conversation.json (라노), 경로를 주면 그곳(리포 리더 등).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage, ConversationStoreApi, RanoConfig } from '../../shared/types.js';

interface StoredConversation {
  sessionId: string | null;
  messages: ChatMessage[];
}

function isChatMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    (o.role === 'user' || o.role === 'rano' || o.role === 'leader') &&
    typeof o.text === 'string' &&
    typeof o.at === 'string'
  );
}

export class ConversationStore implements ConversationStoreApi {
  private readonly dir: string;
  private readonly file: string;
  private state: StoredConversation | null = null;
  private loading: Promise<StoredConversation> | null = null;
  // 쓰기를 순서대로 처리하기 위한 사슬
  private writeChain: Promise<void> = Promise.resolve();

  // file 을 주면 그 절대 경로에 저장한다 (예: 리포 리더 대화 runs/missions/<id>/conversation.json)
  constructor(config: RanoConfig, file?: string) {
    this.file = file ? path.resolve(file) : path.join(config.runsDir, 'rano', 'conversation.json');
    this.dir = path.dirname(this.file);
  }

  async load(): Promise<{ sessionId: string | null; messages: ChatMessage[] }> {
    const s = await this.ensureLoaded();
    return { sessionId: s.sessionId, messages: [...s.messages] };
  }

  async append(message: ChatMessage): Promise<void> {
    const s = await this.ensureLoaded();
    s.messages.push(message);
    await this.persist();
  }

  async setSessionId(sessionId: string): Promise<void> {
    const s = await this.ensureLoaded();
    if (s.sessionId === sessionId) return;
    s.sessionId = sessionId;
    await this.persist();
  }

  private ensureLoaded(): Promise<StoredConversation> {
    if (this.state) return Promise.resolve(this.state);
    if (!this.loading) {
      this.loading = this.readFromDisk().then((s) => {
        this.state = s;
        return s;
      });
    }
    return this.loading;
  }

  private async readFromDisk(): Promise<StoredConversation> {
    await fs.mkdir(this.dir, { recursive: true });
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessionId: null, messages: [] };
      throw err;
    }
    try {
      const raw = JSON.parse(text) as Partial<StoredConversation>;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) throw new Error('형식이 맞지 않음');
      return {
        sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
        messages: raw.messages.filter(isChatMessage),
      };
    } catch {
      // 깨진 파일은 백업 이름으로 옮기고 빈 상태로 시작한다
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.basename(this.file, '.json');
      const backup = path.join(this.dir, `${base}.broken-${stamp}.json`);
      try {
        await fs.rename(this.file, backup);
      } catch {
        // 옮기지 못해도 빈 상태로 계속 진행한다
      }
      return { sessionId: null, messages: [] };
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const run = async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf-8');
      await fs.rename(tmp, this.file);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
