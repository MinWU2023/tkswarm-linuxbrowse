const path = require("node:path");
const fs = require("node:fs");
const uploadDir = path.resolve(__dirname, "../../data/uploads");
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch { /* ignore */ }
function resolveUploadPath() { return null; }
function ensureUploadDir() { return uploadDir; }
module.exports = { uploadDir, resolveUploadPath, ensureUploadDir };
