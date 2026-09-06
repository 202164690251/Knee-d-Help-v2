/**
 * Token 生成与校验（jsonwebtoken）
 * - 用户 token 有效期 7 天（兼顾安全与长者使用体验）
 * - 康复师 token 后续启用时带 role 字段区分权限
 * JWT_SECRET 通过环境变量配置，未配置时使用开发默认值（生产环境必须配置）
 */
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'knee-d-dev-secret-change-me';
const USER_EXPIRES = process.env.JWT_EXPIRES || '7d'; // 用户 token 有效期

/** 签发账号 token（payload 含 user_id/nickname；role 由调用方传入：
 *  'user' 康复用户 7 天 / 'therapist' 康复师 12 小时） */
function signUserToken(payload) {
  const role = payload.role === 'therapist' ? 'therapist' : 'user';
  const expiresIn = role === 'therapist' ? '12h' : USER_EXPIRES;
  return jwt.sign({ ...payload, role }, SECRET, { expiresIn });
}

/** 签发康复师 token（兼容旧调用） */
function signTherapistToken(payload) {
  return signUserToken({ ...payload, role: 'therapist' });
}

/** 校验 token：成功返回 payload，失败抛出带 message 的异常 */
function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

/** 从 Authorization: Bearer xxx 请求头中提取 token */
function extractToken(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

module.exports = { signUserToken, signTherapistToken, verifyToken, extractToken, SECRET };
