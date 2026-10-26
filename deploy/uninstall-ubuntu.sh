#!/usr/bin/env bash
# 卸载服务（保留数据目录，需手动删除 /var/lib/tkswarm-linuxbrowse）
# 用法: sudo bash uninstall-ubuntu.sh

set -euo pipefail

TKSWARM_APP_DIR="${TKSWARM_APP_DIR:-/opt/tkswarm-linuxbrowse}"
TKSWARM_DATA_DIR="${TKSWARM_DATA_DIR:-/var/lib/tkswarm-linuxbrowse}"
TKSWARM_SERVICE_NAME="${TKSWARM_SERVICE_NAME:-tkswarm-linuxbrowse}"
TKSWARM_ENV_FILE="${TKSWARM_ENV_FILE:-/etc/tkswarm-linuxbrowse.env}"

[[ "$(id -u)" -eq 0 ]] || { echo "请使用 root"; exit 1; }

systemctl stop "${TKSWARM_SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${TKSWARM_SERVICE_NAME}" 2>/dev/null || true
rm -f "/etc/systemd/system/${TKSWARM_SERVICE_NAME}.service"
systemctl daemon-reload

echo "已停止并移除 systemd 服务 ${TKSWARM_SERVICE_NAME}"
echo "代码目录: ${TKSWARM_APP_DIR} （未删除）"
echo "数据目录: ${TKSWARM_DATA_DIR} （未删除，含 Cookie/profile）"
echo "配置文件: ${TKSWARM_ENV_FILE} （未删除）"
echo "若需彻底清理: rm -rf ${TKSWARM_APP_DIR} ${TKSWARM_DATA_DIR} ${TKSWARM_ENV_FILE}"
