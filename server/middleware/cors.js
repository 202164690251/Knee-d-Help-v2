/**
 * CORS 跨域中间件：允许前端（本地服务器/其他端口/局域网设备）访问本服务。
 * 正式部署后可将 Access-Control-Allow-Origin 收紧为前端实际域名。
 */
module.exports = function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
