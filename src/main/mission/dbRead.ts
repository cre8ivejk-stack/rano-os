// 믿는 미션의 운영 DB 읽기 조회 (2026-11-12 사용자 결정)
// 미션에 지정한 외부 연결 도구(예: 원격 앱에서 명령 한 번 실행)로, 지정한 앱에서, 정해진 꼴의 psql 읽기 조회만 승인 없이 바로 한다.
// 정해진 꼴: PGOPTIONS='-c default_transaction_read_only=on' psql [허용 옵션] -c "SELECT …" [-c "…"] [2>&1] [| head -N]
//   또는 psql [허용 옵션] -c "SET default_transaction_read_only=on;" -c "SELECT …" …
// 읽기 전용 거래(트랜잭션)로 묶이고, 문장은 SELECT·WITH·EXPLAIN·SHOW·TABLE·VALUES 로 시작해야 하며, 쓰기 단어·위험 함수·셸 확장이 있으면 승인함으로 간다.
import type { MissionConfig } from '../../shared/types.js';

/** 셸 단어 하나. quoted: 따옴표 안에서 온 글자가 있는지 */
interface Word {
  text: string;
  quoted: boolean;
}

/** 아주 좁은 셸 쪼개기. 따옴표 밖의 ; & | > < ` $( 와 줄바꿈은 따로 표시. 해석할 수 없으면 null */
function splitShell(cmd: string): (Word | { op: string })[] | null {
  const out: (Word | { op: string })[] = [];
  let i = 0;
  let cur: Word | null = null;
  const push = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === ' ' || ch === '\t') {
      push();
      i++;
      continue;
    }
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) return null;
      cur = cur ?? { text: '', quoted: false };
      cur.text += cmd.slice(i + 1, end);
      cur.quoted = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\') {
          // 큰따옴표 안에서는 \" 만 받는다(따옴표 붙은 열 이름)
          if (cmd[j + 1] !== '"') return null;
          s += '"';
          j++;
          continue;
        }
        if (cmd[j] === '$' || cmd[j] === '`') return null;
        s += cmd[j];
      }
      if (j >= cmd.length) return null;
      cur = cur ?? { text: '', quoted: false };
      cur.text += s;
      cur.quoted = true;
      i = j + 1;
      continue;
    }
    if (ch === '2' && cmd.startsWith('2>&1', i) && !cur) {
      out.push({ op: '2>&1' });
      i += 4;
      continue;
    }
    if (';&|<>`\n\r\\$(){}*?[]!#~'.includes(ch)) {
      push();
      out.push({ op: ch });
      i++;
      continue;
    }
    cur = cur ?? { text: '', quoted: false };
    cur.text += ch;
    i++;
  }
  push();
  return out;
}

const READ_START = /^\s*(select|with|explain|show|table|values)\b/i;
/** 쓰기·거래 바꾸기·설정 바꾸기 낱말 */
const WRITE_WORD =
  /\b(insert|update|delete|merge|upsert|drop|alter|truncate|create|grant|revoke|copy|vacuum|analyze|reindex|cluster|lock|set|reset|begin|commit|rollback|abort|savepoint|prepare|execute|deallocate|do|call|listen|notify|unlisten|refresh|security|comment|discard|load|import|checkpoint|into)\b/i;
/** 읽기 거래에서도 부작용이 있거나 서버 파일·다른 접속을 건드리는 함수 */
const RISKY_FN =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|pg_sleep\w*|pg_advisory\w*|pg_try_advisory\w*|lo_\w+|dblink\w*|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_file_\w+|pg_logical_\w+|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|pg_switch_wal|pg_promote|pg_backup_\w+|nextval|setval|currval|txid_\w+|pg_notify|query_to_xml\w*|table_to_xml\w*|database_to_xml\w*|cursor_to_xml\w*|xmlparse|pg_import_system_collations|pg_wal_\w+|pg_current_wal\w*)\s*\(/i;

/** SQL 한 문장이 읽기만 하는지. 문자열 안 글자는 빼고 본다 */
export function isReadOnlySql(sql: string): boolean {
  if (sql.length > 20000) return false;
  if (/--|\/\*|\\/.test(sql)) return false; // 주석·psql 명령(\! 등) 금지
  const noStr = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (/'/.test(noStr.replace(/''/g, ''))) return false; // 닫히지 않은 문자열
  if (/\$/.test(noStr)) return false; // 달러 따옴표·자리 표시
  const body = noStr.replace(/;\s*$/, '');
  if (body.includes(';')) return false; // 한 -c 에 한 문장
  if (!READ_START.test(body)) return false;
  if (/^\s*explain\b/i.test(body) && /\banaly[sz]e\b/i.test(body)) return false;
  // 열 이름 "update" 처럼 큰따옴표로 감싼 이름은 빼고 본다
  const bare = body.replace(/"(?:[^"]|"")*"/g, '""');
  if (WRITE_WORD.test(bare)) return false;
  if (RISKY_FN.test(bare)) return false;
  return true;
}

const ENV_VAR = /^\$\{?(POSTGRES|PG)[A-Z_]*(:-[A-Za-z0-9_]+)?\}?$/;
const SECRET_VAR = /PASS|SECRET|TOKEN|KEY/;
const RO_SET = /^\s*set\s+(session\s+)?default_transaction_read_only\s*(=|to)\s*(on|true)\s*;?\s*$/i;
const READ_ONLY_PGOPTIONS = /^PGOPTIONS=-c default_transaction_read_only=on$/;

/**
 * 정해진 꼴의 psql 읽기 조회인지.
 * 셸 확장($)은 -U·-d 값의 POSTGRES*·PG* 변수 하나만 받는다(비밀번호·토큰 변수는 안 됨).
 */
export function isReadOnlyPsql(command: string): boolean {
  if (typeof command !== 'string' || command.length > 30000) return false;
  // -U "$POSTGRES_USER" 같은 변수 자리는 따로 확인하고 자리표로 바꾼다
  const vars: string[] = [];
  const masked = command.replace(/(-[Ud])\s+"(\$\{?[A-Z_]+(?::-[A-Za-z0-9_]+)?\}?)"/g, (_m, opt: string, v: string) => {
    vars.push(v);
    return `${opt} __VAR${vars.length - 1}__`;
  });
  if (vars.some((v) => !ENV_VAR.test(v) || SECRET_VAR.test(v))) return false;
  const toks = splitShell(masked);
  if (!toks || !toks.length) return false;
  let i = 0;
  const word = (t: (typeof toks)[number] | undefined): t is Word => !!t && 'text' in t;
  // 1) 읽기 전용 설정이 맨 앞
  // (또는 PGOPTIONS 없이 첫 -c 가 SET default_transaction_read_only=on)
  const first = toks[i];
  const pgopt = word(first) && READ_ONLY_PGOPTIONS.test(first.text);
  if (pgopt) i++;
  let roSet = false;
  const psql = toks[i++];
  if (!word(psql) || psql.quoted || psql.text !== 'psql') return false;
  let sqlCount = 0;
  // 2) psql 옵션
  while (i < toks.length) {
    const t = toks[i];
    if (!word(t)) break;
    if (t.quoted) return false;
    const opt = t.text;
    if (/^-[XAtqn]+$/.test(opt) || opt === '--no-psqlrc') {
      i++;
      continue;
    }
    if (opt === '-U' || opt === '-d') {
      const v = toks[i + 1];
      if (!word(v) || !(/^__VAR\d+__$/.test(v.text) || /^[A-Za-z0-9_]+$/.test(v.text))) return false;
      i += 2;
      continue;
    }
    if (opt === '-h') {
      const v = toks[i + 1];
      if (!word(v) || !/^(127\.0\.0\.1|localhost)$/.test(v.text)) return false;
      i += 2;
      continue;
    }
    if (opt === '-F') {
      const v = toks[i + 1];
      if (!word(v) || !/^.{1,5}$/.test(v.text) || /[\n\\]/.test(v.text)) return false;
      i += 2;
      continue;
    }
    if (opt === '-v' || opt === '-P') {
      const v = toks[i + 1];
      if (!word(v) || !/^(ON_ERROR_STOP=[01]|pager=off|footer=off|format=\w+|border=\d|null=\w*)$/.test(v.text)) return false;
      i += 2;
      continue;
    }
    if (opt === '-c') {
      const v = toks[i + 1];
      if (!word(v) || !v.quoted) return false;
      if (!pgopt && !roSet && sqlCount === 0 && RO_SET.test(v.text)) {
        roSet = true;
        i += 2;
        continue;
      }
      if (!isReadOnlySql(v.text)) return false;
      sqlCount++;
      i += 2;
      continue;
    }
    return false;
  }
  if (!sqlCount || !(pgopt || roSet)) return false;
  // 3) 꼬리: 2>&1, | head -N
  if (i < toks.length && 'op' in toks[i] && (toks[i] as { op: string }).op === '2>&1') i++;
  if (i < toks.length) {
    const rest = toks.slice(i);
    const [p, h, ...args] = rest;
    if (!('op' in p) || p.op !== '|' || !word(h) || h.quoted || h.text !== 'head') return false;
    const a = args.map((x) => (word(x) && !x.quoted ? x.text : null));
    const ok = a.length === 0 || (a.length === 1 && /^-\d{1,6}$/.test(a[0] ?? '')) || (a.length === 2 && a[0] === '-n' && /^\d{1,6}$/.test(a[1] ?? ''));
    if (!ok) return false;
  }
  return true;
}

/** 믿는 미션에서 이 외부 연결 호출을 운영 DB 읽기 조회로 바로 허용하는지 */
export function trustedDbRead(mission: MissionConfig, toolName: string, input: Record<string, unknown>): boolean {
  const r = mission.dbRead;
  if (!mission.trustRepo || !r || toolName !== r.tool) return false;
  const app = input[r.appField ?? 'app_name'];
  const cmd = input[r.commandField ?? 'command'];
  if (typeof app !== 'string' || !r.apps.includes(app)) return false;
  // 미션이 아는 입력 말고 다른 값(시간 제한 말고)이 있으면 묻는다
  const known = new Set([r.appField ?? 'app_name', r.commandField ?? 'command', 'timeout_seconds']);
  if (Object.keys(input).some((k) => !known.has(k))) return false;
  return typeof cmd === 'string' && isReadOnlyPsql(cmd);
}

/** 리더·팀원 안내에 넣을 읽기 조회 꼴 설명. dbRead 가 없으면 빈 글 */
export function dbReadGuide(mission: MissionConfig): string {
  const r = mission.dbRead;
  if (!mission.trustRepo || !r) return '';
  return `운영 DB 읽기 조회는 ${r.tool} 도구로, 앱 ${r.apps.join('·')} 에서 아래 꼴로 하면 묻지 않고 바로 된다: PGOPTIONS='-c default_transaction_read_only=on' psql -X -At -F '|' -U "$POSTGRES_USER" -d "\${POSTGRES_DB:-postgres}" -c "SELECT …" (문장마다 -c 하나, 끝에 2>&1 · | head -N 가능). 주석·psql 명령(\\…)·$ 확장·쓰기 낱말(insert·update·set 등)이 섞이면 승인함으로 간다. 다른 꼴(node 스크립트 등)이나 바꾸는 쿼리는 승인함으로 간다.`;
}
