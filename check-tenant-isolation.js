const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkTenantIsolation() {
  console.log('🔍 检查租户隔离逻辑\n');

  try {
    // 1. 检查所有租户
    const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, slug: true } });
    console.log(`📊 系统中共有 ${tenants.length} 个租户:`);
    tenants.forEach(t => console.log(`   - ${t.name} (${t.slug})`));
    console.log('');

    // 2. 检查每个租户的用户数
    for (const tenant of tenants) {
      const users = await prisma.user.findMany({
        where: { tenantId: tenant.id },
        select: { username: true, role: true, name: true }
      });
      console.log(`👥 租户 [${tenant.name}] 的用户 (${users.length}个):`);
      users.forEach(u => console.log(`   - ${u.name} (${u.username}) - ${u.role}`));
      console.log('');
    }

    // 3. 检查每个租户的客户数
    for (const tenant of tenants) {
      const customers = await prisma.customer.count({ where: { tenantId: tenant.id } });
      console.log(`📇 租户 [${tenant.name}] 的客户数: ${customers}`);
    }
    console.log('');

    // 4. 检查每个租户的录音数
    for (const tenant of tenants) {
      const recordings = await prisma.recording.count({ where: { tenantId: tenant.id } });
      console.log(`🎙️  租户 [${tenant.name}] 的录音数: ${recordings}`);
    }
    console.log('');

    // 5. 检查每个租户的渠道数
    for (const tenant of tenants) {
      const channels = await prisma.channel.findMany({
        where: { tenantId: tenant.id },
        select: { name: true }
      });
      console.log(`📢 租户 [${tenant.name}] 的渠道 (${channels.length}个):`);
      channels.forEach(ch => console.log(`   - ${ch.name}`));
      console.log('');
    }

    // 6. 检查是否有跨租户的数据关联
    console.log('🔒 检查跨租户数据泄露风险:\n');

    // 检查客户的 agentId 是否属于同一租户
    const allCustomers = await prisma.customer.findMany({
      where: { agentId: { not: null } },
      include: { agent: { select: { tenantId: true } } }
    });
    const crossTenantCustomers = allCustomers.filter(c => c.tenantId !== c.agent.tenantId);

    if (crossTenantCustomers.length > 0) {
      console.log(`❌ 发现 ${crossTenantCustomers.length} 个跨租户的客户-客服关联!`);
      crossTenantCustomers.forEach(c => console.log(`   客户 ${c.name}: 客户租户=${c.tenantId}, 客服租户=${c.agent.tenantId}`));
    } else {
      console.log('✅ 客户-客服关联：无跨租户问题');
    }

    // 检查录音的 agentId 是否属于同一租户
    const allRecordings = await prisma.recording.findMany({
      where: { agentId: { not: null } },
      include: { agent: { select: { tenantId: true } } }
    });
    const crossTenantRecordings = allRecordings.filter(r => r.tenantId !== r.agent.tenantId);

    if (crossTenantRecordings.length > 0) {
      console.log(`❌ 发现 ${crossTenantRecordings.length} 个跨租户的录音-客服关联!`);
    } else {
      console.log('✅ 录音-客服关联：无跨租户问题');
    }

    console.log('\n✅ 租户隔离检查完成');

  } catch (e) {
    console.error('❌ 检查失败:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkTenantIsolation();
