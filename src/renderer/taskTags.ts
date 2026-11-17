// 과제 꼬리표: 같은 미션에서 과제 여러 개가 함께 돌 때, 카드·보고·내 말이 어느 과제 것인지 색 점과 짧은 제목으로 보인다.
// 색은 화면이 과제를 처음 본 순서대로 돌려 쓴다(잇달아 시작한 과제끼리 색이 겹치지 않게).
import { el } from './dom.js';

export const TAG_COLORS = 6;

const colors = new Map<string, number>();

/** 과제 번호 → 색 번호(0~5). 처음 본 순서대로 하나씩 */
export function tagColor(taskId: string): number {
  let c = colors.get(taskId);
  if (c === undefined) {
    c = colors.size % TAG_COLORS;
    colors.set(taskId, c);
  }
  return c;
}

/** 꼬리표에 쓸 짧은 제목 */
export function shortTitle(title: string, max = 16): string {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim() || '과제';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const known = new Map<string, TaskRef>();

/** 화면이 본 과제를 적어 둔다(현황·승인 카드·결과물·보고에서). 제목이 빈 값이면 앞에 적어 둔 제목을 지킨다 */
export function registerTask(ref: TaskRef): void {
  if (!ref || !ref.taskId) return;
  const old = known.get(ref.taskId);
  known.set(ref.taskId, { missionId: ref.missionId || old?.missionId || '', taskId: ref.taskId, title: ref.title || old?.title || '' });
}

export function taskRef(taskId: string): TaskRef | undefined {
  return known.get(taskId);
}

/** 색 점 + 짧은 제목 꼬리표. onPick 이 있으면 단추(눌러서 그 과제만 보기) */
export function taskChip(ref: { taskId: string; title: string }, onPick?: (taskId: string) => void, max = 16): HTMLElement {
  const chip = el(onPick ? 'button' : 'span', `task-chip task-c${tagColor(ref.taskId)}`);
  if (onPick) {
    (chip as HTMLButtonElement).type = 'button';
    chip.title = `「${ref.title || '과제'}」 과제만 보기`;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(ref.taskId);
    });
  } else chip.title = ref.title || '과제';
  chip.dataset.task = ref.taskId;
  chip.appendChild(el('span', 'task-dot'));
  chip.appendChild(el('span', 'task-chip-text', shortTitle(ref.title, max)));
  return chip;
}
