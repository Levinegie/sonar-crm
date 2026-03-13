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
    const pendingCards = recordings.map(r => {
      const confirmResult = r.analysisResults[0];
      const card = confirmResult?.customerCard || {};

      return {
        id: r.id,
        callTime: r.callTime,
        customerPhone: r.customerPhone,
        customerPhoneMasked: r.customerPhone ? r.customerPhone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : null,
        agentName: r.agent?.name,

        // 是否为新客户
        isNewCustomer: card.isNewCustomer !== false,
        existingCustomerId: card.existingCustomerId,

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
      };
    });

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
        area: area || customer.area,
        budget: budget || customer.budget,
        level: customerLevel || customer.level,
        nextFollowAt,
        lastCallAt: recording.callTime,
        callCount: { increment: 1 }
      };

      // 合并画像
      if (portrait) {
        updateData.portrait = {
          ...(customer.portrait || {}),
          ...portrait
        };
        // 计算画像完整度
        const filledFields = Object.values(updateData.portrait).filter(v => v && v !== '暂无').length;
        const totalFields = 12;
        updateData.portraitPct = Math.round((filledFields / totalFields) * 100);
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

      // 计算画像完整度
      const filledFields = Object.values(portraitData).filter(v => v && v !== '暂无').length;
      const totalFields = 12;
      const portraitPct = Math.round((filledFields / totalFields) * 100);

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
    res.status(500).json(error('确认失败', 500));
  }
});

// ============ 测试数据种子（临时） ============
router.post('/seed/confirm-cards', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json(error('仅管理员可用'));
  try {
    const tenantId = req.user.tenantId || 'default-tenant';
    const agentId = req.user.id;

    const mockCards = [
      {
        phone: '13800001111',
        name: '张先生',
        basicInfo: { name: '张先生', phone: '13800001111', community: '碧桂园·天玺', area: 180, houseType: '四室两厅', budget: '50-80万', decorStyle: '现代轻奢', source: '抖音广告' },
        portrait: { familyStructure: '一家四口', decisionMaker: '男主人', urgency: '3个月内装修', concerns: ['环保材料', '收纳空间', '智能家居'] },
        customerLevel: 'S',
        levelReason: '大户型180㎡+高预算50-80万+明确需求+3个月内装修，意向非常强',
        nextFollow: '明天',
        promise: '明天下午2点到店看方案',
        callSummary: '客户张先生，碧桂园天玺180㎡四室两厅，预算50-80万，想做现代轻奢风格。对环保材料和智能家居很感兴趣，约了明天下午到店看方案。'
      },
      {
        phone: '13900002222',
        name: '李女士',
        basicInfo: { name: '李女士', phone: '13900002222', community: '万科·翡翠湖', area: 120, houseType: '三室两厅', budget: '30-50万', decorStyle: '北欧简约', source: '朋友推荐' },
        portrait: { familyStructure: '新婚夫妇', decisionMaker: '女主人', urgency: '半年内', concerns: ['性价比', '环保', '设计感'] },
        customerLevel: 'A',
        levelReason: '120㎡三室+中高预算30-50万+朋友推荐+半年内装修',
        nextFollow: '后天',
        promise: null,
        callSummary: '李女士，万科翡翠湖120㎡，新婚夫妇，预算30-50万，喜欢北欧简约风。朋友推荐过来的，半年内计划装修，还在对比几家公司。'
      },
      {
        phone: '13700003333',
        name: '王总',
        basicInfo: { name: '王总', phone: '13700003333', community: '保利·天悦', area: 260, houseType: '复式', budget: '100万以上', decorStyle: '新中式', source: '老客户转介绍' },
        portrait: { familyStructure: '三代同堂', decisionMaker: '男主人', urgency: '1个月内开工', concerns: ['品质', '工期', '售后保障'] },
        customerLevel: 'S',
        levelReason: '复式260㎡+预算100万以上+老客户转介绍+1个月内开工，超高意向',
        nextFollow: '明天',
        promise: '周六上午带家人一起到店',
        callSummary: '王总，保利天悦260㎡复式，三代同堂，预算100万以上，想做新中式风格。老客户转介绍，1个月内要开工，周六带家人到店看方案。'
      },
      {
        phone: '13600004444',
        name: '赵小姐',
        basicInfo: { name: '赵小姐', phone: '13600004444', community: '融创·壹号院', area: 89, houseType: '两室一厅', budget: '15-20万', decorStyle: '日式', source: '小红书' },
        portrait: { familyStructure: '单身', decisionMaker: '本人', urgency: '不急，先了解', concerns: ['价格', '风格效果'] },
        customerLevel: 'B',
        levelReason: '89㎡两室+预算15-20万+不急装修，意向一般',
        nextFollow: '1周后',
        promise: null,
        callSummary: '赵小姐，融创壹号院89㎡两室一厅，单身，预算15-20万，喜欢日式风格。从小红书看到的，暂时不急，先了解一下。'
      },
      {
        phone: '13500005555',
        name: null,
        basicInfo: { phone: '13500005555' },
        portrait: {},
        customerLevel: '无效',
        levelReason: '电话接通后表示打错了，非目标客户',
        nextFollow: null,
        promise: null,
        callSummary: '电话接通，对方表示不需要装修服务，疑似非目标客户。'
      }
    ];

    const results = [];
    for (const card of mockCards) {
      const recording = await prisma.recording.create({
        data: {
          id: uuidv4(),
          tenantId,
          agentId,
          fileName: `test_call_${card.phone}.mp3`,
          ossUrl: `https://example.com/recordings/test_${card.phone}.mp3`,
          ossKey: `recordings/test_${card.phone}.mp3`,
          fileSize: 1024000,
          duration: 180 + Math.floor(Math.random() * 300),
          customerPhone: card.phone,
          customerName: card.name,
          isValid: true,
          analysisStatus: 'pending_confirm',
          callTime: new Date(Date.now() - Math.floor(Math.random() * 86400000)),
          analyzedAt: new Date()
        }
      });

      await prisma.analysisResult.create({
        data: {
          id: uuidv4(),
          recordingId: recording.id,
          stage: 'confirm_card',
          lineType: 'outbound',
          modelName: 'gemini-test',
          provider: 'google',
          summary: card.callSummary,
          customerCard: {
            isNewCustomer: true,
            basicInfo: card.basicInfo,
            portrait: card.portrait,
            customerLevel: card.customerLevel,
            levelReason: card.levelReason,
            nextFollow: card.nextFollow,
            promise: card.promise,
            callSummary: card.callSummary
          }
        }
      });
      results.push({ phone: card.phone, recordingId: recording.id });
    }

    res.json(success({ message: `已创建 ${results.length} 条待确认卡片`, results }));
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json(error('创建测试数据失败: ' + err.message, 500));
  }
});

module.exports = router;
