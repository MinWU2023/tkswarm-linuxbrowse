/**
 * 轻量 Prometheus 文本指标 + JSON 资源摘要（机房探针）。
 */
const express = require('express');
const { collectHealthExtras } = require('../browser/metrics');
const { PROVIDER_ID, VERSION, MAX_CONCURRENT_OPENS, HOST_ID } = require('../config');

const router = express.Router();

router.get('/metrics', (req, res) => {
  const x = collectHealthExtras();
  const lines = [
    '# HELP tkswarm_lb_up Linux Browser process up',
    '# TYPE tkswarm_lb_up gauge',
    'tkswarm_lb_up 1',
    '# HELP tkswarm_lb_running_windows Open Chrome windows',
    '# TYPE tkswarm_lb_running_windows gauge',
    `tkswarm_lb_running_windows ${x.runningWindows || 0}`,
    '# HELP tkswarm_lb_max_concurrent Configured max concurrent opens',
    '# TYPE tkswarm_lb_max_concurrent gauge',
    `tkswarm_lb_max_concurrent ${x.maxConcurrent || MAX_CONCURRENT_OPENS || 0}`,
    '# HELP tkswarm_lb_headless_windows Headless windows',
    '# TYPE tkswarm_lb_headless_windows gauge',
    `tkswarm_lb_headless_windows ${x.headlessWindows || 0}`,
    '# HELP tkswarm_lb_headed_windows Headed windows',
    '# TYPE tkswarm_lb_headed_windows gauge',
    `tkswarm_lb_headed_windows ${x.headedWindows || 0}`,
    '# HELP tkswarm_lb_active_sessions Logged-in API sessions',
    '# TYPE tkswarm_lb_active_sessions gauge',
    `tkswarm_lb_active_sessions ${x.activeSessions || 0}`,
    '# HELP tkswarm_lb_process_rss_bytes Node RSS',
    '# TYPE tkswarm_lb_process_rss_bytes gauge',
    `tkswarm_lb_process_rss_bytes ${x.memory?.rss || 0}`,
    '# HELP tkswarm_lb_system_mem_free_bytes Host free memory',
    '# TYPE tkswarm_lb_system_mem_free_bytes gauge',
    `tkswarm_lb_system_mem_free_bytes ${x.memory?.systemFree || 0}`,
    `# HELP tkswarm_lb_info Static labels`,
    `# TYPE tkswarm_lb_info gauge`,
    `tkswarm_lb_info{provider="${PROVIDER_ID}",version="${VERSION}",host_id="${String(HOST_ID).replace(/"/g, '')}"} 1`,
    '',
  ];
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n'));
});

/** LB / 编排探针：与 POST /health 字段对齐的 GET */
router.get('/healthz', (req, res) => {
  const x = collectHealthExtras();
  res.json({
    ok: true,
    status: 'ok',
    provider: PROVIDER_ID,
    version: VERSION,
    hostId: HOST_ID,
    runningWindows: x.runningWindows,
    maxConcurrent: x.maxConcurrent || MAX_CONCURRENT_OPENS,
    memory: x.memory,
  });
});

module.exports = router;
