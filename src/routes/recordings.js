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

    // 从文件名解析电话号码和通话时间
    // 格式：电话号码(电话号码)_YYYYMMDDHHmmss.mp3
    const fileName = req.file.originalname;
    let parsedPhone = customerPhone || '';
    let parsedCallTime = callTime ? new Date(callTime) : new Date();

    const fileNameMatch = fileName.match(/^(\d+)\([\d]+\)_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (fileNameMatch) {
      if (!parsedPhone) parsedPhone = fileNameMatch[1];
      if (!callTime) {
        const [, , y, mo, d, h, mi, s] = fileNameMatch;
        parsedCallTime = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
      }
    }

    // 生成 OSS 路径（优先用用户绑定的 ossFolder）
    const folder = req.user.ossFolder
      ? `交换空间/${req.user.ossFolder}`
      : `recordings/${req.tenantId}`;
    const ossKey = `${folder}/${Date.now()}-${uuidv4()}.m4a`;

    // 上传到 OSS
    const ossUrl = await uploadToOSS(req.file.buffer, ossKey, req.file.mimetype);

    // 创建录音记录
    const recording = await prisma.recording.create({
      data: {
        tenantId: req.tenantId,
        fileName,
        ossUrl,
        ossKey,
        fileSize: req.file.size,
        customerPhone: parsedPhone,
        customerName,
        agentId: agentId || req.user.id,
        callTime: parsedCallTime,
        analysisStatus: 'pending'
      }
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
    // 查找状态为 pending_confirm 的录音
    const recordings = await prisma.recording.findMany({
      where: {
        tenantId: req.tenantId,
        analysisStatus: 'pending_confirm',
        isValid: true,
        // 客服只能看到自己的
        ...(req.user.role === 'agent' && { agentId: req.user.id })
      },
      orderBy: { analyzedAt: 'desc' },
      include: {
        customer: {
          select: { id: true, name: true, phone: true, community: true, level: true }
        },
        agent: { select: { id: true, name: true } },
        analysisResults: {
          where: { stage: 'confirm_card' },
          take: 1
        }
      }
    });

    // 组装返回数据
    const pendingCards = [];
    for (const r of recordings) {
      const confirmResult = r.analysisResults[0];
      const card = confirmResult?.customerCard || {};
      const isNew = card.isNewCustomer !== false;

      // 老客户：查询已有客户完整信息
      let existingCustomer = null;
      if (!isNew && r.customerPhone) {
        existingCustomer = await prisma.customer.findFirst({
          where: { tenantId: req.tenantId, phone: r.customerPhone }
        });
      }

      pendingCards.push({
        id: r.id,
        callTime: r.callTime,
        customerPhone: r.customerPhone,
        customerPhoneMasked: r.customerPhone ? r.customerPhone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : null,
        agentName: r.agent?.name,

        // 是否为新客户
        isNewCustomer: isNew,
        existingCustomerId: card.existingCustomerId,

        // 老客户已有信息
        existingCustomer: existingCustomer ? {
          name: existingCustomer.name,
          phone: existingCustomer.phone,
          community: existingCustomer.community,
          area: existingCustomer.area,
          budget: existingCustomer.budget,
          level: existingCustomer.level,
          portrait: existingCustomer.portrait || {},
          portraitPct: existingCustomer.portraitPct || 0,
          callCount: existingCustomer.callCount || 0
        } : null,

        // AI 识别的基础信息
        basicInfo: card.basicInfo || {},
        // AI 识别的画像
        portrait: card.portrait || {},
        // AI 判断的客户等级
        customerLevel: card.customerLevel || 'C',
        levelReason: card.levelReason || '',
        // 下次跟进时间
        nextFollow: card.nextFollow || '明天',
        // 承诺事项
        promise: card.promise || null,
        // 通话摘要
        callSummary: card.callSummary || '',

        // 原始分析结果 ID（用于确认时更新）
        analysisResultId: confirmResult?.id
      });
    }

    res.json(success(pendingCards));
  } catch (err) {
    console.error('Get pending confirm error:', err);
    res.status(500).json(error('获取待确认列表失败', 500));
  }
});

// 确认卡片 - 提交确认
router.post('/:id/confirm', authenticate, tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      // 基础信息
      customerName,
      customerPhone,
      community,
      area,
      budget,
      // 画像信息
      portrait,
      // 客户等级
      customerLevel,
      // 下次跟进时间
      nextFollow,
      // 承诺事项
      promise,
      // 是否标记为无效
      markInvalid
    } = req.body;

    // 获取录音记录
    const recording = await prisma.recording.findFirst({
      where: { id, tenantId: req.tenantId },
      include: {
        analysisResults: {
          where: { stage: 'confirm_card' },
          take: 1
        }
      }
    });

    if (!recording) {
      return res.status(404).json(error('录音不存在', 404));
    }

    if (recording.analysisStatus !== 'pending_confirm') {
      return res.status(400).json(error('该录音已确认或状态异常', 400));
    }

    // 如果标记为无效
    if (markInvalid || customerLevel === 'invalid') {
      // 创建或更新客户（标记为无效）
      const phone = customerPhone || recording.customerPhone;
      if (phone) {
        const existingCustomer = await prisma.customer.findFirst({
          where: { tenantId: req.tenantId, phone }
        });

        if (existingCustomer) {
          // 更新为无效状态
          await prisma.customer.update({
            where: { id: existingCustomer.id },
            data: {
              level: 'invalid',
              status: 'invalid',
              seaStatus: 'invalid',
              agentId: null  // 释放归属
            }
          });
        } else {
          // 创建无效客户
          await prisma.customer.create({
            data: {
              tenantId: req.tenantId,
              phone,
              phoneMasked: phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
              name: customerName || '无效客户',
              level: 'invalid',
              status: 'invalid',
              seaStatus: 'invalid',
              source: '录音识别'
            }
          });
        }
      }

      // 更新录音状态
      await prisma.recording.update({
        where: { id },
        data: { analysisStatus: 'confirmed_invalid' }
      });

      return res.json(success(null, '已标记为无效客户'));
    }

    // 正常确认流程
    const phone = customerPhone || recording.customerPhone;

    // 计算下次跟进时间
    let nextFollowAt = new Date();
    switch (nextFollow) {
      case '后天':
        nextFollowAt.setDate(nextFollowAt.getDate() + 2);
        break;
      case '3天后':
        nextFollowAt.setDate(nextFollowAt.getDate() + 3);
        break;
      case '1周后':
        nextFollowAt.setDate(nextFollowAt.getDate() + 7);
        break;
      default: // 明天
        nextFollowAt.setDate(nextFollowAt.getDate() + 1);
    }

    // 查找或创建客户
    let customer = await prisma.customer.findFirst({
      where: { tenantId: req.tenantId, phone }
    });

    if (customer) {
      // 更新现有客户
      const updateData = {
        name: customerName || customer.name,
        community: community || customer.community,
        area: area ? parseFloat(area) : customer.area,
        budget: budget || customer.budget,
        level: customerLevel || customer.level,
        nextFollowAt,
        lastCallAt: recording.callTime,
        callCount: (customer.callCount || 0) + 1
      };

      // 合并画像
      if (portrait) {
        updateData.portrait = {
          ...(customer.portrait || {}),
          ...portrait
        };
        // 计算画像完整度（只统计标准12字段）
        const standardKeys = ['houseType','houseUsage','houseState','familyMembers','profession','habits','awareness','position','budgetDetail','timeline','focusPoints','stylePreference'];
        const filledFields = standardKeys.filter(k => updateData.portrait[k] && updateData.portrait[k] !== '暂无').length;
        const totalFields = 12;
        updateData.portraitPct = Math.min(Math.round((filledFields / totalFields) * 100), 100);
      }

      // 如果有承诺，存入 portrait
      if (promise) {
        updateData.portrait = {
          ...(updateData.portrait || customer.portrait || {}),
          promise
        };
      }

      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: updateData
      });

    } else {
      // 创建新客户
      const portraitData = portrait || {};
      if (promise) portraitData.promise = promise;

      // 计算画像完整度（只统计标准12字段）
      const standardKeys = ['houseType','houseUsage','houseState','familyMembers','profession','habits','awareness','position','budgetDetail','timeline','focusPoints','stylePreference'];
      const filledFields = standardKeys.filter(k => portraitData[k] && portraitData[k] !== '暂无').length;
      const totalFields = 12;
      const portraitPct = Math.min(Math.round((filledFields / totalFields) * 100), 100);

      customer = await prisma.customer.create({
        data: {
          tenantId: req.tenantId,
          phone,
          phoneMasked: phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
          name: customerName || '未命名客户',
          community,
          area: area ? parseFloat(area) : null,
          budget,
          level: customerLevel || 'C',
          status: 'pending',
          agentId: recording.agentId || req.user.id,
          source: '录音识别',
          portrait: portraitData,
          portraitPct,
          nextFollowAt,
          lastCallAt: recording.callTime,
          callCount: 1,
          claimedAt: new Date()
        }
      });
    }

    // 更新录音状态
    await prisma.recording.update({
      where: { id },
      data: {
        analysisStatus: 'confirmed',
        customerId: customer.id
      }
    });

    res.json(success({
      customerId: customer.id,
      customerName: customer.name,
      customerLevel: customer.level
    }, '确认成功'));

  } catch (err) {
    console.error('Confirm card error:', err);
    res.status(500).json(error('确认失败: ' + err.message, 500));
  }
});


module.exports = router;
