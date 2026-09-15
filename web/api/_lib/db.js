// Neon 연결. 자격증명(DATABASE_URL)은 Vercel 환경변수에만 존재하며 브라우저로 나가지 않는다.
import { neon } from '@neondatabase/serverless';

let _sql = null;

export function sql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  _sql = neon(url);
  return _sql;
}

// 콜드스타트마다 한 번만 실행한다. CREATE ... IF NOT EXISTS 라 몇 번 돌아도 무해하다.
let schemaReady = null;

export function ensureSchema() {
  if (schemaReady) return schemaReady;
  const q = sql();
  schemaReady = (async () => {
    await q`
      CREATE TABLE IF NOT EXISTS responses (
        id            bigserial PRIMARY KEY,
        submission_id text        NOT NULL UNIQUE,
        created_at    timestamptz NOT NULL DEFAULT now(),
        company text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '',
        title text NOT NULL DEFAULT '',   phone text NOT NULL DEFAULT '',
        email text NOT NULL DEFAULT '',   industry text NOT NULL DEFAULT '',
        headcount text NOT NULL DEFAULT '', revenue text NOT NULL DEFAULT '',
        erp text NOT NULL DEFAULT '',
        q1 text NOT NULL DEFAULT '', q2 text NOT NULL DEFAULT '', q3 text NOT NULL DEFAULT '',
        q4 text NOT NULL DEFAULT '', q5 text NOT NULL DEFAULT '', q6 text NOT NULL DEFAULT '',
        q6_1 text NOT NULL DEFAULT '', q7 text NOT NULL DEFAULT '', q7_1 text NOT NULL DEFAULT '',
        consent text NOT NULL DEFAULT '', client_time text NOT NULL DEFAULT '',
        user_agent text NOT NULL DEFAULT '', ip_hash text NOT NULL DEFAULT ''
      )`;
    await q`CREATE INDEX IF NOT EXISTS responses_created_at_idx ON responses (created_at DESC)`;
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
