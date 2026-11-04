/** linuxbrowse 内置执行器：无桌面 WSS，占位避免误 require */
module.exports = {
  hasEnabled() { return false; },
  countEnabled() { return 0; },
  listEnabledClients() { return []; },
  pushWork() { return { ok: false, reason: 'linuxbrowse-executor' }; },
  notifyWorkDone() {},
  clearOfferedEverywhere() {},
};
