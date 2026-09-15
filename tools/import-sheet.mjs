/**
 * 구글 시트에 쌓여 있던 기존 응답을 Neon DB로 옮긴다. (일회성 이관 도구)
 *
 *   DATABASE_URL='postgres://...' node tools/import-sheet.mjs <파일.xlsx|.csv> [--dry-run] [--keep-tests]
 *
 * 여러 번 돌려도 안전하다. 행 내용으로 결정적 ID를 만들어 submission_id 에 넣으므로
 * 같은 파일을 다시 넣어도 UNIQUE 제약에 걸려 건너뛴다.
 *
 * 자격증명은 저장소에 적지 않는다. 실행할 때 환경변수로만 넘긴다.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { neon } from '../web/node_modules/@neondatabase/serverless/index.mjs';

// ── 시트 헤더 → DB 컬럼 ─────────────────────────────────────────────
const HEADER_TO_COLUMN = {
  '접수시각': '_received',            // 시트가 기록한 서버 시각(엑셀 일련값)
  '회사명': 'company',
  '담당자': 'name',
  '직책': 'title',
  '연락처': 'phone',
  '이메일': 'email',
  '업종': 'industry',
  '종업원 수': 'headcount',
  '연매출 규모': 'revenue',
  '사용 ERP': 'erp',
  'Q1 ERP 활용도': 'q1',
  'Q2 AI 관심도': 'q2',
  'Q3 도입 시기': 'q3',
  'Q4 우선 도입 분야': 'q4',
  'Q5 기대 효과': 'q5',
  'Q6 정부지원사업 참여의향': 'q6',
  'Q6-1 과거 지원사업 경험': 'q6_1',
  'Q7 공동신청 의향': 'q7',
  'Q7-1 희망 미팅시기': 'q7_1',
  '개인정보 동의': 'consent',
  '제출시각(응답자 기준)': 'client_time',
};

const DB_COLUMNS = [
  'company', 'name', 'title', 'phone', 'email', 'industry', 'headcount', 'revenue', 'erp',
  'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q6_1', 'q7', 'q7_1', 'consent', 'client_time',
];

// ── 파일 읽기 ───────────────────────────────────────────────────────
const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

/** xlsx 는 XML 묶음 zip 이다. 의존성 없이 필요한 두 파일만 꺼내 읽는다. */
function readXlsx(path) {
  const read = (entry) => execFileSync('unzip', ['-p', path, entry], { maxBuffer: 64 << 20 }).toString('utf8');

  let shared = [];
  try {
    const xml = read('xl/sharedStrings.xml');
    shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(''));
  } catch { /* 공유 문자열이 없는 파일도 있다 */ }

  const colIndex = (ref) => {
    const letters = ref.match(/^[A-Z]+/)[0];
    let n = 0;
    for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
    return n - 1;
  };

  // '응답' 탭을 고른다. 없으면 행이 가장 많은 탭.
  const wb = read('xl/workbook.xml');
  const names = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  // unzip 은 인자를 glob 으로 해석한다 — [Content_Types].xml 의 대괄호가 와일드카드가 되므로
  // 목록은 -Z1(항목 나열)로 얻는다.
  const entries = execFileSync('unzip', ['-Z1', path], { maxBuffer: 16 << 20 }).toString('utf8').split('\n');
  const files = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((e) => e.replace(/^xl\//, ''));

  const sheets = files.map((f, i) => {
    const xml = read('xl/' + f);
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const cells = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
        const idx = colIndex(c[1]);
        const type = (c[2].match(/t="([^"]*)"/) || [])[1];
        const v = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const inline = (c[3].match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        cells[idx] = inline !== undefined ? decodeXml(inline)
          : type === 's' ? (shared[Number(v)] ?? '')
          : v === undefined ? '' : decodeXml(v);
      }
      return cells;
    });
    return { name: names[i] || f, rows };
  });

  const picked = sheets.find((s) => s.name === '응답') ||
    sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  return picked.rows;
}

/** RFC 4180 CSV 파서 — 따옴표 안의 쉼표·줄바꿈·이중따옴표 처리. */
function readCsv(path) {
  let text = fs.readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── 값 손질 ─────────────────────────────────────────────────────────
/** 시트 저장 시 붙인 수식 인젝션 방어용 어포스트로피를 되돌린다. */
const unescapeSheet = (v) => {
  const s = String(v ?? '').trim();
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
};

/** 엑셀은 "01012345678" 같은 값을 수로 바꿔 1.0E9 로 내보낸다. 사람이 읽는 형태로 되돌린다. */
function fixNumericText(s) {
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  const digits = String(Math.round(n));
  if (digits.length === 10 && digits.startsWith('1')) return '0' + digits.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1-$2-$3');
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
  return digits;
}

/**
 * 엑셀 일련값(1899-12-30 기준 경과일) → Date
 *
 * 일련값에는 시간대가 없다. 시트가 기록한 값은 시트 시간대(KST)의 벽시계 시각이므로,
 * UTC로 환산한 뒤 로컬 오프셋만큼 되돌려 같은 벽시계 시각이 되게 맞춘다.
 * (이 보정을 빼면 한국에서 읽을 때 9시간 뒤로 밀린다.)
 */
function fromExcelSerial(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  const asUtc = new Date(Math.round((n - 25569) * 86400 * 1000));
  return new Date(asUtc.getTime() + asUtc.getTimezoneOffset() * 60000);
}

/** "2026. 8. 6. 오후 5:19:18" → Date */
function fromKoreanDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  let h = Number(m[5]);
  if (m[4] === '오후' && h < 12) h += 12;
  if (m[4] === '오전' && h === 12) h = 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[6]), Number(m[7] || 0));
  return isNaN(d) ? null : d;
}

// ── 테스트 행 판별 ──────────────────────────────────────────────────
/**
 * "너무 자명한" 것만 거른다. 애매하면 남긴다 — 실제 고객 응답을 잘못 버리는 쪽이
 * 테스트 행 하나를 남기는 쪽보다 훨씬 나쁘다.
 */
function testReason(r) {
  const c = r.company || '', n = r.name || '', e = r.email || '', ct = r.client_time || '';
  if (/삭제요망|^__.*__$/.test(c)) return '개발용 표식 (__…__ / 삭제요망)';
  if (/^curl\d*$/i.test(n)) return 'curl 로 보낸 연결 확인';
  if (/^(엔드포인트 검증|수동 테스트|연결 검증)$/.test(ct)) return '검증용 수동 입력';
  if (/^테스트/.test(c) || /^테스트$/.test(n)) return '회사명·담당자가 "테스트"';
  if (e === 'test@wace.me') return '내부 테스트 계정 이메일';
  // 자음·모음만 두드린 값 (ㅁㅈㄷㄹ 등)
  if (/^[ㄱ-ㆎ]+$/.test(c) || /^[ㄱ-ㆎ]+$/.test(n)) return '한글 자모 난타';
  // awef, agag, agagag 류 — 회사·담당자·직책이 모두 같은 짧은 영문
  if (/^[a-z]{3,8}$/.test(c) && c.slice(0, 3) === String(n).slice(0, 3) && !/@/.test(e)) return '영문 난타';
  return null;
}

// ── 실행 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const keepTests = args.includes('--keep-tests');

if (!file) {
  console.error('사용법: DATABASE_URL=... node tools/import-sheet.mjs <파일.xlsx|.csv> [--dry-run] [--keep-tests]');
  process.exit(1);
}
if (!dryRun && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다. 먼저 --dry-run 으로 분류를 확인하세요.');
  process.exit(1);
}

const raw = file.endsWith('.csv') ? readCsv(file) : readXlsx(file);
const nonEmpty = raw.filter((r) => r.some((v) => String(v ?? '').trim()));
if (!nonEmpty.length) { console.error('빈 파일입니다.'); process.exit(1); }

const header = nonEmpty[0].map((h) => String(h ?? '').trim());
const unknown = header.filter((h) => h && !HEADER_TO_COLUMN[h]);
const missing = Object.keys(HEADER_TO_COLUMN).filter((h) => !header.includes(h));

console.log(`파일      : ${file}`);
console.log(`데이터 행 : ${nonEmpty.length - 1}`);
if (unknown.length) console.log(`무시할 열 : ${unknown.join(', ')}`);
if (missing.length) console.log(`빠진 열   : ${missing.join(', ')} (빈 값으로 채움)`);

const records = nonEmpty.slice(1).map((row, i) => {
  const rec = Object.fromEntries(DB_COLUMNS.map((c) => [c, '']));
  let received = null;
  header.forEach((h, idx) => {
    const col = HEADER_TO_COLUMN[h];
    if (!col) return;
    const val = fixNumericText(unescapeSheet(row[idx]));
    if (col === '_received') received = fromExcelSerial(row[idx]);
    else rec[col] = val;
  });
  rec._line = i + 1;
  // 접수시각(서버 기준)을 우선 쓰고, 없으면 응답자 기준 시각을 쓴다.
  rec.created_at = received || fromKoreanDate(rec.client_time);
  rec.submission_id = 'sheet-' + crypto.createHash('sha256')
    .update(DB_COLUMNS.map((c) => rec[c]).join(' ')).digest('hex').slice(0, 32);
  rec._test = testReason(rec);
  return rec;
});

const tests = records.filter((r) => r._test);
const keep = keepTests ? records : records.filter((r) => !r._test);

console.log(`\n── 걸러낸 행 ${tests.length}건 ──`);
for (const r of tests) {
  console.log(`  ${String(r._line).padStart(3)}  ${(r.company || '(비어있음)').slice(0, 22).padEnd(24)} ${r._test}`);
}
console.log(`\n── 남긴 행 ${keep.length}건 ──`);
for (const r of keep) {
  const when = r.created_at ? r.created_at.toLocaleString('ko-KR') : '시각없음';
  console.log(`  ${String(r._line).padStart(3)}  ${(r.company || '?').slice(0, 14).padEnd(16)} ${(r.name || '?').padEnd(8)} ${(r.phone || '-').padEnd(15)} ${(r.email || '-').padEnd(22)} ${when}`);
}

if (dryRun) {
  console.log('\n--dry-run 이므로 아무것도 쓰지 않았습니다.');
  process.exit(0);
}

const q = neon(process.env.DATABASE_URL);
let inserted = 0, skipped = 0;

for (const r of keep) {
  const out = await q`
    INSERT INTO responses (
      submission_id, created_at, company, name, title, phone, email,
      industry, headcount, revenue, erp,
      q1, q2, q3, q4, q5, q6, q6_1, q7, q7_1,
      consent, client_time, user_agent, ip_hash
    ) VALUES (
      ${r.submission_id}, ${(r.created_at || new Date()).toISOString()},
      ${r.company}, ${r.name}, ${r.title}, ${r.phone}, ${r.email},
      ${r.industry}, ${r.headcount}, ${r.revenue}, ${r.erp},
      ${r.q1}, ${r.q2}, ${r.q3}, ${r.q4}, ${r.q5}, ${r.q6}, ${r.q6_1}, ${r.q7}, ${r.q7_1},
      ${r.consent}, ${r.client_time}, ${'구글시트 이관'}, ${''}
    )
    ON CONFLICT (submission_id) DO NOTHING
    RETURNING id`;
  if (out.length) inserted++; else skipped++;
}

const [{ n }] = await q`SELECT count(*)::int AS n FROM responses`;
console.log(`\n저장      : ${inserted}건`);
console.log(`이미 있음 : ${skipped}건`);
console.log(`전체 행   : ${n}건`);
