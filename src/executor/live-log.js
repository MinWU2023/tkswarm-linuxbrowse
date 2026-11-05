const { nowChinaIso } = require('./utils/china-time');

const clients = new Set();

function attach(socket) {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
}

function publishEvent(type, data = {}) {
  const raw = JSON.stringify({ type, data });
  for (const socket of clients) {
    if (socket.readyState === 1) socket.send(raw);
  }
}

function publish(message, level = 'info', data = {}) {
  const event = {
    type: 'operation-log',
    data: {
      id: Date.now() + Math.random(),
      time: nowChinaIso(),
      level,
      message,
      ...data,
    },
  };
  const raw = JSON.stringify(event);
  for (const socket of clients) {
    if (socket.readyState === 1) socket.send(raw);
  }

  // 同步输出到 stdout（journalctl 可查）；TKSWARM_LIVELOG_CONSOLE=0 可关闭
  if (String(process.env.TKSWARM_LIVELOG_CONSOLE || '1') !== '0') {
    try { console.log(`[live-log][${level}] ${String(message || '')}`); } catch { /* ignore */ }
  }

  // 有会话/子任务上下文时异步落库，供任务汇总「查看日志」
  const batchId = Number(data.batchId || data.batch_id || 0);
  const itemId = Number(data.itemId || data.item_id || 0);
  if (batchId > 0 || itemId > 0) {
    try {
      const phpApi = require('./php-api');
      const meta = { ...data };
      delete meta.message;
      phpApi.post('/node/work-logs', {
        batchId,
        itemId,
        accountId: Number(data.accountId || data.account_id || 0),
        taskId: Number(data.taskId || data.task_id || 0),
        level: String(level || 'info'),
        message: String(message || ''),
        meta,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

module.exports = { attach, publish, publishEvent };
