// 관리자 페이지가 새로고침될 때 로그인 상태를 확인하는 용도.
import { currentUser } from '../_lib/auth.js';

export default function handler(req, res) {
  const user = currentUser(req);
  return res.status(200).json({ ok: !!user, user: user || null });
}
