/**
 * 数据库连接配置（mysql2 连接池）
 * 全部参数可通过环境变量覆盖，便于不同环境部署：
 *   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 */
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'knee_d',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
});

/** 启动时连接自检：失败不退出进程，接口返回统一 500 错误并打印排查指引 */
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log('[db] MySQL 连接成功（%s/%s）', process.env.DB_NAME || 'knee_d', process.env.DB_HOST || '127.0.0.1');
    return true;
  } catch (e) {
    console.error('[db] MySQL 连接失败：', e.message);
    console.error('[db] 排查步骤：');
    console.error('     1) 确认 MySQL 已启动，且已执行 server/sql/init.sql 初始化');
    console.error('     2) 设置环境变量：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME');
    console.error('     3) 示例：DB_PASSWORD=123456 npm start');
    return false;
  }
}

module.exports = { pool, testConnection };
