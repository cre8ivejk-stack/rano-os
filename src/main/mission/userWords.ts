// 라노가 리더에게 일을 넘길 때 사용자가 직접 쓴 말을 함께 붙인다. 라노가 지시를 풀어 쓰며 단계(검증·비교표·멈춤 조건 등)를
// 덧붙여도, 리더는 사용자가 쓴 말을 범위의 기준으로 삼는다(2026-11-09 사용자 결정).

const MAX = 1500;

export function withUserWords(brief: string, userWords: string): string {
  const words = String(userWords ?? '').trim();
  if (!words) return brief;
  const cut = words.length > MAX ? `${words.slice(0, MAX)}…` : words;
  const quoted = cut.split('\n').map((l) => `> ${l}`).join('\n');
  return [
    brief,
    '',
    '[사용자가 직접 쓴 말] 이 과제의 범위는 이 말이 기준이에요. 위 지시는 라노가 이 말을 풀어 쓴 것이에요.',
    '이 말이 앞선 보고의 안(A안·B안 등)을 고른 것이면 그 안의 내용까지가 범위예요. 이 말과 그 안 어디에도 없는 단계(따로 하는 검증·전후 비교·배포 확인·멈춤 조건·추가 보고 항목 등)는 참고로만 보고, 안전에 꼭 필요할 때만 하세요. 하지 않은 것은 보고에 한 줄로 적으세요.',
    quoted,
  ].join('\n');
}
