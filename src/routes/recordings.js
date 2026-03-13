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
    res.status(500).json(error('确认失败: ' + err.message, 500));
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
        phone: '15800001111',
        name: '陈先生',
        basicInfo: { name: '陈先生', phone: '15800001111', community: '龙湖·春江天玺', area: 145, houseType: '三室两厅', budget: '35-45万', decorStyle: '现代简约', source: '抖音广告' },
        portrait: { houseType: '商品房', houseUsage: '自住', houseState: '毛坯', familyMembers: '夫妻+1孩', profession: '工程师', habits: '喜欢智能家居', awareness: '对比多家', position: '一线品牌', budgetDetail: '35-45万全包', timeline: '2个月后交房', focusPoints: '工程质量、工期、环保材料', stylePreference: '现代简约' },
        customerLevel: 'A',
        levelReason: '145㎡三室+预算35-45万+2个月后交房+对比多家，意向较强',
        nextFollow: '后天',
        promise: '发同小区案例给客户参考',
        callSummary: '陈先生，龙湖春江天玺145㎡三室两厅，夫妻带一个孩子，预算35-45万全包，喜欢现代简约风格。做IT的，对智能家居很感兴趣，2个月后交房，正在对比3家公司。承诺发同小区案例给他参考。',
        transcript: '客服：您好，这里是声纳装饰，请问您是陈先生吗？\n客户：对，我是。\n客服：陈先生您好，我是小严，之前您在抖音上留了信息想了解装修是吧？\n客户：对对对，我们龙湖春江天玺的房子，145平，三室两厅。\n客服：好的，请问您房子现在是什么状态呢？\n客户：毛坯，大概2个月后交房。\n客服：明白了。您对装修风格有什么想法吗？\n客户：我和我老婆都比较喜欢现代简约的，不要太复杂。我是做IT的，希望能做一些智能家居的东西。\n客服：好的，智能家居我们有专门的合作方案。预算方面您大概考虑多少？\n客户：35到45万吧，全包的话。\n客服：这个预算145平做现代简约完全没问题。我们小区有好几个业主都是我们做的，我回头发一些案例给您看看。\n客户：好的，那你发给我看看。我现在也在对比其他两家公司。\n客服：没问题，我今天就整理好发给您。',
        stage1Scores: {
          is_valid: true,
          lead_quality: { score: 7.5, grade: 'B' },
          agent_attitude: { score: 8.0, grade: 'A' }
        },
        stage2: {
          summary: '本通电话客服表现稳健，开场自然，需求挖掘较充分，成功获取了客户的户型、预算、风格偏好和时间节点。但在价值塑造上略显不足，当客户提到在对比其他公司时，未能主动强调差异化优势。承诺发案例是好的跟进动作。',
          scores: {
            overall: 7.8,
            scene: '首通·需求了解·竞品对比',
            opening: { score: 8.0, comment: '开场自然，快速切入主题' },
            needs_discovery: { score: 8.5, comment: '挖掘了户型、预算、风格、时间节点，信息获取全面' },
            value_building: { score: 6.5, comment: '提到同小区案例但未展开，竞品对比时未强调差异化' },
            objection_handling: { score: 7.0, comment: '客户提到对比其他公司时未做深入应对' },
            invitation: { score: 7.5, comment: '未明确邀约到店，仅承诺发案例' },
            retention: { score: 8.0, comment: '承诺发案例保持联系，有后续跟进点' },
            lead_quality: { score: 7.5 },
            gold_quote: '「智能家居我们有专门的合作方案」——快速回应客户兴趣点，但可以展开说明具体方案内容',
            suggest: '下次跟进建议：1. 发送同小区3-5个案例（重点标注智能家居部分）2. 准备一份智能家居方案清单 3. 主动对比竞品优势，强调工程质量和售后保障 4. 争取约到店看材料展厅'
          },
          redFlag: false
        }
      },
      {
        phone: '15900002222',
        name: '周女士',
        basicInfo: { name: '周女士', phone: '15900002222', community: '绿城·桂花园', area: 200, houseType: '四室两厅', budget: '60-80万', decorStyle: '法式轻奢', source: '老客户转介绍' },
        portrait: { houseType: '商品房', houseUsage: '自住', houseState: '毛坯', familyMembers: '夫妻+2孩', profession: '医生', habits: '注重健康环保', awareness: '有装修经验', position: '一线品牌', budgetDetail: '60-80万含软装', timeline: '已交房，尽快开工', focusPoints: '环保材料、设计感、收纳', stylePreference: '法式轻奢' },
        customerLevel: 'S',
        levelReason: '200㎡大户型+高预算60-80万+已交房急开工+老客户转介绍，超高意向',
        nextFollow: '明天',
        promise: '明天上午10点到店看方案，带户型图',
        callSummary: '周女士，绿城桂花园200㎡四室两厅，医生，夫妻带两个孩子。预算60-80万含软装，法式轻奢风格。房子已交房想尽快开工，是老客户张总介绍的。约了明天上午10点到店，会带户型图过来。',
        transcript: '客服：您好周女士，我是声纳装饰的小严，张总介绍您过来的是吧？\n周女士：对，张总家就是你们装的，我看了效果很好。\n客服：谢谢张总的推荐！请问您的房子是在哪个小区呢？\n周女士：绿城桂花园，200平，四室两厅。\n客服：好大的房子！请问现在是什么状态？\n周女士：已经交房了，想尽快开工。我和我老公都是医生，平时比较忙，所以希望找一家靠谱的一次性搞定。\n客服：完全理解。您对风格有什么偏好吗？\n周女士：我喜欢法式轻奢的感觉，要有设计感但不要太浮夸。家里两个孩子，收纳一定要做好。还有材料一定要环保，这个我很在意。\n客服：明白了，环保材料是我们的强项，我们用的都是E0级以上的板材。预算方面您大概考虑多少？\n周女士：60到80万吧，含软装。\n客服：这个预算200平做法式轻奢完全可以做得很精致。要不您明天方便的话来店里看看？我让设计师提前准备一些法式风格的案例。\n周女士：好，明天上午10点可以吗？我把户型图带过来。\n客服：太好了，我们明天见！',
        stage1Scores: {
          is_valid: true,
          lead_quality: { score: 9.0, grade: 'S' },
          agent_attitude: { score: 8.5, grade: 'A' }
        },
        stage2: {
          summary: '优秀的首通电话！客服充分利用了老客户转介绍的信任基础，快速建立关系。需求挖掘全面，成功获取了所有关键信息。价值塑造到位，在客户提到环保时精准回应。最关键的是成功邀约到店，并让客户主动带户型图，说明客户意向极高。唯一可改进的是可以多问一些软装偏好的细节。',
          scores: {
            overall: 8.8,
            scene: '首通·老客户转介绍·高意向邀约',
            opening: { score: 9.0, comment: '利用转介绍关系开场，信任感强' },
            needs_discovery: { score: 9.0, comment: '户型、预算、风格、时间、家庭情况全部获取' },
            value_building: { score: 8.5, comment: '环保材料精准回应，但可以多展开差异化优势' },
            objection_handling: { score: 8.0, comment: '客户无明显异议，处理得当' },
            invitation: { score: 9.5, comment: '成功邀约到店，客户主动带户型图，极高意向' },
            retention: { score: 8.5, comment: '约定明确时间，有设计师准备案例的承诺' },
            lead_quality: { score: 9.0 },
            gold_quote: '「环保材料是我们的强项，我们用的都是E0级以上的板材」——精准回应客户核心关注点，建立专业信任',
            suggest: '明天到店准备：1. 3-5个法式轻奢案例（200㎡左右）2. E0级环保材料样板 3. 收纳方案参考 4. 张总家的实景照片（增强信任）5. 提前和设计师沟通客户需求'
          },
          redFlag: false
        }
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

      // Stage 1: 转写 + 基础评分
      await prisma.analysisResult.create({
        data: {
          id: uuidv4(),
          recordingId: recording.id,
          stage: 'stage1',
          lineType: 'outbound',
          modelName: 'gemini-test',
          provider: 'google',
          transcript: card.transcript || card.callSummary,
          summary: card.callSummary,
          scores: card.stage1Scores || {
            is_valid: true,
            lead_quality: { score: 7, grade: 'B' },
            agent_attitude: { score: 7.5, grade: 'B' }
          },
          metadata: { callStage: 'cold_call' }
        }
      });

      // Confirm Card: 待确认卡片
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

      // Stage 2: 深度报告（金牌教练）
      if (card.stage2) {
        await prisma.analysisResult.create({
          data: {
            id: uuidv4(),
            recordingId: recording.id,
            stage: 'stage2',
            lineType: 'outbound',
            modelName: 'gemini-test',
            provider: 'google',
            summary: card.stage2.summary,
            scores: card.stage2.scores,
            redFlag: card.stage2.redFlag || false,
            redFlagDetail: card.stage2.redFlagDetail || null
          }
        });
      }

      results.push({ phone: card.phone, recordingId: recording.id });
    }

    res.json(success({ message: `已创建 ${results.length} 条待确认卡片`, results }));
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json(error('创建测试数据失败: ' + err.message, 500));
  }
});

module.exports = router;
