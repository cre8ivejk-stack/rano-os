// memory 폴더 같은 기억 폴더를 그 폴더 안의 로컬 git 에 자동 커밋한다.
// 사용자 git 설정은 바꾸지 않고, 작성자는 이번 명령에만 지정한다. 실패해도 예외를 던지지 않는다.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function git(dir: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) });
    });
  });
}

export async function autoCommit(dir: string, message: string): Promise<{ committed: boolean; note?: string }> {
  try {
    if (!existsSync(path.join(dir, '.git'))) {
      const init = await git(dir, ['init', '-q']);
      if (!init.ok) return { committed: false, note: '저장 기록 폴더를 만들지 못했습니다' };
    }
    const add = await git(dir, ['add', '-A']);
    if (!add.ok) return { committed: false, note: '바뀐 파일을 담지 못했습니다' };

    const status = await git(dir, ['status', '--porcelain']);
    if (!status.ok) return { committed: false, note: '바뀐 내용을 확인하지 못했습니다' };
    if (!status.stdout.trim()) return { committed: false, note: '바뀐 내용이 없어 저장하지 않았습니다' };

    const commit = await git(dir, [
      '-c', 'user.name=라노',
      '-c', 'user.email=rano@localhost',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', message,
    ]);
    if (!commit.ok) return { committed: false, note: '저장 기록을 남기지 못했습니다' };
    return { committed: true };
  } catch {
    return { committed: false, note: 'git 을 실행하지 못했습니다' };
  }
}
