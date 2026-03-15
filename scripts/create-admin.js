const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function createAdmin() {
  try {
    console.log('检查admin用户...');

    // 查找或创建默认租户
    let tenant = await prisma.tenant.findFirst({
      where: { slug: 'default' }
    });

    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: {
          id: 'default-tenant',
          name: '默认租户',
          slug: 'default'
        }
      });
      console.log('✓ 创建默认租户');
    }

    // 查找admin用户
    let admin = await prisma.user.findFirst({
      where: { username: 'admin' }
    });

    if (admin) {
      console.log('✓ admin用户已存在');
    } else {
      // 创建admin用户
      const hashedPassword = await bcrypt.hash('du5616', 10);
      admin = await prisma.user.create({
        data: {
          id: 'admin-user',
          username: 'admin',
          password: hashedPassword,
          name: '管理员',
          role: 'admin',
          tenantId: tenant.id
        }
      });
      console.log('✓ 创建admin用户 (用户名: admin, 密码: du5616)');
    }

    console.log('\n完成！');
  } catch (error) {
    console.error('失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createAdmin();
