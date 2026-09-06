/**
 * Knee-d Help 自研轻量后端入口
 * Node.js + Express + MySQL（mysql2 连接池），完全自托管
 *
 * 启动：npm start（先执行 server/sql/init.sql 初始化数据库）
 * 环境变量：PORT / DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME / JWT_SECRET / DEV_MODE
 */
const express = require('express');
const corsMiddleware = require('./middleware/cors');
const userRoutes = require('./routes/user');
const therapistRoutes = require('./routes/therapist');
const { testConnection } = require('./config/db');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(corsMiddleware);                       // 跨域（前端可独立部署）
app.use(express.json({ limit: '2mb' }));       // JSON 请求体（不接收任何二进制/视频数据）

// 路由
app.use('/api', userRoutes);
app.use('/api', therapistRoutes);

// 404 统一响应
app.use((req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在：' + req.method + ' ' + req.path, data: null });
});

// 全局错误处理：统一错误返回格式
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err.message);
  res.status(500).json({ code: 500, message: '服务器内部错误：' + (err.message || '未知错误'), data: null });
});

// 启动：先自检数据库连接（失败不退出，方便排查并保持接口可返回错误信息）
testConnection().then(() => {
  app.listen(PORT, () => {
    console.log('Knee-d Help 后端已启动：http://localhost:%d', PORT);
    if (process.env.DEV_MODE === 'true') console.log('[dev] DEV_MODE 已开启：POST /api/tasks/dev-create 可用');
  });
});
