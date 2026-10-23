# 第一页自研浏览器 Linux：推代码与 Linux 部署教程

> 项目目录：`tkswarm-linuxbrowse/`  
> 形态：**常驻 Node 服务**（非 Electron），部署在 Linux 机房/云主机  
> 与桌面自研版 `tkswarm-browses` **协议兼容、工程独立**——只对齐比特兼容 API  
> 相关：[`README.md`](./README.md) · [`docs/linuxbrowse-pilot.md`](../docs/linuxbrowse-pilot.md)

---

## 0. 和桌面版发版的区别

| | 桌面 `tkswarm-browses` | Linux `tkswarm-linuxbrowse` |
|--|------------------------|------------------------------|
| 产物 | Win EXE / Mac DMG（CI 打 tag） | **源码/目录部署**，无安装包 tag 流程 |
| 推代码 | `git push` + `browser-v*` 触发打包 | `git push` 后在服务器 **pull + 重启** |
| 运行 | 员工本机 Electron | `systemd` / Docker 长驻 |
| 端口 | 本机 `127.0.0.1:54345` | 服务器 `0.0.0.0:54345`（务必防火墙） |

Linux 版 **没有** 类似 `browser-v*` 的自动打安装包流程；发版 = 推远端 + 服务器更新代码并重启服务。

---

## 1. 推代码（开发机 / Windows）

在 **monorepo 根目录** 操作：

```powershell
# 查看改动
git status
git diff tkswarm-linuxbrowse/

# 暂存并提交
git add tkswarm-linuxbrowse/
git commit -m "feat(linuxbrowse): 说明本次改动"

# 推到远端（分支名按实际替换）
git push origin HEAD
```

可选：改版本号（便于对照服务器上的 `package.json`）：

```powershell
cd tkswarm-linuxbrowse
npm version 1.0.1 --no-git-tag-version
cd ..
git add tkswarm-linuxbrowse/package.json tkswarm-linuxbrowse/package-lock.json
git commit -m "chore(linuxbrowse): bump version to 1.0.1"
git push origin HEAD
```

> 打 `git tag` **不是** Linux 部署的必需步骤；除非你们另有约定，否则以分支推送 + 服务器 pull 为准。

---

## 2. 服务器首次部署（systemd，推荐）

以下以 **Ubuntu / Debian** 为例，安装路径 `/opt/tkswarm-linuxbrowse`，数据目录 `/var/lib/tkswarm-linuxbrowse`。

### 2.1 系统依赖

```bash
sudo apt-get update
sudo apt-get install -y \
  nodejs npm \
  chromium-browser \
  xvfb x11vnc \
  ffmpeg \
  fonts-noto-cjk \
  git
```

> 部分发行版包名是 `chromium` 或需装 `google-chrome-stable`。装好后可用：  
> `which chromium || which chromium-browser || which google-chrome-stable`

Node 建议 **≥ 18**（`package.json` engines）。若 apt 版本过旧，用 NodeSource / nvm 安装。

### 2.2 系统用户与目录

```bash
sudo useradd -r -s /usr/sbin/nologin tkswarm || true
sudo mkdir -p /opt/tkswarm-linuxbrowse /var/lib/tkswarm-linuxbrowse
sudo chown -R tkswarm:tkswarm /var/lib/tkswarm-linuxbrowse
```

### 2.3 拉取代码

**方式 A：整仓 clone（推荐，路径清晰）**

```bash
# 例：放到临时目录再拷贝子目录，或整仓放 /opt/TkSwarm-Rebuild
sudo git clone <你的仓库URL> /opt/TkSwarm-Rebuild
sudo cp -a /opt/TkSwarm-Rebuild/tkswarm-linuxbrowse/. /opt/tkswarm-linuxbrowse/
sudo chown -R root:root /opt/tkswarm-linuxbrowse
# node_modules 与运行用户：安装时用 tkswarm
```

**方式 B：只同步 `tkswarm-linuxbrowse` 目录**（rsync / scp）

```bash
# 在开发机（PowerShell / Git Bash）示例：
# scp -r tkswarm-linuxbrowse user@linux-host:/tmp/
# 服务器上：
sudo cp -a /tmp/tkswarm-linuxbrowse/. /opt/tkswarm-linuxbrowse/
```

### 2.4 配置环境变量

```bash
sudo cp /opt/tkswarm-linuxbrowse/.env.example /etc/tkswarm-linuxbrowse.env
sudo nano /etc/tkswarm-linuxbrowse.env
```

**必改 / 强烈建议：**

```bash
# PHP API（与 Node、Web 控制台同一套 admin 登录）
TKSWARM_API_BASE=http://你的-api域名或内网IP/api

TKSWARM_BROWSER_HOST=0.0.0.0
TKSWARM_BROWSER_PORT=54345
TKSWARM_BROWSER_DATA=/var/lib/tkswarm-linuxbrowse

# 监听非本机时必须设 VNC 密码（否则有头 VNC 会被拒）
TKSWARM_VNC_PASSWORD=请改成强密码

# 多机时建议固定
TKSWARM_HOST_ID=lb-seat-01

TKSWARM_BROWSER_XVFB=1
TKSWARM_CHROME_NO_SANDBOX=1
TKSWARM_BROWSER_MAX_CONCURRENT=40
```

完整项见项目内 [`.env.example`](./.env.example)。

### 2.5 安装依赖

```bash
cd /opt/tkswarm-linuxbrowse
sudo -u tkswarm npm install --omit=dev
# 若 postinstall 拉 Chromium 失败，可稍后：
# sudo -u tkswarm npm run chromium
```

### 2.6 安装 systemd 并启动

```bash
sudo cp /opt/tkswarm-linuxbrowse/deploy/tkswarm-linuxbrowse.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tkswarm-linuxbrowse
sudo systemctl status tkswarm-linuxbrowse
```

服务文件要点（已写在 `deploy/tkswarm-linuxbrowse.service`）：

- `WorkingDirectory=/opt/tkswarm-linuxbrowse`
- `EnvironmentFile=-/etc/tkswarm-linuxbrowse.env`
- `ExecStart=/usr/bin/node .../src/server/main.js`
- 数据目录：`TKSWARM_BROWSER_DATA=/var/lib/tkswarm-linuxbrowse`

### 2.7 防火墙

```bash
# 仅内网 / VPN 可访问 54345（按实际网段改）
sudo ufw allow from 10.0.0.0/8 to any port 54345
# 或先不开公网，只走内网安全组
```

**不要把 54345 裸暴露到公网。**

### 2.8 验收

```bash
# 健康检查
curl -sS -X POST http://127.0.0.1:54345/health -H 'Content-Type: application/json' -d '{}'
# 期望 provider 含 tkswarm-linuxbrowse

# 日志
journalctl -u tkswarm-linuxbrowse -f
```

浏览器打开：`http://<Linux主机>:54345/`

1. 用 **tkswarm-api 同一套账号密码** 登录  
2. 复制页面上的 **API Token**  
3. Node 设置：
   - `browserApiUrl` = `http://<Linux主机>:54345`
   - `browserApiToken` = 上一步 Token  
   - `browserBackend` = `tkswarm` 或 `auto`  
4. Node「检测」应显示 **第一页自研浏览器 Linux**（及 hostId）

冒烟（服务已起）：

```bash
cd /opt/tkswarm-linuxbrowse
sudo -u tkswarm npm run smoke
# 全量（需 Token + 环境时）：
# TKSWARM_SMOKE_TOKEN=xxx sudo -u tkswarm -E npm run smoke:all
```

---

## 3. 日常更新部署（推代码之后）

开发机 `git push` 后，在 **Linux 服务器**：

### 3.1 整仓 git 更新

```bash
cd /opt/TkSwarm-Rebuild   # 你的 clone 路径
sudo git fetch origin
sudo git checkout <分支名>
sudo git pull origin <分支名>

# 同步到运行目录（若运行目录与仓库分离）
sudo rsync -a --delete \
  --exclude node_modules \
  --exclude data \
  /opt/TkSwarm-Rebuild/tkswarm-linuxbrowse/ \
  /opt/tkswarm-linuxbrowse/

cd /opt/tkswarm-linuxbrowse
sudo -u tkswarm npm install --omit=dev
sudo systemctl restart tkswarm-linuxbrowse
sudo systemctl status tkswarm-linuxbrowse --no-pager
```

### 3.2 一键更新脚本示例

保存为 `/opt/tkswarm-linuxbrowse/deploy/update.sh`（可自行创建）：

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO=/opt/TkSwarm-Rebuild
APP=/opt/tkswarm-linuxbrowse
BRANCH="${1:-main}"

cd "$REPO"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

rsync -a --delete \
  --exclude node_modules \
  --exclude '.env' \
  --exclude 'data' \
  "$REPO/tkswarm-linuxbrowse/" "$APP/"

cd "$APP"
sudo -u tkswarm npm install --omit=dev
systemctl restart tkswarm-linuxbrowse
systemctl --no-pager status tkswarm-linuxbrowse
echo "OK: updated to $(git -C "$REPO" rev-parse --short HEAD)"
```

```bash
sudo chmod +x /opt/tkswarm-linuxbrowse/deploy/update.sh
sudo /opt/tkswarm-linuxbrowse/deploy/update.sh main
```

> **不要** 用 rsync `--delete` 清掉 `/var/lib/tkswarm-linuxbrowse`（Cookie / profile 在数据目录，不在源码树）。

---

## 4. Docker 部署（可选）

```bash
cd /path/to/tkswarm-linuxbrowse
docker build -t tkswarm-linuxbrowse .

docker run -d --name tkswarm-lb --restart=unless-stopped \
  -p 54345:54345 \
  -v lb-data:/data \
  -e TKSWARM_API_BASE=http://你的API/api \
  -e TKSWARM_BROWSER_HOST=0.0.0.0 \
  -e TKSWARM_BROWSER_PORT=54345 \
  -e TKSWARM_BROWSER_DATA=/data \
  -e TKSWARM_VNC_PASSWORD=请改成强密码 \
  -e TKSWARM_HOST_ID=lb-docker-01 \
  -e TKSWARM_BROWSER_XVFB=1 \
  -e TKSWARM_CHROME_NO_SANDBOX=1 \
  tkswarm-linuxbrowse
```

更新镜像后：

```bash
docker build -t tkswarm-linuxbrowse .
docker stop tkswarm-lb && docker rm tkswarm-lb
# 再执行上面的 docker run（-v lb-data 保留数据）
```

---

## 5. 运维常用命令

```bash
# 启停
sudo systemctl start|stop|restart tkswarm-linuxbrowse
sudo systemctl status tkswarm-linuxbrowse

# 日志
journalctl -u tkswarm-linuxbrowse -f
journalctl -u tkswarm-linuxbrowse --since "1 hour ago"

# 健康 / 指标
curl -sS http://127.0.0.1:54345/healthz
curl -sS http://127.0.0.1:54345/metrics

# 试点快照（对照一周用）
cd /opt/tkswarm-linuxbrowse
TKSWARM_SMOKE_TOKEN=<token> sudo -u tkswarm -E npm run pilot:snapshot -- --note day1
# 报告在 data/pilot/（若 DATA 指向 /var/lib/... 则在那）
```

---

## 6. 多机与换机

- 每台设不同 `TKSWARM_HOST_ID`（或不设，用主机名）
- 环境首次 `open` 会粘滞 `boundHostId`；打到错机会 `HOST_MISMATCH`
- **换机**：控制台导出 profile `.tgz` → 新机导入；或 `POST /browser/host/rebind`
- 关闭粘滞：`TKSWARM_STICKY_HOST=0`

---

## 7. 与 Node 对接检查清单

- [ ] `TKSWARM_API_BASE` 指向正确，Web 控制台能登录  
- [ ] Node `browserApiUrl` = `http://Linux:54345`  
- [ ] Node `browserApiToken` = 该员工登录后的 Token（勿多人共用超管 Token 跑业务）  
- [ ] `browserBackend` = `tkswarm` 或 `auto`  
- [ ] 检测显示 **第一页自研浏览器 Linux** + hostId  
- [ ] 防火墙仅内网/VPN  
- [ ] 已设 `TKSWARM_VNC_PASSWORD`（若有头盯屏）  
- [ ] `npm run smoke` / `smoke:all` 通过  

回滚 Node：设 `browserBackend=bit` 或把 API 地址改回桌面 `127.0.0.1:54345`，业务代码无需改。

---

## 8. 常见问题

| 问题 | 处理 |
|------|------|
| 服务起不来 | `journalctl -u tkswarm-linuxbrowse -e`；检查 `node` 路径、`.env`、`TKSWARM_API_BASE` |
| VNC 打不开 | 是否设了 `TKSWARM_VNC_PASSWORD`；是否真有头窗口；防火墙是否放行（VNC 多走同端口 Web） |
| Chrome 起不来 | 装 chromium；设 `TKSWARM_CHROME_PATH`；容器内保持 `NO_SANDBOX=1` |
| Token 无效 | 重新在 Web 控制台登录复制；确认 API 能访问 `auth/status` |
| 内存爆 | 下调 `TKSWARM_BROWSER_MAX_CONCURRENT`；关掉不用的窗口 |
| pull 后旧代码仍在跑 | 确认 rsync 目标、`systemctl restart`、看 `ExecStart` 路径是否仍是旧目录 |
| 登录失败 | `TKSWARM_API_BASE` 须带 `/api` 且 Linux 机能访问 PHP |

---

## 9. 推荐日常节奏（复制即用）

**开发机：**

```powershell
git add tkswarm-linuxbrowse/
git commit -m "feat(linuxbrowse): ..."
git push origin HEAD
```

**服务器：**

```bash
sudo /opt/tkswarm-linuxbrowse/deploy/update.sh main
# 或手动 git pull + rsync + npm install + systemctl restart
curl -sS -X POST http://127.0.0.1:54345/health -H 'Content-Type: application/json' -d '{}'
```

---

## 10. 相关路径

| 说明 | 路径 |
|------|------|
| 源码 | `tkswarm-linuxbrowse/` |
| 环境变量示例 | `tkswarm-linuxbrowse/.env.example` |
| systemd 单元 | `tkswarm-linuxbrowse/deploy/tkswarm-linuxbrowse.service` |
| Dockerfile | `tkswarm-linuxbrowse/Dockerfile` |
| 本教程 | `tkswarm-linuxbrowse/tkswarm-linuxbrowse-deploy.md` |
| 试点对照 | `docs/linuxbrowse-pilot.md` |
| 能力路线图 | `docs/linuxbrowse-roadmap.md` |
