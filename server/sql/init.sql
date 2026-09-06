-- ════════════════════════════════════════════════════════════════
-- Knee-d Help 自研轻量后端 · MySQL 数据库初始化脚本
-- 引擎 InnoDB / 字符集 utf8mb4（兼容 emoji 与中文）
-- 隐私优先：仅存结构化业务数据，绝不存储视频/原始姿态帧
-- 康复师相关表为预留结构，暂不投入业务，后续无缝接入
-- ════════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS knee_d
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE knee_d;

-- ──────────────────────────────────────────────
-- 1. 用户表：本地账号升级云端 / 云端注册均写入此表
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  user_id          VARCHAR(32)  NOT NULL COMMENT '用户唯一标识（本地 uid 升级后保持一致）',
  nickname         VARCHAR(50)  NOT NULL COMMENT '登录标识（账号/昵称）',
  name             VARCHAR(50)  NULL     COMMENT '显示名称（康复师端按名称搜索用户）',
  role             TINYINT      NOT NULL DEFAULT 1 COMMENT '角色：1=康复用户 2=康复师（v14 康复师端）',
  phone            VARCHAR(20)  NULL     COMMENT '联系电话',
  avatar           TEXT         NULL     COMMENT '头像 base64 或存储路径（建议改存对象存储）',
  birth_year       INT          NULL     COMMENT '出生年份，可选',
  knee_condition   VARCHAR(255) NULL     COMMENT '膝关节情况备注，可选',
  password_hash    VARCHAR(255) NOT NULL COMMENT '密码哈希（bcrypt）',
  create_time      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '注册时间',
  last_login_time  DATETIME     NULL     COMMENT '最后登录时间',
  status           TINYINT      NOT NULL DEFAULT 1 COMMENT '账号状态：1正常 0禁用',
  PRIMARY KEY (user_id),
  UNIQUE KEY uk_nickname (nickname),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表（含康复师账号，role=2）';

-- ──────────────────────────────────────────────
-- 2. 训练记录表：本地推理计数结果的结构化摘要（不含任何画面/帧数据）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_records (
  record_id       VARCHAR(32)  NOT NULL COMMENT '记录唯一标识（前端生成，幂等去重）',
  user_id         VARCHAR(32)  NOT NULL COMMENT '关联用户',
  training_type   TINYINT      NOT NULL COMMENT '训练类型：1=坐站训练 2=仰卧直腿抬高训练',
  total_count     INT          NOT NULL DEFAULT 0 COMMENT '完成总次数',
  standard_count  INT          NOT NULL DEFAULT 0 COMMENT '达标次数',
  standard_rate   DECIMAL(5,2) NOT NULL DEFAULT 0 COMMENT '达标率 0-100',
  duration        INT          NOT NULL DEFAULT 0 COMMENT '训练时长（秒）',
  avg_knee_angle  DECIMAL(5,1) NULL     COMMENT '平均膝关节角度，可选',
  training_time   DATETIME     NOT NULL COMMENT '训练结束时间',
  device_info     VARCHAR(255) NULL     COMMENT '设备浏览器信息，可选',
  task_id         VARCHAR(32)  NULL     COMMENT 'v14：关联的康复师任务（本次训练完成/推进的任务）',
  task_completed  TINYINT      NOT NULL DEFAULT 0 COMMENT 'v14：本次训练是否达成任务目标（训练记录页展示用）',
  PRIMARY KEY (record_id),
  KEY idx_user_time (user_id, training_time),
  KEY idx_user_type (user_id, training_type),
  KEY idx_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='训练记录表';

-- ──────────────────────────────────────────────
-- 3. 训练任务表（v13 新增）：康复师派发任务，用户训练自动关联进度
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_tasks (
  task_id         VARCHAR(32)  NOT NULL COMMENT '任务唯一标识',
  user_id         VARCHAR(32)  NULL     COMMENT 'v13 兼容：单人任务直接归属用户（小组任务为 NULL，走 user_tasks 分配）',
  therapist_id    VARCHAR(32)  NULL     COMMENT '派发任务的康复师ID（users.role=2）',
  group_id        VARCHAR(32)  NULL     COMMENT 'v14：所属小组（NULL=单人任务）',
  title           VARCHAR(100) NULL     COMMENT 'v14：任务动作标题（如「坐站训练」）',
  sets            VARCHAR(50)  NULL     COMMENT 'v14：组数/要求（如「3 组，每组 10 次」）',
  time_text       VARCHAR(50)  NULL     COMMENT 'v14：友好时间文案（如「今天 15:00」）',
  training_type   TINYINT      NOT NULL COMMENT '训练类型：1=坐站训练 2=仰卧直腿抬高',
  target_count    INT          NOT NULL COMMENT '每人目标达标次数',
  deadline        DATETIME     NULL     COMMENT '任务截止时间（NULL=长期任务）',
  remark          VARCHAR(255) NULL     COMMENT '康复师备注说明',
  completed_count INT          NOT NULL DEFAULT 0 COMMENT '已完成人数（user_tasks 中 status=1 的数量，v14 语义）',
  status          TINYINT      NOT NULL DEFAULT 0 COMMENT '整体状态：0=未开始 1=进行中 2=全部完成 3=已过期',
  create_time     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  update_time     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (task_id),
  KEY idx_user_status (user_id, status),
  KEY idx_therapist (therapist_id),
  KEY idx_group (group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='训练任务表';

-- ──────────────────────────────────────────────
-- 3·1 任务分配表（v14 新增）：康复师任务 → 用户逐人分配与完成进度
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_tasks (
  task_id              VARCHAR(32) NOT NULL COMMENT '任务ID',
  user_id              VARCHAR(32) NOT NULL COMMENT '被分配用户',
  status               TINYINT     NOT NULL DEFAULT 0 COMMENT '0=待完成 1=已完成',
  completed_count      INT         NOT NULL DEFAULT 0 COMMENT '该用户累计完成达标次数（训练自动累加）',
  note                 VARCHAR(255) NULL    COMMENT '用户备注/向康复师反馈',
  completed_at         DATETIME    NULL     COMMENT '完成时间',
  completed_record_id  VARCHAR(32) NULL     COMMENT '达成任务的那次训练记录ID（训练记录页展示用）',
  PRIMARY KEY (task_id, user_id),
  KEY idx_user (user_id, status),
  KEY idx_record (completed_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='任务分配与完成进度表';

-- ──────────────────────────────────────────────
-- 3·2 康复师小组（v14 新增）：康复师建组、邀请用户、按组派发任务
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS therapist_groups (
  group_id      VARCHAR(32) NOT NULL COMMENT '小组唯一标识',
  name          VARCHAR(50) NOT NULL COMMENT '小组名称',
  therapist_id  VARCHAR(32) NOT NULL COMMENT '所属康复师',
  create_time   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (group_id),
  KEY idx_therapist (therapist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='康复师小组表';

CREATE TABLE IF NOT EXISTS group_members (
  group_id  VARCHAR(32) NOT NULL COMMENT '小组ID',
  user_id   VARCHAR(32) NOT NULL COMMENT '成员用户ID',
  joined    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '加入时间',
  PRIMARY KEY (group_id, user_id),
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='小组成员表';

-- ──────────────────────────────────────────────
-- 4. 跌倒事件表：仅事件摘要（时间/类型/取消/告警标记），无视频无帧数据
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fall_events (
  event_id       VARCHAR(32)  NOT NULL COMMENT '事件唯一标识',
  user_id        VARCHAR(32)  NOT NULL COMMENT '关联用户',
  event_time     DATETIME     NOT NULL COMMENT '事件触发时间',
  trigger_type   TINYINT      NOT NULL COMMENT '触发类型：1=自动检测 2=手动紧急呼救',
  is_canceled    TINYINT      NOT NULL DEFAULT 0 COMMENT '是否被用户取消（误报）',
  is_alert_sent  TINYINT      NOT NULL DEFAULT 0 COMMENT '是否发送真实告警（Demo 阶段恒为 0）',
  contact_name   VARCHAR(50)  NULL     COMMENT '当时紧急联系人姓名',
  remark         VARCHAR(255) NULL     COMMENT '备注',
  PRIMARY KEY (event_id),
  KEY idx_user_time (user_id, event_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='跌倒事件表';

-- ──────────────────────────────────────────────
-- 5. 紧急联系人表：可多个，is_default 标记默认联系人
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id         INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  user_id    VARCHAR(32)  NOT NULL COMMENT '关联用户',
  name       VARCHAR(50)  NOT NULL COMMENT '联系人姓名',
  phone      VARCHAR(20)  NOT NULL COMMENT '联系电话',
  relation   VARCHAR(20)  NULL     COMMENT '与用户关系',
  is_default TINYINT      NOT NULL DEFAULT 0 COMMENT '是否默认联系人',
  PRIMARY KEY (id),
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='紧急联系人表';

-- ──────────────────────────────────────────────
-- 6. 社群动态表：结构化文本摘要；图片为地址字符串（前端本地 base64 过大不上传）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_posts (
  post_id        VARCHAR(32)  NOT NULL COMMENT '动态唯一标识',
  user_id        VARCHAR(32)  NOT NULL COMMENT '关联用户',
  content        TEXT         NULL     COMMENT '文字内容',
  image_urls     TEXT         NULL     COMMENT '图片地址，逗号分隔（预留）',
  voice_duration INT          NOT NULL DEFAULT 0 COMMENT '语音时长（秒）',
  like_count     INT          NOT NULL DEFAULT 0 COMMENT '点赞数（预留）',
  comment_count  INT          NOT NULL DEFAULT 0 COMMENT '评论数（预留）',
  create_time    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发布时间',
  PRIMARY KEY (post_id),
  KEY idx_user_time (user_id, create_time),
  KEY idx_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='社群动态表';

-- ──────────────────────────────────────────────
-- 7. 用户配置表：云端配置备份，登录/换设备后随 sync/pull 恢复
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id              VARCHAR(32)  NOT NULL COMMENT '用户标识（与 users 一一对应）',
  interface_lang       VARCHAR(10)  NOT NULL DEFAULT 'cn' COMMENT '界面语言：cn/tc/en',
  voice_lang           VARCHAR(10)  NOT NULL DEFAULT 'zh-HK' COMMENT '语音识别语言 zh-CN/zh-HK/en-US',
  voice_broadcast      TINYINT      NOT NULL DEFAULT 1 COMMENT '语音播报开关',
  fall_detect_enabled  TINYINT      NOT NULL DEFAULT 1 COMMENT '跌倒检测开关',
  alert_delay          INT          NOT NULL DEFAULT 5 COMMENT '报警倒计时秒数 3/5/8/10',
  sensitivity          VARCHAR(10)  NOT NULL DEFAULT 'mid' COMMENT '检测灵敏度 low/mid/high',
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户配置表';

-- ──────────────────────────────────────────────
-- 8. 康复师端预留表（结构完整，暂不启用；康复师端开发后直接使用）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS therapists (
  id               INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  name             VARCHAR(50)  NOT NULL COMMENT '康复师姓名',
  job_number       VARCHAR(32)  NOT NULL COMMENT '工号（登录标识，唯一）',
  password_hash    VARCHAR(255) NOT NULL COMMENT '密码哈希（bcrypt）',
  department       VARCHAR(64)  NULL     COMMENT '科室/部门',
  permission_level TINYINT      NOT NULL DEFAULT 1 COMMENT '权限等级：1=初级 2=高级 3=管理员',
  create_time      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  status           TINYINT      NOT NULL DEFAULT 1 COMMENT '账号状态：1正常 0禁用',
  PRIMARY KEY (id),
  UNIQUE KEY uk_job_number (job_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='康复师账号表（预留）';

CREATE TABLE IF NOT EXISTS patient_therapist_relation (
  id           INT         NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  user_id      VARCHAR(32) NOT NULL COMMENT '用户ID',
  therapist_id INT         NOT NULL COMMENT '康复师ID（therapists.id）',
  bind_time    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '绑定时间',
  status       TINYINT     NOT NULL DEFAULT 1 COMMENT '绑定状态：1有效 0解除',
  PRIMARY KEY (id),
  KEY idx_user (user_id),
  KEY idx_therapist (therapist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户-康复师关联表（预留）';

CREATE TABLE IF NOT EXISTS therapist_remarks (
  id           INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  user_id      VARCHAR(32)  NOT NULL COMMENT '用户ID',
  therapist_id INT          NOT NULL COMMENT '康复师ID',
  content      TEXT         NOT NULL COMMENT '备注内容',
  create_time  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  KEY idx_user (user_id),
  KEY idx_therapist (therapist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='康复师备注表（预留）';

-- ════════════════════════════════════════════════════════════════
-- 可选演示数据（测试用，按需取消注释）：
-- ① 演示康复师账号（密码 bcrypt 哈希由后端工具生成，示例为占位）：
-- INSERT INTO therapists (name, job_number, password_hash, department, permission_level)
-- VALUES ('王康复师', 'T001', '<bcrypt-hash>', '康复科', 2);
-- ② 为某用户派发演示任务（user_id 替换为真实用户 ID）：
-- INSERT INTO training_tasks (task_id, user_id, training_type, target_count, deadline, remark, status)
-- VALUES (CONCAT('t', REPLACE(UUID(), '-', '')), '<user_id>', 1, 30, DATE_ADD(NOW(), INTERVAL 7 DAY), '每日坐站训练 30 次达标', 0);
-- ════════════════════════════════════════════════════════════════
