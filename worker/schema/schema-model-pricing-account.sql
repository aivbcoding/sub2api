-- ============================================================
-- 迁移: model_pricing 支持「账号级定价」
--
-- 背景: 之前 model_pricing 是**全局**按模型名一张表(主键 model)。
-- 同一个模型名在不同上游账号上价格不同时只能配一份; 删除账号时
-- 也无法级联清掉它的定价。
--
-- 改动:
--   1. account_id = 0 表示「全局兜底价」(老数据全部映射到 0, 行为不变)
--   2. account_id = N(N>0) 表示「该账号专属价」, 与全局价并存
--   3. 复合主键 (account_id, model) —— 同模型可在不同账号下配不同价
--
-- 说明: 不用 NULL 表示全局是因为 SQLite 复合主键里 NULL 互不相同,
--   (NULL,'gpt-3') 能插多行, 全局兜底唯一性无法保证。用 0 作哨兵
--   则主键天然保证「每个账号每个模型只有一份」。
--
-- 计费解析顺序 (见 billing.ts resolveModelPrice):
--   ① (请求账号, model) 账号级价  ② (0, model) 全局价  ③ 默认价
--
-- 用法: npx wrangler d1 execute sub2api --file=./schema-model-pricing-account.sql --remote -y
-- ============================================================

-- SQLite 改主键必须重建表
ALTER TABLE model_pricing RENAME TO model_pricing_old;

CREATE TABLE IF NOT EXISTS model_pricing (
  account_id            INTEGER NOT NULL DEFAULT 0,  -- 0=全局兜底; >0=账号专属
  model                 TEXT    NOT NULL,
  input_price           INTEGER NOT NULL DEFAULT 0,
  output_price          INTEGER NOT NULL DEFAULT 0,
  cache_read_price      INTEGER NOT NULL DEFAULT 0,
  cache_creation_price  INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, model)
);

-- 老数据全部搬到 account_id=0(全局兜底), 计费行为与改前一致
INSERT INTO model_pricing (account_id, model, input_price, output_price, cache_read_price, cache_creation_price, updated_at)
SELECT 0, model, input_price, output_price, cache_read_price, cache_creation_price, updated_at
FROM model_pricing_old;

DROP TABLE model_pricing_old;

-- 按账号查 + 按模型全局查都要快
CREATE INDEX IF NOT EXISTS idx_model_pricing_account ON model_pricing(account_id);
CREATE INDEX IF NOT EXISTS idx_model_pricing_model    ON model_pricing(model);