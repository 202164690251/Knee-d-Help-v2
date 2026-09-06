/**
 * 康复师端接口（v14 实装）
 * 权限体系：
 *  - 康复师账号 = users.role=2（与用户共用 /api/user/login 登录，token 带 role）
 *  - therapistAuth 中间件校验 role==='therapist'
 *  - 患者访问控制：只能访问「自己小组内的成员」（patient_therapist_relation 表为医院对接预留，
 *    当前以 therapist_groups/group_members 作为绑定关系）
 *  - therapists 表为预留结构（工号/科室体系），后续医院对接时可无缝切换
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../config/db');
const { therapistAuth } = require('../middleware/auth');
const { signUserToken } = require('../utils/jwt');
const { verifyPassword } = require('../utils/password');
const V = require('../utils/validate');

const router = express.Router();
const ok = (res, data, message) => res.json({ code: 200, message: message || 'success', data });
const fail = (res, code, message) => res.status(code >= 500 ? code : 200).json({ code, message, data: null });

/** 校验该患者是否属于当前康复师的任一小组成员（越权返回 null 并响应 403） */
async function requirePatient(req, res, patientId) {
  const [rows] = await pool.query(
    `SELECT gm.user_id FROM group_members gm
     JOIN therapist_groups g ON g.group_id = gm.group_id
     WHERE g.therapist_id = ? AND gm.user_id = ? LIMIT 1`,
    [req.user.user_id, patientId]);
  if (!rows.length) {
    fail(res, 403, '无权查看该用户：不在您的任何小组中');
    return false;
  }
  return true;
}

/* ── 登录 ── */
/** POST /api/therapist/login：康复师登录（昵称+密码，校验 role=2；等价于 /api/user/login 后前端判断角色） */
router.post('/therapist/login', async (req, res, next) => {
  try {
    const { nickname, password } = req.body || {};
    if (!V.isValidNickname(nickname) || !V.isValidPassword(password)) return fail(res, 400, '请输入正确的账号和密码');
    const [rows] = await pool.query(
      'SELECT user_id, nickname, name, role, password_hash, status FROM users WHERE nickname = ?', [nickname.trim()]);
    if (!rows.length || rows[0].role !== 2) return fail(res, 404, '康复师账号不存在');
    const u = rows[0];
    if (u.status !== 1) return fail(res, 403, '账号已被停用');
    if (!(await verifyPassword(password, u.password_hash))) return fail(res, 401, '密码错误，请重试');
    await pool.query('UPDATE users SET last_login_time = NOW() WHERE user_id = ?', [u.user_id]);
    const token = signUserToken({ user_id: u.user_id, nickname: u.nickname, role: 'therapist' });
    ok(res, { token, therapist: { user_id: u.user_id, nickname: u.nickname, name: u.name || u.nickname } }, '登录成功');
  } catch (e) { next(e); }
});

/* ── 患者管理 ── */
/** GET /api/therapist/patients：我的患者列表（各小组成员去重，含最近完成情况） */
router.get('/therapist/patients', therapistAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT u.user_id, u.nickname, u.name, u.phone, u.avatar, u.birth_year, u.knee_condition,
              (SELECT COUNT(*) FROM training_records tr WHERE tr.user_id = u.user_id) AS record_count,
              (SELECT COUNT(*) FROM user_tasks ut JOIN training_tasks t ON t.task_id = ut.task_id
               WHERE ut.user_id = u.user_id AND t.therapist_id = ? AND ut.status = 0) AS pending_tasks,
              (SELECT COUNT(*) FROM user_tasks ut JOIN training_tasks t ON t.task_id = ut.task_id
               WHERE ut.user_id = u.user_id AND t.therapist_id = ? AND ut.status = 1) AS done_tasks
       FROM group_members gm
       JOIN therapist_groups g ON g.group_id = gm.group_id
       JOIN users u ON u.user_id = gm.user_id
       WHERE g.therapist_id = ? ORDER BY u.name, u.nickname`,
      [req.user.user_id, req.user.user_id, req.user.user_id]);
    ok(res, { list: rows, total: rows.length });
  } catch (e) { next(e); }
});

/** GET /api/therapist/patient/:id/overview：患者概览（近7天训练/任务完成率/30天跌倒次数） */
router.get('/therapist/patient/:id/overview', therapistAuth, async (req, res, next) => {
  try {
    if (!(await requirePatient(req, res, req.params.id))) return;
    const uid = req.params.id;
    const [[u]] = await pool.query('SELECT user_id, nickname, name, phone, avatar, birth_year, knee_condition, create_time FROM users WHERE user_id = ?', [uid]);
    const [[{ weekRecords }]] = await pool.query('SELECT COUNT(*) AS weekRecords FROM training_records WHERE user_id = ? AND training_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)', [uid]);
    const [[{ weekReps }]] = await pool.query('SELECT COALESCE(SUM(standard_count),0) AS weekReps FROM training_records WHERE user_id = ? AND training_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)', [uid]);
    const [[{ taskTotal, taskDone }]] = await pool.query(
      `SELECT COUNT(*) AS taskTotal, COALESCE(SUM(ut.status = 1), 0) AS taskDone
       FROM user_tasks ut JOIN training_tasks t ON t.task_id = ut.task_id
       WHERE ut.user_id = ? AND t.therapist_id = ?`, [uid, req.user.user_id]);
    const [[{ fall30d }]] = await pool.query('SELECT COUNT(*) AS fall30d FROM fall_events WHERE user_id = ? AND event_time >= DATE_SUB(NOW(), INTERVAL 30 DAY)', [uid]);
    ok(res, {
      user: u,
      week_records: Number(weekRecords),
      week_reps: Number(weekReps),
      task_total: Number(taskTotal),
      task_done: Number(taskDone), // SUM() 在 mysql2 中返回字符串，统一转数字
      task_done_rate: Number(taskTotal) ? Math.round(Number(taskDone) / Number(taskTotal) * 100) : null,
      fall_count_30d: Number(fall30d),
    });
  } catch (e) { next(e); }
});

/** GET /api/therapist/patient/:id/records：患者训练记录（分页，可按类型过滤；含任务完成标记） */
router.get('/therapist/patient/:id/records', therapistAuth, async (req, res, next) => {
  try {
    if (!(await requirePatient(req, res, req.params.id))) return;
    const uid = req.params.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const type = parseInt(req.query.training_type, 10);
    const where = 'WHERE user_id = ?' + (type === 1 || type === 2 ? ' AND training_type = ?' : '');
    const args = [uid];
    if (type === 1 || type === 2) args.push(type);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM training_records ${where}`, args);
    const [rows] = await pool.query(
      `SELECT record_id, training_type, total_count, standard_count, standard_rate, duration, avg_knee_angle, training_time, task_id, task_completed
       FROM training_records ${where} ORDER BY training_time DESC LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize]);
    ok(res, { list: rows, total, page, pageSize });
  } catch (e) { next(e); }
});

/** GET /api/therapist/patient/:id/trend：近30天训练趋势（按日聚合，供图表） */
router.get('/therapist/patient/:id/trend', therapistAuth, async (req, res, next) => {
  try {
    if (!(await requirePatient(req, res, req.params.id))) return;
    const uid = req.params.id;
    const [rows] = await pool.query(
      `SELECT DATE(training_time) AS date, COUNT(*) AS cnt, COALESCE(SUM(total_count),0) AS total, COALESCE(SUM(standard_count),0) AS standard
       FROM training_records
       WHERE user_id = ? AND training_time >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY DATE(training_time) ORDER BY date ASC`, [uid]);
    const days = rows.map(r => ({
      date: r.date, count: r.cnt, total: r.total, standard: r.standard,
      rate: r.total > 0 ? Math.round(r.standard / r.total * 100) : 0,
    }));
    ok(res, { days });
  } catch (e) { next(e); }
});

/** GET /api/therapist/patient/:id/fall-events：患者跌倒事件列表 */
router.get('/therapist/patient/:id/fall-events', therapistAuth, async (req, res, next) => {
  try {
    if (!(await requirePatient(req, res, req.params.id))) return;
    const [rows] = await pool.query(
      'SELECT event_id, event_time, trigger_type, is_canceled, is_alert_sent, contact_name, remark FROM fall_events WHERE user_id = ? ORDER BY event_time DESC LIMIT 50',
      [req.params.id]);
    ok(res, { list: rows });
  } catch (e) { next(e); }
});

/* ── 任务 ── */
/** POST /api/therapist/task/create：为患者/小组创建训练任务（等价于 POST /api/tasks 的康复师实现） */
router.post('/therapist/task/create', therapistAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const groupId = b.group_id || null;
    const title = typeof b.title === 'string' ? b.title.trim().slice(0, 100) : '';
    if (!title) return fail(res, 400, '请填写训练动作');
    if (!V.isValidTrainingType(b.training_type)) return fail(res, 400, '训练类型不合法');
    if (!V.isNonNegInt(b.target_count, 10000) || b.target_count < 1) return fail(res, 400, '目标达标次数需为正整数');
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
      const uid = Array.isArray(b.user_ids) && b.user_ids[0];
      if (!uid || !V.isValidUserId(uid)) return fail(res, 400, '单人任务需指定用户');
      const [[u]] = await pool.query('SELECT user_id FROM users WHERE user_id = ? AND role = 1', [uid]);
      if (!u) return fail(res, 404, '用户不存在');
      targets = [uid];
    }
    const taskId = 't' + crypto.randomBytes(8).toString('hex');
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
    const [[task]] = await pool.query('SELECT * FROM training_tasks WHERE task_id = ?', [taskId]);
    ok(res, { task, assigned: targets.length }, '训练任务已发布');
  } catch (e) { next(e); }
});

/** GET /api/therapist/patient/:id/tasks：患者被分配的任务与完成情况 */
router.get('/therapist/patient/:id/tasks', therapistAuth, async (req, res, next) => {
  try {
    if (!(await requirePatient(req, res, req.params.id))) return;
    const [rows] = await pool.query(
      `SELECT t.task_id, t.title, t.sets, t.time_text, t.training_type, t.target_count, t.deadline, t.remark,
              t.group_id, g.name AS group_name, ut.status, ut.completed_count, ut.note, ut.completed_at, ut.completed_record_id
       FROM user_tasks ut
       JOIN training_tasks t ON t.task_id = ut.task_id
       LEFT JOIN therapist_groups g ON g.group_id = t.group_id
       WHERE ut.user_id = ? AND t.therapist_id = ? ORDER BY t.create_time DESC`,
      [req.params.id, req.user.user_id]);
    ok(res, { list: rows });
  } catch (e) { next(e); }
});

/** GET /api/therapist/task/:id/detail：任务详情 + 成员完成情况（与 /api/tasks/:id/detail 等价） */
router.get('/therapist/task/:id/detail', therapistAuth, async (req, res, next) => {
  try {
    const taskId = req.params.id;
    const [[task]] = await pool.query(
      `SELECT t.*, g.name AS group_name FROM training_tasks t LEFT JOIN therapist_groups g ON g.group_id = t.group_id WHERE t.task_id = ?`,
      [taskId]);
    if (!task) return fail(res, 404, '任务不存在');
    const [members] = await pool.query(
      `SELECT u.user_id, u.nickname, u.name, u.phone, ut.status, ut.completed_count, ut.note, ut.completed_at, ut.completed_record_id
       FROM user_tasks ut JOIN users u ON u.user_id = ut.user_id
       WHERE ut.task_id = ? ORDER BY ut.status ASC, u.nickname ASC`,
      [taskId]);
    ok(res, { task, members });
  } catch (e) { next(e); }
});

module.exports = router;
