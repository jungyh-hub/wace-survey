/**
 * 오르카아이티 AI 도입 의향 조사 — 응답 수집 엔드포인트 (Google Apps Script)
 *
 * 역할: 외부에 공개된 설문 HTML 페이지가 보내는 POST를 받아 "설문 기획자 소유의" 구글 시트에 적재한다.
 *
 * 소유권 모델(중요):
 *   웹앱을 반드시 [실행: 나(소유자)] + [액세스 권한: 모든 사용자]로 배포할 것.
 *   이 설정이면 스크립트가 소유자 권한으로 실행되므로, 누가 제출하든 아래 SHEET_ID가 가리키는
 *   '소유자의 시트' 한 곳에만 기록된다. 응답자는 구글 로그인이 불필요하고, 응답자 계정에는
 *   아무 파일도 생기지 않으며, SHEET_ID는 서버측(이 파일)에만 존재해 브라우저에 노출되지 않는다.
 *   [실행: 웹앱에 액세스하는 사용자]로 배포하면 응답자에게 로그인을 요구하게 되므로 반드시 피할 것.
 *
 * 노출되는 값: 웹앱 URL 하나뿐이며 이는 자격증명이 아니다(쓰기 전용·append only).
 *   이 URL로는 기존 응답의 조회·수정·삭제가 불가능하다. 최악의 경우는 스팸 행 유입이며,
 *   허니팟 → Turnstile → 유량제한 3단으로 방어한다.
 */

// ─────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────

/**
 * 응답을 적재할 시트 문서 ID.
 *
 * 시트에서 [확장 프로그램 → Apps Script]로 만든 '바인딩된 스크립트'라면 그대로 두면 된다.
 * 이 경우 자동으로 자신이 속한 시트에 기록하므로 아무것도 고칠 필요가 없다.
 *
 * 독립형 스크립트로 만들었을 때만 아래 값을 실제 시트 ID로 교체한다.
 * (시트 URL의 /d/ 와 /edit 사이 문자열)
 */
const SHEET_ID = '';

/** 시트 문서 안의 탭 이름. 없으면 자동 생성된다. */
const SHEET_NAME = '응답';

/** 값 하나당 최대 길이(초과분은 잘라서 저장). 대용량 페이로드로 시트를 부풀리는 것을 방지. */
const MAX_LEN = 1000;

/** 전체 제출 유량 상한(분당). Apps Script는 요청자 IP를 제공하지 않아 IP별 제한은 불가능하므로 전역 상한만 건다. */
const RATE_LIMIT_PER_MIN = 30;

/**
 * 같은 submissionId를 이 시간(초) 안에 다시 받으면 중복 제출로 보고 저장하지 않는다.
 *
 * 왜 필요한가: Apps Script는 POST 응답을 script.googleusercontent.com의 일회용 URL로 리다이렉트해
 * 돌려주는데, 이 회수 단계가 구글 쪽 사정으로 간헐적으로 실패한다(수십 초 지연 후 404).
 * 그 시점에 doPost는 이미 끝나 시트 저장까지 마친 상태라, 페이지가 그냥 재시도하면 같은 응답이
 * 두 줄 쌓인다. 페이지는 제출 1건당 submissionId를 한 번만 발급하고 재시도에도 같은 값을 보내므로,
 * 여기서 그 값을 기억해 두 번째부터는 저장을 건너뛴다.
 */
const DEDUPE_TTL_SEC = 600;

/**
 * 시트 열 정의. key는 HTML 페이지가 보내는 JSON 필드명과 1:1로 일치해야 한다.
 * 순서를 바꾸면 시트 열 순서도 바뀐다. 열을 추가할 때는 HTML의 collectAnswers()에도 같은 key를 추가할 것.
 */
const COLUMNS = [
  { key: 'company',    header: '회사명' },
  { key: 'name',       header: '담당자' },
  { key: 'title',      header: '직책' },
  { key: 'phone',      header: '연락처' },
  { key: 'email',      header: '이메일' },
  { key: 'industry',   header: '업종' },
  { key: 'headcount',  header: '종업원 수' },
  { key: 'revenue',    header: '연매출 규모' },
  { key: 'erp',        header: '사용 ERP' },
  { key: 'q1',         header: 'Q1 ERP 활용도' },
  { key: 'q2',         header: 'Q2 AI 관심도' },
  { key: 'q3',         header: 'Q3 도입 시기' },
  { key: 'q4',         header: 'Q4 우선 도입 분야' },
  { key: 'q5',         header: 'Q5 기대 효과' },
  { key: 'q6',         header: 'Q6 정부지원사업 참여의향' },
  { key: 'q6_1',       header: 'Q6-1 과거 지원사업 경험' },
  { key: 'q7',         header: 'Q7 공동신청 의향' },
  { key: 'q7_1',       header: 'Q7-1 희망 미팅시기' },
  { key: 'consent',    header: '개인정보 동의' },
  { key: 'clientTime', header: '제출시각(응답자 기준)' },
];

// ─────────────────────────────────────────────────────────────
// 엔트리포인트
// ─────────────────────────────────────────────────────────────

/** 배포 확인용. 브라우저로 웹앱 URL을 열었을 때 살아있는지 보기 위한 것으로, 응답 데이터는 일절 반환하지 않는다. */
function doGet() {
  return json({ ok: true, service: 'orca-survey-collector' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty' });
    }

    var d;
    try {
      d = JSON.parse(e.postData.contents);
    } catch (err) {
      return json({ ok: false, error: 'badjson' });
    }

    // 1단계 — 허니팟. 사람에게는 보이지 않는 필드라 값이 있으면 자동화 봇이다.
    //         봇에게 차단 사실을 알리지 않도록 성공으로 응답하고 조용히 폐기한다.
    if (d.website) return json({ ok: true });

    // 2단계 — 전역 유량 제한
    if (!withinRateLimit()) return json({ ok: false, error: 'rate' });

    // 3단계 — Turnstile 검증 (스크립트 속성에 TURNSTILE_SECRET 이 없으면 생략)
    if (!verifyTurnstile(d.turnstileToken)) return json({ ok: false, error: 'captcha' });

    // duplicate=true 면 재시도로 다시 들어온 같은 제출이라 저장을 건너뛴 것이다(정상 처리).
    var duplicate = appendRow(d);
    return json({ ok: true, duplicate: duplicate });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: 'server' });
  }
}

// ─────────────────────────────────────────────────────────────
// 적재
// ─────────────────────────────────────────────────────────────

/**
 * 응답 한 건을 시트에 적재한다.
 * @return {boolean} 이미 저장된 제출이라 건너뛰었으면 true.
 */
function appendRow(d) {
  // 동시 제출 시 같은 행에 겹쳐 쓰는 것을 방지.
  // 중복 판정과 저장이 이 락 안에서 함께 일어나야, 재시도 두 건이 동시에 도착해도 한 번만 저장된다.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var key = dedupeKey(d.submissionId);
    var cache = CacheService.getScriptCache();
    if (key && cache.get(key)) return true;

    var sheet = getSheet();
    var row = [new Date()];
    for (var i = 0; i < COLUMNS.length; i++) {
      row.push(clean(d[COLUMNS[i].key]));
    }
    sheet.appendRow(row);

    // 저장이 끝난 뒤에 기록한다. 저장이 실패하면 키가 남지 않아 재시도가 정상적으로 다시 저장한다.
    if (key) cache.put(key, '1', DEDUPE_TTL_SEC);
    return false;
  } finally {
    lock.releaseLock();
  }
}

/**
 * submissionId를 캐시 키로 변환한다.
 * 외부 입력이므로 형식을 제한하고, 없거나 어긋나면 빈 값을 돌려 중복 판정을 생략한다
 * (중복 차단은 편의 기능이므로, 판정을 못 하더라도 저장 자체는 막지 않는다).
 */
function dedupeKey(id) {
  if (!id) return '';
  var s = String(id);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(s)) return '';
  return 'sub_' + s;
}

/** 정의된 열만 화이트리스트로 통과시키고, 문자열화 + 길이 제한 + 수식 인젝션 무력화까지 처리한다. */
function clean(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN) + '…(생략)';
  // 시트 수식 인젝션(=, +, -, @ 로 시작하는 값) 방지 — 앞에 어포스트로피를 붙여 텍스트로 고정
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

/**
 * 적재 대상 스프레드시트를 반환한다.
 * SHEET_ID가 비어 있으면 이 스크립트가 바인딩된 시트를 쓴다(바인딩 스크립트에서는 웹앱 실행 중에도 유효).
 */
function getSpreadsheet() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('SHEET_ID를 설정하거나, 시트의 [확장 프로그램 → Apps Script]로 만든 스크립트를 사용하십시오.');
}

function getSheet() {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    var headers = ['접수시각'];
    for (var i = 0; i < COLUMNS.length; i++) headers.push(COLUMNS[i].header);
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1e6d2');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ─────────────────────────────────────────────────────────────
// 방어
// ─────────────────────────────────────────────────────────────

function withinRateLimit() {
  var cache = CacheService.getScriptCache();
  var key = 'rate_' + Math.floor(new Date().getTime() / 60000); // 분 단위 버킷
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 120);
  return n <= RATE_LIMIT_PER_MIN;
}

/**
 * Cloudflare Turnstile 서버측 검증.
 * 시크릿 키는 [프로젝트 설정 → 스크립트 속성]에 TURNSTILE_SECRET 으로 저장한다(코드·페이지에 넣지 말 것).
 * 속성이 없으면 검증을 생략하므로, 캡차 없이 허니팟만으로 먼저 운영을 시작했다가 나중에 켤 수 있다.
 */
function verifyTurnstile(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) return true;
  if (!token) return false;

  try {
    var res = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post',
      payload: { secret: secret, response: token },
      muteHttpExceptions: true,
    });
    return JSON.parse(res.getContentText()).success === true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 에디터에서 직접 실행해 배포 전 점검. 시트에 테스트 행이 1건 들어간다(확인 후 삭제할 것). */
function 설치테스트() {
  var sample = { company: '테스트회사', name: '홍길동', clientTime: '수동 테스트' };
  appendRow(sample);
  Logger.log('시트 적재 성공 — 시트를 열어 테스트 행을 확인한 뒤 삭제하십시오.');
}
