/**
 * 설문 응답 수집 엔드포인트.
 *
 * 브라우저는 이 경로만 알면 되고, Neon 자격증명은 서버 환경변수에만 있다.
 * 방어 순서: 허니팟 → Turnstile(선택) → 유량제한 → 필드 화이트리스트 → 중복 차단.
 *
 * 응답 형식은 기존 Apps Script 와 동일하게 유지한다({ok:true} / {ok:false,error}).
 * 설문 페이지의 재시도·폴백 로직을 그대로 쓰기 위해서다.
 */
import { sql, ensureSchema } from './_lib/db.js';
import { pickFields, validSubmissionId, hashIp, clientIp, readJson } from './_lib/validate.js';

/** 전체 제출 유량 상한(분당). 초과분은 재시도해도 결과가 같으므로 페이지가 즉시 수동 접수로 넘어간다. */
const RATE_LIMIT_PER_MIN = 30;

async function turnstileOk(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true; // 시크릿이 없으면 캡차를 쓰지 않는 운영 — 허니팟만으로 동작
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body,
    });
    const j = await r.json();
    return j.success === true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'format' });
  }

  // 허니팟 — 사람에게 보이지 않는 필드. 채워져 있으면 봇이므로 조용히 성공을 반환하고 버린다.
  if (typeof body.website === 'string' && body.website.trim()) {
    return res.status(200).json({ ok: true, discarded: true });
  }

  if (!validSubmissionId(body.submissionId)) {
    return res.status(400).json({ ok: false, error: 'format' });
  }

  const ip = clientIp(req);
  if (!(await turnstileOk(body.turnstileToken, ip))) {
    return res.status(403).json({ ok: false, error: 'captcha' });
  }

  try {
    await ensureSchema();
    const q = sql();

    const f = pickFields(body);

    // 유량 확인과 저장을 한 번의 왕복으로 처리한다.
    // DB가 응답자와 다른 대륙에 있으면 왕복 한 번이 곧 100ms 단위 지연이라,
    // 세던 쿼리와 넣던 쿼리를 CTE 하나로 합쳤다.
    //
    // ON CONFLICT DO NOTHING: 같은 submissionId 가 이미 있으면 아무것도 쓰지 않는다.
    // 페이지는 제출 1건당 ID를 한 번만 발급하고 재시도에도 같은 값을 보내므로,
    // 응답 회수만 실패한 재시도가 행을 두 번 만들지 않는다.
    const [out] = await q`
      WITH rate AS (
        SELECT count(*)::int AS n FROM responses WHERE created_at > now() - interval '1 minute'
      ), ins AS (
        INSERT INTO responses (
          submission_id, company, name, title, phone, email,
          industry, headcount, revenue, erp,
          q1, q2, q3, q4, q5, q6, q6_1, q7, q7_1,
          consent, client_time, user_agent, ip_hash
        )
        SELECT
          ${body.submissionId}, ${f.company}, ${f.name}, ${f.title}, ${f.phone}, ${f.email},
          ${f.industry}, ${f.headcount}, ${f.revenue}, ${f.erp},
          ${f.q1}, ${f.q2}, ${f.q3}, ${f.q4}, ${f.q5}, ${f.q6}, ${f.q6_1}, ${f.q7}, ${f.q7_1},
          ${f.consent}, ${f.clientTime},
          ${String(req.headers['user-agent'] || '').slice(0, 300)},
          ${hashIp(ip, process.env.SESSION_SECRET)}
        FROM rate WHERE rate.n < ${RATE_LIMIT_PER_MIN}
        ON CONFLICT (submission_id) DO NOTHING
        RETURNING id
      )
      SELECT (SELECT n FROM rate) AS n, (SELECT count(*)::int FROM ins) AS inserted`;

    // 유량 상한에 걸린 경우. 재시도해도 결과가 같으므로 페이지가 즉시 수동 접수로 넘어간다.
    if (out.n >= RATE_LIMIT_PER_MIN) {
      return res.status(429).json({ ok: false, error: 'rate' });
    }

    return res.status(200).json({ ok: true, duplicate: out.inserted === 0 });
  } catch (err) {
    console.error('제출 저장 실패:', err);
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
