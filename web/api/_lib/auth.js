/**
 * 관리자 인증 — 외부 라이브러리 없이 Node 기본 crypto 만 쓴다.
 *
 * 비밀번호 원문은 어디에도 저장하지 않는다. 환경변수에는 scrypt 해시만 둔다.
 * 세션은 서버가 HMAC으로 서명한 쿠키 하나이며, 위조하려면 SESSION_SECRET 이 필요하다.
 */
import crypto from 'node:crypto';

const COOKIE = 'wace_admin';
const SESSION_TTL_SEC = 60 * 60 * 8; // 8시간

/** "scrypt$N$r$p$salt$hash" 형식을 검증한다. 타이밍 공격을 피해 상수시간으로 비교한다. */
export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  let expected;
  try {
    expected = Buffer.from(hashB64, 'base64url');
  } catch {
    return false;
  }
  const salt = Buffer.from(saltB64, 'base64url');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
      // 기본 maxmem(32MB)은 N=16384 에서 부족하다.
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET 이 설정되지 않았습니다.');
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** 토큰 = "user.만료시각.서명" */
export function issueToken(user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = `${Buffer.from(String(user)).toString('base64url')}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2] || '', 'base64url');
  const want = Buffer.from(sign(payload), 'base64url');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  if (Number(parts[1]) < Math.floor(Date.now() / 1000)) return null;
  return Buffer.from(parts[0], 'base64url').toString('utf8');
}

export function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const piece of raw.split(';')) {
    const i = piece.indexOf('=');
    if (i < 0) continue;
    out[piece.slice(0, i).trim()] = decodeURIComponent(piece.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, token) {
  // HttpOnly: 스크립트가 못 읽는다 / Secure: HTTPS 전용 / SameSite=Strict: CSRF 차단
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SEC}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

/** 로그인된 관리자 이름을 돌려준다. 아니면 null. */
export function currentUser(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

/** 보호된 핸들러 앞에 세운다. 통과하지 못하면 401을 쓰고 false를 돌려준다. */
export function requireAdmin(req, res) {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  return user;
}

/**
 * 로그인 시도 제한. 서버리스는 인스턴스가 여러 개라 완벽하지 않지만,
 * scrypt 자체가 느려(시도당 ~100ms) 대량 대입은 이것만으로도 실효성이 떨어진다.
 */
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function tooManyAttempts(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW_MS) return false;
  return rec.count >= MAX_ATTEMPTS;
}

export function noteFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW_MS) attempts.set(key, { first: now, count: 1 });
  else rec.count += 1;
  if (attempts.size > 500) attempts.clear(); // 메모리 상한
}

export function clearFailures(key) {
  attempts.delete(key);
}
