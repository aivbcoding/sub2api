# 故障排查手册

## 三种"没号"错误码（gateway.ts 选号失败分支，约 L829-876）

| 错误 | 含义 | 处置 |
|---|---|---|
| 429 `upstream_rate_limited` | 平台有账号，但全部在冷却（上游 429） | 按 `Retry-After` 等待后重试 |
| 503 `no_upstream_account` | **判定出的平台下没有任何账号** —— 多数情况是路由判错了平台，而不是真没配账号 | 按下方步骤排查 |
| 503 `no_available_account` | 有账号但被停用 / 不可调度 | 检查账号 `status` 与 `schedulable` |

> 报错文案看着像"没配账号"，实际最常见成因是**模型被判定到了没有账号的平台**。

## 503 no_upstream_account 排查步骤

1. **跑诊断**（worker/ 目录，Node ≥ 22，见 [ops-environment.md](ops-environment.md)）：
   ```powershell
   & "C:\Users\admin\AppData\Roaming\nvm\v24.3.0\node.exe" tools/diag-model-routing.mjs <模型名...>
   ```
   输出「① 重定向表命中 → ② 分组 platform → ③ 自动发现 → 最终平台 → 可用账号 → 最终 URL」完整链路，与线上 `inferPlatform` 同规则。
2. **看最终平台名是否真实存在**。最常见根因：重定向表残留指向不存在/写错平台名的条目（例如指向 `deepseek`，而账号平台实际叫 `chatapiweixin`）。
3. 若走的是自动发现：去对应账号跑「模型获取」；上游不支持列模型时（如微信账号，见 [inventory.md](inventory.md)），靠**重定向表或账号别名**显式声明。
4. **全量体检**：把所有分组的「重定向表 / 模型关联白名单 / 分组平台」里声明的平台名，与账号表实际平台逐一比对：
   ```sql
   SELECT DISTINCT platform FROM accounts WHERE deleted_at IS NULL;
   ```
   白名单条目（`平台::模型`）的平台前缀同样会锁路由，也要核对。

## 案例实录

### 2026-09-24：Deepseek-v4-flash 报 503 no_upstream_account

- **现象**：请求 `Deepseek-v4-flash` 返回
  `No upstream account configured for platform "deepseek"`，且 configured platforms（anthropic, chatapiweixin, gemini, gitcode, sensenova, siliconflow）里确实没有 deepseek。
- **排查**：`diag-model-routing.mjs` 显示 ① 分组重定向表命中
  `"Deepseek-v4-flash": {"platform":"deepseek","model":"Deepseek-v4-flash"}` —— 重定向优先级最高，直接把平台定死为 `deepseek`，而该平台无账号。别名设置（chatapiweixin::Deepseek-v4-flash）与分组关联（chatapiweixin::Deepseek-v4-flash）本身都没配错，但全被重定向表盖过。
- **根因**：default 分组重定向表残留旧条目，平台名误写成模型家族名 `deepseek`（账号表里真实平台叫 `chatapiweixin`）。
- **修复**（D1 远程执行）：
  ```sql
  UPDATE groups SET model_platform_routing = json_set(
    model_platform_routing,
    '$."Deepseek-v4-flash"',
    json('{"platform":"chatapiweixin","model":"Deepseek-v4-flash"}')
  ) WHERE id = 1;
  ```
- **验证**：重跑诊断 → `Deepseek-v4-flash` 最终平台 = chatapiweixin → 账号 #9 微信 ✅；全小写 `deepseek-v4-flash` 仍走 sensenova（大小写分流保持不变）。
- **教训**：
  1. 「模型 → 平台 重定向」优先级最高，排障**先查它**，再查别名/关联；
  2. 平台名必须用账号表里的真实 `platform` 值，不要顺手写成模型家族名；
  3. 改完用诊断脚本验证"模型 → 平台 → 账号 → URL"全链路，别只看单一配置。
