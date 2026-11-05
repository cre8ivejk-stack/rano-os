// 라노 전역 기억(memory/*.md)을 읽고 쓴다. 허용된 파일 이름만 다루고, 쓰기는 원자적으로 순서대로 처리한다.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Emit, MemoryFile, MemoryServiceApi, RanoConfig } from '../../shared/types.js';
import { autoCommit } from './autoCommit.js';

export class MemoryService implements MemoryServiceApi {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: RanoConfig,
    private readonly emit: Emit,
  ) {}

  // config.memoryFiles 에 있는 이름만 통과. 경로 조작(../, 하위 폴더)은 여기서 막힌다.
  private filePath(name: string): string {
    if (typeof name !== 'string' || !this.config.memoryFiles.includes(name) || name !== path.basename(name)) {
      throw new Error(`다룰 수 없는 기억 파일 이름입니다: ${String(name)} (가능한 이름: ${this.config.memoryFiles.join(', ')})`);
    }
    return path.join(this.config.memoryDir, name);
  }

  async read(name: string): Promise<string> {
    const file = this.filePath(name);
    try {
      return await fs.readFile(file, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  }

  async readAll(): Promise<MemoryFile[]> {
    const out: MemoryFile[] = [];
    for (const name of this.config.memoryFiles) out.push({ name, content: await this.read(name) });
    return out;
  }

  write(name: string, content: string, reason: string): Promise<{ committed: boolean; note?: string }> {
    const run = this.queue.then(() => this.doWrite(name, content, reason));
    this.queue = run.catch(() => undefined); // 앞 요청이 실패해도 다음 요청은 진행
    return run;
  }

  private async doWrite(name: string, content: string, reason: string): Promise<{ committed: boolean; note?: string }> {
    const file = this.filePath(name);
    if (typeof content !== 'string') throw new Error('기억 내용은 글자여야 합니다');
    const why = String(reason ?? '').replace(/\s+/g, ' ').trim() || '이유 없음';

    await fs.mkdir(this.config.memoryDir, { recursive: true });
    const tmp = path.join(this.config.memoryDir, `.${name}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, content, 'utf-8');
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }

    let result: { committed: boolean; note?: string } = { committed: false };
    let suffix = '';
    if (this.config.autoCommit) {
      result = await autoCommit(this.config.memoryDir, `기억 갱신: ${name} — ${why}`);
      const unchanged = result.note === '바뀐 내용이 없어 저장하지 않았습니다';
      suffix = result.committed
        ? ' (자동 저장됨)'
        : unchanged
          ? ' (바뀐 내용 없음)'
          : ` (자동 저장 실패: ${result.note ?? '알 수 없는 이유'})`;
    }
    this.emit({ kind: 'activity', text: `기억 갱신: ${name}${suffix}`, at: new Date().toISOString() });
    return result;
  }
}
