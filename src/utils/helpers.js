/**
 * 工具函数库
 * 包含：加密解密、日志、响应格式化等
 */

const crypto = require('crypto');
const dayjs = require('dayjs');

// =====================================================
// AES 加密/解密（用于敏感数据）
// =====================================================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || Buffer.from(ENCRYPTION_KEY).length !== 32) {
  console.error('[FATAL] ENCRYPTION_KEY must be set and exactly 32 bytes. Refusing to start.');
  process.exit(1);
}
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  if (!text) return null;
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return text; // 如果解密失败，返回原文本
  }
}

// =====================================================
// 电话号码处理
// =====================================================
function maskPhone(phone) {
  if (!phone) return '';
  // 移除所有非数字字符
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return phone;
  return digits.slice(0, 3) + '****' + digits.slice(-4);
}

function encryptPhone(phone) {
  return encrypt(phone);
}

function decryptPhone(encryptedPhone) {
  return decrypt(encryptedPhone);
}

// =====================================================
// API 响应格式化
// =====================================================
function success(data = null, message = '操作成功') {
  return {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString()
  };
}

function error(message = '操作失败', code = 500, details = null) {
  const res = {
    success: false,
    error: message,
    code,
    timestamp: new Date().toISOString()
  };
  if (details && process.env.NODE_ENV === 'development') {
    res.details = details;
  }
  return res;
}

function paginate(data, total, page, pageSize) {
  return {
    list: data,
    pagination: {
      total,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      totalPages: Math.ceil(total / pageSize)
    }
  };
}

// =====================================================
// 日期处理
// =====================================================
function now() {
  return dayjs();
}

function formatDate(date, format = 'YYYY-MM-DD HH:mm:ss') {
  return dayjs(date).format(format);
}

function parseDate(date) {
  return dayjs(date);
}

// =====================================================
// 日志
// =====================================================
function log(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta
  };
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
}

// =====================================================
// 随机 ID
// =====================================================
function generateId() {
  return crypto.randomUUID();
}

// =====================================================
// 敏感信息过滤
// =====================================================
function sanitizeObject(obj, fields = ['password', 'apiKey', 'secret']) {
  if (!obj) return obj;
  const result = { ...obj };
  for (const field of fields) {
    if (result[field]) {
      result[field] = '***';
    }
  }
  return result;
}

module.exports = {
  encrypt,
  decrypt,
  maskPhone,
  encryptPhone,
  decryptPhone,
  success,
  error,
  paginate,
  now,
  formatDate,
  parseDate,
  log,
  generateId,
  sanitizeObject
};
