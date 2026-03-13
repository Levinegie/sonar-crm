/**
 * 客户管理路由
 * 包含：客户列表、公海、抢单、转移
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { success, error, paginate, maskPhone } = require('../utils/helpers');
const { authenticate, authorize, tenantScope } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// 获取客户列表
router.get('/', authenticate, tenantScope, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, status, level, agentId, keyword, seaStatus, channel, sort = 'createdAt', order = 'desc' } = req.query;

    // 客服只能看自己的客户，老板/管理员看全部
    const isAgent = req.user.role === 'agent';

    const where = {
      tenantId: req.tenantId,
      ...(isAgent && { agentId: req.user.id }),
      ...(status && { status }),
      ...(level && { level }),
      ...(channel && { source: channel }),
      ...(seaStatus && { seaStatus }),
      ...(agentId && { agentId }),
      ...(keyword && {
        OR: [
          { name: { contains: keyword } },
          { community: { contains: keyword } },
          { phone: { contains: keyword.replace(/\*/g, '') } }
        ]
      })
    };

    // 公海特殊处理
    if (seaStatus === 'in_sea') {
      delete where.agentId;
      where.seaStatus = 'in_sea';
    }

    const [list, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { [sort]: order },
        include: {
          agent: { select: { id: true, name: true } },
          _count: { select: { recordings: true } }
        }
      }),
      prisma.customer.count({ where })
    ]);

    // 脱敏处理
    const sanitizedList = list.map(c => ({
      ...c,
      phone: c.phone ? maskPhone(c.phone) : null,
      // 字段映射： 补充
      agentName: c.agent?.name || null,
      callCount: c._count?.recordings || 0,
      portraitPct: c.portraitPct || 0,
      portrait: c.portrait || {},
      nextFollowAt: c.nextFollowAt,
      seaReason: c.seaReason,
      seaAt: c.seaAt
    }));

    res.json(success(paginate(sanitizedList, total, page, pageSize)));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('获取客户列表失败', 500));
  }
});

// 获取公海客户列表
router.get('/sea', authenticate, tenantScope, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query;

    const where = {
      tenantId: req.tenantId,
      seaStatus: 'in_sea',
      ...(keyword && {
        OR: [
          { name: { contains: keyword } },
          { community: { contains: keyword } }
        ]
      })
    };

    const [list, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { seaAt: 'desc' }
      }),
      prisma.customer.count({ where })
    ]);

    const sanitizedList = list.map(c => ({
      ...c,
      phone: c.phone ? maskPhone(c.phone) : null,
      // 字段映射
      daysAgo: c.seaAt ? Math.floor((Date.now() - new Date(c.seaAt)) / 86400000) : 0,
      reason: c.seaReason || '转入公海'
    }));

    res.json(success(paginate(sanitizedList, total, page, pageSize)));
  } catch (err) {
    res.status(500).json(error('获取公海客户失败', 500));
  }
});

// 获取无效公海客户列表
router.get('/invalid-sea', authenticate, tenantScope, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query;

    const where = {
      tenantId: req.tenantId,
      seaStatus: 'invalid',
      ...(keyword && {
        OR: [
          { name: { contains: keyword } },
          { community: { contains: keyword } }
        ]
      })
    };

    const [list, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { seaAt: 'desc' }
      }),
      prisma.customer.count({ where })
    ]);

    const sanitizedList = list.map(c => ({
      ...c,
      phone: c.phone ? maskPhone(c.phone) : null,
      daysAgo: c.seaAt ? Math.floor((Date.now() - new Date(c.seaAt)) / 86400000) : 0,
      reason: c.seaReason || '标记无效'
    }));

    res.json(success(paginate(sanitizedList, total, page, pageSize)));
  } catch (err) {
    res.status(500).json(error('获取无效公海客户失败', 500));
  }
});

// 抢单
router.post('/:id/claim', authenticate, tenantScope, async (req, res) => {
  try {
    const { id } = req.params;

    // 检查客户是否在公海
    const customer = await prisma.customer.findFirst({
      where: { id, tenantId: req.tenantId, seaStatus: 'in_sea' }
    });

    if (!customer) {
      return res.status(400).json(error('该客户不在公海或已被领取', 400));
    }

    // 检查客服客户数量上限
    const agentCount = await prisma.customer.count({
      where: { agentId: req.user.id, seaStatus: null }
    });

    const agent = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (agentCount >= agent.maxCustomers) {
      return res.status(400).json(error(`已达到客户数量上限（${agent.maxCustomers}个）`, 400));
    }

    // 抢单
    const updated = await prisma.customer.update({
      where: { id },
      data: {
        agentId: req.user.id,
        seaStatus: 'claimed',
        claimedAt: new Date(),
        claimedById: req.user.id
      }
    });

    res.json(success(updated, '抢单成功'));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('抢单失败', 500));
  }
});

// 转移到公海
router.post('/:id/to-sea', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const customer = await prisma.customer.update({
      where: { id, tenantId: req.tenantId },
      data: {
        agentId: null,
        seaStatus: 'in_sea',
        seaReason: reason,
        seaAt: new Date()
      }
    });

    res.json(success(customer, '已转移到公海'));
  } catch (err) {
    res.status(500).json(error('转移失败', 500));
  }
});

// 分配给客服
router.post('/:id/assign', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { agentId } = req.body;

    const customer = await prisma.customer.update({
      where: { id, tenantId: req.tenantId },
      data: {
        agentId,
        seaStatus: null,
        seaReason: null,
        seaAt: null,
        claimedAt: null,
        claimedById: null
      }
    });

    res.json(success(customer, '分配成功'));
  } catch (err) {
    res.status(500).json(error('分配失败', 500));
  }
});

// 创建客户
router.post('/', authenticate, tenantScope, async (req, res) => {
  try {
    const { name, phone, community, area, houseType, budget, channel, level = 'C' } = req.body;

    // 检查是否已存在
    const exists = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId: req.tenantId, phone } }
    });

    if (exists) {
      return res.status(400).json(error('该客户已存在', 400));
    }

    const customer = await prisma.customer.create({
      data: {
        tenantId: req.tenantId,
        name,
        phone, // 应该加密存储
        phoneMasked: maskPhone(phone),
        community,
        area,
        houseType,
        budget,
        source: channel,
        level,
        agentId: req.user.role === 'agent' ? req.user.id : null
      }
    });

    res.json(success(customer, '创建成功'));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('创建客户失败', 500));
  }
});

// 更新客户
router.put('/:id', authenticate, tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, community, area, houseType, budget, level, status, portrait, tags } = req.body;

    const customer = await prisma.customer.update({
      where: { id, tenantId: req.tenantId },
      data: {
        ...(name && { name }),
        ...(community && { community }),
        ...(area && { area }),
        ...(houseType && { houseType }),
        ...(budget && { budget }),
        ...(level && { level }),
        ...(status && { status }),
        ...(portrait && { portrait }),
        ...(tags && { tags })
      }
    });

    res.json(success(customer, '更新成功'));
  } catch (err) {
    res.status(500).json(error('更新客户失败', 500));
  }
});

// 删除客户
router.delete('/:id', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    await prisma.customer.delete({
      where: { id: req.params.id, tenantId: req.tenantId }
    });

    res.json(success(null, '删除成功'));
  } catch (err) {
    res.status(500).json(error('删除客户失败', 500));
  }
});

// 获取客户详情
router.get('/:id', authenticate, tenantScope, async (req, res) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        agent: { select: { id: true, name: true } },
        recordings: {
          take: 10,
          orderBy: { callTime: 'desc' },
          include: {
            analysisResults: { take: 1, orderBy: { createdAt: 'desc' } }
          }
        },
        followUps: {
          take: 10,
          orderBy: { createdAt: 'desc' }
        },
        _count: { select: { recordings: true, followUps: true } }
      }
    });

    if (!customer) {
      return res.status(404).json(error('客户不存在', 404));
    }

    res.json(success({
      ...customer,
      phone: maskPhone(customer.phone)
    }));
  } catch (err) {
    res.status(500).json(error('获取客户详情失败', 500));
  }
});

module.exports = router;
