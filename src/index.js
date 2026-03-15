const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const cron = require('node-cron');

// 加载环境变量
dotenv.config();

// 全局未捕获异常兜底，防止进程无声崩溃
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err);
});

const { ensureTable, generateDailyTasks } = require('./services/daily-tasks');
const { startWorker } = require('./services/queue');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null;

app.use(cors({
  origin: allowedOrigins
    ? (origin, cb) => {
        // 允许无 origin 的请求（服务端直调、健康检查）和白名单内的域名
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error('Not allowed by CORS'));
      }
    : true  // 未配置时全放行（开发环境）
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 静态文件（三个端）
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.use('/agent', express.static(path.join(__dirname, '../public/agent')));
app.use('/boss', express.static(path.join(__dirname, '../public/boss')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// API 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/recordings', require('./routes/recordings'));
app.use('/api/analysis', require('./routes/analysis'));
app.use('/api/config', require('./routes/config'));
app.use('/api/tenants', require('./routes/tenants'));
app.use('/api/oss', require('./routes/oss'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/tasks', require('./routes/tasks'));

const { PrismaClient } = require('@prisma/client');
const healthPrisma = new PrismaClient();

// 健康检查
app.get('/api/health', async (req, res) => {
  try {
    await healthPrisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable', timestamp: new Date().toISOString() });
  }
});

// 根路径重定向到管理后台
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || '服务器内部错误',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 启动服务器
app.listen(PORT, async () => {
  console.log(`🚀 声纳 CRM 服务已启动`);
  console.log(`📍 API 地址: http://localhost:${PORT}/api`);
  console.log(`🎛️  管理后台: http://localhost:${PORT}/admin`);

  // 启动时确保 daily_tasks 表存在
  await ensureTable();

  // 启动录音分析队列 worker
  startWorker();

  // 每天凌晨 00:00（Asia/Shanghai）自动生成每日任务
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] 开始生成每日任务...');
    try {
      await generateDailyTasks();
    } catch (e) {
      console.error('[Cron] 生成每日任务失败:', e);
    }
  }, { timezone: 'Asia/Shanghai' });
  console.log('[Cron] 每日任务定时器已注册 (00:00 Asia/Shanghai)');
});

module.exports = app;
