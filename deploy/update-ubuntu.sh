#!/usr/bin/env bash
# 第一页自研浏览器 Linux — Ubuntu 日常更新
# 用法: sudo bash update-ubuntu.sh [分支名]
# 默认分支 main；环境变量 TKSWARM_APP_DIR 可覆盖安装路径

set -euo pipefail

TKSWARM_APP_DIR="${TKSWARM_APP_DIR:-/opt/tkswarm-linuxbrowse}"
TKSWARM_DATA_DIR="${TKSWARM_DATA_DIR:-/var/lib/tkswarm-linuxbrowse}"
TKSWARM_SERVICE_NAME="${TKSWARM_SERVICE_NAME:-tkswarm-linuxbrowse}"
BRANCH="${1:-${TKSWARM_GIT_BRANCH:-main}}"

log() { echo "[tkswarm-update] $*"; }
die() { echo "[tkswarm-update] 错误: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "请使用 root 运行"
[[ -d "${TKSWARM_APP_DIR}/.git" ]] || die "未找到 Git 仓库: ${TKSWARM_APP_DIR}"

# root 操作属主为 tkswarm 的仓库时避免 dubious ownership
git_app() {
  git -c "safe.directory=${TKSWARM_APP_DIR}" -C "${TKSWARM_APP_DIR}" "$@"
}

log "拉取分支 ${BRANCH} ..."
git_app fetch origin "${BRANCH}"
git_app checkout "${BRANCH}"
git_app reset --hard "origin/${BRANCH}"
REV="$(git_app rev-parse --short HEAD)"
log "当前版本: ${REV}"

log "检查 npm 依赖 ..."
cd "${TKSWARM_APP_DIR}"
NEED_NPM=1
if [[ -d node_modules/express ]] && [[ -f node_modules/.package-lock.json ]]; then
  if [[ ! -f package-lock.json ]] || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
    log "package-lock.json 有更新，将执行 npm install"
  else
    NEED_NPM=0
    log "node_modules 已齐全，跳过 npm install（强制: TKSWARM_FORCE_NPM=1）"
  fi
fi
if [[ "${TKSWARM_FORCE_NPM:-0}" == "1" ]] || [[ "${NEED_NPM}" -eq 1 ]]; then
  NPM_CACHE="${TKSWARM_DATA_DIR}/.npm"
  NPMRC="${TKSWARM_DATA_DIR}/.npmrc"
  mkdir -p "${NPM_CACHE}"
  cat > "${NPMRC}" <<'EOF'
registry=https://registry.npmmirror.com
fund=false
audit=false
update-notifier=false
EOF
  chown -R tkswarm:tkswarm "${TKSWARM_APP_DIR}" "${TKSWARM_DATA_DIR}"
  if [[ -d node_modules ]]; then
    # 半残依赖或强制重装时整清，避免 call-bind-apply-helpers 等缺文件
    if [[ "${TKSWARM_FORCE_NPM:-0}" == "1" ]] \
      || [[ ! -f node_modules/call-bind-apply-helpers/index.js ]]; then
      rm -rf node_modules
    fi
  fi
  sudo -u tkswarm -H env \
    HOME="${TKSWARM_DATA_DIR}" \
    npm_config_cache="${NPM_CACHE}" \
    npm_config_userconfig="${NPMRC}" \
    npm_config_globalconfig=/dev/null \
    npm_config_registry=https://registry.npmmirror.com \
    npm_config_update_notifier=false \
    npm install --omit=dev --no-fund --no-audit
fi

log "重启服务 ..."
systemctl restart "${TKSWARM_SERVICE_NAME}"
sleep 2
systemctl --no-pager status "${TKSWARM_SERVICE_NAME}" || true

PORT="${TKSWARM_BROWSER_PORT:-54345}"
if curl -fsS -X POST "http://127.0.0.1:${PORT}/health" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1; then
  log "health 检查通过 (rev ${REV})"
else
  log "警告: health 未响应，请查看 journalctl -u ${TKSWARM_SERVICE_NAME} -f"
fi

log "更新完成。数据目录 ${TKSWARM_DATA_DIR} 未改动。"
