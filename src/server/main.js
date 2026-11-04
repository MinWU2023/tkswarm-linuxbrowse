#!/usr/bin/env node
/**
 * 第一页自研浏览器 Linux — 比特兼容本地 API + Web 控制台
 * + 内置任务执行队列（客服坐席 / Linux 拓客）：API 只存任务，本进程领取并跑，无需另起 tkswarm-node。
 */
const { startServer } = require('./index');
const {
  API_HOST, API_PORT, PROVIDER_LABEL, DATA_ROOT, REQUIRE_BEARER, VNC_PASSWORD, CAPACITY,
} = require('../config');
const { startGcLoop } = require('../browser/gc');
const { startTokenGuard } = require('../auth/token-guard');
const { startWorker } = require('../worker');

startServer(API_PORT, API_HOST).then(({ url }) => {
  startGcLoop();
  startTokenGuard();
  // 服务就绪后启动最多 3 路任务队列（claim → 本机开窗 → 写中心库日志）
  startWorker();

  console.log(`[${PROVIDER_LABEL}] API ${url}`);
  console.log(`[${PROVIDER_LABEL}] Web 控制台 ${url.replace(/\/$/, '')}/`);
  console.log(`[${PROVIDER_LABEL}] 数据目录 ${DATA_ROOT}`);
  console.log(`[${PROVIDER_LABEL}] Bearer 强制: ${REQUIRE_BEARER ? 'ON' : 'OFF (TKSWARM_ALLOW_ANON=1)'}`);
  console.log(
    `[${PROVIDER_LABEL}] 并发容量: ${CAPACITY.maxConcurrent} 个环境` +
    `（${CAPACITY.tierLabel}，${CAPACITY.hardware.cpuCores}核/${CAPACITY.hardware.memoryGB}GB，` +
    `受限于${CAPACITY.limitedBy === 'memory' ? '内存' : 'CPU'}，来源 ${CAPACITY.source}）`,
  );
  console.log(`[${PROVIDER_LABEL}] 容量配置 ${CAPACITY.filePath}（可用 TKSWARM_BROWSER_MAX_CONCURRENT 覆盖）`);
  if ((API_HOST === '0.0.0.0' || API_HOST === '::') && !VNC_PASSWORD) {
    console.warn(`[${PROVIDER_LABEL}] 警告: 监听 ${API_HOST} 且未设 TKSWARM_VNC_PASSWORD，有头 VNC 将被拒绝启动`);
  }
  console.log(`[${PROVIDER_LABEL}] 请先在 Web 控制台登录（执行器会用该会话 Token 调中心 API）`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
