/**
 * 租户管理路由
 * 仅平台管理员（default 租户 admin）可访问
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { success, error } = require('../utils/helpers');
const { authenticate, platformOnly } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// 所有路由需要认证 + 平台管理员权限
router.use(authenticate, platformOnly);

// =====================================================
// 租户统计
// =====================================================
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [total, active, expiringSoon, totalUsers] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: 'active' } }),
      prisma.tenant.count({
        where: {
          expiresAt: { not: null, gt: now, lte: in7Days },
          status: 'active'
        }
      }),
      prisma.user.count()
    ]);

    res.json(success({ total, active, expiringSoon, totalUsers }));
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json(error('获取统计失败', 500));
  }
});

// =====================================================
// 租户列表
// =====================================================
router.get('/', async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        users: {
          where: { role: 'admin' },
          select: { username: true, name: true }
        },
        _count: { select: { users: true } }
      }
    });

    const list = tenants.map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      maxUsers: t.maxUsers,
      status: t.status,
      expiresAt: t.expiresAt,
      allowedIps: t.allowedIps,
      inviteCodeAgent: t.inviteCodeAgent,
      inviteCodeBoss: t.inviteCodeBoss,
      inviteExpiresAt: t.inviteExpiresAt,
      adminUser: t.users[0]?.username || null,
      userCount: t._count.users,
      createdAt: t.createdAt
    }));

    res.json(success(list));
  } catch (err) {
    console.error('List tenants error:', err);
    res.status(500).json(error('获取租户列表失败', 500));
  }
});

// =====================================================
// 创建租户（事务：tenant + admin user + 5 条 ai_configs）
// =====================================================
router.post('/', async (req, res) => {
  try {
    const { name, slug, username, password, maxUsers, expiresAt, allowedIps, bossCount = 0, agentCount = 0, inviteExpiresAt } = req.body;

    if (!name || !slug || !username || !password) {
      return res.status(400).json(error('租户名称、标识、登录账号和密码为必填项', 400));
    }

    // 检查 slug 唯一
    const existing = await prisma.tenant.findUnique({ where: { slug } });
    if (existing) {
      return res.status(400).json(error('租户标识已存在', 400));
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      // 1. 创建租户
      const tenant = await tx.tenant.create({
        data: {
          name,
          slug,
          maxUsers: maxUsers || 10,
          status: 'active',
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          allowedIps: allowedIps || null,
          inviteCodeAgent: crypto.randomBytes(4).toString('hex').toUpperCase(),
          inviteCodeBoss: crypto.randomBytes(4).toString('hex').toUpperCase(),
          inviteExpiresAt: inviteExpiresAt ? new Date(inviteExpiresAt) : null
        }
      });

      // 2. 创建管理员账号
      await tx.user.create({
        data: {
          tenantId: tenant.id,
          username,
          password: hashedPassword,
          name: name + '管理员',
          role: 'admin',
          isActive: true,
          maxCustomers: 1000
        }
      });

      // 3. 批量创建老板账号
      for (let i = 1; i <= bossCount; i++) {
        await tx.user.create({
          data: {
            tenantId: tenant.id,
            username: `boss${i}`,
            password: hashedPassword,
            name: `老板${i}`,
            role: 'boss',
            isActive: true,
            maxCustomers: 1000
          }
        });
      }

      // 4. 批量创建客服账号
      for (let i = 1; i <= agentCount; i++) {
        await tx.user.create({
          data: {
            tenantId: tenant.id,
            username: `agent${i}`,
            password: hashedPassword,
            name: `客服${i}`,
            role: 'agent',
            isActive: true,
            maxCustomers: 50
          }
        });
      }

      // 5. 初始化 5 条 AI 配置（复制默认模板）
      const defaultConfigs = [
        { name: 'line_a1', description: '首通客户 - 第一阶段：录音解析', provider: 'gemini', model: 'gemini-3.1-flash-preview', apiUrl: 'https://yunwu.ai' },
        { name: 'line_a2', description: '首通客户 - 第二阶段：深度诊断', provider: 'gemini', model: 'gemini-3.1-flash-preview', apiUrl: 'https://yunwu.ai' },
        { name: 'line_b1', description: '跟进客户 - 第一阶段：录音解析', provider: 'gemini', model: 'gemini-3.1-flash-preview', apiUrl: 'https://yunwu.ai' },
        { name: 'line_b2', description: '跟进客户 - 第二阶段：深度诊断', provider: 'gemini', model: 'gemini-3.1-flash-preview', apiUrl: 'https://yunwu.ai' },
        { name: 'confirm_card', description: '待确认卡片识别', provider: 'gemini', model: 'gemini-3.1-flash-preview', apiUrl: 'https://yunwu.ai' }
      ];

      for (const cfg of defaultConfigs) {
        await tx.aIConfig.create({
          data: { tenantId: tenant.id, ...cfg, isActive: true, priority: 100 }
        });
      }

      return tenant;
    });

    res.json(success(result, '租户创建成功'));
  } catch (err) {
    console.error('Create tenant error:', err);
    res.status(500).json(error('创建租户失败', 500));
  }
});

// =====================================================
// 编辑租户
// =====================================================
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, maxUsers, expiresAt, allowedIps } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (maxUsers !== undefined) updateData.maxUsers = maxUsers;
    if (expiresAt !== undefined) updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
    if (allowedIps !== undefined) updateData.allowedIps = allowedIps || null;

    const tenant = await prisma.tenant.update({
      where: { id },
      data: updateData
    });

    res.json(success(tenant, '更新成功'));
  } catch (err) {
    console.error('Update tenant error:', err);
    res.status(500).json(error('更新租户失败', 500));
  }
});

// =====================================================
// 启用/禁用租户
// =====================================================
router.put('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return res.status(404).json(error('租户不存在', 404));

    const updated = await prisma.tenant.update({
      where: { id },
      data: { status: tenant.status === 'active' ? 'disabled' : 'active' }
    });

    res.json(success(updated, updated.status === 'active' ? '已启用' : '已禁用'));
  } catch (err) {
    console.error('Toggle tenant error:', err);
    res.status(500).json(error('操作失败', 500));
  }
});

// =====================================================
// 重置租户管理员密码
// =====================================================
router.post('/:id/reset-password', async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json(error('密码至少 6 位', 400));
    }

    const admin = await prisma.user.findFirst({
      where: { tenantId: id, role: 'admin' }
    });

    if (!admin) return res.status(404).json(error('未找到该租户管理员', 404));

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: admin.id },
      data: { password: hashedPassword, loginFailCount: 0, lockedUntil: null }
    });

    res.json(success(null, '密码已重置'));
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json(error('重置密码失败', 500));
  }
});

module.exports = router;
