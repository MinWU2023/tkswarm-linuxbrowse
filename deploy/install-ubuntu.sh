#!/usr/bin/env bash
# 第一页自研浏览器 Linux — Ubuntu 一键部署
# 用法（root）:
#   curl -fsSL .../install-ubuntu.sh | sudo bash
#   sudo bash install-ubuntu.sh --api-base http://api.example.com/api --vnc-password 'YourStrongPass'
#
# 环境变量（可选，与参数二选一）:
#   TKSWARM_GIT_URL      默认 https://github.com/MinWU2023/tkswarm-linuxbrowse.git
#   TKSWARM_GIT_BRANCH   默认 main
#   TKSWARM_API_BASE     PHP API 地址，须带 /api
#   TKSWARM_VNC_PASSWORD VNC 密码（监听 0.0.0.0 时强烈建议设置）
#   TKSWARM_APP_DIR      默认 /opt/tkswarm-linuxbrowse
#   TKSWARM_DATA_DIR     默认 /var/lib/tkswarm-linuxbrowse
#   TKSWARM_HOST_ID      多机标识，默认主机名
#   TKSWARM_SKIP_FIREWALL=1  跳过 ufw 提示

set -euo pipefail

TKSWARM_GIT_URL="${TKSWARM_GIT_URL:-https://github.com/MinWU2023/tkswarm-linuxbrowse.git}"
TKSWARM_GIT_BRANCH="${TKSWARM_GIT_BRANCH:-main}"
TKSWARM_APP_DIR="${TKSWARM_APP_DIR:-/opt/tkswarm-linuxbrowse}"
TKSWARM_DATA_DIR="${TKSWARM_DATA_DIR:-/var/lib/tkswarm-linuxbrowse}"
TKSWARM_ENV_FILE="${TKSWARM_ENV_FILE:-/etc/tkswarm-linuxbrowse.env}"
TKSWARM_SERVICE_NAME="${TKSWARM_SERVICE_NAME:-tkswarm-linuxbrowse}"
TKSWARM_BROWSER_PORT="${TKSWARM_BROWSER_PORT:-54345}"
TKSWARM_NODE_MAJOR="${TKSWARM_NODE_MAJOR:-20}"
TKSWARM_SKIP_FIREWALL="${TKSWARM_SKIP_FIREWALL:-0}"

# 日志必须走 stderr：stdout 留给「echo 包名」等可被 $() 捕获的结果
log() { echo "[tkswarm-install] $*" >&2; }
die() { echo "[tkswarm-install] 错误: $*" >&2; exit 1; }

# deb 包是否已安装
pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'
}

# 可执行文件是否已在 PATH
cmd_exists() {
  command -v "$1" >/dev/null 2>&1
}

# apt 包名 → 用于检测的命令（有则优先看命令，避免重复装）
declare -A APT_CMD_MAP=(
  [curl]=curl
  [git]=git
  [rsync]=rsync
  [xvfb]=Xvfb
  [x11vnc]=x11vnc
  [ffmpeg]=ffmpeg
)

# apt 源里是否有可安装候选（Ubuntu 24.04+ 部分库改名为 *t64；
# 仅 apt-cache show 不够：虚拟包/已弃用包也会有 show 输出却无 Candidate）
apt_pkg_available() {
  local cand
  cand="$(apt-cache policy "$1" 2>/dev/null | awk '/^[[:space:]]*Candidate:/ {print $2; exit}')"
  [[ -n "${cand}" && "${cand}" != "(none)" ]]
}

# 从候选包名里选第一个已安装或可安装的
resolve_pkg_candidate() {
  local pkg
  for pkg in "$@"; do
    if pkg_installed "${pkg}"; then
      echo "${pkg}"
      return 0
    fi
    if apt_pkg_available "${pkg}"; then
      echo "${pkg}"
      return 0
    fi
  done
  return 1
}

# 解析一项依赖：已满足返回 1（stdout 为空）；否则 stdout 打印待安装包名
resolve_dep_install_name() {
  local primary="$1"
  shift
  local alts=("${primary}" "$@")
  local cmd resolved

  cmd="${APT_CMD_MAP[$primary]:-}"
  if [[ -n "${cmd}" ]] && cmd_exists "${cmd}"; then
    log "  已存在 ${cmd}（跳过包 ${primary}）"
    return 1
  fi

  resolved="$(resolve_pkg_candidate "${alts[@]}")" || {
    log "  警告: 源中无可用包 ${primary}（已尝试: ${alts[*]}），跳过"
    return 1
  }

  if pkg_installed "${resolved}"; then
    log "  已安装 ${resolved}"
    return 1
  fi

  echo "${resolved}"
  return 0
}

# dpkg 是否处于异常（半安装/待清理）
dpkg_is_broken() {
  dpkg --audit 2>/dev/null | grep -q .
}

# 尝试自动修复卡住的包（常见：linux-headers + Bad message 删不掉文件）
# 策略：挪走损坏目录 → force-remove → apt -f install
repair_broken_dpkg() {
  local pkg src_dir bak
  if ! dpkg_is_broken; then
    # 即使 audit 空，也可能有「待 remove 但文件坏」的包，探测一次
    if ! DEBIAN_FRONTEND=noninteractive dpkg --configure -a &>/dev/null; then
      :
    else
      return 0
    fi
  fi

  log "  检测到 dpkg 异常，尝试自动修复..."

  # 优先处理 linux-headers-*（本次报错路径）
  while IFS= read -r pkg; do
    [[ -z "${pkg}" ]] && continue
    [[ "${pkg}" == linux-headers-* ]] || continue
    src_dir="/usr/src/${pkg}"
    if [[ -e "${src_dir}" ]]; then
      bak="${src_dir}.broken.$$"
      log "  移走损坏目录 ${src_dir} -> ${bak}"
      mv "${src_dir}" "${bak}" 2>/dev/null \
        || rm -rf "${src_dir}" 2>/dev/null \
        || log "  警告: 无法移走 ${src_dir}（可能磁盘坏块），继续强制卸包"
    fi
    log "  强制移除 ${pkg}"
    dpkg --remove --force-remove-reinstreq "${pkg}" 2>/dev/null \
      || dpkg --purge --force-all "${pkg}" 2>/dev/null \
      || true
  done < <(dpkg -l 'linux-headers-*' 2>/dev/null | awk '/^iF|^iU|^rH|^rc/ {print $2}')

  # 再处理 audit 列出的其它包
  while IFS= read -r pkg; do
    [[ -z "${pkg}" ]] && continue
    log "  强制移除异常包 ${pkg}"
    dpkg --remove --force-remove-reinstreq "${pkg}" 2>/dev/null || true
  done < <(dpkg --audit 2>/dev/null | awk '/^[[:alnum:].+-]+ / {print $1}')

  DEBIAN_FRONTEND=noninteractive apt-get -f install -y -qq 2>/dev/null || true
  DEBIAN_FRONTEND=noninteractive dpkg --configure -a 2>/dev/null || true

  if dpkg_is_broken; then
    log "  自动修复未完全成功。请手动执行:"
    log "    sudo mv /usr/src/linux-headers-6.8.0-136 /usr/src/linux-headers-6.8.0-136.bak 2>/dev/null || true"
    log "    sudo dpkg --remove --force-remove-reinstreq linux-headers-6.8.0-136"
    log "    sudo apt-get -f install"
    return 1
  fi
  log "  dpkg 异常已清理"
  return 0
}

# 批量检查系统依赖（每项可写「主包名 备选包名…」，兼容 Ubuntu 22/24）
install_system_deps() {
  local items=(
    "ca-certificates"
    "curl"
    "git"
    "rsync"
    "xvfb"
    "x11vnc"
    "ffmpeg"
    "fonts-noto-cjk"
    "fonts-noto-cjk-extra"
    "libnss3"
    "libatk-bridge2.0-0 libatk-bridge2.0-0t64"
    "libdrm2 libdrm2t64"
    "libxkbcommon0 libxkbcommon0t64"
    "libgbm1 libgbm1t64"
    "libasound2 libasound2t64"
  )
  local item pkg pending=()
  for item in "${items[@]}"; do
    # shellcheck disable=SC2086
    pkg="$(resolve_dep_install_name ${item} || true)"
    # 仅接受合法 deb 包名，防止异常输出混入 pending
    if [[ -n "${pkg}" && "${pkg}" =~ ^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$ ]]; then
      pending+=("${pkg}")
    elif [[ -n "${pkg}" ]]; then
      log "  忽略非法包名候选: ${pkg}"
    fi
  done
  if [[ ${#pending[@]} -eq 0 ]]; then
    log "  系统依赖均已满足"
    return 0
  fi
  repair_broken_dpkg || true
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || log "  警告: apt-get update 失败，继续尝试安装"
  local fail=0
  for pkg in "${pending[@]}"; do
    log "  安装 ${pkg}"
    if ! apt-get install -y -qq "${pkg}"; then
      # 首次失败再修一次 dpkg 后重试该包
      if repair_broken_dpkg; then
        apt-get install -y -qq "${pkg}" && continue
      fi
      log "  警告: 安装 ${pkg} 失败，继续后续步骤"
      fail=1
    fi
  done
  if [[ "${fail}" -eq 1 ]]; then
    repair_broken_dpkg || true
  fi
}

# snap 版 chromium 只是 wrapper，受 AppArmor 限制：无法使用自定义 --user-data-dir，
# systemd/无头场景基本不可用，一律不认（否则会误判"已有浏览器"而跳过安装）
is_snap_wrapper() {
  local p="${1:-}"
  [[ -z "$p" ]] && return 0
  [[ "$p" == /snap/* ]] && return 0
  [[ "$(readlink -f "$p" 2>/dev/null)" == /usr/bin/snap ]] && return 0
  return 1
}

# 解析出真正可用的浏览器路径（跳过 snap 包装）
real_chrome_path() {
  local c w
  for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome /opt/google/chrome/chrome \
           /usr/bin/chromium /usr/bin/chromium-browser \
           /var/lib/tkswarm-linuxbrowse/browsers/*/chrome-linux/chrome \
           /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome; do
    [[ -x "$c" ]] || continue
    is_snap_wrapper "$c" && continue
    echo "$c"; return 0
  done
  for w in google-chrome-stable google-chrome chromium chromium-browser; do
    c="$(command -v "$w" 2>/dev/null || true)"
    [[ -n "$c" ]] || continue
    is_snap_wrapper "$c" && continue
    echo "$c"; return 0
  done
  return 1
}
has_chromium() {
  [[ -n "$(real_chrome_path)" ]]
}

install_chromium_if_missing() {
  if has_chromium; then
    log "  已存在可用浏览器（非 snap）：$(real_chrome_path)，跳过安装"
    return 0
  fi
  # 优先装官方 Google Chrome（deb，不受 snap 限制，也不依赖 npm 缓存）
  if install_google_chrome_deb; then
    has_chromium && return 0
  fi
  local pkg
  for pkg in chromium-browser chromium; do
    apt-get install -y -qq "$pkg" 2>/dev/null || continue
    has_chromium && return 0
  done
  log "  ！未装到可用浏览器（snap 版不可用），请手动安装 Google Chrome 后设置 TKSWARM_CHROME_PATH"
  return 1
}

# 官方 Google Chrome（apt 源）；失败不影响主流程
install_google_chrome_deb() {
  [[ -x /usr/bin/google-chrome-stable ]] && ! is_snap_wrapper /usr/bin/google-chrome-stable && return 0
  command -v curl >/dev/null 2>&1 || return 1
  log "  安装 Google Chrome（官方 deb 源）..."
  install -d -m 0755 /usr/share/keyrings 2>/dev/null || true
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg 2>/dev/null || return 1
  echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main' \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq google-chrome-stable >/dev/null 2>&1 || return 1
  [[ -x /usr/bin/google-chrome-stable ]] && return 0
  return 1
}

node_major_version() {
  if ! cmd_exists node; then
    echo 0
    return
  fi
  node -p "parseInt(process.versions.node.split('.')[0], 10)" 2>/dev/null || echo 0
}

install_node_if_missing() {
  local ver
  ver="$(node_major_version)"
  if [[ "${ver}" -ge 18 ]]; then
    log "  已存在 Node $(node -v)，跳过 NodeSource 安装"
    return 0
  fi
  if [[ "${ver}" -gt 0 ]]; then
    log "  当前 Node $(node -v) 版本过低（需 >= 18），将安装 Node ${TKSWARM_NODE_MAJOR}.x"
  else
    log "  未检测到 Node，将安装 Node ${TKSWARM_NODE_MAJOR}.x"
  fi
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL "https://deb.nodesource.com/setup_${TKSWARM_NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
}

npm_deps_ready() {
  # 关键模块齐全才算就绪（避免半残 node_modules 误判跳过）
  [[ -f "${TKSWARM_APP_DIR}/node_modules/express/package.json" ]] \
    && [[ -f "${TKSWARM_APP_DIR}/node_modules/ws/package.json" ]] \
    && [[ -f "${TKSWARM_APP_DIR}/node_modules/call-bind-apply-helpers/index.js" ]] \
    && [[ -f "${TKSWARM_APP_DIR}/package-lock.json" ]] \
    && [[ -f "${TKSWARM_APP_DIR}/node_modules/.package-lock.json" ]]
}

# 写入干净 npmrc，覆盖宝塔全局过期淘宝源 / 畸形 --init.module
write_tkswarm_npmrc() {
  local userconfig="${TKSWARM_DATA_DIR}/.npmrc"
  mkdir -p "${TKSWARM_DATA_DIR}"
  cat > "${userconfig}" <<'EOF'
registry=https://registry.npmmirror.com
fund=false
audit=false
update-notifier=false
EOF
  chown tkswarm:tkswarm "${userconfig}" 2>/dev/null || true
  echo "${userconfig}"
}

# 以 tkswarm 跑 npm：专用 cache/HOME/userconfig，避开宝塔全局 npm 配置
run_as_tkswarm_npm() {
  local npm_cache="${TKSWARM_DATA_DIR}/.npm"
  local userconfig
  userconfig="$(write_tkswarm_npmrc)"
  mkdir -p "${npm_cache}"
  chown -R tkswarm:tkswarm "${TKSWARM_DATA_DIR}"
  sudo -u tkswarm -H env \
    HOME="${TKSWARM_DATA_DIR}" \
    npm_config_cache="${npm_cache}" \
    npm_config_userconfig="${userconfig}" \
    npm_config_globalconfig=/dev/null \
    npm_config_registry=https://registry.npmmirror.com \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    "$@"
}

run_npm_install_if_needed() {
  local force="${TKSWARM_FORCE_NPM:-0}"
  cd "${TKSWARM_APP_DIR}"
  if [[ "${force}" != "1" ]] && npm_deps_ready; then
    log "  node_modules 已存在，跳过 npm install（强制重装: TKSWARM_FORCE_NPM=1 或 --force-npm）"
    return 0
  fi
  log "  执行 npm install --omit=dev ..."
  # 服务以 tkswarm 运行；须保证其能写 node_modules
  chown -R tkswarm:tkswarm "${TKSWARM_APP_DIR}"
  # 强制或半残依赖时整目录清掉（root 执行，避免残留坏包）
  if [[ -d "${TKSWARM_APP_DIR}/node_modules" ]]; then
    log "  清理旧 node_modules ..."
    rm -rf "${TKSWARM_APP_DIR}/node_modules"
  fi
  run_as_tkswarm_npm npm install --omit=dev --no-fund --no-audit
  if ! npm_deps_ready; then
    log "  依赖不完整，再清一次后重试 ..."
    rm -rf "${TKSWARM_APP_DIR}/node_modules"
    chown -R tkswarm:tkswarm "${TKSWARM_APP_DIR}"
    run_as_tkswarm_npm npm install --omit=dev --no-fund --no-audit
  fi
  npm_deps_ready || die "npm 依赖安装不完整（缺 express/ws/call-bind-apply-helpers），请检查网络与 registry"
}

run_ensure_chromium_if_needed() {
  if has_chromium; then
    log "  系统已有 Chromium/Chrome，跳过 ensure-chromium.js"
    return 0
  fi
  if [[ -f "${TKSWARM_APP_DIR}/node_modules/playwright-core/.local-browsers" ]] \
    || [[ -d "${TKSWARM_DATA_DIR}/.cache/ms-playwright" ]]; then
    log "  Playwright Chromium 缓存已存在，跳过 ensure-chromium.js"
    return 0
  fi
  if [[ -f "${TKSWARM_APP_DIR}/scripts/ensure-chromium.js" ]]; then
    log "  运行 ensure-chromium.js ..."
    run_as_tkswarm_npm node scripts/ensure-chromium.js 2>/dev/null \
      || log "  ensure-chromium 跳过（可手动: sudo -u tkswarm npm run chromium）"
  fi
}

usage() {
  cat <<'EOF'
用法: sudo bash install-ubuntu.sh [选项]

选项:
  --api-base URL        TkSwarm PHP API（须含 /api），例: http://10.0.0.1/api
  --vnc-password PASS   VNC 密码（有头盯屏必填）
  --branch NAME         Git 分支，默认 main
  --git-url URL         Git 仓库地址
  --app-dir PATH        安装目录，默认 /opt/tkswarm-linuxbrowse
  --data-dir PATH       数据目录，默认 /var/lib/tkswarm-linuxbrowse
  --host-id ID          多机 hostId，默认主机名
  --port PORT           监听端口，默认 54345
  --skip-firewall       跳过防火墙提示
  --force-npm           强制重新 npm install（默认 node_modules 齐全则跳过）
  -h, --help            显示帮助

示例:
  sudo bash install-ubuntu.sh \
    --api-base http://tkswarm-api.example.com/api \
    --vnc-password 'ChangeMe123!'
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-base) TKSWARM_API_BASE="$2"; shift 2 ;;
    --vnc-password) TKSWARM_VNC_PASSWORD="$2"; shift 2 ;;
    --branch) TKSWARM_GIT_BRANCH="$2"; shift 2 ;;
    --git-url) TKSWARM_GIT_URL="$2"; shift 2 ;;
    --app-dir) TKSWARM_APP_DIR="$2"; shift 2 ;;
    --data-dir) TKSWARM_DATA_DIR="$2"; shift 2 ;;
    --host-id) TKSWARM_HOST_ID="$2"; shift 2 ;;
    --port) TKSWARM_BROWSER_PORT="$2"; shift 2 ;;
    --skip-firewall) TKSWARM_SKIP_FIREWALL=1; shift ;;
    --force-npm) TKSWARM_FORCE_NPM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（用 --help 查看）" ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "请使用 root 运行: sudo bash $0"

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" ]] || log "警告: 脚本针对 Ubuntu/Debian 编写，当前 ID=${ID:-unknown}"
else
  log "警告: 无法识别发行版，继续尝试安装"
fi

if [[ -z "${TKSWARM_API_BASE:-}" ]]; then
  read -r -p "请输入 TkSwarm API 地址（须带 /api，例 http://api.example.com/api）: " TKSWARM_API_BASE
fi
TKSWARM_API_BASE="$(echo "${TKSWARM_API_BASE}" | sed 's/[[:space:]]//g; s#/*$##')"
[[ -n "${TKSWARM_API_BASE}" ]] || die "TKSWARM_API_BASE 不能为空"
[[ "${TKSWARM_API_BASE}" == */api ]] || die "API 地址须以 /api 结尾，当前: ${TKSWARM_API_BASE}"

if [[ -z "${TKSWARM_VNC_PASSWORD:-}" ]]; then
  read -r -s -p "请输入 VNC 密码（监听 0.0.0.0，直接回车则稍后手动写入 ${TKSWARM_ENV_FILE}）: " TKSWARM_VNC_PASSWORD || true
  echo
fi

TKSWARM_HOST_ID="${TKSWARM_HOST_ID:-$(hostname -s 2>/dev/null || hostname)}"

log "========== 1/7 检查/安装系统依赖（已存在则跳过）=========="
install_system_deps
install_chromium_if_missing

log "========== 2/7 检查/安装 Node.js（>=18，已满足则跳过）=========="
install_node_if_missing
cmd_exists node || die "Node 未安装成功"
cmd_exists npm || die "npm 未安装成功"
log "  Node $(node -v) / npm $(npm -v)"

log "========== 3/7 创建系统用户与目录 =========="
if id -u tkswarm &>/dev/null; then
  log "  系统用户 tkswarm 已存在"
else
  useradd -r -s /usr/sbin/nologin -d "${TKSWARM_DATA_DIR}" tkswarm
  log "  已创建系统用户 tkswarm"
fi
mkdir -p "${TKSWARM_APP_DIR}" "${TKSWARM_DATA_DIR}"
chown -R tkswarm:tkswarm "${TKSWARM_DATA_DIR}"

# root 操作属主为 tkswarm 的仓库时避免 dubious ownership（不改全局 gitconfig）
git_app() {
  git -c "safe.directory=${TKSWARM_APP_DIR}" -C "${TKSWARM_APP_DIR}" "$@"
}

log "========== 4/7 拉取代码 =========="
if [[ -d "${TKSWARM_APP_DIR}/.git" ]]; then
  log "目录已存在 Git 仓库，执行 fetch + reset"
  git_app fetch origin "${TKSWARM_GIT_BRANCH}"
  git_app checkout "${TKSWARM_GIT_BRANCH}"
  git_app reset --hard "origin/${TKSWARM_GIT_BRANCH}"
else
  rm -rf "${TKSWARM_APP_DIR:?}"/*
  git clone --depth 1 --branch "${TKSWARM_GIT_BRANCH}" "${TKSWARM_GIT_URL}" "${TKSWARM_APP_DIR}" \
    || die "git clone 失败，请确认仓库 ${TKSWARM_GIT_URL} 分支 ${TKSWARM_GIT_BRANCH} 可访问"
fi
# 服务用户需读源码、写 node_modules；勿再 chown root:root
chown -R tkswarm:tkswarm "${TKSWARM_APP_DIR}"

log "========== 5/7 写入环境配置 ${TKSWARM_ENV_FILE} =========="
CHROME_PATH="$(real_chrome_path || true)"

if [[ -f "${TKSWARM_ENV_FILE}" ]]; then
  log "  配置文件已存在，保留原文件（仅更新 TKSWARM_API_BASE / VNC / CHROME_PATH 相关项）"
  # 保留用户自定义项，只确保关键变量存在
  grep -q '^TKSWARM_API_BASE=' "${TKSWARM_ENV_FILE}" \
    && sed -i "s|^TKSWARM_API_BASE=.*|TKSWARM_API_BASE=${TKSWARM_API_BASE}|" "${TKSWARM_ENV_FILE}" \
    || echo "TKSWARM_API_BASE=${TKSWARM_API_BASE}" >> "${TKSWARM_ENV_FILE}"
  if [[ -n "${TKSWARM_VNC_PASSWORD:-}" ]]; then
    grep -q '^TKSWARM_VNC_PASSWORD=' "${TKSWARM_ENV_FILE}" \
      && sed -i "s|^TKSWARM_VNC_PASSWORD=.*|TKSWARM_VNC_PASSWORD=${TKSWARM_VNC_PASSWORD}|" "${TKSWARM_ENV_FILE}" \
      || echo "TKSWARM_VNC_PASSWORD=${TKSWARM_VNC_PASSWORD}" >> "${TKSWARM_ENV_FILE}"
  fi
  if [[ -n "${CHROME_PATH}" ]]; then
    if grep -q '^TKSWARM_CHROME_PATH=' "${TKSWARM_ENV_FILE}"; then
      # 已存在：若是 snap 包装则纠正为可用路径，其余保持用户自定义值

      if grep -q '^TKSWARM_CHROME_PATH=/snap/' "${TKSWARM_ENV_FILE}"; then
        sed -i "s|^TKSWARM_CHROME_PATH=.*|TKSWARM_CHROME_PATH=${CHROME_PATH}|" "${TKSWARM_ENV_FILE}"
        log "  已把 snap 浏览器路径纠正为 ${CHROME_PATH}"
      fi
    else
      echo "TKSWARM_CHROME_PATH=${CHROME_PATH}" >> "${TKSWARM_ENV_FILE}"
    fi
  fi
else
  {
    echo "# 由 install-ubuntu.sh 生成于 $(date -Iseconds)"
    echo "TKSWARM_API_BASE=${TKSWARM_API_BASE}"
    echo "TKSWARM_BROWSER_HOST=0.0.0.0"
    echo "TKSWARM_BROWSER_PORT=${TKSWARM_BROWSER_PORT}"
    echo "TKSWARM_BROWSER_DATA=${TKSWARM_DATA_DIR}"
    echo "# 并发上限默认按本机 CPU/内存自动评估（见 \$TKSWARM_BROWSER_DATA/capacity.json）"
    echo "# 需要手工压过自动评估时取消下面两行注释："
    echo "#TKSWARM_BROWSER_MAX_CONCURRENT=40"
    echo "#TKSWARM_BROWSER_MAX_ENVS=300"
    echo "TKSWARM_BROWSER_XVFB=1"
    echo "TKSWARM_CHROME_NO_SANDBOX=1"
    echo "TKSWARM_HOST_ID=${TKSWARM_HOST_ID}"
    [[ -n "${TKSWARM_VNC_PASSWORD:-}" ]] && echo "TKSWARM_VNC_PASSWORD=${TKSWARM_VNC_PASSWORD}"
    [[ -n "${CHROME_PATH}" ]] && echo "TKSWARM_CHROME_PATH=${CHROME_PATH}"
  } > "${TKSWARM_ENV_FILE}"
fi
chmod 640 "${TKSWARM_ENV_FILE}"

log "========== 6/7 检查/安装 npm 依赖（已齐全则跳过）=========="
run_npm_install_if_needed
run_ensure_chromium_if_needed

log "========== 7/7 安装并启动 systemd =========="
SERVICE_FILE="/etc/systemd/system/${TKSWARM_SERVICE_NAME}.service"
if [[ -f "${TKSWARM_APP_DIR}/deploy/tkswarm-linuxbrowse.service" ]]; then
  sed \
    -e "s|/opt/tkswarm-linuxbrowse|${TKSWARM_APP_DIR}|g" \
    -e "s|/var/lib/tkswarm-linuxbrowse|${TKSWARM_DATA_DIR}|g" \
    -e "s|TKSWARM_BROWSER_PORT=54345|TKSWARM_BROWSER_PORT=${TKSWARM_BROWSER_PORT}|g" \
    "${TKSWARM_APP_DIR}/deploy/tkswarm-linuxbrowse.service" > "${SERVICE_FILE}"
else
  NODE_BIN="$(command -v node)"
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=第一页自研浏览器 Linux (Bit-compatible CDP API)
After=network.target

[Service]
Type=simple
User=tkswarm
Group=tkswarm
WorkingDirectory=${TKSWARM_APP_DIR}
EnvironmentFile=-${TKSWARM_ENV_FILE}
ExecStart=${NODE_BIN} ${TKSWARM_APP_DIR}/src/server/main.js
Restart=always
RestartSec=3
LimitNOFILE=65535
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${TKSWARM_SERVICE_NAME}
TasksMax=infinity

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable "${TKSWARM_SERVICE_NAME}"
systemctl restart "${TKSWARM_SERVICE_NAME}"

sleep 2
if ! systemctl is-active --quiet "${TKSWARM_SERVICE_NAME}"; then
  log "服务未处于 active，最近日志："
  journalctl -u "${TKSWARM_SERVICE_NAME}" -n 40 --no-pager || true
  die "systemd 启动失败，请检查 journalctl -u ${TKSWARM_SERVICE_NAME}"
fi

HEALTH_OK=0
for i in 1 2 3 4 5; do
  if curl -fsS -X POST "http://127.0.0.1:${TKSWARM_BROWSER_PORT}/health" \
    -H 'Content-Type: application/json' -d '{}' >/tmp/tkswarm-lb-health.json 2>/dev/null; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
log "========== 部署完成 =========="
echo "  服务状态:  $(systemctl is-active ${TKSWARM_SERVICE_NAME})"
echo "  安装目录:  ${TKSWARM_APP_DIR}"
echo "  数据目录:  ${TKSWARM_DATA_DIR}"
echo "  环境配置:  ${TKSWARM_ENV_FILE}"
echo "  API 地址:  ${TKSWARM_API_BASE}"
echo "  Web 控制台: http://${SERVER_IP:-<服务器IP>}:${TKSWARM_BROWSER_PORT}/"
echo "  健康检查:  curl -X POST http://127.0.0.1:${TKSWARM_BROWSER_PORT}/health -d '{}'"
if [[ "${HEALTH_OK}" -eq 1 ]]; then
  echo "  health 响应: $(cat /tmp/tkswarm-lb-health.json)"
else
  log "警告: health 暂未响应，请执行: journalctl -u ${TKSWARM_SERVICE_NAME} -f"
fi
echo
echo "  下一步:"
echo "    1. 浏览器打开 Web 控制台，用 TkSwarm 账号登录"
echo "    2. 复制页面上的 API Token"
echo "    3. 在 tkswarm-node 设置 browserApiUrl=http://${SERVER_IP:-LinuxIP}:${TKSWARM_BROWSER_PORT}"
echo "       browserApiToken=<Token>，browserBackend=tkswarm 或 auto"
echo "  日常更新: sudo bash ${TKSWARM_APP_DIR}/deploy/update-ubuntu.sh"
echo "  查看日志: journalctl -u ${TKSWARM_SERVICE_NAME} -f"
echo

if [[ "${TKSWARM_SKIP_FIREWALL}" != "1" ]] && command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    log "检测到 ufw 已启用。建议仅对内网放行 ${TKSWARM_BROWSER_PORT}，勿裸暴露公网，例如:"
    echo "  sudo ufw allow from 10.0.0.0/8 to any port ${TKSWARM_BROWSER_PORT} proto tcp"
  else
    log "提示: 生产环境请用防火墙/安全组限制 ${TKSWARM_BROWSER_PORT} 仅内网或 VPN 可访问"
  fi
fi

rm -f /tmp/tkswarm-lb-health.json
