/**
 * 密码哈希与校验：bcrypt（bcryptjs 纯 JS 实现，跨平台免编译）
 * 绝对禁止明文存储密码
 */
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

/** 密码哈希 */
async function hashPassword(plain) {
  return bcrypt.hash(String(plain), SALT_ROUNDS);
}

/** 校验明文密码与哈希是否匹配 */
async function verifyPassword(plain, hash) {
  try {
    return await bcrypt.compare(String(plain), String(hash));
  } catch (e) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
