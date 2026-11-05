/**
 * 默认头像：任务里指定的头像文件不存在时，用它代替，避免整个改资料任务因此失败。
 * 不依赖任何静态资源：用 zlib 现生成一张 400x400 的灰底人形剪影 PNG，写到系统临时目录并缓存。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 400;
const DEFAULT_NAME = 'tkswarm-default-avatar-v1.png';

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildPng() {
  const bg = [200, 205, 215];
  const fg = [245, 247, 250];
  const rowLen = 1 + SIZE * 3;
  const raw = Buffer.alloc(rowLen * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const base = y * rowLen;
    raw[base] = 0; // filter: none
    for (let x = 0; x < SIZE; x += 1) {
      const dx = x - 200;
      const headDy = y - 160;
      const bodyDy = y - 400;
      const inHead = dx * dx + headDy * headDy <= 70 * 70;
      const inBody = (dx * dx) / (130 * 130) + (bodyDy * bodyDy) / (110 * 110) <= 1;
      const c = (inHead || inBody) ? fg : bg;
      const o = base + 1 + x * 3;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 返回默认头像的本地绝对路径；生成失败返回空串 */
function ensureDefaultAvatar() {
  try {
    const file = path.join(os.tmpdir(), DEFAULT_NAME);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
    fs.writeFileSync(file, buildPng());
    return file;
  } catch {
    return '';
  }
}

/**
 * 头像文件存在则原样返回；不存在则回退到默认头像并打日志。
 * 默认头像也生成不了时才返回空串，由调用方决定是否跳过头像。
 */
function resolveAvatarOrDefault(filePath, log = () => {}) {
  try {
    if (filePath && fs.existsSync(filePath)) return filePath;
  } catch { /* fallthrough */ }
  const fallback = ensureDefaultAvatar();
  if (fallback) {
    try { log(`头像文件不存在（${filePath || '空'}），改用默认头像`); } catch { /* ignore */ }
  }
  return fallback;
}

module.exports = { ensureDefaultAvatar, resolveAvatarOrDefault };
