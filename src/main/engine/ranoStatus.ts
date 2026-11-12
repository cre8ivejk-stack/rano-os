// 라노가 답하기 전에 붙여 줄 "지금 현황" 한 묶음: 미션별 진행 중 과제·승인 대기·터미널에서 따로 하는 일.
// 라노가 확인 없이 짐작해 답하지 않게 하려는 것. 사용자 말 차례에만 붙인다.
import type { MissionStatus } from '../../shared/types.js';

export interface StatusNoteInput {
  missions: MissionStatus[];
  pending: { missionId?: string; title: string }[]; // 사용자를 기다리는 승인 카드
  terminal?: { missionName: string; text: string }[]; // 터미널(앱 밖) 세션 요약
  now?: Date;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

export function buildStatusNote(input: StatusNoteInput): string {
  const now = input.now ?? new Date();
  const hhmm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
  const lines: string[] = [];
  for (const m of input.missions) {
    const running = m.running?.length ? m.running : m.leaderState === 'working' && m.currentTask ? [m.currentTask] : [];
    if (running.length) {
      for (const t of running) {
        const members = m.members.filter((x) => (x.state === 'working' || x.state === 'reviewing') && (!x.taskId || x.taskId === t.id)).map((x) => `${x.role}${x.state === 'reviewing' ? '(검수 중)' : ''}`);
        lines.push(`- ${m.name}: 진행 중 「${clip(t.title, 50)}」 (${hhmm(t.startedAt)} 시작${members.length ? `, 일하는 팀원: ${members.join(', ')}` : ''})`);
      }
    } else {
      const last = m.currentTask;
      lines.push(`- ${m.name}: 쉬는 중${last ? ` (마지막 과제 「${clip(last.title, 40)}」 ${last.status === 'failed' ? '실패·중단' : '끝남'} ${hhmm(last.endedAt)})` : ''}`);
    }
    const mine = input.pending.filter((p) => p.missionId === m.missionId);
    if (mine.length) lines.push(`  · 사용자 승인을 기다리는 카드 ${mine.length}장: ${mine.slice(0, 3).map((p) => `「${clip(p.title, 40)}」`).join(', ')}`);
  }
  const parts = [`[앱 안내 — 지금 현황 ${now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}] 미션 진행 상황을 말할 때는 기억이나 짐작 대신 이 현황을 근거로 답하세요(더 자세히 필요하면 get_mission_status). 이 안내를 사용자에게 따로 읽어 주지는 않아요.\n${lines.join('\n') || '- (등록된 미션 없음)'}`];
  const term = (input.terminal ?? []).filter((t) => t.text);
  if (term.length)
    parts.push(`[앱 안내 — 터미널(Claude Code)에서 따로 진행한 최근 세션] 앱 밖에서 사용자가 직접 하는 일이에요. 제목이 비슷해도 라노가 맡긴 과제와 같은 일이라고 단정하지 말고, 겹쳐 보이면 사용자에게 물어보세요(자세한 내용은 get_terminal_sessions).\n${term.map((t) => `${t.missionName}:\n${t.text}`).join('\n')}`);
  return parts.join('\n\n');
}
