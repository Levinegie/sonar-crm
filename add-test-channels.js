const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function addChannels() {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { slug: 'default' } });

    const channelNames = [
      '抖音-装修主号',
      '抖音-设计号',
      '直播间留资',
      '老客户转介绍',
      '小红书',
      '百度推广',
      '线下活动',
    ];

    for (const name of channelNames) {
      const code = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').toLowerCase();
      const exists = await prisma.channel.findFirst({
        where: { tenantId: tenant.id, name }
      });
      if (!exists) {
        await prisma.channel.create({
          data: { tenantId: tenant.id, name, code: `${code}_${Date.now()}` }
        });
        console.log(`✅ 创建渠道: ${name}`);
      } else {
        console.log(`⏭️  渠道已存在: ${name}`);
      }
    }

    const all = await prisma.channel.findMany({
      where: { tenantId: tenant.id },
      select: { name: true }
    });
    console.log(`\n📊 当前共有 ${all.length} 个渠道:`, all.map(c => c.name).join(', '));
  } catch (e) {
    console.error('❌ 失败:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

addChannels();
