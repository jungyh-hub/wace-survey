# Neon DB 전환 · 관리자 페이지 배포 가이드

응답 저장처를 구글 시트에서 **Neon Postgres**로 옮기고, 응답 열람용 관리자 페이지를 붙였다.

```
[응답자 브라우저]  → POST /api/submit →  [Vercel 서버리스 함수]  →  [Neon Postgres]
     web/index.html                        DATABASE_URL 은 여기만               responses 테이블
                                                  ↑
[관리자 브라우저]  → /admin.html  → /api/admin/*  (세션 쿠키 필요)
```

**핵심 원칙: connection string은 브라우저에 절대 내려가지 않는다.** 정적 페이지가 Postgres에
직접 붙으면 설문 링크를 받은 누구나 DB를 읽고 지울 수 있다. 그래서 서버리스 함수를 사이에 두고,
자격증명은 Vercel 환경변수에만 둔다.

---

## 1. Neon 프로젝트 만들기

1. <https://console.neon.tech> 에서 프로젝트 생성 (리전은 **AWS ap-northeast-1 (Tokyo)** 권장 —
   Vercel 함수와 가까울수록 지연이 줄어든다).
2. 대시보드의 **Connection string** 복사. 형태는 다음과 같다.

   ```
   postgresql://<user>:<password>@ep-xxxx-pooler.ap-northeast-1.aws.neon.tech/neondb?sslmode=require
   ```

   **`-pooler` 가 붙은 pooled 주소를 쓴다.** 서버리스 함수는 요청마다 새로 연결하므로
   풀링 주소가 아니면 연결 수가 금방 바닥난다.

테이블은 직접 만들 필요가 없다. 함수가 첫 요청에서 `CREATE TABLE IF NOT EXISTS` 로 만든다
(스키마 원문은 [`web/db/schema.sql`](web/db/schema.sql)).

---

## 2. Vercel 환경변수 설정

프로젝트 → **Settings → Environment Variables** 에서 아래 3개를 **Production·Preview 모두**에 추가한다.

| 이름 | 값 | 비고 |
|---|---|---|
| `DATABASE_URL` | Neon pooled connection string | |
| `ADMIN_PASSWORD_HASH` | 별도 전달 | 비밀번호 원문이 아니라 scrypt 해시 |
| `SESSION_SECRET` | 별도 전달 | 세션 쿠키 서명 키 |

**세 값 모두 이 문서에 적지 않는다.** 특히 `SESSION_SECRET` 이 유출되면 비밀번호를 몰라도
관리자 세션 쿠키를 위조할 수 있다. 저장소가 Private이어도 접근 권한이 있는 사람 전원에게
노출되므로, 값은 비밀번호 관리자나 Vercel 환경변수에만 둔다.

값을 분실했다면 아래 3절·4절의 생성 명령으로 새로 만들어 교체하면 된다.

선택 항목.

| 이름 | 기본값 | 용도 |
|---|---|---|
| `ADMIN_USER` | `orca-admin` | 관리자 아이디를 바꾸고 싶을 때 |
| `TURNSTILE_SECRET` | (없음) | 캡차를 켤 때. 없으면 허니팟만으로 동작 |

환경변수를 추가한 뒤에는 **재배포해야 반영된다** (Deployments → 최신 배포 → Redeploy).

### Root Directory 확인

Settings → General → **Root Directory 가 `web` 이어야 한다.** 이 값이 비어 있으면
`web/api/` 가 함수로 인식되지 않아 `/api/submit` 이 404가 나고, 저장소의 내부 문서가 공개된다.

---

## 3. 관리자 계정

| 항목 | 값 |
|---|---|
| 주소 | `https://<배포주소>/admin.html` |
| 아이디 | `orca-admin` (환경변수 `ADMIN_USER` 로 변경 가능) |
| 비밀번호 | 별도 전달 — 이 문서에 적지 않는다 |

비밀번호 **원문은 어디에도 저장되어 있지 않다.** 환경변수에 든 것은 scrypt 해시라 역산이 불가능하다.
분실하면 아래 절차로 새로 만들어 교체한다.

```bash
node -e '
const c=require("crypto"), pw=process.argv[1];
const s=c.randomBytes(16), h=c.scryptSync(pw,s,64,{N:65536,r:8,p:1,maxmem:268435456});
console.log("scrypt$65536$8$1$"+s.toString("base64url")+"$"+h.toString("base64url"));
' "새비밀번호"
```

출력값을 `ADMIN_PASSWORD_HASH` 에 넣고 재배포한다.

`SESSION_SECRET` 은 아래로 만든다. 이 값을 바꾸면 이미 발급된 세션이 전부 무효가 되므로,
계정이 샜다고 판단되면 비밀번호와 함께 이 값도 바꾼다.

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'
```

---

## 4. 관리자 페이지로 할 수 있는 것

- 응답 목록 (최신순, 25건씩)
- 회사명 · 담당자 · 이메일 · 연락처 · 업종 · ERP 검색
- 행을 누르면 21개 항목 전체 상세
- 상단 요약 — 전체 / 오늘 접수 / 후속 상담 희망(Q7 긍정 응답)
- 전체 CSV 내려받기 (엑셀에서 바로 열리도록 UTF-8 BOM 포함)

읽기 전용이다. 수정·삭제 기능은 넣지 않았다 — 필요하면 Neon SQL Editor에서 직접 한다.

---

## 5. 방어 장치

| 단계 | 내용 |
|---|---|
| 허니팟 | 사람에게 안 보이는 `website` 필드가 채워지면 조용히 폐기 |
| Turnstile | `TURNSTILE_SECRET` 이 있을 때만 서버측 검증 |
| 유량제한 | 분당 30건 초과 시 `429` — 페이지는 즉시 수동 접수 화면으로 넘어간다 |
| 필드 화이트리스트 | 알려진 20개 키만 취하고 나머지는 버림. 값당 1,000자 상한 |
| SQL 인젝션 | 모든 쿼리가 파라미터 바인딩. 문자열 조립 없음 |
| 중복 제출 | `submission_id UNIQUE` + `ON CONFLICT DO NOTHING` |
| 관리자 인증 | scrypt(N=65536, 검증 1회 ≈ 100ms) + HttpOnly·Secure·SameSite=Strict 쿠키, 8시간 만료 |
| 로그인 시도 | IP당 10분에 10회 |

개인정보 최소화: **응답자 IP 원문은 저장하지 않는다.** 스팸 추적에 필요한 만큼만 HMAC 해시로 남긴다.

---

## 6. 구글 시트는 어떻게 되나

`/api/submit` 으로 전환되면서 Apps Script 웹앱으로는 **더 이상 아무것도 가지 않는다.**
[`응답수집_AppsScript_코드.gs`](응답수집_AppsScript_코드.gs) 와
[`응답수집_배포가이드_2026-08-06.md`](응답수집_배포가이드_2026-08-06.md) 는 참고용으로 남겨 두었다.

전환 전에 이미 시트에 쌓인 응답이 있다면 자동으로 옮겨가지 않는다. 필요하면 시트를 CSV로 내려
Neon SQL Editor에서 `COPY` 로 적재한다.

---

## 7. 문항을 바꿀 때

세 곳을 함께 고쳐야 한다.

1. [`web/index.html`](web/index.html) 의 `collectAnswers()` 반환 키
2. [`web/api/_lib/validate.js`](web/api/_lib/validate.js) 의 `FIELDS` 배열
3. [`web/db/schema.sql`](web/db/schema.sql) 과 [`web/api/_lib/db.js`](web/api/_lib/db.js) 의 컬럼,
   그리고 [`web/api/submit.js`](web/api/submit.js) 의 INSERT 목록

열을 추가할 때는 기존 테이블에 `ALTER TABLE responses ADD COLUMN ... text NOT NULL DEFAULT ''`
를 먼저 적용한다(`CREATE TABLE IF NOT EXISTS` 는 이미 있는 테이블을 고치지 않는다).

CSV 헤더는 [`web/api/admin/export.js`](web/api/admin/export.js), 상세 화면 항목은
[`web/admin.html`](web/admin.html) 의 `DETAIL` 배열에 있다.

---

## 8. 로컬에서 확인하려면

```bash
cd web
npm install
DATABASE_URL='<Neon 주소>' \
ADMIN_PASSWORD_HASH='<위 해시>' \
SESSION_SECRET='<위 시크릿>' \
npx vercel dev
```

`vercel dev` 는 Vercel 로그인이 필요하다. 로그인 없이 확인하고 싶다면 설문 페이지만
정적으로 띄울 수 있으나(`python3 -m http.server`), 이 경우 `/api/*` 가 없어 제출은
수동 접수 화면으로 폴백한다.
