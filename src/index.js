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
const { runSeaRecovery } = require('./services/sea-recovery');

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

// APK 上传完成回调（硬编码在 APK 里的接口）
const { v4: uuidv4 } = require('uuid');
const { analyzeRecording } = require('./services/ai');
const { success, error } = require('./utils/helpers');

app.post('/api/url', async (req, res) => {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    console.log('[APK Callback] 收到通知:', req.body);

    const { url } = req.body;

    if (!url) {
      return res.status(400).json(error('缺少 url 参数', 400));
    }

    // 从 URL 中提取文件夹和文件名
    // 例如: https://xxx.oss.com/bucket/agent001/20240316_123456_13800138000.m4a
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const pathParts = pathname.split('/').filter(p => p);
    const fileName = pathParts[pathParts.length - 1];
    const folderName = pathParts.length > 1 ? pathParts[pathParts.length - 2] : null;

    console.log('[APK Callback] 文件夹:', folderName, '文件名:', fileName);

    // 解析文件名获取信息（格式: 20240316_123456_13800138000.m4a）
    const match = fileName.match(/(\d{8})_(\d{6})_(\d+)/);

    let callTime = new Date();
    let customerPhone = null;

    if (match) {
      const [, dateStr, timeStr, phone] = match;
      const year = dateStr.substr(0, 4);
      const month = dateStr.substr(4, 2);
      const day = dateStr.substr(6, 2);
      const hour = timeStr.substr(0, 2);
      const minute = timeStr.substr(2, 2);
      const second = timeStr.substr(4, 2);

      callTime = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
      customerPhone = phone;
    }

    console.log('[APK Callback] 通话时间:', callTime, '客户电话:', customerPhone);

    // 根据文件夹名查找客服
    let agent = null;
    let tenant = null;

    if (folderName) {
      agent = await prisma.user.findFirst({
        where: {
          ossFolder: folderName,
          role: 'agent'
        },
        include: { tenant: true }
      });

      if (agent) {
        tenant = agent.tenant;
        console.log('[APK Callback] 匹配到客服:', agent.name, '租户:', tenant.name);
      } else {
        console.log('[APK Callback] 未找到匹配的客服，文件夹:', folderName);
      }
    }

    // 如果没有匹配到客服，查找交换空间租户作为默认
    if (!tenant) {
      tenant = await prisma.tenant.findFirst({
        where: { name: '交换空间' }
      });
    }

    if (!tenant) {
      return res.status(500).json(error('租户不存在', 500));
    }

    // 创建录音记录
    const recording = await prisma.recording.create({
      data: {
        id: uuidv4(),
        tenantId: tenant.id,
        agentId: agent?.id || null, // 如果匹配到客服就关联，否则为空（孤儿录音）
        ossUrl: url,
        ossKey: pathname.substring(1), // 去掉开头的 /
        fileName: fileName,
        fileSize: 0,
        customerPhone: customerPhone || 'unknown', // 如果没有电话号码，使用默认值
        callTime,
        analysisStatus: agent ? 'pending' : 'unassigned' // 有客服就待分析，无客服就未分配
      }
    });

    console.log('[APK Callback] 录音记录已创建:', recording.id, agent ? '(已关联客服)' : '(孤儿录音)');

    // 只有匹配到客服才触发 AI 分析
    if (agent) {
      analyzeRecording(recording.id).catch(err => {
        console.error('[APK Callback] AI分析失败:', err);
      });
    }

    res.json(success({
      recordingId: recording.id,
      matched: !!agent,
      agentName: agent?.name
    }, agent ? '录音已接收，正在分析' : '录音已接收，等待分配'));

  } catch (err) {
    console.error('[APK Callback] 处理失败:', err);
    res.status(500).json(error('处理失败: ' + err.message, 500));
  } finally {
    await prisma.$disconnect();
  }
});

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

  // 每天凌晨 00:00（Asia/Shanghai）自动生成每日任务 + 公海回收
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] 开始生成每日任务...');
    try {
      await generateDailyTasks();
    } catch (e) {
      console.error('[Cron] 生成每日任务失败:', e);
    }
    try {
      await runSeaRecovery();
    } catch (e) {
      console.error('[Cron] 公海回收失败:', e);
    }
  }, { timezone: 'Asia/Shanghai' });
  console.log('[Cron] 每日任务定时器已注册 (00:00 Asia/Shanghai)');
});

module.exports = app;
