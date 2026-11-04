/**
 * 业务入库 / 提交 PHP API 的时间一律按 Asia/Shanghai（东八区）墙钟。
 * 注意：Date#toISOString() 永远是 UTC，不可直接 slice 当 DATETIME。
 */
const TZ = 'Asia/Shanghai';

function pad(v) {
  return String(v).padStart(2, '0');
}

/**
 * @param {Date|number|string} [input]
 * @returns {string} `YYYY-MM-DD HH:mm:ss`
 */
function formatInChina(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  let hour = String(parts.hour || '00');
  if (hour === '24') hour = '00';
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(hour)}:${pad(parts.minute)}:${pad(parts.second || '00')}`;
}

/** 当前北京时间 `YYYY-MM-DD HH:mm:ss`（写入 MySQL DATETIME / API 字段） */
function nowChinaSql() {
  return formatInChina(new Date());
}

/** 当前北京时间 ISO 带偏移：`YYYY-MM-DDTHH:mm:ss+08:00` */
function nowChinaIso() {
  const wall = nowChinaSql();
  return wall ? `${wall.replace(' ', 'T')}+08:00` : '';
}

/** datetime-local 用：`YYYY-MM-DDTHH:mm` */
function nowChinaLocalInput() {
  return nowChinaSql().replace(' ', 'T').slice(0, 16);
}

module.exports = {
  TZ,
  formatInChina,
  nowChinaSql,
  nowChinaIso,
  nowChinaLocalInput,
};
