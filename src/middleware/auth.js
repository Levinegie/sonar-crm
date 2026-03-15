/**
 * 认证中间件
 * JWT 验证 + 租户隔离 + 权限检查
 */

const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { error } = require('../utils/helpers');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}

// =====================================================
// 生成 Token
// =====================================================
function generateToken(user) {
  const payload = {
    id: user.id,
    tenantId: user.tenantId,
    username: user.username,
    role: user.role
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });
}

// =====================================================
// 验证 Token 中间件
// =====================================================
function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json(error('未登录或登录已过期', 401));
    }

    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    // 挂载用户信息到请求
    req.user = decoded;
    req.tenantId = decoded.tenantId;

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json(error('登录已过期，请重新登录', 401));
    }
    return res.status(401).json(error('无效的 Token', 401));
  }
}

// =====================================================
// 角色权限检查
// =====================================================
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json(error('未登录', 401));
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json(error('没有权限执行此操作', 403));
    }

    next();
  };
}

// =====================================================
// 租户数据隔离中间件
// =====================================================
function tenantScope(req, res, next) {
  req.tenantId = req.user.tenantId;
  next();
}

// =====================================================
// 登录限流中间件（每 IP 5分钟内最多 10 次）
// =====================================================
const loginRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '登录尝试过于频繁，请 5 分钟后再试', code: 429 }
});

// =====================================================
// 记录操作日志中间件
// =====================================================
function auditLog(action, resource) {
  return async (req, res, next) => {
    // 保存原始 json 方法
    const originalJson = res.json.bind(res);

    // 重写 json 方法
    res.json = function(data) {
      // 只记录写操作
      if (req.method !== 'GET' && res.statusCode < 400) {
        (async () => {
          try {
            await prisma.auditLog.create({
              data: {
                tenantId: req.tenantId,
                userId: req.user?.id,
                action,
                resource,
                resourceId: req.params.id || data?.id,
                detail: {
                  method: req.method,
                  path: req.path,
                  body: sanitizeBody(req.body)
                },
                ip: req.ip,
                userAgent: req.headers['user-agent']
              }
            });
          } catch (e) {
            console.error('Audit log error:', e);
          }
        })();
      }

      return originalJson(data);
    };

    next();
  };
}

function sanitizeBody(body) {
  if (!body) return {};
  const sanitized = { ...body };
  const sensitiveFields = ['password', 'apiKey', 'secret', 'token'];
  for (const field of sensitiveFields) {
    if (sanitized[field]) sanitized[field] = '***';
  }
  return sanitized;
}

// =====================================================
// 平台管理员校验（仅 default 租户的 admin）
// =====================================================
async function platformOnly(req, res, next) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId }
    });
    if (!tenant || tenant.slug !== 'default' || req.user.role !== 'admin') {
      return res.status(403).json(error('仅平台管理员可访问', 403));
    }
    next();
  } catch (err) {
    return res.status(500).json(error('权限校验失败', 500));
  }
}

module.exports = {
  generateToken,
  authenticate,
  authorize,
  tenantScope,
  loginRateLimit,
  auditLog,
  platformOnly
};
