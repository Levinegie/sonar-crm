/**
 * 公海自动回收
 * 每天凌晨执行：将超过 sea_recovery_days 天未跟进的客户移入公海
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runSeaRecovery() {
  console.log('[SeaRecovery] 开始公海自动回收...');

  try {
    // 获取所有活跃租户
    const tenants = await prisma.tenant.findMany({
      where: { status: 'active' }
    });

    let totalMoved = 0;

    for (const tenant of tenants) {
      try {
        // 读取该租户的 sea_recovery_days 设置（默认 6 天）
        const config = await prisma.tenantConfig.findFirst({
          where: { tenantId: tenant.id, key: 'sea_recovery_days' }
        });
        const days = parseInt(config?.value || '6', 10);
        if (!days || days <= 0) continue;

        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // 找出：已分配给客服、不在公海、最后跟进时间超过 cutoff（或从未跟进且创建时间超过 cutoff）
        const stale = await prisma.customer.findMany({
          where: {
            tenantId: tenant.id,
            agentId: { not: null },
            seaStatus: null,
            OR: [
              { lastFollowAt: { lt: cutoff } },
              { lastFollowAt: null, createdAt: { lt: cutoff } }
            ]
          },
          select: { id: true }
        });

        if (!stale.length) continue;

        const ids = stale.map(c => c.id);

        await prisma.customer.updateMany({
          where: { id: { in: ids } },
          data: {
            agentId: null,
            seaStatus: 'in_sea',
            seaReason: `超过 ${days} 天未跟进，自动回收`,
            seaAt: new Date()
          }
        });

        console.log(`[SeaRecovery] 租户 ${tenant.name}(${tenant.id}): 回收 ${ids.length} 个客户`);
        totalMoved += ids.length;
      } catch (err) {
        console.error(`[SeaRecovery] 租户 ${tenant.id} 处理失败:`, err);
      }
    }

    console.log(`[SeaRecovery] 完成，共回收 ${totalMoved} 个客户`);
  } catch (err) {
    console.error('[SeaRecovery] 执行失败:', err);
  }
}

module.exports = { runSeaRecovery };
