/**
 * 统计路由
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { Prisma } = require('@prisma/client');
const { success, error } = require('../utils/helpers');
const { authenticate, tenantScope } = require('../middleware/auth');
const dayjs = require('dayjs');

const router = express.Router();
const prisma = new PrismaClient();

// 仪表盘概览
router.get('/dashboard', authenticate, tenantScope, async (req, res) => {
  try {
    const { date = 'today' } = req.query;
    const isAgent = req.user.role === 'agent';

    // 计算日期范围
    let startDate, endDate;
    const today = dayjs().startOf('day');

    if (date === 'today') {
      startDate = today.toDate();
      endDate = today.endOf('day').toDate();
    } else if (date === 'week') {
      startDate = today.startOf('week').toDate();
      endDate = today.endOf('day').toDate();
    } else if (date === 'month') {
      startDate = today.startOf('month').toDate();
      endDate = today.endOf('day').toDate();
    }

    const dateFilter = {
      callTime: { gte: startDate, lte: endDate }
    };

    const tenantFilter = { tenantId: req.tenantId };
    const agentFilter = isAgent ? { agentId: req.user.id } : {};

    // 基础统计
    const [
      todayCalls,
      totalCustomers,
      validCustomers,
      signedCustomers,
      inSeaCount,
      pendingConfirm
    ] = await Promise.all([
      // 今日通话数
      prisma.recording.count({
        where: {
          ...tenantFilter,
          ...agentFilter,
          ...dateFilter,
          isValid: true
        }
      }),
      // 总客户数
      prisma.customer.count({ where: { ...tenantFilter, ...(isAgent && { agentId: req.user.id }) } }),
      // 有效客户数
      prisma.customer.count({ where: { ...tenantFilter, status: { in: ['valid', 'invited', 'visited', 'signed'] } } }),
      // 已签单数
      prisma.customer.count({ where: { ...tenantFilter, status: 'signed' } }),
      // 公海客户数
      prisma.customer.count({ where: { ...tenantFilter, seaStatus: 'in_sea' } }),
      // 待确认数
      prisma.recording.count({
        where: {
          ...tenantFilter,
          analysisStatus: 'completed',
          isValid: true
        }
      })
    ]);

    // 客服排行
    let agentStats = [];
    if (!isAgent && req.user.role === 'admin') {
      const agents = await prisma.user.findMany({
        where: { tenantId: req.tenantId, role: 'agent', isActive: true },
        select: {
          id: true,
          name: true,
          _count: { select: { customers: true } }
        }
      });

      // 获取每个客服的今日通话
      for (const agent of agents) {
        const calls = await prisma.recording.count({
          where: {
            tenantId: req.tenantId,
            agentId: agent.id,
            ...dateFilter,
            isValid: true
          }
        });
        agentStats.push({
          ...agent,
          todayCalls: calls
        });
      }

      agentStats.sort((a, b) => b.todayCalls - a.todayCalls);
    }

    // 转化漏斗
    const funnel = await prisma.customer.groupBy({
      by: ['status'],
      where: tenantFilter,
      _count: true
    });

    const funnelData = {
      total: totalCustomers,
      pending: 0,
      valid: 0,
      invited: 0,
      visited: 0,
      signed: 0,
      dead: 0
    };

    funnel.forEach(f => {
      funnelData[f.status] = f._count;
    });

    res.json(success({
      todayCalls,
      totalCustomers,
      validCustomers,
      signedCustomers,
      inSeaCount,
      pendingConfirm,
      funnel: funnelData,
      agentStats: agentStats.slice(0, 5)
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('获取统计数据失败', 500));
  }
});

// 转化漏斗
router.get('/funnel', authenticate, tenantScope, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const where = {
      tenantId: req.tenantId,
      ...(startDate && endDate && {
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate)
        }
      })
    };

    const funnel = await prisma.customer.groupBy({
      by: ['status'],
      where,
      _count: true
    });

    const result = {
      pending: 0,
      valid: 0,
      invited: 0,
      visited: 0,
      signed: 0,
      dead: 0
    };

    let total = 0;
    funnel.forEach(f => {
      result[f.status] = f._count;
      total += f._count;
    });

    res.json(success({ ...result, total }));
  } catch (err) {
    res.status(500).json(error('获取漏斗数据失败', 500));
  }
});

// 趋势图
router.get('/trend', authenticate, tenantScope, async (req, res) => {
  try {
    const { type = 'calls', days = 30 } = req.query;

    const startDate = dayjs().subtract(parseInt(days), 'day').startOf('day').toDate();

    let groupBy = 'callTime';
    if (type === 'customers') {
      groupBy = 'createdAt';
    }

    const data = await prisma.recording.groupBy({
      by: [groupBy],
      where: {
        tenantId: req.tenantId,
        callTime: { gte: startDate },
        isValid: true
      },
      _count: true,
      orderBy: { [groupBy]: 'asc' }
    });

    // 按天汇总
    const trend = {};
    data.forEach(d => {
      const date = dayjs(d[groupBy]).format('YYYY-MM-DD');
      trend[date] = (trend[date] || 0) + d._count;
    });

    const result = Object.entries(trend).map(([date, count]) => ({
      date,
      count
    }));

    res.json(success(result));
  } catch (err) {
    res.status(500).json(error('获取趋势数据失败', 500));
  }
});

// 渠道 ROI
router.get('/roi', authenticate, tenantScope, async (req, res) => {
  try {
    const { month } = req.query;

    const startDate = dayjs(month || undefined).startOf('month').toDate();
    const endDate = dayjs(month || undefined).endOf('month').toDate();

    // 按渠道统计
    const channelStats = await prisma.customer.groupBy({
      by: ['source'],
      where: {
        tenantId: req.tenantId,
        createdAt: { gte: startDate, lte: endDate }
      },
      _count: true
    });

    const result = channelStats.map(c => ({
      channel: c.source || '未知',
      count: c._count
    }));

    res.json(success(result));
  } catch (err) {
    res.status(500).json(error('获取渠道数据失败', 500));
  }
});

module.exports = router;
