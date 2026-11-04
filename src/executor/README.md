# 内置任务执行核心（纯净）

本目录是 **服务器浏览器自己的任务执行器**，不依赖旁路 `tkswarm-node` 进程或源码路径。

## 职责

- 从中心 API `claim` 领取 `cs_seat` / linux `ai_lead` 总任务
- 最多 3 路并发，跑完立刻补位
- 本机开窗（回环 `127.0.0.1:54345`）+ CDP 跑坐席/拓客等业务
- 日志写入中心库 `account_work_logs`
- 支持重试入队、强制关停

## 入口

| 文件 | 作用 |
|------|------|
| `queue.js` | 并发队列（领取 / 补位 / kick / forceStop） |
| `runner.js` | 总任务 / 分任务执行 |
| `browser/*` | TikTok / CDP / 坐席 / 拓客 业务 |
| `php-api.js` | 中心 API 客户端 |

由 `src/worker/index.js` 在 HTTP 服务 listen 后启动，任务页 `/api/executor-queue` 读本机状态。

## 不含

- 桌面管理后台 UI / 路由
- WSS 前台推送领取（`executor-hub` 仅为占位 stub）
- 比特桌面流水线（publish/warm 等仅因历史模块耦合残留代码，服务器队列不会领 general）
