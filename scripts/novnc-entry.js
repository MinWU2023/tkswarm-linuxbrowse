/** esbuild 入口：把 CJS 的 RFB 导出成真正的 ESM default 构造函数 */
import RFB from '@novnc/novnc/lib/rfb.js';
export default RFB?.default || RFB;
