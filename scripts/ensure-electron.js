/** 确认 Electron 二进制可用；缺失时提示安装（postinstall 不强制下载失败阻断） */
const fs = require('node:fs');

function main() {
  let bin = '';
  try {
    bin = require('electron');
  } catch (e) {
    console.warn('[ensure-electron] require(electron) 失败:', e.message || e);
    console.warn('[ensure-electron] 请执行: npm install electron --save');
    process.exitCode = 1;
    return;
  }
  if (!bin || !fs.existsSync(String(bin))) {
    console.warn('[ensure-electron] Electron 二进制不存在:', bin);
    process.exitCode = 1;
    return;
  }
  console.log('[ensure-electron] OK:', bin);
}

main();
