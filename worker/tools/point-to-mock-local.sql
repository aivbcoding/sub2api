-- 本地 D1: 把账号 base_url 指向 mock(9099), 用于协议转换回归测试
--
-- 跑 test/translate-e2e.mjs 前执行, 跑完**务必**用 tools/reset-local.sql 复位
-- (否则标准 e2e 的"上游 401"用例会变成打到 mock 而失败)。
UPDATE accounts SET base_url = 'http://127.0.0.1:9099' WHERE deleted_at IS NULL;
