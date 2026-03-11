const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function initDatabase() {
  try {
    // 尝试执行一个简单查询来检查连接
    await prisma.$queryRaw`SELECT 1`;
    console.log('Database connected successfully');

    // 使用 Prisma 的 db push 功能
    const { execSync } = require('child_process');
    try {
      execSync('npx prisma db push --skip-generate --accept-data-loss', {
        stdio: 'inherit',
        timeout: 60000
      });
      console.log('Database schema pushed successfully');
    } catch (error) {
      console.log('Note: Schema push had issues, but continuing...');
    }
  } catch (error) {
    console.error('Database connection failed:', error.message);
    console.log('Retrying in 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    return initDatabase();
  }
}

initDatabase()
  .then(() => {
    console.log('Starting application...');
    require('./src/index.js');
  })
  .catch((error) => {
    console.error('Failed to initialize:', error);
    // 即使初始化失败也启动应用
    require('./src/index.js');
  });
