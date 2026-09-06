/**
 * 参数校验工具：所有接口做基础校验，防止非法写入
 */

/** 校验昵称：2-20 字符，允许中文/字母/数字/下划线 */
function isValidNickname(v) {
  return typeof v === 'string' && /^[一-龥A-Za-z0-9_]{2,20}$/.test(v.trim());
}

/** 校验密码：4-64 位非空字符 */
function isValidPassword(v) {
  return typeof v === 'string' && v.length >= 4 && v.length <= 64;
}

/** 校验用户ID：6-32 位字母数字下划线短横线 */
function isValidUserId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{6,32}$/.test(v);
}

/** 校验记录/任务/事件ID：4-64 位安全字符 */
function isValidId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v);
}

/** 校验训练类型：1 或 2 */
function isValidTrainingType(v) {
  return v === 1 || v === 2;
}

/** 校验非负整数（含上限） */
function isNonNegInt(v, max) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && (max == null || v <= max);
}

/** 校验日期时间字符串（YYYY-MM-DD HH:mm:ss 或 ISO 可被 MySQL 解析） */
function isValidDateTime(v) {
  return typeof v === 'string' && !isNaN(Date.parse(v));
}

module.exports = {
  isValidNickname, isValidPassword, isValidUserId, isValidId,
  isValidTrainingType, isNonNegInt, isValidDateTime,
};
