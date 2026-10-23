#!/usr/bin/env node
/**
 * 第一页自研浏览器 Linux — 比特兼容本地 API + Web 控制台
 * 专为 tkswarm-node 长驻任务（客服坐席等）设计，无 Electron。
 */
const { startServer } = require('./index');
const {
  API_HOST, API_PORT, PROVIDER_LABEL, DATA_ROOT, REQUIRE_BEARER, VNC_PASSWORD,
} = require('../config');
const { startGcLoop } = require('../browser/gc');
const { startTokenGuard } = require('../auth/token-guard');

startServer(API_PORT, API_HOST).then(({ url }) => {
  startGcLoop();
  startTokenGuard();

  console.log(`[${PROVIDER_LABEL}] API ${url}`);
  console.log(`[${PROVIDER_LABEL}] Web 控制台 ${url.replace(/\/$/, '')}/`);
  console.log(`[${PROVIDER_LABEL}] 数据目录 ${DATA_ROOT}`);
  console.log(`[${PROVIDER_LABEL}] Bearer 强制: ${REQUIRE_BEARER ? 'ON' : 'OFF (TKSWARM_ALLOW_ANON=1)'}`);
  if ((API_HOST === '0.0.0.0' || API_HOST === '::') && !VNC_PASSWORD) {
    console.warn(`[${PROVIDER_LABEL}] 警告: 监听 ${API_HOST} 且未设 TKSWARM_VNC_PASSWORD，有头 VNC 将被拒绝启动`);
  }
  console.log(`[${PROVIDER_LABEL}] 请先在 Web 控制台登录，把 Token 填入 Node browserApiToken`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
