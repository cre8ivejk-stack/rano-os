// 엔진(Claude 실행 파일) 위치를 찾는다. 맥 앱으로 포장하면 실행 파일은 app.asar 밖(app.asar.unpacked)에 풀려 있어야 실행된다.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

let cached: string | undefined | null = null;

export function claudeBinaryPath(): string | undefined {
  if (cached !== null) return cached;
  cached = undefined;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = path.join(path.dirname(pkg), 'claude').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    if (existsSync(bin)) cached = bin;
  } catch {
    // 못 찾으면 SDK 기본 동작에 맡긴다
  }
  return cached;
}
