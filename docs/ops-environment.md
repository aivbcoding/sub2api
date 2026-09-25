# 运维环境备忘

## Node 版本（重要）

- 本机系统默认 `node` 是 **v14.19.2**，而 wrangler 4 要求 **Node ≥ 22**——直接 `node tools/xxx.mjs` 调 wrangler 会报
  `Wrangler requires at least Node.js v22.0.0`。
- nvm 已装 `24.3.0` / `18.15.0` / `14.19.2`（当前默认 14）。**用 24.3.0 显式调用**，不要切换全局默认：

  ```powershell
  & "C:\Users\admin\AppData\Roaming\nvm\v24.3.0\node.exe" tools/diag-model-routing.mjs Deepseek-v4-flash
  ```

## wrangler / D1 常用命令（均在 `worker/` 目录执行）

```powershell
# 查询远程 D1（输出 JSON）
& "C:\Users\admin\AppData\Roaming\nvm\v24.3.0\node.exe" node_modules\wrangler\bin\wrangler.js `
  d1 execute sub2api --remote --json --command "SELECT id,name,platform FROM accounts WHERE deleted_at IS NULL" -y

# 模型路由诊断（默认 remote；加 --local 查本地）
& "C:\Users\admin\AppData\Roaming\nvm\v24.3.0\node.exe" tools/diag-model-routing.mjs <模型名...>

# 部署（predeploy 自动先跑 npm run check）
npm run deploy
```

注意：

- wrangler 运行日志写在 `C:\Users\admin\AppData\Roaming\xdg.config\.wrangler\logs`，受限环境可能拦截该写入（命令本身仍会执行完）。
- `wrangler d1 execute` 失败会自动回滚，可安全重试。
- 登录 Cloudflare 用 `01-login.bat`（交互式，无法代跑）。

## 安全红线

- **不要**写脚本把生产库里的上游凭证 / API Key 读到本地再拼请求——会被安全策略拦截，且任何日志/报错都可能泄漏密钥。
  账号级操作（连通性测试、模型获取）一律走**后台管理页面 / worker 自己的管理接口**，凭证不出服务器。
- 文档、命令输出、工单里都不出现明文密钥；引用配置时用账号名代替。

## 后台入口与常用页面

- 地址：https://sub2api.aixm.ccwu.cc/ （根目录即控制台，未登录跳 `/login`）
- **分组 → 编辑**：「模型 → 平台 重定向」JSON / 模型关联（平台::模型）/ 平台
- **模型 / 别名设置**：账号级别名列表 + 从上游批量获取别名
- **上游账号**：连通性测试、启停、「清空粘性会话」

## 粘性会话

调度器有粘性会话（默认缓存 1 小时）：改完账号配置（换 key / 换 base_url）后，旧会话可能仍走旧配置，表现为"改了不生效"。处置：上游账号页 →「清空粘性会话」，立即重新选号。

## 相关文档

- 部署 / 功能全量说明：`worker/README.md`
- 路由机制：[routing.md](routing.md) · 排障：[troubleshooting.md](troubleshooting.md) · 资源现状：[inventory.md](inventory.md)
