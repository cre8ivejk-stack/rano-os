// 조직 화면: 역할 만들기·고치기·보기. 인재풀(pool) 역할만 고칠 수 있고, 나머지는 보기만 한다.
import { el, zoneInfo } from './dom.js';
import { ROLE_NAME_RULE, SOURCE_LABEL, abilityText, button, checkbox, field, tildify, type Notice } from './orgCommon.js';

interface RoleTemplate {
  label: string;
  description: string;
  canWrite: boolean;
  canRun: boolean;
  body: string;
}

// "틀에서 시작" 예시. 지침은 무엇을 하고, 무엇은 하지 않고, 어떻게 보고하는지를 담는다.
const TEMPLATES: RoleTemplate[] = [
  {
    label: '문서 담당',
    description: '리더가 맡긴 문서를 쓰고 다듬는 담당',
    canWrite: true,
    canRun: false,
    body: [
      '리더가 맡긴 문서(보고서, 안내서, 정리 노트)를 쓰고 다듬는다.',
      '사실은 작업 폴더와 참고 폴더에서 확인한 내용만 쓰고, 모르는 것은 "확인 필요"로 남긴다.',
      '비밀 파일(.env, 자격증명)은 열지 않는다.',
      '커밋·push 는 리더가 지시할 때만 한다.',
      '끝나면 바꾼 파일 목록과 무엇을 고쳤는지 세 줄 안으로 리더에게 보고한다.',
    ].join('\n'),
  },
  {
    label: '코드 담당',
    description: '리더가 맡긴 코드를 고치고 간단히 확인하는 담당',
    canWrite: true,
    canRun: true,
    body: [
      '리더가 맡긴 범위의 코드만 고친다. 범위 밖 변경이 필요하면 먼저 리더에게 묻는다.',
      '고친 뒤 타입 확인·테스트처럼 가능한 확인을 직접 돌려 본다.',
      '비밀 파일(.env, 자격증명)은 열지 않고, 값도 출력하지 않는다.',
      '커밋·push·삭제는 리더가 지시할 때만 한다.',
      '끝나면 바꾼 파일, 돌려 본 확인과 결과, 남은 문제를 리더에게 보고한다.',
    ].join('\n'),
  },
  {
    label: '검토 담당 (읽기만)',
    description: '바뀐 내용을 읽고 문제를 찾는 검수 담당',
    canWrite: false,
    canRun: false,
    body: [
      '작업 담당이 바꾼 파일을 읽고 맞는지, 빠진 것이 없는지 살핀다.',
      '파일은 읽기만 하고 직접 고치지 않는다.',
      '비밀 파일(.env, 자격증명)은 열지 않는다.',
      '결과는 "통과" 또는 "고칠 점" 목록으로, 파일과 줄을 짚어 리더에게 보고한다.',
    ].join('\n'),
  },
  {
    label: '검증 담당 (명령 실행)',
    description: '테스트·확인 명령을 돌려 결과를 확인하는 검수 담당',
    canWrite: false,
    canRun: true,
    body: [
      '타입 확인, 테스트, 빌드처럼 결과를 확인하는 명령을 돌린다.',
      '파일을 고치거나 지우는 명령, 배포·push 하는 명령은 돌리지 않는다.',
      '비밀 파일(.env, 자격증명)은 열지 않는다.',
      '돌린 명령과 결과(통과/실패, 실패면 핵심 오류 줄)를 리더에게 보고한다.',
    ].join('\n'),
  },
];

export class RoleEditor {
  /** 저장했거나 닫았을 때. saved=true 면 목록을 새로 불러온다 */
  onDone: (saved: boolean, name?: string) => void = () => {};

  constructor(
    private root: HTMLElement,
    private notice: Notice,
  ) {}

  private zone: Zone = 'work';

  /** name 이 없으면 새 역할 만들기. zone 은 새 역할을 둘 인재풀 구역 */
  async open(name?: string, zone: Zone = 'work'): Promise<void> {
    this.zone = zone;
    this.root.replaceChildren(el('p', 'board-note', name ? '역할을 불러오는 중이에요…' : ''));
    if (!name) {
      this.render(null);
      return;
    }
    try {
      const role = await window.rano.orgRole(name);
      if (!role) {
        this.notice.show('역할을 찾지 못했어요. 목록을 새로 불러올게요.', false);
        this.onDone(true);
        return;
      }
      this.render(role);
    } catch {
      this.notice.show('역할을 불러오지 못했어요. 잠시 뒤 다시 눌러 주세요.', false);
      this.onDone(false);
    }
  }

  private render(role: RoleInfo | null): void {
    const editable = !role || role.editable;
    const wrap = el('section', 'org-editor');
    const head = el('div', 'org-editor-head');
    head.appendChild(el('h2', 'pane-title', !role ? '역할 만들기' : editable ? `역할 고치기 · ${role.name}` : `역할 보기 · ${role.name}`));
    const back = button('목록으로', 'btn btn-plain');
    back.addEventListener('click', () => this.onDone(false));
    head.appendChild(back);
    wrap.appendChild(head);

    if (role) {
      const meta = el('p', 'pane-sub', `${zoneInfo(role.zone).label} 구역 · ${SOURCE_LABEL[role.source] ?? role.source} · ${tildify(role.dir)}`);
      wrap.appendChild(meta);
    }
    if (!editable) {
      wrap.appendChild(el('p', 'org-readonly', '이 역할은 보기만 할 수 있어요. 라노 인재풀에 있는 역할만 앱에서 고칠 수 있어요.'));
    } else if (role) {
      wrap.appendChild(el('p', 'pane-sub', '라노 인재풀에 있는 역할이에요. 고치면 다음 과제부터 반영돼요.'));
    } else {
      wrap.appendChild(el('p', 'pane-sub', '새 역할은 라노 인재풀(~/rano/pool)에 저장돼요. 같은 구역 미션의 팀을 꾸릴 때 고를 수 있어요.'));
      const group = el('fieldset', 'org-radio-group');
      group.appendChild(el('legend', 'org-label', '인재풀 구역'));
      for (const [value, title, desc] of [
        ['work', zoneInfo('work').label, `${zoneInfo('work').label} 구역 미션이 쓸 수 있어요.`],
        ['personal', zoneInfo('personal').label, `${zoneInfo('personal').label} 구역 미션만 쓸 수 있어요.`],
      ] as const) {
        const label = el('label', `org-radio${this.zone === value ? ' on' : ''}`);
        const input = el('input');
        input.type = 'radio';
        input.name = 'org-role-zone';
        input.value = value;
        input.checked = this.zone === value;
        label.appendChild(input);
        const text = el('span', 'org-radio-text');
        text.appendChild(el('strong', undefined, title));
        text.appendChild(el('span', 'org-hint', desc));
        label.appendChild(text);
        input.addEventListener('change', () => {
          if (!input.checked) return;
          this.zone = value;
          group.querySelectorAll('.org-radio').forEach((l) => l.classList.toggle('on', l === label));
        });
        group.appendChild(label);
      }
      wrap.appendChild(group);
    }

    // ---- 틀에서 시작 ----
    const nameInput = el('input', 'org-input');
    const descInput = el('input', 'org-input');
    const write = checkbox('파일 쓰기', role?.canWrite ?? false);
    const run = checkbox('명령 실행', role?.canRun ?? false);
    const bodyInput = el('textarea', 'org-input org-textarea');

    if (editable) {
      const tpl = el('div', 'org-templates');
      tpl.appendChild(el('span', 'org-label', '틀에서 시작'));
      for (const t of TEMPLATES) {
        const b = button(t.label, 'btn btn-small');
        b.addEventListener('click', () => {
          descInput.value = t.description;
          write.input.checked = t.canWrite;
          run.input.checked = t.canRun;
          bodyInput.value = t.body;
          refresh();
        });
        tpl.appendChild(b);
      }
      wrap.appendChild(tpl);
    }

    // ---- 입력칸 ----
    nameInput.value = role?.name ?? '';
    nameInput.maxLength = 60;
    nameInput.placeholder = '예) report-writer';
    nameInput.spellcheck = false;
    wrap.appendChild(field('이름', nameInput, editable ? '영문 소문자, 숫자, - 만 쓸 수 있어요. 리더가 이 이름으로 불러요.' : undefined));

    descInput.value = role?.description ?? '';
    descInput.maxLength = 200;
    descInput.placeholder = '예) 주간 보고서를 쓰는 담당';
    wrap.appendChild(field('한 줄 설명', descInput));

    const abil = el('div', 'org-field');
    abil.appendChild(el('span', 'org-label', '할 수 있는 일'));
    const abilRow = el('div', 'org-check-row');
    const readAlways = checkbox('읽기 (항상)', true);
    readAlways.input.disabled = true;
    abilRow.append(readAlways.label, write.label, run.label);
    abil.appendChild(abilRow);
    abil.appendChild(el('p', 'org-hint', '쓰기도 미션이 "승인함을 거쳐 쓰기"일 때만, 파일 하나마다 승인을 받은 뒤에 실행돼요.'));
    wrap.appendChild(abil);

    bodyInput.value = role?.body ?? '';
    bodyInput.rows = 10;
    bodyInput.placeholder = '무엇을 하고, 무엇은 하지 않고, 결과를 어떻게 보고하는지 적어 주세요.';
    wrap.appendChild(field('지침', bodyInput));

    const err = el('p', 'org-problem');
    err.hidden = true;
    wrap.appendChild(err);

    if (!editable) {
      for (const n of [nameInput, descInput, bodyInput]) n.readOnly = true;
      write.input.disabled = run.input.disabled = true;
      this.root.replaceChildren(wrap);
      return;
    }

    const actions = el('div', 'org-actions');
    const save = button(role ? '저장' : '역할 만들기', 'btn btn-confirm');
    actions.appendChild(save);
    wrap.appendChild(actions);

    const reason = (): string => {
      const n = nameInput.value.trim();
      if (!n) return '이름을 적어 주세요.';
      if (!ROLE_NAME_RULE.test(n)) return '이름은 영문 소문자, 숫자, - 로 적어 주세요. (예: report-writer)';
      if (!descInput.value.trim()) return '한 줄 설명을 적어 주세요.';
      if (!bodyInput.value.trim()) return '지침을 적어 주세요. "틀에서 시작"을 누르면 예시가 채워져요.';
      return '';
    };
    const refresh = () => {
      const r = reason();
      save.disabled = !!r;
      err.textContent = r;
      err.hidden = !r || !nameInput.value.trim();
    };
    for (const n of [nameInput, descInput, bodyInput]) n.addEventListener('input', refresh);
    refresh();

    let busy = false;
    save.addEventListener('click', async () => {
      if (busy || reason()) return;
      busy = true;
      save.disabled = true;
      save.textContent = '저장하는 중…';
      const draft: RoleDraft = {
        zone: role ? role.zone : this.zone,
        name: nameInput.value.trim(),
        description: descInput.value.trim(),
        canWrite: write.input.checked,
        canRun: run.input.checked,
        body: bodyInput.value,
      };
      try {
        const res = await window.rano.orgSaveRole(draft, role ? role.name : undefined);
        this.notice.show(res?.message || (res?.ok ? '저장했어요.' : '저장하지 못했어요.'), !!res?.ok);
        if (res?.ok) {
          this.onDone(true, res.id ?? draft.name);
          return;
        }
      } catch {
        this.notice.show('역할을 저장하지 못했어요. 잠시 뒤 다시 눌러 주세요.', false);
      }
      busy = false;
      save.textContent = role ? '저장' : '역할 만들기';
      refresh();
    });

    this.root.replaceChildren(wrap);
    nameInput.focus();
  }
}

/** 역할 한 줄 설명(목록용) */
export function roleSummary(r: RoleInfo): string {
  return `${abilityText(r)} · ${SOURCE_LABEL[r.source] ?? r.source}`;
}
