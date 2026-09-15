// 페이지가 보내는 값을 그대로 믿지 않는다 — 필드 화이트리스트 + 길이 상한.
import crypto from 'node:crypto';

/**
 * responses 테이블의 텍스트 컬럼. 이 목록에 없는 키는 전부 버린다.
 * 설문 페이지 collectAnswers() 의 반환 키와 1:1로 일치해야 한다(문항을 바꿀 때 함께 고칠 것).
 */
export const FIELDS = [
  'company', 'name', 'title', 'phone', 'email',
  'industry', 'headcount', 'revenue', 'erp',
  'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q6_1', 'q7', 'q7_1',
  'consent', 'clientTime',
];

/** 값 하나당 최대 길이. 대용량 페이로드로 테이블을 부풀리는 것을 막는다. */
const MAX_LEN = 1000;

/** 제어문자(줄바꿈·탭 제외)를 걸러낸다. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

export function clean(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).replace(CONTROL_CHARS, '').trim();
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN) + '…(생략)';
  return s;
}

/** 페이로드에서 알려진 필드만 뽑아 정제한다. */
export function pickFields(body) {
  const out = {};
  for (const k of FIELDS) out[k] = clean(body[k]);
  return out;
}

/** submissionId 형식 제한 — UUID 또는 페이지의 폴백 형식(sid-xxx)만 받는다. */
export function validSubmissionId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
}

/** 원문 IP는 저장하지 않는다. 스팸 추적에 필요한 만큼만 해시로 남긴다. */
export function hashIp(ip, secret) {
  if (!ip) return '';
  return crypto.createHmac('sha256', secret || 'wace').update(ip).digest('base64url').slice(0, 22);
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || '';
}

/**
 * 요청 본문을 JSON으로 읽는다.
 * 설문 페이지는 CORS 프리플라이트를 피하려고 text/plain 으로 보내므로
 * Vercel이 자동 파싱해 주지 않을 수 있다 → 직접 읽는 경로를 둔다.
 */
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) return null; // 64KB 상한
    chunks.push(c);
  }
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
