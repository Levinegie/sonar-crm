const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// 加载环境变量
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
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
app.use('/api/oss', require('./routes/oss'));
app.use('/api/stats', require('./routes/stats'));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
app.listen(PORT, () => {
  console.log(`🚀 声纳 CRM 服务已启动`);
  console.log(`📍 API 地址: http://localhost:${PORT}/api`);
  console.log(`🎛️  管理后台: http://localhost:${PORT}/admin`);
});

module.exports = app;
