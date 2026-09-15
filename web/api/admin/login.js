import {
  verifyPassword, issueToken, setSessionCookie,
  tooManyAttempts, noteFailure, clearFailures,
} from '../_lib/auth.js';
import { readJson, clientIp } from '../_lib/validate.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  const key = clientIp(req) || 'unknown';
  if (tooManyAttempts(key)) {
    return res.status(429).json({ ok: false, error: '시도가 너무 많습니다. 10분 뒤에 다시 시도해 주세요.' });
  }

  const body = (await readJson(req)) || {};
  const user = String(body.user || '');
  const pass = String(body.password || '');

  const expectedUser = process.env.ADMIN_USER || '';
  const hash = process.env.ADMIN_PASSWORD_HASH || '';

  // 둘 중 하나라도 비어 있으면 로그인을 아예 막는다.
  // 기본 아이디를 두면 환경변수가 빠졌을 때 그 값으로 조용히 되돌아가 버린다.
  if (!expectedUser || !hash) {
    console.error('ADMIN_USER 또는 ADMIN_PASSWORD_HASH 가 설정되지 않았습니다.');
    return res.status(500).json({ ok: false, error: '서버 설정이 끝나지 않았습니다.' });
  }

  // 아이디가 틀렸을 때도 해시 검증을 돌려, 응답 시간으로 아이디 존재 여부가 드러나지 않게 한다.
  const okUser = user === expectedUser;
  const okPass = verifyPassword(pass, hash);

  if (!okUser || !okPass) {
    noteFailure(key);
    return res.status(401).json({ ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  clearFailures(key);
  setSessionCookie(res, issueToken(expectedUser));
  return res.status(200).json({ ok: true, user: expectedUser });
}
