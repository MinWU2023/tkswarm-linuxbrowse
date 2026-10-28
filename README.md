# 第一页自研浏览器 Linux (`tkswarm-linuxbrowse`)

专为 **tkswarm-node** 长驻任务（客服坐席、持续私信等）设计的 **Linux 服务端指纹浏览器**。  
本地 API **与比特浏览器协议兼容**，Node **无需大改**——把 `browserApiUrl` 指到本服务即可。

与桌面版 `tkswarm-browses`（Win/Mac Electron）**协议兼容、工程独立**；本仓库为 **常驻 Node 服务 + Web 控制台**，适合机房/云主机 7×24 运行。

**能力补齐与对接计划：** 见仓库 [`docs/linuxbrowse-roadmap.md`](../docs/linuxbrowse-roadmap.md)。  
**坐席试点说明：** [`docs/linuxbrowse-pilot.md`](../docs/linuxbrowse-pilot.md)。

---

## 为什么不用 Win/Mac 桌面跑坐席？

| | Win/Mac 桌面 `tkswarm-browses` | Linux 服务 `tkswarm-linuxbrowse` |
|---|---|---|
| 场景 | 人机交互、开发调试 | 客服坐席、长时间挂任务 |
| 占用 | 占员工电脑 | 独立服务器 |
| 形态 | Electron 壳 | systemd / Docker |
| 有头 | 本机窗口 | Xvfb 虚拟显示；控制台可「显示窗口」切有头 |

---

## 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Node.js 18+** | 与 `tkswarm-browses` / Node 栈一致，易维护 |
| 比特兼容 API | **Express** | 复刻 `POST /health`、`/browser/*`，`BitBrowserProvider` 零改协议 |
| 内核 | **系统 Chromium / Chrome** | `--remote-debugging-port` → CDP → Playwright `connectOverCDP` |
| 有头（无显示器） | **Xvfb** | 每环境独占 DISPLAY |
| 远程盯屏 | **x11vnc + noVNC** | 浏览器打开 `/vnc.html?id=` |
| 指纹 / 代理 | 复用 browses 模块 | Canvas/WebGL 注入、SOCKS 账密桥、时区/地理 |
| 控制台 | **静态 Web UI** | 登录、用量、窗口列表、Token |
| 部署 | **Docker / systemd** | 长驻、可扩容 |

**刻意不做：** 不为 Node 另写一套私有协议；不引入第二套任务队列。

---

## 能力

- 多环境 / 多代理 / 多时区 / 独立 `user-data-dir`
- `browser/open` 支持 **有头 / 无头**（`args` 含 `--headless` 或 `headless: true`）
- 登录账号与 **TkSwarm 管理后台同一套**（`TKSWARM_API_BASE`）
- **多账号并发会话**：多人同时登录；Node 用各自 Bearer Token；默认**环境共用**（`owner_id` 仅计创建额度；`TKSWARM_STRICT_ENV_OWNER=1` 才按人隔离）
- 每账号最多 **300** 环境（`TKSWARM_BROWSER_MAX_ENVS`）
- 首页：本账号用量、子级汇总、并发会话（超管）、运行中窗口
- 无头可点 **显示窗口**；有头可点 **VNC 查看**（Xvfb + x11vnc + noVNC）
- `POST /health` → `provider: tkswarm-linuxbrowse`（Node `auto` 识别为 tkswarm 家族）
- **生产默认**：`browser/*` 强制 Bearer；Token 定时与 PHP `auth/status` 同步；启动/定时 GC；health 带窗口与内存粗指标
- **VNC**：监听 `0.0.0.0` 时需设 `TKSWARM_VNC_PASSWORD`（或显式 `TKSWARM_VNC_ALLOW_NOPW=1`）

---

## 冒烟

```bash
# 服务已启动后
npm run smoke          # health
npm run smoke:all      # health + lifecycle + cdp + vnc 页
# 全链路（需已登录 Token + 至少一个环境）
TKSWARM_SMOKE_TOKEN=xxx npm run smoke:lifecycle
TKSWARM_SMOKE_TOKEN=xxx npm run smoke:cdp
```

---

## 快速开始（Linux）

```bash
# 依赖
sudo apt-get update
sudo apt-get install -y nodejs npm chromium xvfb x11vnc ffmpeg fonts-noto-cjk

cd tkswarm-linuxbrowse
cp .env.example .env   # 编辑 TKSWARM_API_BASE
npm install
npm start
```

浏览器打开：`http://服务器IP:54345/`

1. 用与 Node 相同的账号登录（可多账号同时登录，互不踢下线）  
2. 复制页面上的 **API Token**（每个账号各自一份）  
3. tkswarm-node 设置：
   - `browserApiUrl` = `http://Linux主机:54345`
   - `browserApiToken` = 上一步 Token  
   - `browserBackend` = `tkswarm` 或 `auto`
4. 有头窗口在控制台点 **VNC 查看**，或打开 `/vnc.html?id=<环境ID>`

---

## Docker

```bash
docker build -t tkswarm-linuxbrowse .
docker run -d --name tkswarm-lb \
  -p 54345:54345 \
  -v lb-data:/data \
  -e TKSWARM_API_BASE=http://host.docker.internal:8080/api \
  tkswarm-linuxbrowse
```

---

## systemd

见 `deploy/tkswarm-linuxbrowse.service`。示例：

```bash
sudo useradd -r -s /usr/sbin/nologin tkswarm
sudo mkdir -p /opt/tkswarm-linuxbrowse /var/lib/tkswarm-linuxbrowse
sudo cp -a . /opt/tkswarm-linuxbrowse
sudo chown -R tkswarm:tkswarm /var/lib/tkswarm-linuxbrowse
cd /opt/tkswarm-linuxbrowse && sudo -u tkswarm npm install --omit=dev
sudo cp deploy/tkswarm-linuxbrowse.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tkswarm-linuxbrowse
```

---

## 与 Node 对接（几乎零改）

| Node 配置 | 值 |
|---|---|
| `browserApiUrl` / `BIT_API_URL` | `http://<linux-host>:54345` |
| `browserApiToken` / `BIT_API_TOKEN` | Web 登录后的 Token |
| `browserBackend` | `tkswarm` 或 `auto` |

### 多员工 / 多 Token（短期）

Linux 支持多账号同时登录，**每个账号一份 Bearer**。默认**同机环境共用**：任意已登录用户可列表/打开/关闭/改配/删除；`owner_id` 只用于创建额度（`MAX_ENVS_PER_USER`）。真·按人隔离时设 `TKSWARM_STRICT_ENV_OWNER=1`。

| 场景 | 做法 |
|------|------|
| 一台 Node 只服务一个坐席员工 | Node 填该员工在 Linux 控制台登录后的 Token |
| 多员工共用一台 Linux | 默认可共用同一批环境；各 Node 各自 Token 即可 |
| 需要按创建者隔离 | 设 `TKSWARM_STRICT_ENV_OWNER=1`（写操作仅创建者/超管） |
| 长期 | PHP 侧按员工 lease Token（roadmap L1-2） |

### 窗口收尸（keepBrowser）

- 默认 `TKSWARM_SESSION_STALE_MS=0`（坐席长挂不自动关）
- 批任务可设例如 `3600000`（1h 无 open/detail/heartbeat 则 close）
- Node 在 `keepBrowser` 仅断 CDP 时会调 `POST /browser/heartbeat` 保活

已实现接口（与比特 / 桌面版一致）：

- `POST /health`
- `POST /group/list|add|edit|delete`
- `POST /browser/list|detail|open|close|delete|clear|update|update/partial|heartbeat|screenshot`
- `POST /browser/record/start|stop`（有头短时录屏，需 ffmpeg）
- `POST /browser/host/rebind`（环境粘滞重绑到本机 `hostId`）
- `POST /browser/proxy/update`
- `GET /healthz`、`GET /metrics`（LB / Prometheus 探针）

试点快照：`npm run pilot:snapshot`（可选 `TKSWARM_SMOKE_TOKEN`）。

`open` 成功返回 `{ ws, http, pid, headless, lastIp, ... }`，供 Playwright CDP。  
失败时可带 `errCode`：`AUTH_REQUIRED` / `TOKEN_INVALID` / `CONCURRENT_LIMIT` / `PROXY_PROBE_FAIL` 等。

---

## 架构

```text
tkswarm-node 任务（客服坐席 / 发布 / 养号 …）
        ↓ BitBrowserProvider（已有）
POST :54345 /browser/open → CDP ws
        ↓
tkswarm-linuxbrowse (Express)
        ↓ spawn Chromium (+ Xvfb 若有头)
独立 profile · 代理 · 指纹 · 时区
```

---

## 环境变量

见 `.env.example`。

---

## 与 `tkswarm-browses` 的关系

| | browses | linuxbrowse |
|---|---|---|
| 协议 | 比特兼容 | 比特兼容（契约对齐，代码独立） |
| UI | Electron | 浏览器访问 Web |
| OS | Win / Mac | Linux |
| 用途 | 办公机 | 服务器长驻 |

两端各自演进；对 Node 只保证比特兼容 API 契约一致。本仓库面向 Linux 运维与容量。
