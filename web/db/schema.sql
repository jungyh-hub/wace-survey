-- 오르카아이티 AI 도입 의향 조사 — 응답 저장 스키마 (Neon Postgres)
--
-- api/_lib/db.js 의 ensureSchema() 가 콜드스타트마다 한 번 이 내용을 그대로 실행하므로
-- 보통은 따로 돌릴 필요가 없다. Neon SQL Editor에서 손으로 만들고 싶을 때만 쓴다.

CREATE TABLE IF NOT EXISTS responses (
  id            bigserial PRIMARY KEY,
  -- 페이지가 제출 1건당 한 번 발급하는 값. 재시도에도 같은 값이 오므로
  -- UNIQUE + ON CONFLICT DO NOTHING 만으로 중복 저장이 원천 차단된다.
  submission_id text        NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),

  company    text NOT NULL DEFAULT '',
  name       text NOT NULL DEFAULT '',
  title      text NOT NULL DEFAULT '',
  phone      text NOT NULL DEFAULT '',
  email      text NOT NULL DEFAULT '',
  industry   text NOT NULL DEFAULT '',
  headcount  text NOT NULL DEFAULT '',
  revenue    text NOT NULL DEFAULT '',
  erp        text NOT NULL DEFAULT '',
  q1         text NOT NULL DEFAULT '',
  q2         text NOT NULL DEFAULT '',
  q3         text NOT NULL DEFAULT '',
  q4         text NOT NULL DEFAULT '',
  q5         text NOT NULL DEFAULT '',
  q6         text NOT NULL DEFAULT '',
  q6_1       text NOT NULL DEFAULT '',
  q7         text NOT NULL DEFAULT '',
  q7_1       text NOT NULL DEFAULT '',
  consent    text NOT NULL DEFAULT '',
  client_time text NOT NULL DEFAULT '',

  -- 운영 흔적. 원문 IP는 저장하지 않고 해시만 남긴다(스팸 추적용, 개인정보 최소수집).
  user_agent text NOT NULL DEFAULT '',
  ip_hash    text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS responses_created_at_idx ON responses (created_at DESC);
