# sub2api 运维知识库

本目录沉淀 sub2api（Cloudflare Workers 移植版）生产运维中踩过的坑与结论，按主题分文件：

| 文件 | 内容 |
|---|---|
| [code-fixes.md](code-fixes.md) | 代码优化与修复记录：部署批次总览 + 路由/翻译/计费/安全/UI 各维度 |
| [routing.md](routing.md) | 模型路由机制：平台判定优先级、重定向表、模型关联、别名、大小写坑 |
| [troubleshooting.md](troubleshooting.md) | 故障排查手册：三种"没号"错误码、诊断工具、案例实录 |
| [inventory.md](inventory.md) | 生产资源快照：上游账号、分组、Key、路由配置现状 |
| [ops-environment.md](ops-environment.md) | 运维环境备忘：Node 版本、wrangler 用法、安全红线 |

- 线上地址：https://sub2api.aixm.ccwu.cc/ （根目录即管理后台）
- 代码：`worker/`（路由核心在 `worker/src/gateway.ts`）
- 快照时间：**2026-09-24**，配置有改动时请同步更新 [inventory.md](inventory.md)

> 完整部署/功能说明见 `worker/README.md`，本目录只记录运维视角的经验。
