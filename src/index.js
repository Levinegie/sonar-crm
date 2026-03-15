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
app.use('/api/agent', require('./routes/agent'));

// 临时重置密码接口（紧急使用，用完记得删除）
app.post('/api/emergency-reset-password', async (req, res) => {
  const { PrismaClient } = require('@prisma/client');
  const bcrypt = require('bcryptjs');
  const prisma = new PrismaClient();

  try {
    const { secret } = req.body;

    // 简单的安全验证
    if (secret !== 'reset-admin-2026') {
      return res.status(403).json({ success: false, error: '无权限' });
    }

    const admin = await prisma.user.findFirst({
      where: { username: 'admin', role: 'admin' }
    });

    if (!admin) {
      return res.status(404).json({ success: false, error: '未找到 admin 账号' });
    }

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

    res.json({
      success: true,
      message: '密码已重置为 admin123',
      username: admin.username
    });

  } catch (err) {
    console.error('[Emergency Reset] 失败:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    await prisma.$disconnect();
  }
});

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
    // 例如: https://xxx.oss.com/bucket/租户文件夹/员工文件夹/20240316_123456_13800138000.m4a
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const pathParts = pathname.split('/').filter(p => p);
    const fileName = pathParts[pathParts.length - 1];
    const agentFolder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : null;
    const tenantFolder = pathParts.length > 2 ? pathParts[pathParts.length - 3] : null;

    console.log('[APK Callback] 租户文件夹:', tenantFolder, '员工文件夹:', agentFolder, '文件名:', fileName);

    // 通用解析：提取手机号和时间
    let customerPhone = null;
    let callTime = new Date();

    // 1. 提取11位手机号（任意位置，1开头）
    const phoneMatch = fileName.match(/\b(1[3-9]\d{9})\b/);
    if (phoneMatch) {
      customerPhone = phoneMatch[1];
    }

    // 2. 提取日期时间（支持多种格式）
    let dateTimeMatch = null;

    // 格式1: YYYYMMDD_HHMMSS 或 YYMMDD_HHMMSS
    dateTimeMatch = fileName.match(/(\d{6,8})_(\d{6})/);
    if (dateTimeMatch) {
      let [, dateStr, timeStr] = dateTimeMatch;

      // 判断是6位还是8位日期
      let year, month, day;
      if (dateStr.length === 8) {
        year = dateStr.substr(0, 4);
        month = dateStr.substr(4, 2);
        day = dateStr.substr(6, 2);
      } else {
        // 6位日期，补充20前缀
        year = '20' + dateStr.substr(0, 2);
        month = dateStr.substr(2, 2);
        day = dateStr.substr(4, 2);
      }

      const hour = timeStr.substr(0, 2);
      const minute = timeStr.substr(2, 2);
      const second = timeStr.substr(4, 2);

      callTime = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
    }
    // 格式2: YYYY-MM-DD HH_MM_SS
    else {
      dateTimeMatch = fileName.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2})[_:](\d{2})[_:](\d{2})/);
      if (dateTimeMatch) {
        const [, year, month, day, hour, minute, second] = dateTimeMatch;
        callTime = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
      }
    }

    console.log('[APK Callback] 通话时间:', callTime, '客户电话:', customerPhone);

    // 根据文件夹名查找租户和客服
    let agent = null;
    let tenant = null;

    // 先匹配租户
    if (tenantFolder) {
      tenant = await prisma.tenant.findFirst({
        where: { ossFolder: tenantFolder }
      });

      if (tenant) {
        console.log('[APK Callback] 匹配到租户:', tenant.name);

        // 在该租户下匹配客服
        if (agentFolder) {
          agent = await prisma.user.findFirst({
            where: {
              tenantId: tenant.id,
              ossFolder: agentFolder,
              role: 'agent'
            }
          });

          if (agent) {
            console.log('[APK Callback] 匹配到客服:', agent.name);
          } else {
            console.log('[APK Callback] 未找到匹配的客服，员工文件夹:', agentFolder);
          }
        }
      } else {
        console.log('[APK Callback] 未找到匹配的租户，租户文件夹:', tenantFolder);
      }
    }

    // 如果没有匹配到租户，查找交换空间租户作为默认
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
