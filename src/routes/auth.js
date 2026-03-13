/**
 * 认证路由
 * 登录、注册、登出
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { error, success } = require('../utils/helpers');
const { generateToken, authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// =====================================================
// 登录
// =====================================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json(error('用户名和密码不能为空', 400));
    }

    // 查找用户（先尝试租户内）
    const user = await prisma.user.findFirst({
      where: {
        username,
        isActive: true
      },
      include: {
        tenant: true
      }
    });

    if (!user) {
      return res.status(401).json(error('用户名或密码错误', 401));
    }

    // 检查租户状态
    if (user.tenant.status !== 'active') {
      return res.status(403).json(error('账号已被禁用', 403));
    }

    // 检查租户到期时间
    if (user.tenant.expiresAt && new Date(user.tenant.expiresAt) < new Date()) {
      return res.status(403).json(error('租户已到期，请联系平台管理员续期', 403));
    }

    // 检查 IP 白名单
    if (user.tenant.allowedIps) {
      const clientIp = req.ip?.replace('::ffff:', '') || '';
      const allowed = user.tenant.allowedIps.split(',').map(ip => ip.trim()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(clientIp)) {
        return res.status(403).json(error('当前 IP 不在允许范围内', 403));
      }
    }

    // 检查是否被锁定
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      return res.status(403).json(error(`账号已被锁定，请 ${formatMinutes(user.lockedUntil)} 后再试`, 403));
    }

    // 验证密码
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      // 记录失败次数
      await prisma.user.update({
        where: { id: user.id },
        data: {
          loginFailCount: user.loginFailCount + 1,
          lockedUntil: user.loginFailCount >= 4 ? new Date(Date.now() + 30 * 60 * 1000) : null // 5次失败锁定30分钟
        }
      });
      return res.status(401).json(error('用户名或密码错误', 401));
    }

    // 登录成功，重置失败次数
    await prisma.user.update({
      where: { id: user.id },
      data: {
        loginFailCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date()
      }
    });

    // 生成 Token
    const token = generateToken(user);

    // 记录日志
    await prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'login',
        resource: 'user',
        resourceId: user.id,
        ip: req.ip
      }
    });

    res.json(success({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        avatar: user.avatar,
        tenant: {
          id: user.tenant.id,
          name: user.tenant.name,
          slug: user.tenant.slug
        }
      }
    }, '登录成功'));
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json(error('登录失败', 500));
  }
});

// =====================================================
// 邀请码注册（角色由邀请码决定，注册后待审核）
// =====================================================
router.post('/register', async (req, res) => {
  try {
    const { inviteCode, username, password, name } = req.body;

    if (!inviteCode || !username || !password || !name) {
      return res.status(400).json(error('邀请码、用户名、密码和姓名为必填项', 400));
    }

    if (password.length < 6) {
      return res.status(400).json(error('密码至少6位', 400));
    }

    // 通过邀请码判断角色和租户
    let tenant = await prisma.tenant.findFirst({ where: { inviteCodeAgent: inviteCode } });
    let role = 'agent';
    if (!tenant) {
      tenant = await prisma.tenant.findFirst({ where: { inviteCodeBoss: inviteCode } });
      role = 'boss';
    }
    if (!tenant) {
      return res.status(400).json(error('邀请码无效', 400));
    }
    if (tenant.status !== 'active') {
      return res.status(403).json(error('该租户已被禁用', 403));
    }
    if (tenant.expiresAt && new Date(tenant.expiresAt) < new Date()) {
      return res.status(403).json(error('该租户已到期', 403));
    }
    if (tenant.inviteExpiresAt && new Date(tenant.inviteExpiresAt) < new Date()) {
      return res.status(403).json(error('邀请链接已过期，请联系管理员', 403));
    }

    // 检查用户数是否超限
    const userCount = await prisma.user.count({ where: { tenantId: tenant.id } });
    if (userCount >= tenant.maxUsers) {
      return res.status(400).json(error('该租户用户数已达上限', 400));
    }

    // 检查用户名是否已存在
    const exists = await prisma.user.findFirst({
      where: { tenantId: tenant.id, username }
    });
    if (exists) {
      return res.status(400).json(error('用户名已存在', 400));
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        username,
        password: hashedPassword,
        name,
        role,
        isActive: false,
        maxCustomers: role === 'boss' ? 1000 : 50
      }
    });

    res.json(success(null, '注册成功，请等待管理员审核后即可登录'));
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json(error('注册失败', 500));
  }
});

// =====================================================
// 获取当前用户信息
// =====================================================
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        tenant: true
      }
    });

    if (!user) {
      return res.status(404).json(error('用户不存在', 404));
    }

    res.json(success({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      avatar: user.avatar,
      leaveUntil: user.leaveUntil,
      carryoverCalls: user.carryoverCalls || 0,
      tenant: {
        id: user.tenant.id,
        name: user.tenant.name,
        slug: user.tenant.slug
      }
    }));
  } catch (err) {
    res.status(500).json(error('获取用户信息失败', 500));
  }
});

// =====================================================
// 刷新 Token
// =====================================================
router.post('/refresh', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user || !user.isActive) {
      return res.status(401).json(error('用户不存在或已禁用', 401));
    }

    const token = generateToken(user);
    res.json(success({ token }, '刷新成功'));
  } catch (err) {
    res.status(500).json(error('刷新失败', 500));
  }
});

// =====================================================
// 登出
// =====================================================
router.post('/logout', authenticate, async (req, res) => {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId,
        userId: req.user.id,
        action: 'logout',
        resource: 'user',
        resourceId: req.user.id,
        ip: req.ip
      }
    });

    res.json(success(null, '登出成功'));
  } catch (err) {
    res.status(500).json(error('登出失败', 500));
  }
});

function formatMinutes(date) {
  const diff = new Date(date) - new Date();
  return Math.ceil(diff / 60000);
}

module.exports = router;
