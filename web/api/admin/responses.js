/** 응답 열람 — 검색·페이지 나눔·요약 통계. 로그인 없이는 아무것도 돌려주지 않는다. */
import { sql, ensureSchema } from '../_lib/db.js';
import { requireAdmin } from '../_lib/auth.js';

const PAGE_SIZE = 25;

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    await ensureSchema();
    const q = sql();

    const url = new URL(req.url, 'http://localhost');
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    // 검색어는 파라미터로만 넘긴다(문자열 조립 없음) → SQL 인젝션 여지가 없다.
    const term = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const like = `%${term}%`;
    const offset = (page - 1) * PAGE_SIZE;

    // 목록·건수·요약을 한 번의 왕복으로 가져온다.
    // Neon HTTP 드라이버는 요청을 직렬화하므로 Promise.all 로 묶어도 왕복이 겹치지 않는다
    // (실측: 순차 672ms / 병렬 623ms). DB가 다른 대륙에 있을 때는 이 차이가 크다.
    const [out] = await q`
      WITH filtered AS (
        SELECT * FROM responses
        WHERE ${term}::text = ''
           OR company ILIKE ${like} OR name ILIKE ${like} OR email ILIKE ${like}
           OR phone ILIKE ${like} OR industry ILIKE ${like} OR erp ILIKE ${like}
      ), page AS (
        SELECT * FROM filtered ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}
      )
      SELECT
        (SELECT count(*)::int FROM filtered) AS total,
        COALESCE((SELECT json_agg(p ORDER BY p.created_at DESC) FROM page p), '[]'::json) AS rows,
        (SELECT json_build_object(
           'all_count',   count(*)::int,
           'today_count', count(*) FILTER (WHERE created_at > date_trunc('day', now()))::int,
           'lead_count',  count(*) FILTER (WHERE q7 LIKE '예,%' OR q7 LIKE '관심은 있으나%')::int
         ) FROM responses) AS stats`;

    const { total, rows, stats } = out;

    return res.status(200).json({
      ok: true,
      rows,
      total,
      page,
      pageSize: PAGE_SIZE,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      stats,
    });
  } catch (err) {
    console.error('응답 조회 실패:', err);
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
