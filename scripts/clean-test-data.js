const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanTestData() {
  try {
    console.log('开始清理测试数据...');

    // 删除录音分析
    const deletedAnalysis = await prisma.analysisResult.deleteMany({});
    console.log(`✓ 删除 ${deletedAnalysis.count} 条录音分析`);

    // 删除录音
    const deletedRecordings = await prisma.recording.deleteMany({});
    console.log(`✓ 删除 ${deletedRecordings.count} 条录音记录`);

    // 删除跟进记录
    const deletedFollowUps = await prisma.followUp.deleteMany({});
    console.log(`✓ 删除 ${deletedFollowUps.count} 条跟进记录`);

    // 删除客户
    const deletedCustomers = await prisma.customer.deleteMany({});
    console.log(`✓ 删除 ${deletedCustomers.count} 条客户记录`);

    // 删除每日任务
    const deletedTasks = await prisma.dailyTask.deleteMany({});
    console.log(`✓ 删除 ${deletedTasks.count} 条每日任务`);

    // 删除通知
    const deletedNotifications = await prisma.notification.deleteMany({});
    console.log(`✓ 删除 ${deletedNotifications.count} 条通知`);

    // 删除所有非admin用户
    const deletedUsers = await prisma.user.deleteMany({
      where: {
        username: { not: 'admin' }
      }
    });
    console.log(`✓ 删除 ${deletedUsers.count} 个用户（保留admin）`);

    console.log('\n清理完成！');
  } catch (error) {
    console.error('清理失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

cleanTestData();
