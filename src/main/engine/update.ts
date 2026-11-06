// 새 버전 확인: GitHub Releases 의 최신 버전과 지금 앱 버전을 비교한다(받기·설치는 사용자가 직접).
// 저장소 주소는 package.json repository 에서 읽는다(포크하면 그 저장소를 본다). 바깥으로 요청 한 번만 보내고, 포트는 열지 않는다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { UpdateInfo } from '../../shared/types.js';

export function repoSlug(appPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(appPath, 'package.json'), 'utf-8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? ''));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** '0.10.1' > '0.9.3' 이면 1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export async function checkForUpdate(appPath: string, current: string): Promise<UpdateInfo> {
  const slug = repoSlug(appPath);
  if (!slug) return { current, newer: false, error: '저장소 주소를 몰라서 확인할 수 없어요' };
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rano-os' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { current, newer: false, error: '배포본을 찾지 못했어요 (저장소가 비공개이거나 아직 배포본이 없어요)' };
    if (!res.ok) return { current, newer: false, error: `새 버전을 확인하지 못했어요 (${res.status})` };
    const d: any = await res.json();
    const latest = String(d.tag_name ?? '').replace(/^v/, '');
    if (!latest) return { current, newer: false, error: '최신 버전 번호를 읽지 못했어요' };
    return {
      current,
      latest,
      newer: compareVersions(latest, current) > 0,
      url: typeof d.html_url === 'string' ? d.html_url : `https://github.com/${slug}/releases/latest`,
      notes: typeof d.body === 'string' ? d.body.slice(0, 4000) : '',
      publishedAt: d.published_at,
    };
  } catch {
    return { current, newer: false, error: '인터넷에 연결되지 않아 새 버전을 확인하지 못했어요' };
  }
}
