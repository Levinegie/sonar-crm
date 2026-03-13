/**
 * 每日任务分配引擎
 * - ensureTable(): 启动时创建 daily_tasks 表
 * - generateDailyTasks(): 遍历所有租户/agent 生成任务
 * - generateForAgent(): 单个 agent 的任务生成逻辑
 */

const { PrismaClient } = require('@prisma/client');
const dayjs = require('dayjs');

const prisma = new PrismaClient();

// =====================================================
// 启动时确保表存在（兼容无法 prisma db push 的环境）
// =====================================================
async function ensureTable() {
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS daily_tasks (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "tenantId" TEXT NOT NULL,
        "agentId" TEXT NOT NULL,
        "customerId" TEXT NOT NULL,
        date DATE NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        "overdueDays" INT NOT NULL DEFAULT 0,
        "sortOrder" INT NOT NULL DEFAULT 0,
        "completedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE("tenantId", "agentId", "customerId", date)
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_daily_tasks_tenant_agent_date
      ON daily_tasks ("tenantId", "agentId", date)
    `);
    console.log('[DailyTasks] 表已就绪');
  } catch (e) {
    console.error('[DailyTasks] ensureTable 失败:', e.message);
  }
}

// =====================================================
// 遍历所有活跃租户和 agent，生成每日任务
// =====================================================
async function generateDailyTasks() {
  const today = dayjs().startOf('day').toDate();
  console.log('[DailyTasks] 开始生成每日任务:', dayjs(today).format('YYYY-MM-DD'));

  const tenants = await prisma.tenant.findMany({
    where: { status: 'active' }
  });

  let totalTasks = 0;
  for (const tenant of tenants) {
    const agents = await prisma.user.findMany({
      where: {
        tenantId: tenant.id,
        role: 'agent',
        isActive: true,
        OR: [
          { leaveUntil: null },
          { leaveUntil: { lt: today } }
        ]
      }
    });

    for (const agent of agents) {
      const count = await generateForAgent(tenant.id, agent.id, today);
      totalTasks += count;
    }
  }

  console.log(`[DailyTasks] 生成完毕，共 ${totalTasks} 条任务`);
  return totalTasks;
}

// =====================================================
// 单个 agent 的任务生成
// =====================================================
async function generateForAgent(tenantId, agentId, today) {
  const todayStart = dayjs(today).startOf('day');
  const todayEnd = todayStart.endOf('day');
  const todayDate = todayStart.toDate();

  // 幂等：先删除当天已有任务
  await prisma.$executeRawUnsafe(
    `DELETE FROM daily_tasks WHERE "tenantId" = $1 AND "agentId" = $2 AND date = $3`,
    tenantId, agentId, todayDate
  );

  const excludeStatuses = ['dead', 'signed', 'invalid'];
  const tasks = [];
  const seenCustomerIds = new Set();
  let sortOrder = 0;

  // --- P0: 逾期任务 ---
  const overdueCustomers = await prisma.customer.findMany({
    where: {
      tenantId,
      agentId,
      nextFollowAt: { lt: todayStart.toDate() },
      status: { notIn: excludeStatuses },
      seaStatus: null
    },
    orderBy: { nextFollowAt: 'asc' }
  });

  for (const c of overdueCustomers) {
    const overdueDays = todayStart.diff(dayjs(c.nextFollowAt), 'day');
    seenCustomerIds.add(c.id);
    tasks.push({
      tenantId, agentId, customerId: c.id,
      date: todayDate, priority: 'P0', status: 'pending',
      overdueDays, sortOrder: sortOrder++
    });
  }

  // --- P1: 今日 S/A ---
  const todaySA = await prisma.customer.findMany({
    where: {
      tenantId, agentId,
      nextFollowAt: { gte: todayStart.toDate(), lte: todayEnd.toDate() },
      level: { in: ['S', 'A'] },
      status: { notIn: excludeStatuses },
      seaStatus: null,
      id: { notIn: [...seenCustomerIds] }
    },
    orderBy: [{ level: 'asc' }, { nextFollowAt: 'asc' }]
  });

  for (const c of todaySA) {
    seenCustomerIds.add(c.id);
    tasks.push({
      tenantId, agentId, customerId: c.id,
      date: todayDate, priority: 'P1', status: 'pending',
      overdueDays: 0, sortOrder: sortOrder++
    });
  }

  // --- P2: 今日 B/C ---
  const todayBC = await prisma.customer.findMany({
    where: {
      tenantId, agentId,
      nextFollowAt: { gte: todayStart.toDate(), lte: todayEnd.toDate() },
      level: { in: ['B', 'C'] },
      status: { notIn: excludeStatuses },
      seaStatus: null,
      id: { notIn: [...seenCustomerIds] }
    },
    orderBy: [{ level: 'asc' }, { nextFollowAt: 'asc' }]
  });

  for (const c of todayBC) {
    seenCustomerIds.add(c.id);
    tasks.push({
      tenantId, agentId, customerId: c.id,
      date: todayDate, priority: 'P2', status: 'pending',
      overdueDays: 0, sortOrder: sortOrder++
    });
  }

  // --- P3: 补充到 100 条 ---
  const todayCount = todaySA.length + todayBC.length;
  if (todayCount < 100) {
    const need = 100 - todayCount;
    const futureEnd = todayStart.add(3, 'day').endOf('day').toDate();

    const futureCustomers = await prisma.customer.findMany({
      where: {
        tenantId, agentId,
        nextFollowAt: { gt: todayEnd.toDate(), lte: futureEnd },
        status: { notIn: excludeStatuses },
        seaStatus: null,
        id: { notIn: [...seenCustomerIds] }
      },
      orderBy: [
        { level: 'asc' },       // S < A < B < C 字典序，S/A 排前
        { nextFollowAt: 'asc' }
      ],
      take: need
    });

    for (const c of futureCustomers) {
      seenCustomerIds.add(c.id);
      tasks.push({
        tenantId, agentId, customerId: c.id,
        date: todayDate, priority: 'P3', status: 'pending',
        overdueDays: 0, sortOrder: sortOrder++
      });
    }
  }

  // 批量写入
  if (tasks.length > 0) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO daily_tasks (id, "tenantId", "agentId", "customerId", date, priority, status, "overdueDays", "sortOrder", "createdAt")
       VALUES ${tasks.map((_, i) => {
         const base = i * 10;
         return `(gen_random_uuid()::text, $${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, now())`;
       }).join(', ')}`,
      ...tasks.flatMap(t => [t.tenantId, t.agentId, t.customerId, t.date, t.priority, t.status, t.overdueDays, t.sortOrder])
    );
  }

  return tasks.length;
}

module.exports = { ensureTable, generateDailyTasks, generateForAgent };
