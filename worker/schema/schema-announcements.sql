-- ============================================================
-- 公告
-- 用法: npx wrangler d1 execute sub2api --file=./schema/schema-announcements.sql --remote -y
--       npx wrangler d1 execute sub2api --file=./schema/schema-announcements.sql --local  -y
--
-- 背景:
--   管理员在「公告管理」菜单维护公告(标题 + 详情);
--   普通用户登录成功后自动弹窗一次, 顶栏右侧也有一个公告按钮可随时查看。
--
-- 设计要点:
--   1. **一条公告 = 一行**, 不是 settings 表里的一个大字符串。
--      旧实现把公告存成 settings.announcement 单串(只有正文、没有标题),
--      既不能有多条, 也没法撤回。这里改成真表, 同时**兼容读旧键**:
--      新表为空时后端会退回去读 settings.announcement 当"只有正文的历史公告"。
--   2. `status` 只有 'published'(已发布) / 'draft'(草稿) 两种取值。
--      **登录弹窗与顶栏按钮只读 published** —— 草稿是给运营存着改的。
--      不给软删行之外的第二套"可见性"字段, 免得出现"三条字段两两打架"。
--   3. `pinned` = 置顶。列表按 `pinned DESC, id DESC` 排 ——
--      用自增主键排序, 不受 created_at 两种存储格式(带 Z / 不带)影响。
--   4. **软删除**(deleted_at)。公告发出去就有人看过, 硬删会让审计对不上。
--      所有查询都必须带 `deleted_at IS NULL`。
--   5. `revision` = 内容版本号。前端把"已读版本"记在 localStorage,
--      **每次编辑公告(改标题或正文) revision += 1** ——
--      于是"公告改了"这件事会重新触发一次自动弹窗, 而没改就不打扰用户。
--      (用 updated_at 做这件事会被"仅改状态"之类的无关写入误触发, 所以给独立计数列。)
-- ============================================================

CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'published',   -- published | draft
  pinned     INTEGER NOT NULL DEFAULT 0,             -- 0/1, 置顶
  revision   INTEGER NOT NULL DEFAULT 1,             -- 内容版本, 编辑一次 +1
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

-- 列表查询固定是 "where deleted_at is null order by pinned desc, id desc"
CREATE INDEX IF NOT EXISTS idx_announcements_list ON announcements(deleted_at, pinned DESC, id DESC);
