# Knee-d Help 自研轻量后端

Node.js + Express + MySQL，完全自托管，不依赖任何第三方云服务。
前端（`index.html`）本地优先运行，联网后通过本服务异步同步数据。

**隐私优先**：数据库仅存结构化业务数据，绝不存储摄像头视频画面与原始姿态帧数据——姿态识别与推理全程在用户浏览器本地完成。

## 一、项目结构

```
server/
├── package.json          # 依赖配置（express/mysql2/jsonwebtoken/bcryptjs）
├── app.js                # 入口：CORS → 路由 → 404 → 全局错误处理
├── config/db.js          # MySQL 连接池配置（环境变量可覆盖）
├── middleware/
│   ├── auth.js           # Token 鉴权（Authorization: Bearer）
│   └── cors.js           # 跨域配置
├── routes/
│   ├── user.js           # 用户端全部接口（账号/训练/任务/跌倒/配置/同步/社群）
│   └── therapist.js      # 康复师端预留接口框架（501 占位 + 对接说明）
├── utils/
│   ├── jwt.js            # token 签发/校验（用户 7 天 / 康复师 12 小时）
│   ├── password.js       # 密码 bcrypt 哈希
│   └── validate.js       # 参数校验工具
├── sql/init.sql          # 数据库初始化建表（8+2 张表、索引、utf8mb4）
└── test-api.cjs          # 本地接口自测脚本（需本机 MySQL，见「本地测试」）
```

## 二、环境要求

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 18（建议 18/20 LTS） |
| MySQL | ≥ 5.7（建议 8.0），InnoDB + utf8mb4 |
| 网络 | 自托管：服务器放行 3000 端口（或自行配置 Nginx 反代） |

## 三、部署步骤

**第 1 步：初始化数据库**

```bash
mysql -u root -p < server/sql/init.sql
```

（脚本会自动创建 `knee_d` 库与全部 13 张表；重复执行安全。）
**v13 老库升级**：执行增量迁移 `mysql -u root -p knee_d < server/sql/migration_v14.sql`（新增康复师角色/小组/任务分配表与字段）。

**没有 MySQL 或无法启动系统服务时的开发替代方案**：可用安装目录的 mysqld 直接启动一个数据目录独立、端口独立（如 3307）的开发实例（无需管理员权限）：

```bash
# 首次初始化（root 空密码）：
"C:\Program Files\MySQL\MySQL Server 5.7\bin\mysqld.exe" --initialize-insecure --datadir="D:/Knee-d/mysql-dev-data"
# 启动：
"C:\Program Files\MySQL\MySQL Server 5.7\bin\mysqld.exe" --datadir="D:/Knee-d/mysql-dev-data" --port=3307
# 后端连接：DB_PORT=3307 DB_PASSWORD='' npm start
```

**第 2 步：安装依赖并启动**

```bash
cd server
npm install
npm start
```

**第 3 步：配置环境变量**（可选，均有默认值）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | 服务端口 |
| `DB_HOST` / `DB_PORT` | 127.0.0.1 / 3306 | MySQL 地址 |
| `DB_USER` / `DB_PASSWORD` | root / 空 | 数据库账号 |
| `DB_NAME` | knee_d | 库名 |
| `JWT_SECRET` | 开发默认值 | **生产环境必须设置**，如 `JWT_SECRET=$(openssl rand -hex 32)` |
| `DEV_MODE` | — | `true` 时启用 `POST /api/tasks/dev-create` 测试接口 |

示例：`DB_PASSWORD=你的密码 JWT_SECRET=xxxx npm start`

**第 4 步：前端对接配置**

打开 `index.html` 顶部 `CFG` 对象，将 `API_BASE` 改为后端实际地址（末尾不带 `/`）：

```js
API_BASE: 'http://localhost:3000', // 本机调试
API_BASE: 'http://192.168.1.10:3000', // 局域网设备
API_BASE: 'https://api.your-domain.com', // 生产（建议 Nginx 反代 + HTTPS）
```

前端在服务器不可达时自动降级为纯本地模式，所有功能照常使用。

## 四、本地测试方法（手动创建任务验证全链路）

**方式一（推荐）：DEV_MODE 测试接口**

```bash
# 1. 启动后端（开启 DEV_MODE）
DEV_MODE=true DB_PASSWORD=root npm start

# 2. 注册云端账号
curl -X POST http://localhost:3000/api/user/register \
  -H "Content-Type: application/json" \
  -d '{"nickname":"测试用户","password":"123456"}'
# 响应里取 token 与 user_id

# 3. 创建测试任务（模拟康复师派发）
curl -X POST http://localhost:3000/api/tasks/dev-create \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token>" \
  -d '{"training_type":1,"target_count":20,"deadline":"2026-09-12T00:00:00.000Z","remark":"每日坐站训练 20 次达标"}'

# 4. 浏览器打开前端 → 云端账号登录 → 首页即出现任务卡片与角标
# 5. 完成一次坐站训练 → 训练结果卡片显示任务进度 → 任务达标自动「已完成」
```

**方式二：直接 SQL 插入任务**（`init.sql` 末尾有注释示例）

```sql
INSERT INTO training_tasks (task_id, user_id, training_type, target_count, deadline, remark)
VALUES (CONCAT('t', REPLACE(UUID(),'-','')), '<user_id>', 1, 30, DATE_ADD(NOW(), INTERVAL 7 DAY), '每日坐站 30 次');
```

**方式三：跑接口自测**（后端启动后，覆盖全部 28 项接口断言）

```bash
node test-api.cjs
```

## 五、用户端接口一览（均已实现）

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/user/register` | POST | — | 注册（昵称唯一、密码哈希；v14 支持 role=therapist + 名称 + 电话） |
| `/api/user/login` | POST | — | 登录（返回 token，含角色；康复师 12h / 用户 7 天） |
| `/api/user/info` | GET | ✓ | 用户信息与配置 |
| `/api/training/upload` | POST | ✓ | 单条训练记录上报（record_id 幂等；含任务关联字段） |
| `/api/training/batch-upload` | POST | ✓ | 批量上报本地历史（首登同步） |
| `/api/training/list` | GET | ✓ | 分页记录列表（可按类型过滤；含 task_id/task_completed） |
| `/api/tasks/list` 与 `/api/tasks` | GET | ✓ | 角色感知：用户=被分配任务（个人进度）；康复师=自己发布的任务（完成统计） |
| `/api/tasks/update-progress` | POST | ✓ | 训练达标联动任务进度（分配制：自动匹配/达标完成/训练记录回写任务完成标记） |
| `/api/tasks` | POST | 康复师 | 发布任务（小组全员或指定组员/单人任务） |
| `/api/tasks/:id/complete` | POST | ✓ | 手动标记任务完成（兜底） |
| `/api/tasks/:id/note` | PATCH | ✓ | 填写任务备注（向康复师反馈） |
| `/api/tasks/:id/detail` | GET | 康复师 | 任务详情 + 每位成员完成情况 |
| `/api/groups` | GET/POST | 康复师 | 小组列表 / 新建小组 |
| `/api/groups/:id/members` | GET | 康复师 | 成员列表（含最近任务完成状态/备注/完成时间） |
| `/api/groups/:id/invite` | POST | 康复师 | 邀请用户入组 |
| `/api/groups/:id/members/:uid` | DELETE | 康复师 | 移除成员 |
| `/api/users/search` | GET | 康复师 | 按昵称/名称搜索康复用户 |
| `/api/my_groups` | GET | ✓ | 我所在的小组 |
| `/api/fall/upload` | POST | ✓ | 跌倒事件上报（event_id 幂等） |
| `/api/fall/list` | GET | ✓ | 跌倒事件列表 |
| `/api/sync/pull` | GET | ✓ | 拉取配置+最近10条记录+任务+小组+联系人 |
| `/api/settings/update` | POST | ✓ | 配置更新（含默认紧急联系人 upsert） |
| `/api/community/post` | POST | ✓ | 发布社群动态（文字+语音时长摘要） |
| `/api/community/list` | GET | ✓ | 社群动态列表（含发布者昵称） |
| `/api/tasks/dev-create` | POST | ✓ | 仅 `DEV_MODE=true`：手动创建测试任务（自分配） |

统一响应：`{ code: 200, message: 'success', data: {...} }`；业务错误 `code` 为 4xx/409 等，HTTP 状态 200（鉴权 401、未找到路由 404 除外）。

## 五·五、康复师端接口（v14 实装）

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/therapist/login` | POST | — | 康复师登录（昵称+密码，校验 role=2） |
| `/api/therapist/patients` | GET | 康复师 | 我的患者列表（小组去重，含待办/已完成任务数） |
| `/api/therapist/patient/:id/overview` | GET | 康复师 | 患者概览（近7天训练/任务完成率/30天跌倒数） |
| `/api/therapist/patient/:id/records` | GET | 康复师 | 患者训练记录（分页，含任务完成标记） |
| `/api/therapist/patient/:id/trend` | GET | 康复师 | 近30天训练趋势（按日聚合） |
| `/api/therapist/patient/:id/fall-events` | GET | 康复师 | 患者跌倒事件列表 |
| `/api/therapist/task/create` | POST | 康复师 | 创建任务（单人/小组，等价于 POST /api/tasks） |
| `/api/therapist/patient/:id/tasks` | GET | 康复师 | 患者的任务与完成情况 |
| `/api/therapist/task/:id/detail` | GET | 康复师 | 任务详情 + 成员完成情况 |

权限控制：康复师账号 = `users.role=2`（与用户共用登录通道，token 带 role）；`therapistAuth` 中间件校验角色；患者数据接口校验「患者须在自己小组内」，越权返回 403。

## 六、康复师端后续接入指南

### 已就绪的预留内容

1. **表结构**（`init.sql`，可直接使用）：
   - `therapists`：康复师账号（工号唯一、密码哈希、`permission_level` 1/2/3）
   - `patient_therapist_relation`：用户-康复师绑定（`status` 1 有效 / 0 解除）
   - `therapist_remarks`：康复师对患者的备注
   - `training_tasks.therapist_id`：任务已预留派发人字段，用户端接口完全兼容

2. **接口框架**（`routes/therapist.js`，当前返回 501 占位 + 出入参说明）：
   `therapist/login`、`therapist/patients`、`therapist/patient/:id/overview|records|trend|fall-events|tasks`、`therapist/task/create`、`therapist/task/:id/detail`

3. **权限体系**：
   - 康复师 token（12 小时）已支持签发：`utils/jwt.js → signTherapistToken`
   - 访问控制约定：患者数据接口必须校验 `patient_therapist_relation` 绑定；`permission_level=3` 管理员可越级

### 接入步骤（康复师端开发完成后）

1. 在 `routes/therapist.js` 将各 501 占位替换为真实查询（表与索引已就绪，无需改库）；
2. 新增 `middleware/therapistAuth.js`（校验 `role === 'therapist'`，复用 `auth.js` 结构即可）；
3. 康复师前端按 `{ code, message, data }` 统一格式对接；
4. **用户端零改动**：康复师建的任务写入 `training_tasks` 后，用户端任务卡片/角标自动可见，训练达标自动累加 `completed_count`，康复师端通过 `patient/:id/tasks` 与 `overview` 查看完成情况——任务联动闭环已经打通。

## 七、安全与运维注意

- `JWT_SECRET` 生产环境必须改为随机长字符串，否则 token 可被伪造
- 密码一律 bcrypt 哈希存储，数据库泄露不会暴露明文
- CORS 默认放开，正式部署建议收紧 `Access-Control-Allow-Origin` 为前端实际域名
- 数据备份：`mysqldump knee_d > backup.sql`；仅存结构化数据，备份体积很小
