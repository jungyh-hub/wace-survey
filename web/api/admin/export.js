/** 전체 응답 CSV 내려받기. 엑셀에서 바로 열 수 있도록 UTF-8 BOM을 붙인다. */
import { sql, ensureSchema } from '../_lib/db.js';
import { requireAdmin } from '../_lib/auth.js';

const COLUMNS = [
  ['created_at', '접수시각'],
  ['company', '회사명'],
  ['name', '담당자'],
  ['title', '직책'],
  ['phone', '연락처'],
  ['email', '이메일'],
  ['industry', '업종'],
  ['headcount', '종업원 수'],
  ['revenue', '연매출 규모'],
  ['erp', '사용 ERP'],
  ['q1', 'Q1 ERP 활용도'],
  ['q2', 'Q2 AI 관심도'],
  ['q3', 'Q3 도입 시기'],
  ['q4', 'Q4 우선 도입 분야'],
  ['q5', 'Q5 기대 효과'],
  ['q6', 'Q6 정부지원사업 참여의향'],
  ['q6_1', 'Q6-1 과거 지원사업 경험'],
  ['q7', 'Q7 공동신청 의향'],
  ['q7_1', 'Q7-1 희망 미팅시기'],
  ['consent', '개인정보 동의'],
  ['client_time', '제출시각(응답자 기준)'],
];

/**
 * CSV 한 칸을 감싼다.
 * 엑셀은 =, +, -, @ 로 시작하는 값을 수식으로 해석한다 → 앞에 작은따옴표를 붙여 텍스트로 고정한다.
 */
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`SELECT * FROM responses ORDER BY created_at DESC`;

    const lines = [COLUMNS.map(([, h]) => cell(h)).join(',')];
    for (const r of rows) {
      lines.push(COLUMNS.map(([k]) => {
        const v = r[k];
        return cell(k === 'created_at' && v ? new Date(v).toLocaleString('ko-KR') : v);
      }).join(','));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    // HTTP 헤더는 ASCII만 담을 수 있다. 한글 파일명은 filename* 에 퍼센트 인코딩으로 넣고,
    // 이를 모르는 옛 클라이언트를 위해 filename 에는 ASCII 이름을 남긴다(RFC 6266).
    const asciiName = `survey-responses_${stamp}.csv`;
    const utf8Name = encodeURIComponent(`AI도입의향조사_${stamp}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
    // BOM — 없으면 엑셀이 한글을 깨뜨린다.
    return res.status(200).send('﻿' + lines.join('\r\n'));
  } catch (err) {
    console.error('CSV 내보내기 실패:', err);
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
