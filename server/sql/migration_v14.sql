-- ════════════════════════════════════════════════════════════════
-- v13 → v14 增量迁移（老库升级用；新库直接执行 init.sql 即可）
-- 新增：康复师角色/名称/电话、康复师小组、任务分配、记录-任务关联
-- 执行：mysql -u root -p knee_d < migration_v14.sql
-- ════════════════════════════════════════════════════════════════

-- users：康复师角色 + 显示名称 + 电话
ALTER TABLE users
  ADD COLUMN name  VARCHAR(50)  NULL     COMMENT '显示名称（康复师端按名称搜索用户）' AFTER nickname,
  ADD COLUMN role  TINYINT      NOT NULL DEFAULT 1 COMMENT '角色：1=康复用户 2=康复师' AFTER name,
  ADD COLUMN phone VARCHAR(20)  NULL     COMMENT '联系电话' AFTER role;

-- training_records：任务关联（训练记录页展示任务完成）
ALTER TABLE training_records
  ADD COLUMN task_id        VARCHAR(32) NULL COMMENT '关联的康复师任务' AFTER device_info,
  ADD COLUMN task_completed TINYINT     NOT NULL DEFAULT 0 COMMENT '本次训练是否达成任务目标' AFTER task_id,
  ADD KEY idx_task (task_id);

-- training_tasks：小组任务字段（title/sets/time_text/group_id）
ALTER TABLE training_tasks
  MODIFY COLUMN user_id VARCHAR(32) NULL COMMENT 'v13 兼容：单人任务直接归属用户（小组任务为 NULL）',
  ADD COLUMN group_id  VARCHAR(32)  NULL COMMENT '所属小组' AFTER therapist_id,
  ADD COLUMN title     VARCHAR(100) NULL COMMENT '任务动作标题' AFTER group_id,
  ADD COLUMN sets      VARCHAR(50)  NULL COMMENT '组数/要求' AFTER title,
  ADD COLUMN time_text VARCHAR(50)  NULL COMMENT '友好时间文案' AFTER sets,
  ADD KEY idx_group (group_id);

-- 任务分配表
CREATE TABLE IF NOT EXISTS user_tasks (
  task_id              VARCHAR(32) NOT NULL COMMENT '任务ID',
  user_id              VARCHAR(32) NOT NULL COMMENT '被分配用户',
  status               TINYINT     NOT NULL DEFAULT 0 COMMENT '0=待完成 1=已完成',
  completed_count      INT         NOT NULL DEFAULT 0 COMMENT '该用户累计完成达标次数',
  note                 VARCHAR(255) NULL    COMMENT '用户备注/向康复师反馈',
  completed_at         DATETIME    NULL     COMMENT '完成时间',
  completed_record_id  VARCHAR(32) NULL     COMMENT '达成任务的那次训练记录ID',
  PRIMARY KEY (task_id, user_id),
  KEY idx_user (user_id, status),
  KEY idx_record (completed_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='任务分配与完成进度表';

-- 康复师小组
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
