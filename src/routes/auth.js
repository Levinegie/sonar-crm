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
