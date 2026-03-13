/**
 * 每日任务 API
 * GET  /api/tasks/today            - 获取当天任务列表
 * POST /api/tasks/:id/complete     - 标记任务完成
 * POST /api/tasks/complete-by-customer - 按 customerId 完成今日任务
 * POST /api/tasks/generate         - 手动触发生成（admin/boss）
 */

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const dayjs = require('dayjs');
const { authenticate, authorize } = require('../middleware/auth');
const { success, error } = require('../utils/helpers');
const { generateDailyTasks } = require('../services/daily-tasks');

const prisma = new PrismaClient();

// 所有接口需要登录
router.use(authenticate);

// =====================================================
// GET /today - 获取当天任务列表（含客户信息）
// =====================================================
router.get('/today', async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const agentId = req.user.id;
    const today = dayjs().startOf('day').toDate();

    const tasks = await prisma.$queryRawUnsafe(`
      SELECT t.id, t.priority, t.status, t."overdueDays", t."sortOrder", t."completedAt",
             c.id as "customerId", c.name as "customerName", c."phoneMasked",
             c.level, c.community, c."callCount", c."nextFollowAt",
             c.area, c.budget, c.portrait, c."portraitPct", c.phone,
             c.status as "customerStatus", c."seaStatus"
      FROM daily_tasks t
      JOIN customers c ON c.id = t."customerId"
      WHERE t."tenantId" = $1 AND t."agentId" = $2 AND t.date = $3
        AND c.status NOT IN ('dead', 'signed', 'invalid')
        AND c."seaStatus" IS NULL
      ORDER BY t."sortOrder" ASC
    `, tenantId, agentId, today);

    // 格式化返回
    const formatted = tasks.map(t => ({
      id: t.id,
      priority: t.priority,
      status: t.status,
      overdueDays: t.overdueDays,
      sortOrder: t.sortOrder,
      completedAt: t.completedAt,
      customer: {
        id: t.customerId,
        name: t.customerName,
        phoneMasked: t.phoneMasked,
        phone: t.phone,
        level: t.level,
        community: t.community,
        area: t.area,
        budget: t.budget,
        callCount: t.callCount,
        nextFollowAt: t.nextFollowAt,
        portraitPct: t.portraitPct,
        portrait: t.portrait
      }
    }));
    const stats = {
      total: formatted.length,
      completed: formatted.filter(t => t.status === 'completed').length,
      overdue: formatted.filter(t => t.priority === 'P0').length,
      pending: formatted.filter(t => t.status === 'pending').length
    };

    res.json(success({ tasks: formatted, stats }));
  } catch (e) {
    console.error('[Tasks] GET /today error:', e);
    res.status(500).json(error('获取任务列表失败'));
  }
});

// =====================================================
// POST /:id/complete - 标记任务完成
// =====================================================
router.post('/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.$executeRawUnsafe(
      `UPDATE daily_tasks SET status = 'completed', "completedAt" = now()
       WHERE id = $1 AND "tenantId" = $2 AND "agentId" = $3`,
      id, req.user.tenantId, req.user.id
    );
    res.json(success({ id, status: 'completed' }));
  } catch (e) {
    console.error('[Tasks] POST /:id/complete error:', e);
    res.status(500).json(error('完成任务失败'));
  }
});

// =====================================================
// POST /complete-by-customer - 按 customerId 完成今日任务
// =====================================================
router.post('/complete-by-customer', async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json(error('缺少 customerId'));

    const today = dayjs().startOf('day').toDate();
    await prisma.$executeRawUnsafe(
      `UPDATE daily_tasks SET status = 'completed', "completedAt" = now()
       WHERE "tenantId" = $1 AND "agentId" = $2 AND "customerId" = $3 AND date = $4 AND status = 'pending'`,
      req.user.tenantId, req.user.id, customerId, today
    );
    res.json(success({ customerId, status: 'completed' }));
  } catch (e) {
    console.error('[Tasks] POST /complete-by-customer error:', e);
    res.status(500).json(error('完成任务失败'));
  }
});

// =====================================================
// POST /generate - 手动触发生成（admin/boss）
// =====================================================
router.post('/generate', authorize('admin', 'boss'), async (req, res) => {
  try {
    const count = await generateDailyTasks();
    res.json(success({ generated: count }));
  } catch (e) {
    console.error('[Tasks] POST /generate error:', e);
    res.status(500).json(error('生成任务失败'));
  }
});

module.exports = router;
