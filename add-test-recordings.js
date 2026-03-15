const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function addRecordings() {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { slug: 'default' } });
    const agents = await prisma.user.findMany({
      where: { tenantId: tenant.id, role: 'agent' },
      take: 3
    });
    const customers = await prisma.customer.findMany({
      where: { tenantId: tenant.id },
      take: 5
    });

    const today = new Date();
    const recordings = [];

    // 为每个客服创建今日录音
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const callCount = 15 + Math.floor(Math.random() * 20); // 15-35通

      for (let j = 0; j < callCount; j++) {
        const customer = customers[j % customers.length];
        const callTime = new Date(today);
        callTime.setHours(9 + Math.floor(Math.random() * 9)); // 9-18点
        callTime.setMinutes(Math.floor(Math.random() * 60));

        const duration = 60 + Math.floor(Math.random() * 300);
        const fileName = `recording_${Date.now()}_${j}.mp3`;

        recordings.push({
          tenantId: tenant.id,
          agentId: agent.id,
          customerId: customer.id,
          callTime: callTime,
          duration: duration,
          fileName: fileName,
          ossUrl: `https://oss.example.com/recordings/${fileName}`,
          ossKey: `recordings/${tenant.id}/${agent.id}/${fileName}`,
          fileSize: 1024 * (duration / 10), // 模拟文件大小
          customerPhone: customer.phone || '13900000000',
          customerName: customer.name,
          analysisStatus: Math.random() > 0.3 ? 'completed' : 'pending',
          isValid: Math.random() > 0.2
        });
      }
    }

    await prisma.recording.createMany({ data: recordings });
    console.log(`✅ 创建了 ${recordings.length} 条今日录音数据`);

    // 验证数据
    const count = await prisma.recording.count({
      where: {
        tenantId: tenant.id,
        callTime: { gte: new Date(today.setHours(0,0,0,0)) }
      }
    });
    console.log(`📊 今日总录音数：${count}`);

  } catch (error) {
    console.error('❌ 创建录音失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

addRecordings();
