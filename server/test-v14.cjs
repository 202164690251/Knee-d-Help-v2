/* v14 康复师端全链路自测：康复师注册→建组→邀请→发布任务（单人/小组）→
   用户训练自动达标→任务完成→训练记录关联可见→康复师端查看完成情况 */
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
  const RS = Date.now().toString(36);
  // 1. 康复师注册（role=therapist，需电话）
  let r = await api('/api/user/register', { method: 'POST', body: { nickname: 'tp' + RS, password: 'pass1234', role: 'therapist', name: '王康复师', phone: '13800001111' } });
  ok('康复师注册(role+电话)', r.json.code === 200 && r.json.data.role === 'therapist', r.json.message);
  const tpToken = r.json.data.token;
  r = await api('/api/user/register', { method: 'POST', body: { nickname: 'tp' + RS, password: 'pass1234', role: 'therapist' } });
  ok('康复师注册缺电话被拒', r.json.code === 400);

  // 2. 康复师登录
  r = await api('/api/user/login', { method: 'POST', body: { nickname: 'tp' + RS, password: 'pass1234' } });
  ok('康复师登录返回角色', r.json.code === 200 && r.json.data.role === 'therapist', JSON.stringify(r.json.data.role));
  r = await api('/api/therapist/login', { method: 'POST', body: { nickname: 'tp' + RS, password: 'pass1234' } });
  ok('therapist/login 通道', r.json.code === 200 && !!r.json.data.token);

  // 3. 两个康复用户注册
  const u1 = (await api('/api/user/register', { method: 'POST', body: { nickname: 'chen' + RS, password: 'pass1234', name: '陈伯' } })).json.data;
  const u2 = (await api('/api/user/register', { method: 'POST', body: { nickname: 'li' + RS, password: 'pass1234', name: '李婆婆' } })).json.data;
  ok('康复用户注册', !!u1.token && !!u2.token);

  // 4. 用户搜索（康复师）
  r = await api('/api/users/search?q=陈', { token: tpToken });
  ok('康复师搜索用户', r.json.code === 200 && r.json.data.users.some(u => u.user_id === u1.user_id), JSON.stringify(r.json.data.users.length));
  r = await api('/api/users/search?q=', { token: u1.token });
  ok('用户无权搜索', r.json.code === 403);

  // 5. 建组 + 邀请
  r = await api('/api/groups', { method: 'POST', token: tpToken, body: { name: '晨练小组' } });
  ok('创建小组', r.json.code === 200 && !!r.json.data.group, r.json.message);
  const gid = r.json.data.group.group_id;
  r = await api('/api/groups/' + gid + '/invite', { method: 'POST', token: tpToken, body: { user_id: u1.user_id } });
  ok('邀请用户1', r.json.code === 200);
  r = await api('/api/groups/' + gid + '/invite', { method: 'POST', token: tpToken, body: { user_id: u2.user_id } });
  ok('邀请用户2', r.json.code === 200);
  r = await api('/api/groups', { token: tpToken });
  ok('小组列表含成员数', r.json.code === 200 && r.json.data.groups[0].member_count === 2, JSON.stringify(r.json.data.groups[0]));
  r = await api('/api/my_groups', { token: u1.token });
  ok('用户端我的小组', r.json.code === 200 && r.json.data.groups.length === 1 && r.json.data.groups[0].name === '晨练小组');

  // 6. 发布小组任务（指定成员 u1）
  r = await api('/api/tasks', { method: 'POST', token: tpToken, body: {
    group_id: gid, title: '坐站训练', training_type: 1, target_count: 15,
    sets: '3 组，每组 5 次', time_text: '今天 15:00', user_ids: [u1.user_id],
  } });
  ok('发布小组任务(指定成员)', r.json.code === 200 && r.json.data.assigned === 1, r.json.message);
  const taskId = r.json.data.task.task_id;
  // 7. 发布单人任务（直接指定 u2）
  r = await api('/api/tasks', { method: 'POST', token: tpToken, body: {
    title: '仰卧直腿抬高训练', training_type: 2, target_count: 10, sets: '2 组', time_text: '明天 10:00', user_ids: [u2.user_id],
  } });
  ok('发布单人任务', r.json.code === 200 && r.json.data.assigned === 1);
  const taskId2 = r.json.data.task.task_id;

  // 8. 用户端任务列表
  r = await api('/api/tasks', { token: u1.token });
  ok('用户1任务列表(分配1条+未完成)', r.json.code === 200 && r.json.data.list.length === 1 && r.json.data.list[0].user_status === 0 && r.json.data.list[0].group_name === '晨练小组', JSON.stringify(r.json.data.list[0] && { n: r.json.data.list.length, s: r.json.data.list[0].user_status }));
  r = await api('/api/tasks', { token: u2.token });
  ok('用户2任务列表(单人任务)', r.json.code === 200 && r.json.data.list.length === 1 && !r.json.data.list[0].group_name);
  r = await api('/api/tasks', { token: tpToken });
  ok('康复师任务列表(2条+完成统计)', r.json.code === 200 && r.json.data.list.length === 2 && r.json.data.list[0].total_count >= 0);

  // 9. 用户训练上报 → 自动进度（第一次 8 次达标）
  const rec1 = { record_id: 'r14a' + RS, training_type: 1, total_count: 10, standard_count: 8, standard_rate: 80, duration: 300, training_time: new Date().toISOString() };
  r = await api('/api/training/upload', { method: 'POST', token: u1.token, body: rec1 });
  ok('训练记录上报', r.json.code === 200 && r.json.data.inserted === true);
  r = await api('/api/tasks/update-progress', { method: 'POST', token: u1.token, body: { training_type: 1, standard_count: 8, record_id: rec1.record_id } });
  ok('任务进度+8(进行中)', r.json.code === 200 && r.json.data.matched && r.json.data.task.my_count === 8 && !r.json.data.reached, JSON.stringify(r.json.data.task && r.json.data.task.my_count));

  // 10. 第二次训练 7 次 → 达标 15 → 任务完成 + 记录关联
  const rec2 = { record_id: 'r14b' + RS, training_type: 1, total_count: 9, standard_count: 7, standard_rate: 78, duration: 280, training_time: new Date().toISOString() };
  await api('/api/training/upload', { method: 'POST', token: u1.token, body: rec2 });
  r = await api('/api/tasks/update-progress', { method: 'POST', token: u1.token, body: { training_type: 1, standard_count: 7, record_id: rec2.record_id } });
  ok('任务达成→完成(15/15)', r.json.code === 200 && r.json.data.reached === true && r.json.data.task.my_count === 15 && r.json.data.task.my_status === 1, JSON.stringify(r.json.data.task && { c: r.json.data.task.my_count, s: r.json.data.task.my_status }));

  // 11. 训练记录任务关联回写（训练记录可见）
  r = await api('/api/training/list?page=1&pageSize=10', { token: u1.token });
  const linked = r.json.data.list.find(x => x.record_id === rec2.record_id);
  ok('训练记录回写任务完成标记', linked && linked.task_id === taskId && linked.task_completed === 1, JSON.stringify(linked && { t: linked.task_id, c: linked.task_completed }));

  // 12. 康复师端查看完成情况
  r = await api('/api/therapist/task/' + taskId + '/detail', { token: tpToken });
  ok('任务详情(成员完成)', r.json.code === 200 && r.json.data.members.length === 1 && r.json.data.members[0].status === 1 && r.json.data.members[0].completed_record_id === rec2.record_id, JSON.stringify(r.json.data.members[0] && { s: r.json.data.members[0].status }));
  r = await api('/api/groups/' + gid + '/members', { token: tpToken });
  ok('小组成员列表含完成状态', r.json.code === 200 && r.json.data.members.some(m => m.user_id === u1.user_id && m.user_status === 1));
  r = await api('/api/therapist/patient/' + u1.user_id + '/overview', { token: tpToken });
  ok('患者概览(周记录+任务完成率)', r.json.code === 200 && r.json.data.week_records === 2 && r.json.data.task_done === 1 && r.json.data.task_done_rate === 100, JSON.stringify(r.json.data.task_done_rate));
  r = await api('/api/therapist/patient/' + u1.user_id + '/records', { token: tpToken });
  ok('患者训练记录', r.json.code === 200 && r.json.data.total === 2);
  r = await api('/api/therapist/patient/' + u1.user_id + '/trend', { token: tpToken });
  ok('患者训练趋势', r.json.code === 200 && r.json.data.days.length >= 1);
  r = await api('/api/therapist/patient/' + u1.user_id + '/tasks', { token: tpToken });
  ok('患者任务列表', r.json.code === 200 && r.json.data.list.length === 1 && r.json.data.list[0].status === 1);
  r = await api('/api/therapist/patients', { token: tpToken });
  ok('我的患者列表', r.json.code === 200 && r.json.data.list.length === 2 && r.json.data.list.some(p => p.pending_tasks === 0 && p.done_tasks === 1));

  // 13. 越权访问：用户2看不了用户1的任务详情/康复师看不了非本组患者
  r = await api('/api/therapist/task/' + taskId + '/detail', { token: u2.token });
  ok('用户无权访问康复师接口', r.status === 403 || r.json.code === 403, JSON.stringify(r.json.code));
  // 注册另一个康复师访问 u1（不在其小组）
  const tp2 = (await api('/api/user/register', { method: 'POST', body: { nickname: 'tp2' + RS, password: 'pass1234', role: 'therapist', phone: '13900002222' } })).json.data;
  r = await api('/api/therapist/patient/' + u1.user_id + '/overview', { token: tp2.token });
  ok('康复师越权拦截(非本组患者)', r.json.code === 403);

  // 14. 手动标记完成 + 备注（兜底路径）
  r = await api('/api/tasks/' + taskId2 + '/note', { method: 'PATCH', token: u2.token, body: { note: '膝盖有些酸痛，做完了' } });
  ok('用户填写任务备注', r.json.code === 200 && r.json.data.note.includes('酸痛'));
  r = await api('/api/tasks/' + taskId2 + '/complete', { method: 'POST', token: u2.token });
  ok('手动标记任务完成', r.json.code === 200 && r.json.data.done === true);
  r = await api('/api/therapist/task/' + taskId2 + '/detail', { token: tpToken });
  ok('康复师看到备注与完成', r.json.code === 200 && r.json.data.members[0].status === 1 && r.json.data.members[0].note.includes('酸痛'));

  // 15. sync/pull 含任务与小组
  r = await api('/api/sync/pull', { token: u1.token });
  ok('同步拉取(任务+小组)', r.json.code === 200 && r.json.data.tasks.length === 1 && r.json.data.groups.length === 1 && r.json.data.tasks[0].user_status === 1);

  const fails = results.filter(x => !x).length;
  console.log(`\n===== 共 ${results.length} 项，失败 ${fails} 项 =====`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });
