/* 后端接口全链路自测（本地 MySQL root/root，DEV_MODE 开启）
   覆盖：注册/登录/信息、训练上传(幂等)/批量/列表、任务列表/进度/完成、
   跌倒上报/列表、配置更新、同步拉取、社群发布/列表、康复师预留 501 */
const BASE = 'http://localhost:3000';
const results = [];
const ok = (n, c, x = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'} | ${n}${x ? ' | ' + x : ''}`); };

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

(async () => {
  const nick = 'e2e' + Date.now().toString(36).slice(-6);
  const RS = Date.now().toString(36); // 每次运行唯一后缀（幂等测试需每次新 ID）
  const uid = 'u_e2e' + Date.now().toString(36).slice(-6);

  // 1. 注册
  let r = await api('/api/user/register', { method: 'POST', body: { nickname: nick, password: 'pass1234', client_user_id: uid } });
  ok('注册(含客户端uid)', r.json.code === 200 && r.json.data.user_id === uid && !!r.json.data.token, r.json.message);
  const token = r.json.data.token;
  ok('注册返回默认配置', r.json.data.settings && r.json.data.settings.alert_delay === 5);

  // 2. 重复注册（昵称唯一）
  r = await api('/api/user/register', { method: 'POST', body: { nickname: nick, password: 'pass1234' } });
  ok('昵称唯一校验', r.json.code === 409, 'code=' + r.json.code);

  // 3. 非法参数校验
  r = await api('/api/user/register', { method: 'POST', body: { nickname: 'a', password: '1234' } });
  ok('参数校验(昵称过短)', r.json.code === 400);
  r = await api('/api/training/upload', { method: 'POST', token, body: { record_id: 'bad', training_type: 9 } });
  ok('参数校验(非法训练类型)', r.json.code === 400);

  // 4. 登录 + 信息
  r = await api('/api/user/login', { method: 'POST', body: { nickname: nick, password: 'pass1234' } });
  ok('登录', r.json.code === 200 && r.json.data.nickname === nick);
  const token2 = r.json.data.token;
  r = await api('/api/user/info', { token: token2 });
  ok('用户信息', r.json.code === 200 && r.json.data.user.nickname === nick);
  r = await api('/api/user/info', { token: 'bad-token' });
  ok('鉴权拦截', r.json.code === 401);

  // 5. 训练记录上传（幂等）
  const rec = {
    record_id: 'r_e2e1' + RS, training_type: 1, total_count: 12, standard_count: 10, standard_rate: 83.3,
    duration: 420, training_time: new Date().toISOString(), device_info: 'node-test',
  };
  r = await api('/api/training/upload', { method: 'POST', token, body: rec });
  ok('训练记录上传', r.json.code === 200 && r.json.data.inserted === true);
  r = await api('/api/training/upload', { method: 'POST', token, body: rec });
  ok('训练记录幂等(重复不插)', r.json.code === 200 && r.json.data.inserted === false);

  // 6. 批量上传
  const batch = [2, 3].map(i => ({
    record_id: 'r_e2e' + RS + '_' + i, training_type: 2, total_count: 8 + i, standard_count: 6, standard_rate: 70,
    duration: 300, training_time: new Date(Date.now() - i * 86400000).toISOString(),
  }));
  r = await api('/api/training/batch-upload', { method: 'POST', token, body: { records: batch } });
  ok('批量上传', r.json.code === 200 && r.json.data.success === 2, JSON.stringify(r.json.data));

  // 7. 记录列表分页
  r = await api('/api/training/list?page=1&pageSize=2&training_type=2', { token });
  ok('记录列表(分页+类型过滤)', r.json.code === 200 && r.json.data.list.length === 2 && r.json.data.total === 2);

  // 8. 任务：dev-create → list → progress → 完成
  r = await api('/api/tasks/dev-create', { method: 'POST', token, body: { training_type: 1, target_count: 20, deadline: new Date(Date.now() + 86400000).toISOString(), remark: '每日坐站 20 次' } });
  ok('测试任务创建(DEV)', r.json.code === 200 && r.json.data.task.status === 0, r.json.message);
  const taskId = r.json.data.task.task_id;
  r = await api('/api/tasks/list', { token });
  ok('任务列表', r.json.code === 200 && r.json.data.list.length === 1 && r.json.data.list[0].task_id === taskId);

  r = await api('/api/tasks/update-progress', { method: 'POST', token, body: { training_type: 1, standard_count: 10, record_id: 'r_e2e1' + RS } });
  ok('任务进度+10(未开始→进行中)', r.json.code === 200 && r.json.data.matched && r.json.data.task.my_count === 10 && r.json.data.task.status === 1 && r.json.data.task.my_status === 0, JSON.stringify(r.json.data.task && { c: r.json.data.task.my_count, agg: r.json.data.task.status }));
  r = await api('/api/tasks/update-progress', { method: 'POST', token, body: { training_type: 2, standard_count: 5 } });
  ok('无匹配类型任务', r.json.code === 200 && r.json.data.matched === false);
  r = await api('/api/tasks/update-progress', { method: 'POST', token, body: { training_type: 1, standard_count: 10, record_id: 'r_x' + RS } });
  ok('任务达成目标→已完成', r.json.code === 200 && r.json.data.reached === true && r.json.data.task.my_status === 1 && r.json.data.task.my_count === 20);
  r = await api('/api/tasks/update-progress', { method: 'POST', token, body: { training_type: 1, standard_count: 5 } });
  ok('已完成任务不再更新', r.json.code === 200 && r.json.data.matched === false);

  // 9. 过期任务
  await api('/api/tasks/dev-create', { method: 'POST', token, body: { training_type: 2, target_count: 10, deadline: new Date(Date.now() - 60000).toISOString() } });
  r = await api('/api/tasks/list', { token });
  const expired = r.json.data.list.find(t => t.training_type === 2);
  ok('过期任务惰性标记', expired && expired.task_status === 3, 'task_status=' + (expired && expired.task_status));

  // 10. 跌倒事件
  r = await api('/api/fall/upload', { method: 'POST', token, body: { event_id: 'f_e2e1' + RS, event_time: new Date().toISOString(), trigger_type: 1, is_canceled: 0, is_alert_sent: 0, contact_name: '家人', remark: '自动跌倒检测（演示）' } });
  ok('跌倒事件上报', r.json.code === 200 && r.json.data.inserted === true);
  r = await api('/api/fall/list', { token });
  ok('跌倒事件列表', r.json.code === 200 && r.json.data.list.length === 1 && r.json.data.list[0].trigger_type === 1);

  // 11. 配置更新 + 紧急联系人
  r = await api('/api/settings/update', { method: 'POST', token, body: { alert_delay: 8, sensitivity: 'high', emergency_contact: { name: '女儿', phone: '13900001111' } } });
  ok('配置更新', r.json.code === 200 && r.json.data.settings.alert_delay === 8 && r.json.data.settings.sensitivity === 'high');
  r = await api('/api/settings/update', { method: 'POST', token, body: { alert_delay: 99 } });
  ok('配置参数校验', r.json.code === 400);

  // 12. 同步拉取
  r = await api('/api/sync/pull', { token });
  ok('同步拉取(配置+记录+任务+联系人)', r.json.code === 200 && r.json.data.recent_records.length === 3 && r.json.data.tasks.length === 2 && r.json.data.contacts.length === 1 && r.json.data.settings.alert_delay === 8);

  // 13. 社群
  r = await api('/api/community/post', { method: 'POST', token, body: { post_id: 'p_e2e1' + RS, content: '今天完成训练打卡！', voice_duration: 0 } });
  ok('社群发布', r.json.code === 200 && r.json.data.inserted === true);
  r = await api('/api/community/list?page=1&pageSize=5', { token });
  ok('社群列表(含昵称)', r.json.code === 200 && r.json.data.list.length >= 1 && r.json.data.list[0].nickname === nick);

  // 14. 康复师接口（v14 已实装：非康复师账号登录返回 404）
  r = await api('/api/therapist/login', { method: 'POST', body: { nickname: nick, password: 'pass1234' } });
  ok('康复师接口已实装(普通账号被拒)', r.json.code === 404, r.json.message);
  r = await api('/api/nothing-here');
  ok('404 统一响应', r.status === 404 && r.json.code === 404);

  const fails = results.filter(x => !x).length;
  console.log(`\n===== 共 ${results.length} 项，失败 ${fails} 项 =====`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });
