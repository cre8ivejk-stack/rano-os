// 미션 전용 임시 폴더: 명령 결과를 잠깐 담아 두는 곳(~/rano/runs/tmp/<미션 id>).
// 예전에는 모든 미션이 /tmp 를 같이 썼다. 미션끼리(특히 회사·개인 구역끼리) 섞이지 않게 미션마다 따로 둔다.
// 앱이 자동으로 지우지 않는다(/tmp 와 달리 재시동해도 남는다).
import path from 'node:path';
import type { RanoConfig } from '../../shared/types.js';

/** 이 미션의 임시 폴더(절대 경로). 데이터 폴더의 runs 아래 */
export function missionTmpDir(config: Pick<RanoConfig, 'runsDir'>, missionId: string): string {
  return path.join(config.runsDir, 'tmp', missionId);
}
