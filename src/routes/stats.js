/**
 * 统计路由
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { Prisma } = require('@prisma/client');
const { success, error } = require('../utils/helpers');
const { authenticate, tenantScope, authorize } = require('../middleware/auth');
const { callGemini } = require('../services/ai');
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

    // 客服排行（admin 和 boss 都能看）
    let agentStats = [];
    if (!isAgent && (req.user.role === 'admin' || req.user.role === 'boss')) {
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

// 老板看板 - 客服表现详情
router.get('/agent-performance', authenticate, tenantScope, async (req, res) => {
  try {
    if (req.user.role === 'agent') {
      return res.status(403).json(error('无权限', 403));
    }

    const today = dayjs().startOf('day');
    const monthStart = today.startOf('month').toDate();
    const todayStart = today.toDate();
    const todayEnd = today.endOf('day').toDate();

    const agents = await prisma.user.findMany({
      where: { tenantId: req.tenantId, role: 'agent', isActive: true },
      select: { id: true, name: true, avatar: true }
    });

    const result = [];
    for (const agent of agents) {
      const [todayCalls, monthCalls, customerCount, signedCount, visitedCount] = await Promise.all([
        prisma.recording.count({
          where: { tenantId: req.tenantId, agentId: agent.id, callTime: { gte: todayStart, lte: todayEnd }, isValid: true }
        }),
        prisma.recording.count({
          where: { tenantId: req.tenantId, agentId: agent.id, callTime: { gte: monthStart, lte: todayEnd }, isValid: true }
        }),
        prisma.customer.count({ where: { tenantId: req.tenantId, agentId: agent.id } }),
        prisma.customer.count({ where: { tenantId: req.tenantId, agentId: agent.id, status: 'signed' } }),
        prisma.customer.count({ where: { tenantId: req.tenantId, agentId: agent.id, status: 'visited' } }),
      ]);

      result.push({
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        todayCalls,
        monthCalls,
        customerCount,
        signedCount,
        visitedCount,
      });
    }

    res.json(success(result));
  } catch (err) {
    console.error('Agent performance error:', err);
    res.status(500).json(error('获取客服表现失败', 500));
  }
});

// 老板看板 - 规则设置读取/保存
router.get('/boss-settings', authenticate, tenantScope, async (req, res) => {
  try {
    if (req.user.role === 'agent') {
      return res.status(403).json(error('无权限', 403));
    }

    const configs = await prisma.tenantConfig.findMany({
      where: { tenantId: req.tenantId, category: 'boss_rules' }
    });

    const settings = {};
    configs.forEach(c => { settings[c.key] = c.value; });

    // 返回默认值
    res.json(success({
      daily_call_min: settings.daily_call_min || '60',
      followup_cycle_days: settings.followup_cycle_days || '3',
      sea_recovery_days: settings.sea_recovery_days || '6',
      order_mode: settings.order_mode || 'active',
      per_person_target: settings.per_person_target || '100',
    }));
  } catch (err) {
    res.status(500).json(error('获取规则设置失败', 500));
  }
});

router.put('/boss-settings', authenticate, tenantScope, async (req, res) => {
  try {
    if (req.user.role === 'agent') {
      return res.status(403).json(error('无权限', 403));
    }

    const keys = ['daily_call_min', 'followup_cycle_days', 'sea_recovery_days', 'order_mode', 'per_person_target'];
    for (const key of keys) {
      if (req.body[key] !== undefined) {
        await prisma.tenantConfig.upsert({
          where: { tenantId_key: { tenantId: req.tenantId, key } },
          update: { value: String(req.body[key]) },
          create: { tenantId: req.tenantId, key, value: String(req.body[key]), category: 'boss_rules' }
        });
      }
    }

    res.json(success(null, '规则已保存'));
  } catch (err) {
    console.error('Save boss settings error:', err);
    res.status(500).json(error('保存规则失败', 500));
  }
});

// 请假申请 - 列表（boss/admin 看全部，agent 看自己的）
router.get('/leave-requests', authenticate, tenantScope, async (req, res) => {
  try {
    const isAgent = req.user.role === 'agent';
    const where = {
      tenantId: req.tenantId,
      ...(isAgent && { userId: req.user.id })
    };

    const list = await prisma.leaveRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    // 附加用户名
    const userIds = [...new Set(list.map(l => l.userId))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true }
    });
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u.name; });

    const result = list.map(l => ({
      ...l,
      userName: userMap[l.userId] || '未知'
    }));

    res.json(success(result));
  } catch (err) {
    res.status(500).json(error('获取请假列表失败', 500));
  }
});

// 请假申请 - 提交（agent）
router.post('/leave-requests', authenticate, tenantScope, async (req, res) => {
  try {
    const { type = 'leave', startDate, endDate, reason } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json(error('请选择起止日期', 400));
    }

    const leave = await prisma.leaveRequest.create({
      data: {
        tenantId: req.tenantId,
        userId: req.user.id,
        type,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        reason
      }
    });

    res.json(success(leave, '申请已提交'));
  } catch (err) {
    res.status(500).json(error('提交申请失败', 500));
  }
});

// 请假申请 - 审批（boss/admin）
router.put('/leave-requests/:id', authenticate, tenantScope, async (req, res) => {
  try {
    if (req.user.role === 'agent') {
      return res.status(403).json(error('无权限', 403));
    }

    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json(error('状态无效', 400));
    }

    const leave = await prisma.leaveRequest.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId }
    });
    if (!leave) return res.status(404).json(error('申请不存在', 404));

    const updated = await prisma.leaveRequest.update({
      where: { id: req.params.id },
      data: { status, reviewedBy: req.user.id, reviewedAt: new Date() }
    });

    res.json(success(updated, status === 'approved' ? '已批准' : '已拒绝'));
  } catch (err) {
    res.status(500).json(error('审批失败', 500));
  }
});

// 违禁词预警列表
router.get('/violations', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { tenantId: req.tenantId, type: 'violation' },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    // 收集 agentId 和 recordingId
    const agentIds = new Set();
    const recordingIds = new Set();
    const parsed = notifications.map(n => {
      let data = {};
      try { data = JSON.parse(n.content); } catch {}
      if (data.agentId) agentIds.add(data.agentId);
      if (data.recordingId) recordingIds.add(data.recordingId);
      return { ...n, parsed: data };
    });

    // 批量查询客服名和录音信息
    const [users, recordings] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: [...agentIds] } },
        select: { id: true, name: true }
      }),
      prisma.recording.findMany({
        where: { id: { in: [...recordingIds] } },
        select: { id: true, callTime: true, customerPhone: true }
      })
    ]);

    const userMap = {};
    users.forEach(u => { userMap[u.id] = u.name; });
    const recMap = {};
    recordings.forEach(r => { recMap[r.id] = r; });

    const result = parsed.map(n => ({
      id: n.id,
      agentName: userMap[n.parsed.agentId] || '未知',
      words: (n.parsed.words || []).map(w => w.word),
      wordDetails: n.parsed.words || [],
      recordingId: n.parsed.recordingId,
      callTime: recMap[n.parsed.recordingId]?.callTime || n.createdAt,
      customerPhone: recMap[n.parsed.recordingId]?.customerPhone || '',
      createdAt: n.createdAt
    }));

    res.json(success(result));
  } catch (err) {
    console.error('Get violations error:', err);
    res.status(500).json(error('获取违禁词预警失败', 500));
  }
});

// ══ 月度经营报告 ══

async function gatherMonthlyData(tenantId, month) {
  const startDate = dayjs(month).startOf('month').toDate();
  const endDate = dayjs(month).endOf('month').toDate();
  const dateRange = { gte: startDate, lte: endDate };

  const [
    totalCalls, validCalls, funnel, agentStats, channelStats, violationCount
  ] = await Promise.all([
    prisma.recording.count({ where: { tenantId, callTime: dateRange } }),
    prisma.recording.count({ where: { tenantId, callTime: dateRange, isValid: true } }),
    prisma.customer.groupBy({
      by: ['status'],
      where: { tenantId, createdAt: dateRange },
      _count: true
    }),
    // 各客服表现
    prisma.user.findMany({
      where: { tenantId, role: 'agent', isActive: true },
      select: { id: true, name: true }
    }).then(async agents => {
      const results = [];
      for (const agent of agents) {
        const [calls, customers, signed] = await Promise.all([
          prisma.recording.count({ where: { tenantId, agentId: agent.id, callTime: dateRange, isValid: true } }),
          prisma.customer.count({ where: { tenantId, agentId: agent.id, createdAt: dateRange } }),
          prisma.customer.count({ where: { tenantId, agentId: agent.id, status: 'signed', updatedAt: dateRange } }),
        ]);
        results.push({ name: agent.name, calls, customers, signed });
      }
      return results;
    }),
    prisma.customer.groupBy({
      by: ['source'],
      where: { tenantId, createdAt: dateRange },
      _count: true
    }),
    prisma.notification.count({ where: { tenantId, type: 'violation', createdAt: dateRange } })
  ]);

  const funnelData = { pending: 0, valid: 0, invited: 0, visited: 0, signed: 0, dead: 0 };
  funnel.forEach(f => { funnelData[f.status] = f._count; });
  const funnelTotal = Object.values(funnelData).reduce((a, b) => a + b, 0);

  const channels = channelStats.map(c => ({ source: c.source || '未知', count: c._count }));

  return { totalCalls, validCalls, funnel: { ...funnelData, total: funnelTotal }, agents: agentStats, channels, violationCount };
}

// GET /api/stats/monthly-report?month=2026-03
router.get('/monthly-report', authenticate, tenantScope, async (req, res) => {
  try {
    if (req.user.role === 'agent') return res.status(403).json(error('无权限', 403));

    const month = req.query.month || dayjs().format('YYYY-MM');
    const cacheKey = `report_${month}`;

    // 查找缓存
    const cached = await prisma.tenantConfig.findFirst({
      where: { tenantId: req.tenantId, key: cacheKey, category: 'monthly_report' }
    });

    const stats = await gatherMonthlyData(req.tenantId, month);

    if (cached) {
      let reportContent = null;
      try { reportContent = JSON.parse(cached.value); } catch {}
      return res.json(success({ month, stats, reportContent }));
    }

    res.json(success({ month, stats, reportContent: null }));
  } catch (err) {
    console.error('Monthly report error:', err);
    res.status(500).json(error('获取月度报告失败', 500));
  }
});

// POST /api/stats/monthly-report/generate
router.post('/monthly-report/generate', authenticate, tenantScope, async (req, res) => {
  try {
    if (req.user.role === 'agent') return res.status(403).json(error('无权限', 403));

    const month = req.body.month || dayjs().format('YYYY-MM');
    const stats = await gatherMonthlyData(req.tenantId, month);

    const messages = [
      {
        role: 'system',
        content: `你是一位资深的家装行业经营分析师。请根据提供的月度经营数据，生成一份专业的经营分析报告。
请严格按照以下 JSON 格式输出，不要输出其他内容：
{
  "summary": "本月经营总结（200字左右）",
  "highlights": ["亮点1", "亮点2", "亮点3"],
  "concerns": ["问题1", "问题2"],
  "funnel_analysis": "转化漏斗分析（分析各阶段转化率，指出瓶颈）",
  "agent_analysis": "客服表现分析（对比各客服数据，指出优秀和需改进的）",
  "channel_analysis": "渠道分析（各渠道获客效果对比）",
  "suggestions": ["建议1", "建议2", "建议3"]
}`
      },
      {
        role: 'user',
        content: `以下是 ${month} 月的经营数据：

通话数据：总通话 ${stats.totalCalls} 次，有效通话 ${stats.validCalls} 次，有效率 ${stats.totalCalls ? Math.round(stats.validCalls / stats.totalCalls * 100) : 0}%

客户转化漏斗：
- 新增客户总数: ${stats.funnel.total}
- 待跟进: ${stats.funnel.pending}
- 有效客户: ${stats.funnel.valid}
- 已邀约: ${stats.funnel.invited}
- 已到店: ${stats.funnel.visited}
- 已签单: ${stats.funnel.signed}
- 无效/死单: ${stats.funnel.dead}

客服表现：
${stats.agents.map(a => `- ${a.name}：有效通话 ${a.calls} 次，客户 ${a.customers} 个，签单 ${a.signed} 个`).join('\n')}

渠道来源：
${stats.channels.map(c => `- ${c.source}：${c.count} 个客户`).join('\n')}

违禁词预警：本月共 ${stats.violationCount} 次

请生成经营分析报告。`
      }
    ];

    const rawOutput = await callGemini(messages, { temperature: 0.5, maxTokens: 4096 });

    // 解析 JSON
    let reportContent;
    try {
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      reportContent = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: rawOutput };
    } catch {
      reportContent = { summary: rawOutput };
    }

    // 缓存到 TenantConfig
    const cacheKey = `report_${month}`;
    await prisma.tenantConfig.upsert({
      where: { tenantId_key: { tenantId: req.tenantId, key: cacheKey } },
      update: { value: JSON.stringify(reportContent) },
      create: { tenantId: req.tenantId, key: cacheKey, value: JSON.stringify(reportContent), category: 'monthly_report' }
    });

    res.json(success({ month, stats, reportContent }));
  } catch (err) {
    console.error('Generate report error:', err);
    res.status(500).json(error('生成报告失败', 500));
  }
});

module.exports = router;
