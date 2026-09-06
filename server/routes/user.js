/**
 * 用户端全部接口实现（/api/user /api/training /api/tasks /api/fall /api/sync /api/settings /api/community）
 * - 统一响应格式：{ code: 200, message: 'success', data: {...} }
 * - 全部写接口做参数校验；训练记录/事件/任务上报按 ID 幂等（重复上报不重复插入）
 * - 隐私优先：仅接收结构化业务字段，接口不接受任何视频/图像二进制数据
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../config/db');
const auth = require('../middleware/auth');
const { signUserToken } = require('../utils/jwt');
const { hashPassword, verifyPassword } = require('../utils/password');
const V = require('../utils/validate');

const router = express.Router();

const ok = (res, data, message) => res.json({ code: 200, message: message || 'success', data });
const fail = (res, code, message) => res.status(code >= 500 ? code : 200).json({ code, message, data: null });

/** 生成 32 位内的随机 ID（crypto 安全随机） */
function genId(prefix) {
  return (prefix || '') + crypto.randomBytes(8).toString('hex'); // 前缀 + 16 位 hex
}

/** 读取用户信息 + 配置（内部共用） */
async function loadUserProfile(userId) {
  const [users] = await pool.query(
    'SELECT user_id, nickname, name, role, phone, avatar, birth_year, knee_condition, create_time, last_login_time, status FROM users WHERE user_id = ?', [userId]);
  if (!users.length) return null;
  const [settings] = await pool.query('SELECT * FROM user_settings WHERE user_id = ?', [userId]);
  return { ...users[0], settings: settings[0] || null };
}

/* ══════════════ 账号相关 ══════════════ */

/**
 * POST /api/user/register
 * 入参：nickname, password, client_user_id（可选：本地 uid 升级云端时保持一致）
 *      role（可选 'user'|'therapist'，默认 user，v14 康复师注册）、name（可选显示名称）、phone（可选电话）
 * 返回：{ token, user_id, nickname, role, settings }
 */
router.post('/user/register', async (req, res, next) => {
  try {
    const { nickname, password } = req.body || {};
    const clientId = (req.body && req.body.client_user_id) || null;
    const role = (req.body && req.body.role) === 'therapist' ? 2 : 1;
    const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim().slice(0, 50) : '';
    const phone = (req.body && typeof req.body.phone === 'string') ? req.body.phone.trim().slice(0, 20) : '';
    if (!V.isValidNickname(nickname)) return fail(res, 400, '昵称需为 2-20 位中文、字母、数字或下划线');
    if (!V.isValidPassword(password)) return fail(res, 400, '密码需为 4-64 位');
    if (role === 2 && (!/^\d{6,15}$/.test(phone))) return fail(res, 400, '康复师注册需填写正确的电话号码');
    if (clientId && !V.isValidUserId(clientId)) return fail(res, 400, '客户端用户ID格式不合法');
    const nick = nickname.trim();
    const [dup] = await pool.query('SELECT user_id FROM users WHERE nickname = ?', [nick]);
    if (dup.length) return fail(res, 409, '该昵称已注册，请直接登录');
    const userId = clientId || genId('u');
    const [dupId] = await pool.query('SELECT user_id FROM users WHERE user_id = ?', [userId]);
    if (dupId.length) return fail(res, 409, '客户端用户ID已存在');
    const hash = await hashPassword(password);
    await pool.query(
      'INSERT INTO users (user_id, nickname, name, role, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, nick, name || nick, role, phone || null, hash]);
    if (role === 1) { // 康复用户初始化默认配置（康复师无需用户端配置）
      await pool.query(
        'INSERT INTO user_settings (user_id, interface_lang, voice_lang, voice_broadcast, fall_detect_enabled, alert_delay, sensitivity) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, 'cn', 'zh-HK', 1, 1, 5, 'mid']);
    }
    const profile = await loadUserProfile(userId);
    const token = signUserToken({ user_id: userId, nickname: nick, role: role === 2 ? 'therapist' : 'user' });
    ok(res, { token, user_id: userId, nickname: nick, role: role === 2 ? 'therapist' : 'user', name: name || nick, phone, user: profile, settings: profile.settings }, '注册成功');
  } catch (e) { next(e); }
});

/**
 * POST /api/user/login
 * 入参：nickname, password
 * 返回：{ token, user_id, nickname, role, settings }（role='therapist' 时前端进入康复师工作台）
 */
router.post('/user/login', async (req, res, next) => {
  try {
    const { nickname, password } = req.body || {};
    if (!V.isValidNickname(nickname) || !V.isValidPassword(password)) return fail(res, 400, '请输入正确的昵称和密码');
    const [rows] = await pool.query(
      'SELECT user_id, nickname, name, role, phone, password_hash, status FROM users WHERE nickname = ?', [nickname.trim()]);
    if (!rows.length) return fail(res, 404, '账号不存在，请先注册');
    const u = rows[0];
    if (u.status !== 1) return fail(res, 403, '账号已被停用');
    const pass = await verifyPassword(password, u.password_hash);
    if (!pass) return fail(res, 401, '密码错误，请重试');
    await pool.query('UPDATE users SET last_login_time = NOW() WHERE user_id = ?', [u.user_id]);
    const profile = await loadUserProfile(u.user_id);
    const isTp = u.role === 2;
    const token = signUserToken({ user_id: u.user_id, nickname: u.nickname, role: isTp ? 'therapist' : 'user' });
    ok(res, { token, user_id: u.user_id, nickname: u.nickname, role: isTp ? 'therapist' : 'user', name: u.name || u.nickname, phone: u.phone, user: profile, settings: profile.settings }, '登录成功');
  } catch (e) { next(e); }
});

/** GET /api/user/info（鉴权）：当前用户信息与配置 */
router.get('/user/info', auth, async (req, res, next) => {
  try {
    const profile = await loadUserProfile(req.user.user_id);
    if (!profile) return fail(res, 404, '用户不存在');
    ok(res, { user: profile, settings: profile.settings });
  } catch (e) { next(e); }
});

/* ══════════════ 训练记录相关 ══════════════ */

/** 校验并规范化训练记录字段（非法返回 null） */
function sanitizeRecord(r) {
  if (!r || !V.isValidId(r.record_id)) return null;
  if (!V.isValidTrainingType(r.training_type)) return null;
  if (!V.isNonNegInt(r.total_count, 100000) || !V.isNonNegInt(r.standard_count, 100000)) return null;
  const rate = typeof r.standard_rate === 'number' ? r.standard_rate : null;
  if (rate != null && (rate < 0 || rate > 100)) return null;
  const dur = V.isNonNegInt(r.duration, 86400) ? r.duration : 0;
  const t = r.training_time ? (V.isValidDateTime(r.training_time) ? new Date(r.training_time) : null) : null;
  return {
    record_id: r.record_id,
    training_type: r.training_type,
    total_count: r.total_count,
    standard_count: r.standard_count,
    standard_rate: rate,
    duration: dur,
    avg_knee_angle: (typeof r.avg_knee_angle === 'number' && r.avg_knee_angle >= 0 && r.avg_knee_angle <= 200) ? r.avg_knee_angle : null,
    training_time: t || new Date(),
    device_info: typeof r.device_info === 'string' ? r.device_info.slice(0, 255) : null,
    task_id: (r.task_id && V.isValidId(r.task_id)) ? r.task_id : null, // v14：关联任务（update-progress 服务端回写）
    task_completed: r.task_completed === 1 ? 1 : 0,
  };
}

/**
 * POST /api/training/upload（鉴权）
 * 入参：单条训练记录完整字段；幂等：record_id 已存在则不重复插入
 */
router.post('/training/upload', auth, async (req, res, next) => {
  try {
    const rec = sanitizeRecord(req.body || {});
    if (!rec) return fail(res, 400, '训练记录字段不合法');
    const [r] = await pool.query(
      'INSERT IGNORE INTO training_records (record_id, user_id, training_type, total_count, standard_count, standard_rate, duration, avg_knee_angle, training_time, device_info, task_id, task_completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [rec.record_id, req.user.user_id, rec.training_type, rec.total_count, rec.standard_count, rec.standard_rate, rec.duration, rec.avg_knee_angle, rec.training_time, rec.device_info, rec.task_id, rec.task_completed]);
    ok(res, { inserted: r.affectedRows > 0, record_id: rec.record_id });
  } catch (e) { next(e); }
});

/**
 * POST /api/training/batch-upload（鉴权）
 * 入参：{ records: [记录...] }；首次登录同步本地历史时使用；逐条幂等
 */
router.post('/training/batch-upload', auth, async (req, res, next) => {
  try {
    const list = (req.body && req.body.records) || [];
    if (!Array.isArray(list) || !list.length || list.length > 500) return fail(res, 400, '记录列表不合法（1-500 条）');
    let success = 0;
    for (const item of list) {
      const rec = sanitizeRecord(item);
      if (!rec) continue;
      const [r] = await pool.query(
        'INSERT IGNORE INTO training_records (record_id, user_id, training_type, total_count, standard_count, standard_rate, duration, avg_knee_angle, training_time, device_info, task_id, task_completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [rec.record_id, req.user.user_id, rec.training_type, rec.total_count, rec.standard_count, rec.standard_rate, rec.duration, rec.avg_knee_angle, rec.training_time, rec.device_info, rec.task_id, rec.task_completed]);
      if (r.affectedRows > 0) success++;
    }
    ok(res, { success, total: list.length });
  } catch (e) { next(e); }
});

/** GET /api/training/list（鉴权）：分页记录列表，按时间倒序 */
router.get('/training/list', auth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const type = parseInt(req.query.training_type, 10);
    const where = 'WHERE user_id = ?' + (type === 1 || type === 2 ? ' AND training_type = ?' : '');
    const args = [req.user.user_id];
    if (type === 1 || type === 2) args.push(type);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM training_records ${where}`, args);
    const [rows] = await pool.query(
      `SELECT record_id, training_type, total_count, standard_count, standard_rate, duration, avg_knee_angle, training_time, device_info, task_id, task_completed
       FROM training_records ${where} ORDER BY training_time DESC LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize]);
    ok(res, { list: rows, total, page, pageSize });
  } catch (e) { next(e); }
});

/* ══════════════ 训练任务相关（v13 新增） ══════════════ */

/** 惰性过期：把 deadline 已过的未完成/未开始任务置为「已过期」，保证列表与进度统计准确 */
async function expireTasks(userId, conn) {
  await (conn || pool).query(
    'UPDATE training_tasks SET status = 3 WHERE user_id = ? AND status IN (0, 1) AND deadline IS NOT NULL AND deadline < NOW()',
    [userId]);
}

/** GET /api/tasks/list 与 GET /api/tasks（鉴权，v14 角色感知）：
 *  - 康复用户：被分配的任务（含个人进度/完成时间/完成记录）+ v13 单人直挂任务
 *  - 康复师：自己发布的任务（含已完成/已分配人数与小组名） */
async function handleTasksList(req, res, next) {
  try {
    const isTp = req.user.role === 'therapist';
    if (isTp) {
      const [rows] = await pool.query(
        `SELECT t.*, g.name AS group_name,
                (SELECT COUNT(*) FROM user_tasks ut WHERE ut.task_id = t.task_id AND ut.status = 1) AS done_count,
                (SELECT COUNT(*) FROM user_tasks ut WHERE ut.task_id = t.task_id) AS total_count
         FROM training_tasks t LEFT JOIN therapist_groups g ON g.group_id = t.group_id
         WHERE t.therapist_id = ? ORDER BY t.create_time DESC`,
        [req.user.user_id]);
      return ok(res, { list: rows });
    }
    await expireTasks(req.user.user_id);
    // 分配任务（user_tasks）＋ v13 单人直挂任务（无分配行）
    const [rows] = await pool.query(
      `SELECT t.task_id, t.title, t.sets, t.time_text, t.training_type, t.target_count, t.deadline,
              t.remark, t.create_time, t.update_time, t.group_id, g.name AS group_name,
              th.name AS therapist_name,
              ut.completed_count, ut.status AS user_status, ut.note, ut.completed_at, ut.completed_record_id,
              t.status AS task_status
       FROM training_tasks t
       LEFT JOIN user_tasks ut ON ut.task_id = t.task_id AND ut.user_id = ?
       LEFT JOIN therapist_groups g ON g.group_id = t.group_id
       LEFT JOIN users th ON th.user_id = t.therapist_id
       WHERE ut.user_id = ? OR (t.user_id = ? AND ut.task_id IS NULL)
       ORDER BY FIELD(COALESCE(ut.status, t.status), 0, 1, 2, 3), t.create_time DESC`,
      [req.user.user_id, req.user.user_id, req.user.user_id]);
    return ok(res, { list: rows });
  } catch (e) { next(e); }
}
router.get('/tasks/list', auth, handleTasksList);
router.get('/tasks', auth, handleTasksList);

/** GET /api/tasks/:id/detail（康复师）：任务详情 + 每位被分配成员的完成情况 */
router.get('/tasks/:id/detail', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'therapist') return fail(res, 403, '仅康复师可以查看任务详情');
    const taskId = req.params.id;
    if (!V.isValidId(taskId)) return fail(res, 400, '任务ID不合法');
    const [[task]] = await pool.query(
      `SELECT t.*, g.name AS group_name FROM training_tasks t LEFT JOIN therapist_groups g ON g.group_id = t.group_id WHERE t.task_id = ?`,
      [taskId]);
    if (!task) return fail(res, 404, '任务不存在');
    const [members] = await pool.query(
      `SELECT u.user_id, u.nickname, u.name, ut.status, ut.completed_count, ut.note, ut.completed_at, ut.completed_record_id
       FROM user_tasks ut JOIN users u ON u.user_id = ut.user_id
       WHERE ut.task_id = ? ORDER BY ut.status ASC, u.nickname ASC`,
      [taskId]);
    ok(res, { task, members });
  } catch (e) { next(e); }
});

/**
 * POST /api/tasks（康复师）：发布训练任务
 * 入参：{ group_id?, title, training_type, target_count, sets?, time_text?, remark?, user_ids?[], deadline? }
 * 分配规则：指定 user_ids（须为小组成员）→ 只发给勾选成员；未指定 → 发给全组。
 */
router.post('/tasks', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'therapist') return fail(res, 403, '仅康复师可以发布任务');
    const b = req.body || {};
    const groupId = b.group_id || null;
    const title = typeof b.title === 'string' ? b.title.trim().slice(0, 100) : '';
    if (!title) return fail(res, 400, '请填写训练动作');
    if (!V.isValidTrainingType(b.training_type)) return fail(res, 400, '训练类型不合法');
    if (!V.isNonNegInt(b.target_count, 10000) || b.target_count < 1) return fail(res, 400, '目标达标次数需为正整数');
    if (groupId && !V.isValidId(groupId)) return fail(res, 400, '小组ID不合法');
    const deadline = b.deadline && V.isValidDateTime(b.deadline) ? new Date(b.deadline) : null;
    let targets = [];
    if (groupId) {
      const [[g]] = await pool.query('SELECT group_id FROM therapist_groups WHERE group_id = ? AND therapist_id = ?', [groupId, req.user.user_id]);
      if (!g) return fail(res, 404, '小组不存在');
      const [members] = await pool.query('SELECT user_id FROM group_members WHERE group_id = ?', [groupId]);
      const allIds = members.map(m => m.user_id);
      const picked = Array.isArray(b.user_ids) ? b.user_ids.filter(x => typeof x === 'string') : [];
      targets = picked.length ? allIds.filter(id => picked.includes(id)) : allIds;
      if (!targets.length) return fail(res, 400, '该小组暂无成员');
    } else {
      if (!b.user_ids || !Array.isArray(b.user_ids) || !b.user_ids.length) return fail(res, 400, '单人任务需指定用户');
      const uid = b.user_ids[0];
      if (!V.isValidUserId(uid)) return fail(res, 400, '用户ID不合法');
      const [[u]] = await pool.query('SELECT user_id FROM users WHERE user_id = ? AND role = 1', [uid]);
      if (!u) return fail(res, 404, '用户不存在');
      targets = [uid];
    }
    const taskId = genId('t');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO training_tasks (task_id, therapist_id, group_id, title, sets, time_text, training_type, target_count, deadline, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [taskId, req.user.user_id, groupId, title,
         typeof b.sets === 'string' ? b.sets.slice(0, 50) : null,
         typeof b.time_text === 'string' ? b.time_text.slice(0, 50) : null,
         b.training_type, b.target_count, deadline,
         typeof b.remark === 'string' ? b.remark.slice(0, 255) : null]);
      for (const uid of targets) {
        await conn.query('INSERT IGNORE INTO user_tasks (task_id, user_id, status, completed_count) VALUES (?, ?, 0, 0)', [taskId, uid]);
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      throw e;
    } finally { conn.release(); }
    const [[task]] = await pool.query(
      `SELECT t.*, g.name AS group_name FROM training_tasks t LEFT JOIN therapist_groups g ON g.group_id = t.group_id WHERE t.task_id = ?`,
      [taskId]);
    ok(res, { task, assigned: targets.length }, '训练任务已发布');
  } catch (e) { next(e); }
});

/** POST /api/tasks/:id/complete（用户）：手动标记任务完成（兜底；训练自动达标由 update-progress 处理） */
router.post('/tasks/:id/complete', auth, async (req, res, next) => {
  try {
    const taskId = req.params.id;
    if (!V.isValidId(taskId)) return fail(res, 400, '任务ID不合法');
    const [r] = await pool.query(
      'UPDATE user_tasks SET status = 1, completed_at = COALESCE(completed_at, NOW()), completed_count = GREATEST(completed_count, (SELECT target_count FROM training_tasks WHERE task_id = ?)) WHERE task_id = ? AND user_id = ?',
      [taskId, taskId, req.user.user_id]);
    if (!r.affectedRows) {
      // v13 直挂任务兜底
      const [r2] = await pool.query('UPDATE training_tasks SET status = 2 WHERE task_id = ? AND user_id = ?', [taskId, req.user.user_id]);
      if (!r2.affectedRows) return fail(res, 404, '任务不存在');
    }
    ok(res, { done: true }, '已标记完成');
  } catch (e) { next(e); }
});

/** PATCH /api/tasks/:id/note（用户）：填写任务备注（向康复师反馈） */
router.patch('/tasks/:id/note', auth, async (req, res, next) => {
  try {
    const taskId = req.params.id;
    if (!V.isValidId(taskId)) return fail(res, 400, '任务ID不合法');
    const note = typeof (req.body || {}).note === 'string' ? req.body.note.slice(0, 255) : '';
    const [r] = await pool.query('UPDATE user_tasks SET note = ? WHERE task_id = ? AND user_id = ?', [note || null, taskId, req.user.user_id]);
    if (!r.affectedRows) return fail(res, 404, '任务不存在');
    ok(res, { note: note || null });
  } catch (e) { next(e); }
});

/* ══════════════ 康复师小组（v14） ══════════════ */

/** GET /api/users/search（康复师）：按昵称/名称搜索康复用户（邀请用） */
router.get('/users/search', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'therapist') return fail(res, 403, '仅康复师可以搜索用户');
    const q = (req.query.q || '').toString().trim();
    const rows = q
      ? (await pool.query(
          "SELECT user_id, nickname, name, phone, avatar FROM users WHERE role = 1 AND (name LIKE ? OR nickname LIKE ?) ORDER BY name LIMIT 20",
          ['%' + q + '%', '%' + q + '%']))[0]
      : (await pool.query('SELECT user_id, nickname, name, phone, avatar FROM users WHERE role = 1 ORDER BY name LIMIT 20'))[0];
    ok(res, { users: rows });
  } catch (e) { next(e); }
});

/** GET /api/groups（康复师）：我的小组列表（含成员数） */
router.get('/groups', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'therapist') return fail(res, 403, '仅康复师可以管理小组');
    const [rows] = await pool.query(
      `SELECT g.group_id, g.name, g.create_time,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.group_id) AS member_count
       FROM therapist_groups g WHERE g.therapist_id = ? ORDER BY g.create_time DESC`,
      [req.user.user_id]);
    ok(res, { groups: rows });
  } catch (e) { next(e); }
});

/** POST /api/groups（康复师）：新建小组 */
router.post('/groups', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'therapist') return fail(res, 403, '仅康复师可以管理小组');
    const name = ((req.body || {}).name || '').toString().trim();
    if (!name || name.length > 50) return fail(res, 400, '请填写小组名称（50 字以内）');
    const gid = genId('g');
    await pool.query('INSERT INTO therapist_groups (group_id, name, therapist_id) VALUES (?, ?, ?)', [gid, name, req.user.user_id]);
    const [[g]] = await pool.query('SELECT group_id, name FROM therapist_groups WHERE group_id = ?', [gid]);
    ok(res, { group: g }, '小组已创建');
  } catch (e) { next(e); }
});

/** GET /api/groups/:id/members（康复师）：小组成员（含最近任务完成情况与备注） */
router.get('/groups/:id/members', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'therapist') return fail(res, 403, '仅康复师可以查看小组');
    const gid = req.params.id;
    const [[g]] = await pool.query('SELECT group_id FROM therapist_groups WHERE group_id = ? AND therapist_id = ?', [gid, req.user.user_id]);
    if (!g) return fail(res, 404, '小组不存在');
    const [rows] = await pool.query(
      `SELECT u.user_id, u.nickname, u.name, u.phone, u.avatar, gm.joined,
              (SELECT ut.status FROM user_tasks ut JOIN training_tasks t ON t.task_id = ut.task_id
               WHERE ut.user_id = u.user_id AND t.group_id = ? ORDER BY t.create_time DESC LIMIT 1) AS user_status,
              (SELECT ut.note FROM user_tasks ut JOIN training_tasks t ON t.task_id = ut.task_id
               WHERE ut.user_id = u.user_id AND t.group_id = ? ORDER BY t.create_time DESC LIMIT 1) AS note,
              (SELECT ut.completed_at FROM user_tasks ut JOIN training_tasks t ON t.task_id = ut.task_id
               WHERE ut.user_id = u.user_id AND t.group_id = ? ORDER BY t.create_time DESC LIMIT 1) AS completed_at
       FROM group_members gm JOIN users u ON u.user_id = gm.user_id
       WHERE gm.group_id = ? ORDER BY gm.joined DESC`,
      [gid, gid, gid, gid]);
    ok(res, { members: rows });
  } catch (e) { next(e); }
});

/** POST /api/groups/:id/invite（康复师）：邀请用户加入小组 */
router.post('/groups/:id/invite', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'therapist') return fail(res, 403, '仅康复师可以管理小组');
    const gid = req.params.id;
    const uid = (req.body || {}).user_id;
    if (!V.isValidUserId(uid)) return fail(res, 400, '用户ID不合法');
    const [[g]] = await pool.query('SELECT group_id FROM therapist_groups WHERE group_id = ? AND therapist_id = ?', [gid, req.user.user_id]);
    if (!g) return fail(res, 404, '小组不存在');
    const [[u]] = await pool.query('SELECT user_id FROM users WHERE user_id = ? AND role = 1', [uid]);
    if (!u) return fail(res, 404, '用户不存在');
    const [[dup]] = await pool.query('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', [gid, uid]);
    if (dup) return fail(res, 409, '该用户已在小组中');
    await pool.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [gid, uid]);
    ok(res, {}, '邀请已发送，用户已加入小组');
  } catch (e) { next(e); }
});

/** DELETE /api/groups/:id/members/:uid（康复师）：移除成员 */
router.delete('/groups/:id/members/:uid', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'therapist') return fail(res, 403, '仅康复师可以管理小组');
    const { id: gid, uid } = req.params;
    const [[g]] = await pool.query('SELECT group_id FROM therapist_groups WHERE group_id = ? AND therapist_id = ?', [gid, req.user.user_id]);
    if (!g) return fail(res, 404, '小组不存在');
    await pool.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [gid, uid]);
    ok(res, {}, '已移除成员');
  } catch (e) { next(e); }
});

/** GET /api/my_groups（用户）：我所在的小组 */
router.get('/my_groups', auth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT g.group_id, g.name, g.create_time, th.name AS therapist_name,
              (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.group_id) AS member_count
       FROM group_members gm JOIN therapist_groups g ON g.group_id = gm.group_id
       LEFT JOIN users th ON th.user_id = g.therapist_id
       WHERE gm.user_id = ? ORDER BY gm.joined DESC`,
      [req.user.user_id]);
    ok(res, { groups: rows });
  } catch (e) { next(e); }
});

/**
 * POST /api/tasks/update-progress（鉴权）
 * 入参：{ training_type, standard_count, record_id? }
 * 核心逻辑（事务，v14 分配制）：
 *   1) 惰性过期；2) 在该用户「被分配的任务」（user_tasks）中匹配「待完成、对应类型、未过期」
 *      按截止时间最早优先累加达标次数；
 *   3) 达到目标 → user_tasks 置已完成 + 记录 completed_at/completed_record_id，
 *      并回写训练记录 task_id/task_completed（训练记录页与康复师端可见）；
 *   4) 同步训练任务整体状态与 update_time。
 * 兼容 v13：无分配行时回退匹配单人归属任务（user_id 直挂）。
 * 边界：已过期不再累加；已完成任务不再重复更新；无匹配任务返回 matched=false。
 */
router.post('/tasks/update-progress', auth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { training_type, standard_count } = req.body || {};
    const recordId = (req.body && req.body.record_id) || null;
    if (!V.isValidTrainingType(training_type)) return fail(res, 400, '训练类型不合法');
    if (!V.isNonNegInt(standard_count, 10000)) return fail(res, 400, '达标次数不合法');
    if (recordId && !V.isValidId(recordId)) return fail(res, 400, '关联记录ID不合法');
    await conn.beginTransaction();
    await expireTasks(req.user.user_id, conn);
    // 被分配任务（user_tasks JOIN training_tasks），待完成且未过期，按截止时间最早
    let [rows] = await conn.query(
      `SELECT t.*, ut.completed_count AS my_count, ut.status AS my_status
       FROM user_tasks ut JOIN training_tasks t ON t.task_id = ut.task_id
       WHERE ut.user_id = ? AND t.training_type = ? AND ut.status = 0
         AND (t.deadline IS NULL OR t.deadline >= NOW())
       ORDER BY (t.deadline IS NULL) ASC, t.deadline ASC, t.create_time DESC LIMIT 1`,
      [req.user.user_id, training_type]);
    let assignment = rows[0] || null;
    let activated = false;
    if (!assignment) {
      // v13 兼容：单人直挂任务
      [rows] = await conn.query(
        `SELECT t.*, 0 AS my_count, 0 AS my_status FROM training_tasks t
         WHERE t.user_id = ? AND t.training_type = ? AND t.status IN (0, 1) AND (t.deadline IS NULL OR t.deadline >= NOW())
         ORDER BY (t.deadline IS NULL) ASC, t.deadline ASC, t.create_time DESC LIMIT 1`,
        [req.user.user_id, training_type]);
      if (rows.length) {
        assignment = { ...rows[0] };
        // 补齐分配行（把旧直挂任务迁移为分配制）
        await conn.query('INSERT IGNORE INTO user_tasks (task_id, user_id, status, completed_count) VALUES (?, ?, ?, ?)',
          [assignment.task_id, req.user.user_id, 0, 0]);
        if (assignment.status === 0) activated = true;
      }
    }
    if (!assignment) {
      await conn.rollback();
      return ok(res, { matched: false, task: null, reached: false, activated: false }, '没有匹配的任务');
    }
    const task = assignment;
    const newCount = (task.my_count || 0) + standard_count;
    const reached = newCount >= task.target_count;
    await conn.query(
      `UPDATE user_tasks SET completed_count = ?, status = ?, completed_at = ?, completed_record_id = ?, note = NULL
       WHERE task_id = ? AND user_id = ?`,
      [newCount, reached ? 1 : 0, reached ? new Date() : null, reached ? recordId : null,
       task.task_id, req.user.user_id]);
    // 训练记录回写任务关联（训练记录页展示「完成康复师任务」）
    if (recordId) {
      await conn.query('UPDATE training_records SET task_id = ?, task_completed = ? WHERE record_id = ? AND user_id = ?',
        [task.task_id, reached ? 1 : 0, recordId, req.user.user_id]);
    }
    // 整体状态同步
    const [[{ doneCnt }]] = await conn.query(
      'SELECT COUNT(*) AS doneCnt FROM user_tasks WHERE task_id = ? AND status = 1', [task.task_id]);
    const [[{ totalCnt }]] = await conn.query(
      'SELECT COUNT(*) AS totalCnt FROM user_tasks WHERE task_id = ?', [task.task_id]);
    const aggStatus = totalCnt > 0 ? (doneCnt >= totalCnt ? 2 : 1) : (reached ? 2 : 1);
    await conn.query('UPDATE training_tasks SET completed_count = ?, status = ?, update_time = NOW() WHERE task_id = ?',
      [doneCnt, aggStatus, task.task_id]);
    await conn.commit();
    const [[updated]] = await pool.query(
      `SELECT t.*, ut.completed_count AS my_count, ut.status AS my_status, ut.completed_at, ut.completed_record_id
       FROM training_tasks t LEFT JOIN user_tasks ut ON ut.task_id = t.task_id AND ut.user_id = ? WHERE t.task_id = ?`,
      [req.user.user_id, task.task_id]);
    ok(res, { matched: true, task: updated, reached, activated, hint: reached ? '任务已完成' : '任务进度已更新' });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    next(e);
  } finally {
    conn.release();
  }
});

/* ══════════════ 跌倒事件相关 ══════════════ */

/**
 * POST /api/fall/upload（鉴权）
 * 入参：{ event_id, event_time, trigger_type, is_canceled, is_alert_sent, contact_name, remark }
 * 幂等：event_id 重复不重复插入（仅结构化摘要，绝不上传画面/帧数据）
 */
router.post('/fall/upload', auth, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!V.isValidId(b.event_id)) return fail(res, 400, '事件ID不合法');
    if (![1, 2].includes(b.trigger_type)) return fail(res, 400, '触发类型不合法');
    const t = V.isValidDateTime(b.event_time) ? new Date(b.event_time) : null;
    if (!t) return fail(res, 400, '事件时间不合法');
    const [r] = await pool.query(
      'INSERT IGNORE INTO fall_events (event_id, user_id, event_time, trigger_type, is_canceled, is_alert_sent, contact_name, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [b.event_id, req.user.user_id, t, b.trigger_type, b.is_canceled ? 1 : 0, b.is_alert_sent ? 1 : 0,
       typeof b.contact_name === 'string' ? b.contact_name.slice(0, 50) : null,
       typeof b.remark === 'string' ? b.remark.slice(0, 255) : null]);
    ok(res, { inserted: r.affectedRows > 0, event_id: b.event_id });
  } catch (e) { next(e); }
});

/** GET /api/fall/list（鉴权）：跌倒事件列表（最多 50 条，时间倒序） */
router.get('/fall/list', auth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT event_id, event_time, trigger_type, is_canceled, is_alert_sent, contact_name, remark FROM fall_events WHERE user_id = ? ORDER BY event_time DESC LIMIT 50',
      [req.user.user_id]);
    ok(res, { list: rows });
  } catch (e) { next(e); }
});

/* ══════════════ 配置与同步相关 ══════════════ */

/** GET /api/sync/pull（鉴权）：拉取配置 + 最近10条训练记录 + 任务（分配制）+ 小组 + 联系人 */
router.get('/sync/pull', auth, async (req, res, next) => {
  try {
    const profile = await loadUserProfile(req.user.user_id);
    await expireTasks(req.user.user_id);
    const [records] = await pool.query(
      'SELECT record_id, training_type, total_count, standard_count, standard_rate, duration, training_time, task_id, task_completed FROM training_records WHERE user_id = ? ORDER BY training_time DESC LIMIT 10',
      [req.user.user_id]);
    const [tasks] = await pool.query(
      `SELECT t.task_id, t.title, t.sets, t.time_text, t.training_type, t.target_count, t.deadline, t.remark,
              t.group_id, g.name AS group_name, th.name AS therapist_name,
              ut.completed_count, ut.status AS user_status, ut.note, ut.completed_at, ut.completed_record_id,
              t.status AS task_status
       FROM training_tasks t
       LEFT JOIN user_tasks ut ON ut.task_id = t.task_id AND ut.user_id = ?
       LEFT JOIN therapist_groups g ON g.group_id = t.group_id
       LEFT JOIN users th ON th.user_id = t.therapist_id
       WHERE ut.user_id = ? OR (t.user_id = ? AND ut.task_id IS NULL)
       ORDER BY FIELD(COALESCE(ut.status, t.status), 0, 1, 2, 3), t.create_time DESC`,
      [req.user.user_id, req.user.user_id, req.user.user_id]);
    const [groups] = await pool.query(
      `SELECT g.group_id, g.name, g.create_time, th.name AS therapist_name,
              (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.group_id) AS member_count
       FROM group_members gm JOIN therapist_groups g ON g.group_id = gm.group_id
       LEFT JOIN users th ON th.user_id = g.therapist_id
       WHERE gm.user_id = ? ORDER BY gm.joined DESC`,
      [req.user.user_id]);
    const [contacts] = await pool.query(
      'SELECT name, phone, relation, is_default FROM emergency_contacts WHERE user_id = ? ORDER BY is_default DESC, id ASC',
      [req.user.user_id]);
    ok(res, { settings: profile.settings, recent_records: records, tasks, groups, contacts });
  } catch (e) { next(e); }
});

/**
 * POST /api/settings/update（鉴权）
 * 入参：配置字段（可选任意子集）+ emergency_contact { name, phone }（可选，写入默认联系人）
 */
router.post('/settings/update', auth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = [];
    const args = [];
    const allow = { // 白名单字段 → 校验函数
      interface_lang: v => ['cn', 'tc', 'en'].includes(v),
      voice_lang: v => ['zh-CN', 'zh-HK', 'en-US'].includes(v),
      voice_broadcast: v => v === 0 || v === 1,
      fall_detect_enabled: v => v === 0 || v === 1,
      alert_delay: v => [3, 5, 8, 10].includes(v),
      sensitivity: v => ['low', 'mid', 'high'].includes(v),
    };
    for (const [k, chk] of Object.entries(allow)) {
      if (b[k] === undefined) continue;
      if (!chk(b[k])) return fail(res, 400, `配置字段 ${k} 不合法`);
      fields.push(`${k} = ?`);
      args.push(b[k]);
    }
    if (fields.length) {
      args.push(req.user.user_id);
      await pool.query(`UPDATE user_settings SET ${fields.join(', ')} WHERE user_id = ?`, args);
    }
    // 紧急联系人：默认联系人 upsert（is_default=1）
    const ec = b.emergency_contact;
    if (ec && typeof ec === 'object' && typeof ec.name === 'string' && typeof ec.phone === 'string') {
      const name = ec.name.trim().slice(0, 50);
      const phone = ec.phone.trim().slice(0, 20);
      if (name && phone) {
        await pool.query(
          `INSERT INTO emergency_contacts (user_id, name, phone, relation, is_default)
           VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone)`,
          [req.user.user_id, name, phone, typeof ec.relation === 'string' ? ec.relation.slice(0, 20) : null]);
      }
    }
    const [rows] = await pool.query('SELECT * FROM user_settings WHERE user_id = ?', [req.user.user_id]);
    ok(res, { settings: rows[0] || null });
  } catch (e) { next(e); }
});

/* ══════════════ 社群相关 ══════════════ */

/**
 * POST /api/community/post（鉴权）
 * 入参：{ post_id, content, image_urls?, voice_duration? }
 * 注：前端本地图片为 base64 且体积大，仅上传文字与语音时长摘要（隐私优先）
 */
router.post('/community/post', auth, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!V.isValidId(b.post_id)) return fail(res, 400, '动态ID不合法');
    const content = typeof b.content === 'string' ? b.content.trim().slice(0, 2000) : '';
    const voice = V.isNonNegInt(b.voice_duration, 600) ? b.voice_duration : 0;
    if (!content && !voice) return fail(res, 400, '动态内容不能为空');
    const [r] = await pool.query(
      'INSERT IGNORE INTO community_posts (post_id, user_id, content, image_urls, voice_duration) VALUES (?, ?, ?, ?, ?)',
      [b.post_id, req.user.user_id, content || null,
       typeof b.image_urls === 'string' ? b.image_urls.slice(0, 2000) : null, voice]);
    const [[post]] = await pool.query('SELECT * FROM community_posts WHERE post_id = ?', [b.post_id]);
    ok(res, { inserted: r.affectedRows > 0, post });
  } catch (e) { next(e); }
});

/** GET /api/community/list（鉴权）：社群动态分页列表（含发布者昵称） */
router.get('/community/list', auth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM community_posts');
    const [rows] = await pool.query(
      `SELECT p.post_id, p.user_id, u.nickname, p.content, p.image_urls, p.voice_duration, p.like_count, p.comment_count, p.create_time
       FROM community_posts p LEFT JOIN users u ON u.user_id = p.user_id
       ORDER BY p.create_time DESC LIMIT ? OFFSET ?`,
      [pageSize, (page - 1) * pageSize]);
    ok(res, { list: rows, total, page, pageSize });
  } catch (e) { next(e); }
});

/* ══════════════ 开发辅助（仅 DEV_MODE=true 时启用） ══════════════ */
/**
 * POST /api/tasks/dev-create：本地联调时手动创建测试任务（生产环境关闭）
 * 入参：{ training_type, target_count, deadline(可选 ISO 日期), remark(可选) }
 */
if (process.env.DEV_MODE === 'true') {
  router.post('/tasks/dev-create', auth, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!V.isValidTrainingType(b.training_type)) return fail(res, 400, '训练类型不合法');
      if (!V.isNonNegInt(b.target_count, 10000) || b.target_count < 1) return fail(res, 400, '目标次数需为正整数');
      const deadline = b.deadline && V.isValidDateTime(b.deadline) ? new Date(b.deadline) : null;
      const remark = typeof b.remark === 'string' ? b.remark.slice(0, 255) : null;
      const taskId = genId('t');
      await pool.query(
        'INSERT INTO training_tasks (task_id, user_id, training_type, target_count, deadline, remark, title) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [taskId, req.user.user_id, b.training_type, b.target_count, deadline, remark, b.training_type === 1 ? '坐站训练' : '仰卧直腿抬高训练']);
      await pool.query('INSERT IGNORE INTO user_tasks (task_id, user_id, status, completed_count) VALUES (?, ?, 0, 0)', [taskId, req.user.user_id]);
      const [[task]] = await pool.query('SELECT * FROM training_tasks WHERE task_id = ?', [taskId]);
      ok(res, { task }, '测试任务已创建');
    } catch (e) { next(e); }
  });
}

module.exports = router;
