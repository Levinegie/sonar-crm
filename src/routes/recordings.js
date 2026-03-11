/**
 * 录音管理路由
 * 上传、列表、分析
 */

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { PrismaClient } = require('@prisma/client');
const { success, error, paginate } = require('../utils/helpers');
const { authenticate, tenantScope } = require('../middleware/auth');
const { uploadToOSS, deleteFromOSS } = require('../services/oss');
const { analyzeRecording } = require('../services/ai');

const router = express.Router();
const prisma = new PrismaClient();

// Multer 配置（临时存储）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// 获取录音列表
router.get('/', authenticate, tenantScope, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, agentId, customerId, analysisStatus, keyword, startDate, endDate } = req.query;

    const isAgent = req.user.role === 'agent';

    const where = {
      tenantId: req.tenantId,
      ...(isAgent && { agentId: req.user.id }),
      ...(agentId && { agentId }),
      ...(customerId && { customerId }),
      ...(analysisStatus && { analysisStatus }),
      ...(keyword && {
        OR: [
          { customerName: { contains: keyword } },
          { fileName: { contains: keyword } }
        ]
      }),
      ...(startDate && endDate && {
        callTime: {
          gte: new Date(startDate),
          lte: new Date(endDate)
        }
      })
    };

    const [list, total] = await Promise.all([
      prisma.recording.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { callTime: 'desc' },
        include: {
          customer: { select: { id: true, name: true, phone: true, community: true } },
          agent: { select: { id: true, name: true } },
          _count: { select: { analysisResults: true } }
        }
      }),
      prisma.recording.count({ where })
    ]);

    // 脱敏处理
    const sanitizedList = list.map(r => ({
      ...r,
      customer: r.customer ? {
        ...r.customer,
        phone: r.customer.phone ? r.customer.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : null
      } : null
    }));

    res.json(success(paginate(sanitizedList, total, page, pageSize)));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('获取录音列表失败', 500));
  }
});

// 上传录音
router.post('/upload', authenticate, tenantScope, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(error('请选择要上传的文件', 400));
    }

    const { customerPhone, customerName, agentId, callTime } = req.body;

    // 生成 OSS 路径
    const ossKey = `recordings/${req.tenantId}/${Date.now()}-${uuidv4()}.m4a`;

    // 上传到 OSS
    const ossUrl = await uploadToOSS(req.file.buffer, ossKey, req.file.mimetype);

    // 创建录音记录
    const recording = await prisma.recording.create({
      data: {
        tenantId: req.tenantId,
        fileName: req.file.originalname,
        ossUrl,
        ossKey,
        fileSize: req.file.size,
        customerPhone: customerPhone || '',
        customerName,
        agentId: agentId || req.user.id,
        callTime: callTime ? new Date(callTime) : new Date(),
        analysisStatus: 'pending'
      }
    });

    // 触发 AI 分析（异步）
    analyzeRecording(recording.id).catch(err => {
      console.error('AI analysis failed:', err);
    });

    res.json(success(recording, '上传成功，正在分析'));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('上传失败', 500));
  }
});

// 获取录音详情
router.get('/:id', authenticate, tenantScope, async (req, res) => {
  try {
    const recording = await prisma.recording.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        customer: true,
        agent: { select: { id: true, name: true } },
        analysisResults: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!recording) {
      return res.status(404).json(error('录音不存在', 404));
    }

    res.json(success(recording));
  } catch (err) {
    res.status(500).json(error('获取详情失败', 500));
  }
});

// 手动触发分析
router.post('/:id/analyze', authenticate, tenantScope, async (req, res) => {
  try {
    const recording = await prisma.recording.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId }
    });

    if (!recording) {
      return res.status(404).json(error('录音不存在', 404));
    }

    // 更新状态
    await prisma.recording.update({
      where: { id: recording.id },
      data: { analysisStatus: 'processing' }
    });

    // 触发分析
    analyzeRecording(recording.id).catch(err => {
      console.error('Analysis failed:', err);
    });

    res.json(success(null, '已开始分析'));
  } catch (err) {
    res.status(500).json(error('触发分析失败', 500));
  }
});

// 删除录音
router.delete('/:id', authenticate, tenantScope, async (req, res) => {
  try {
    const recording = await prisma.recording.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId }
    });

    if (!recording) {
      return res.status(404).json(error('录音不存在', 404));
    }

    // 从 OSS 删除
    if (recording.ossKey) {
      await deleteFromOSS(recording.ossKey);
    }

    // 删除数据库记录
    await prisma.recording.delete({
      where: { id: recording.id }
    });

    res.json(success(null, '删除成功'));
  } catch (err) {
    res.status(500).json(error('删除失败', 500));
  }
});

// 获取待确认卡片列表
router.get('/pending/confirm', authenticate, tenantScope, async (req, res) => {
  try {
    const recordings = await prisma.recording.findMany({
      where: {
        tenantId: req.tenantId,
        agentId: req.user.role === 'agent' ? req.user.id : undefined,
        analysisStatus: 'completed',
        isValid: true
      },
      take: 20,
      orderBy: { analyzedAt: 'desc' },
      include: {
        customer: true,
        analysisResults: {
          where: { stage: 'stage1' },
          take: 1
        }
      }
    });

    // 过滤出需要确认的
    const pendingConfirm = recordings.filter(r =>
      r.analysisResults.length > 0 &&
      r.analysisResults[0].customerCard
    );

    res.json(success(pendingConfirm));
  } catch (err) {
    res.status(500).json(error('获取待确认列表失败', 500));
  }
});

module.exports = router;
