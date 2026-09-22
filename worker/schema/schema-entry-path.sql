-- 入口路径(entry_path) —— 让「请求 URL」而不是「模型名」决定走哪条上游。
--
-- 背景: 之前平台判定只能靠模型名(重定向表 / 账号模型索引), 一旦同一个模型名
-- 在多家中转上都有、或上游根本没暴露模型列表, 就没法精确指定"这次走哪条"。
-- 现在给每条上游账号配一个入口路径, 客户端请求 /<entry>/v1/chat/completions
-- 即直接锁定该账号(它的 base_url + 它的别名表), 完全不经过模型名判定。
--
-- 惯例: 这里破例用了**真实列**而不是 accounts.extra —— 因为它是路由的**查找键**,
-- 需要唯一约束与索引; 塞进 extra 的 JSON 里只能全表扫描字符串, 既慢又不可靠。
-- (extra 仍用于 model_aliases 这类"读多写少、不需要被检索"的字段。)

ALTER TABLE accounts ADD COLUMN entry_path TEXT;

-- 部分唯一索引: 空值不参与唯一性(大量账号本来就没有入口路径)
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_entry_path
  ON accounts(entry_path)
  WHERE entry_path IS NOT NULL AND entry_path <> '';
