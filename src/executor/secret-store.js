const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const keyPath = process.env.SECRET_KEY_PATH ? path.resolve(process.env.SECRET_KEY_PATH) : path.join(dataDir, '.secret-key');

function loadKey() {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw new Error(`密钥文件格式错误：${keyPath}`);
  return key;
}

const key = loadKey();

function encrypt(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decrypt(value) {
  if (!value) return '';
  const [version, iv, tag, ciphertext] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('无法识别的密文格式');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, keyPath };
