/**
 * Token 鉴权中间件：校验 Authorization: Bearer <token>
 * - auth：任意已登录账号（康复用户 / 康复师）
 * - therapistAuth：仅康复师（users.role=2）
 * 通过后 req.user = { user_id, nickname, role }
 */
const { verifyToken, extractToken } = require('../utils/jwt');

function checkToken(req, res) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ code: 401, message: '未登录或登录已过期', data: null });
    return null;
  }
  try {
    return verifyToken(token);
  } catch (e) {
    res.status(401).json({ code: 401, message: '登录凭证无效，请重新登录', data: null });
    return null;
  }
}

/** 任意登录账号 */
module.exports = function authMiddleware(req, res, next) {
  const payload = checkToken(req, res);
  if (!payload) return;
  req.user = { user_id: payload.user_id, nickname: payload.nickname, role: payload.role || 'user' };
  next();
};

/** 仅康复师（v14 康复师端） */
module.exports.therapistAuth = function therapistAuth(req, res, next) {
  const payload = checkToken(req, res);
  if (!payload) return;
  if (payload.role !== 'therapist') {
    return res.status(403).json({ code: 403, message: '权限不足：需要康复师账号', data: null });
  }
  req.user = { user_id: payload.user_id, nickname: payload.nickname, role: 'therapist' };
  next();
};
