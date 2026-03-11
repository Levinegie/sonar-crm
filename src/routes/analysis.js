/**
 * 分析结果路由
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, tenantScope, success, error } = require('../utils/helpers');

const router = express.Router();
const prisma = new PrismaClient();

// 获取分析结果详情
router.get('/:recordingId', authenticate, tenantScope, async (req, res) => {
  try {
    const { recordingId } = req.params;
    const { stage } = req.query;

    const where = {
      recordingId,
      ...(stage && { stage })
    };

    const results = await prisma.analysisResult.findMany({
      where,
      orderBy: { stage: 'asc' }
    });

    res.json(success(results));
  } catch (err) {
    res.status(500).json(error('获取分析结果失败', 500));
  }
});

// 获取客户的分析历史
router.get('/customer/:customerId', authenticate, tenantScope, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { page = 1, pageSize = 10 } = req.query;

    const [list, total] = await Promise.all([
      prisma.analysisResult.findMany({
        where: { customerId },
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { createdAt: 'desc' },
        include: {
          recording: { select: { id: true, callTime: true, duration: true } }
        }
      }),
      prisma.analysisResult.count({ where: { customerId } })
    ]);

    res.json(success({ list, total, page: parseInt(page), pageSize: parseInt(pageSize) }));
  } catch (err) {
    res.status(500).json(error('获取分析历史失败', 500));
  }
});

module.exports = router;
