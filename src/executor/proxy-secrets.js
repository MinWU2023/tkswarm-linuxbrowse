const { encrypt, decrypt } = require('./secret-store');

function proxyPasswordOf(row) {
  if (!row) return '';
  if (row.password_encrypted) {
    try { return decrypt(row.password_encrypted); } catch { return ''; }
  }
  return row.password || '';
}

function encryptProxyPassword(password) {
  return password ? encrypt(password) : '';
}

module.exports = { proxyPasswordOf, encryptProxyPassword };
