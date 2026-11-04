const crypto = require('node:crypto');

function decodeBase32(input) {
  const value = String(input || '').replace(/[\s=-]/g, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(value)) throw new Error('TOTP 密钥不是有效的 Base32 格式');
  let bits = '';
  for (const char of value) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateTotp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return { code, validForSeconds: 30 - (Math.floor(timestamp / 1000) % 30) };
}

module.exports = { generateTotp };
