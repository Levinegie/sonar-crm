/**
 * 用户管理路由
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { success, error, paginate } = require('../utils/helpers');
const { authenticate, authorize, tenantScope } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// 客服列表
router.get('/agents', authenticate, tenantScope, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, role, isActive, keyword } = req.query;

    const where = {
      tenantId: req.tenantId,
      ...(role && { role }),
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
      ...(keyword && {
        OR: [
          { username: { contains: keyword } },
          { name: { contains: keyword } },
          { phone: { contains: keyword } }
        ]
      })
    };

    const [list, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          username: true,
          name: true,
          role: true,
          phone: true,
          avatar: true,
          isActive: true,
          lastLoginAt: true,
          maxCustomers: true,
          createdAt: true,
          _count: { select: { customers: true } }
        }
      }),
      prisma.user.count({ where })
    ]);

    res.json(success(paginate(list, total, page, pageSize)));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('获取客服列表失败', 500));
  }
});

// 创建用户
router.post('/', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const { username, password, name, role = 'agent', phone, maxCustomers = 50 } = req.body;

    // 检查用户名是否存在
    const exists = await prisma.user.findUnique({
      where: { tenantId_username: { tenantId: req.tenantId, username } }
    });

    if (exists) {
      return res.status(400).json(error('用户名已存在', 400));
    }

    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        tenantId: req.tenantId,
        username,
        password: hashedPassword,
        name,
        role,
        phone,
        maxCustomers
      }
    });

    res.json(success({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    }, '创建成功'));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('创建用户失败', 500));
  }
});

// 更新用户
router.put('/:id', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, role, isActive, maxCustomers } = req.body;

    const user = await prisma.user.update({
      where: { id, tenantId: req.tenantId },
      data: {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(role && { role }),
        ...(isActive !== undefined && { isActive }),
        ...(maxCustomers && { maxCustomers })
      }
    });

    res.json(success({ id: user.id }, '更新成功'));
  } catch (err) {
    res.status(500).json(error('更新用户失败', 500));
  }
});

// 删除用户
router.delete('/:id', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;

    // 不能删除自己
    if (id === req.user.id) {
      return res.status(400).json(error('不能删除自己的账号', 400));
    }

    await prisma.user.delete({
      where: { id, tenantId: req.tenantId }
    });

    res.json(success(null, '删除成功'));
  } catch (err) {
    res.status(500).json(error('删除用户失败', 500));
  }
});

// 重置密码
router.post('/:id/reset-password', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id, tenantId: req.tenantId },
      data: { password: hashedPassword }
    });

    res.json(success(null, '密码重置成功'));
  } catch (err) {
    res.status(500).json(error('重置密码失败', 500));
  }
});

module.exports = router;
