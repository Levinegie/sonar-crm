// 临时重置密码脚本
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function resetPassword() {
  try {
    // 查找 admin 账号
    const admin = await prisma.user.findFirst({
      where: {
        username: 'admin',
        role: 'admin'
      }
    });

    if (!admin) {
      console.log('❌ 未找到 admin 账号');
      return;
    }

    console.log('找到账号:', admin.username, '(', admin.name, ')');

    // 重置密码为 admin123
    const newPassword = 'admin123';
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: admin.id },
      data: {
        password: hashedPassword,
        loginFailCount: 0,
        lockedUntil: null
      }
    });

    console.log('✅ 密码已重置！');
    console.log('用户名: admin');
    console.log('新密码: admin123');
    console.log('请登录后立即修改密码');

  } catch (err) {
    console.error('❌ 重置失败:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

resetPassword();
