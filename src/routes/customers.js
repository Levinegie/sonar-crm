/**
 * 客户管理路由
 * 包含：客户列表、公海、抢单、转移
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const XLSX = require('xlsx');
const { success, error, paginate, maskPhone } = require('../utils/helpers');
const { authenticate, authorize, tenantScope } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = express.Router();
const prisma = new PrismaClient();

// 获取客户列表
router.get('/', authenticate, tenantScope, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, status, level, agentId, keyword, seaStatus, channel, sort = 'createdAt', order = 'desc' } = req.query;

    // 客服只能看自己的客户，老板/管理员看全部
    const isAgent = req.user.role === 'agent';

    const where = {
      tenantId: req.tenantId,
      ...(isAgent && { agentId: req.user.id }),
      ...(status && { status }),
      ...(level && { level }),
      ...(channel && { source: channel }),
      ...(seaStatus && { seaStatus }),
      ...(agentId && { agentId }),
      ...(keyword && {
        OR: [
          { name: { contains: keyword } },
          { community: { contains: keyword } },
          { phone: { contains: keyword.replace(/\*/g, '') } }
        ]
      })
    };

    // 公海特殊处理
    if (seaStatus === 'in_sea') {
      delete where.agentId;
      where.seaStatus = 'in_sea';
    }

    const [list, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { [sort]: order },
        include: {
          agent: { select: { id: true, name: true } },
          _count: { select: { recordings: true } }
        }
      }),
      prisma.customer.count({ where })
    ]);

    // 脱敏处理
    const sanitizedList = list.map(c => ({
      ...c,
      phone: c.phone ? maskPhone(c.phone) : null,
      // 字段映射： 补充
      agentName: c.agent?.name || null,
      callCount: c._count?.recordings || 0,
      portraitPct: c.portraitPct || 0,
      portrait: c.portrait || {},
      nextFollowAt: c.nextFollowAt,
      seaReason: c.seaReason,
      seaAt: c.seaAt
    }));

    res.json(success(paginate(sanitizedList, total, page, pageSize)));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('获取客户列表失败', 500));
  }
});

// 获取公海客户列表
router.get('/sea', authenticate, tenantScope, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query;

    const where = {
      tenantId: req.tenantId,
      seaStatus: 'in_sea',
      ...(keyword && {
        OR: [
          { name: { contains: keyword } },
          { community: { contains: keyword } }
        ]
      })
    };

    const [list, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { seaAt: 'desc' }
      }),
      prisma.customer.count({ where })
    ]);

    const sanitizedList = list.map(c => ({
      ...c,
      phone: c.phone ? maskPhone(c.phone) : null,
      // 字段映射
      daysAgo: c.seaAt ? Math.floor((Date.now() - new Date(c.seaAt)) / 86400000) : 0,
      reason: c.seaReason || '转入公海'
    }));

    res.json(success(paginate(sanitizedList, total, page, pageSize)));
  } catch (err) {
    res.status(500).json(error('获取公海客户失败', 500));
  }
});

// 获取无效公海客户列表
router.get('/invalid-sea', authenticate, tenantScope, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query;

    const where = {
      tenantId: req.tenantId,
      seaStatus: 'invalid',
      ...(keyword && {
        OR: [
          { name: { contains: keyword } },
          { community: { contains: keyword } }
        ]
      })
    };

    const [list, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: parseInt(pageSize),
        orderBy: { seaAt: 'desc' }
      }),
      prisma.customer.count({ where })
    ]);

    const sanitizedList = list.map(c => ({
      ...c,
      phone: c.phone ? maskPhone(c.phone) : null,
      daysAgo: c.seaAt ? Math.floor((Date.now() - new Date(c.seaAt)) / 86400000) : 0,
      reason: c.seaReason || '标记无效'
    }));

    res.json(success(paginate(sanitizedList, total, page, pageSize)));
  } catch (err) {
    res.status(500).json(error('获取无效公海客户失败', 500));
  }
});

// 抢单
router.post('/:id/claim', authenticate, tenantScope, async (req, res) => {
  try {
    const { id } = req.params;

    // 检查客户是否在公海（含死单公海）
    const customer = await prisma.customer.findFirst({
      where: { id, tenantId: req.tenantId, seaStatus: { in: ['in_sea', 'invalid'] } }
    });

    if (!customer) {
      return res.status(400).json(error('该客户不在公海或已被领取', 400));
    }

    // 检查客服客户数量上限
    const agentCount = await prisma.customer.count({
      where: { agentId: req.user.id, seaStatus: null }
    });

    const agent = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (agentCount >= agent.maxCustomers) {
      return res.status(400).json(error(`已达到客户数量上限（${agent.maxCustomers}个）`, 400));
    }

    // 抢单
    const updated = await prisma.customer.update({
      where: { id },
      data: {
        agentId: req.user.id,
        seaStatus: 'claimed',
        claimedAt: new Date(),
        claimedById: req.user.id
      }
    });

    res.json(success(updated, '抢单成功'));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('抢单失败', 500));
  }
});

// 转移到公海
router.post('/:id/to-sea', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const customer = await prisma.customer.update({
      where: { id, tenantId: req.tenantId },
      data: {
        agentId: null,
        seaStatus: 'in_sea',
        seaReason: reason,
        seaAt: new Date()
      }
    });

    res.json(success(customer, '已转移到公海'));
  } catch (err) {
    res.status(500).json(error('转移失败', 500));
  }
});

// 分配给客服
router.post('/:id/assign', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { agentId } = req.body;

    const customer = await prisma.customer.update({
      where: { id, tenantId: req.tenantId },
      data: {
        agentId,
        seaStatus: null,
        seaReason: null,
        seaAt: null,
        claimedAt: null,
        claimedById: null
      }
    });

    res.json(success(customer, '分配成功'));
  } catch (err) {
    res.status(500).json(error('分配失败', 500));
  }
});

// 创建客户
router.post('/', authenticate, tenantScope, async (req, res) => {
  try {
    const { name, phone, community, area, houseType, budget, channel, level = 'C', portrait, portraitPct, nextFollowAt } = req.body;

    // 检查是否已存在
    const exists = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId: req.tenantId, phone } }
    });

    if (exists) {
      return res.status(400).json(error('该客户已存在', 400));
    }

    const customer = await prisma.customer.create({
      data: {
        tenantId: req.tenantId,
        name,
        phone, // 应该加密存储
        phoneMasked: maskPhone(phone),
        community,
        area: area ? (typeof area === 'number' ? area : parseFloat(area) || null) : null,
        houseType,
        budget,
        source: channel || '手动新建',
        level,
        portrait: portrait || undefined,
        portraitPct: portraitPct || 0,
        nextFollowAt: nextFollowAt ? new Date(nextFollowAt) : null,
        agentId: req.user.role === 'agent' ? req.user.id : null
      }
    });

    res.json(success(customer, '创建成功'));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('创建客户失败', 500));
  }
});

// 批量导入客户
const portraitKeys = ['houseType','houseUsage','houseState','familyMembers','profession','habits','awareness','position','budgetDetail','timeline','focusPoints','stylePreference'];
const colMap = {
  '姓名':'name','电话':'phone','小区':'community','面积':'area','预算':'budget','客户等级':'level',
  '房屋类型':'houseType','房屋用途':'houseUsage','房屋现状':'houseState','家庭成员':'familyMembers',
  '职业':'profession','生活习惯':'habits','了解程度':'awareness','装修定位':'position',
  '装修预算':'budgetDetail','装修时间':'timeline','关注点':'focusPoints','风格偏好':'stylePreference'
};

router.post('/import', authenticate, tenantScope, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json(error('请上传文件', 400));

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json(error('文件为空', 400));

    // 获取已有电话号码用于去重
    const existingPhones = new Set(
      (await prisma.customer.findMany({
        where: { tenantId: req.tenantId },
        select: { phone: true }
      })).map(c => c.phone)
    );

    let successCount = 0;
    const failures = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // 映射列名
      const mapped = {};
      for (const [cn, val] of Object.entries(row)) {
        const key = colMap[cn.trim()];
        if (key) mapped[key] = String(val).trim();
      }

      const name = mapped.name;
      const phone = mapped.phone;

      if (!name || !phone) {
        failures.push({ row: i + 2, reason: '姓名或电话为空' });
        continue;
      }

      if (existingPhones.has(phone)) {
        failures.push({ row: i + 2, reason: `电话 ${phone} 已存在，跳过` });
        continue;
      }

      // 构建画像
      const portrait = {};
      portraitKeys.forEach(k => { if (mapped[k]) portrait[k] = mapped[k]; });
      const filledCount = portraitKeys.filter(k => portrait[k]).length;
      const portraitPct = Math.round((filledCount / portraitKeys.length) * 100);

      const validLevels = ['S', 'A', 'B', 'C'];
      const level = validLevels.includes(mapped.level) ? mapped.level : 'C';

      try {
        await prisma.customer.create({
          data: {
            tenantId: req.tenantId,
            name,
            phone,
            phoneMasked: maskPhone(phone),
            community: mapped.community || null,
            area: mapped.area ? parseFloat(mapped.area) || null : null,
            budget: mapped.budget || null,
            level,
            portrait,
            portraitPct,
            agentId: req.user.role === 'agent' ? req.user.id : null,
            source: '导入'
          }
        });
        existingPhones.add(phone);
        successCount++;
      } catch (e) {
        failures.push({ row: i + 2, reason: e.message.slice(0, 80) });
      }
    }

    res.json(success({ successCount, failCount: failures.length, failures: failures.slice(0, 20) },
      `导入完成：成功 ${successCount} 条，失败 ${failures.length} 条`));
  } catch (err) {
    console.error(err);
    res.status(500).json(error('导入失败：' + err.message, 500));
  }
});

// 更新客户
router.put('/:id', authenticate, tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, community, area, houseType, budget, level, status, portrait, portraitPct, tags, nextFollowAt, pinned } = req.body;

    const customer = await prisma.customer.update({
      where: { id, tenantId: req.tenantId },
      data: {
        ...(name && { name }),
        ...(community && { community }),
        ...(area !== undefined && { area: typeof area === 'number' ? area : parseFloat(area) || null }),
        ...(houseType && { houseType }),
        ...(budget && { budget }),
        ...(level && { level }),
        ...(status && { status }),
        ...(portrait && { portrait }),
        ...(portraitPct !== undefined && { portraitPct: parseInt(portraitPct) || 0 }),
        ...(tags && { tags }),
        ...(nextFollowAt !== undefined && { nextFollowAt: nextFollowAt ? new Date(nextFollowAt) : null }),
        ...(pinned !== undefined && { pinned })
      }
    });

    res.json(success(customer, '更新成功'));
  } catch (err) {
    res.status(500).json(error('更新客户失败', 500));
  }
});

// 删除客户
router.delete('/:id', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    await prisma.customer.delete({
      where: { id: req.params.id, tenantId: req.tenantId }
    });

    res.json(success(null, '删除成功'));
  } catch (err) {
    res.status(500).json(error('删除客户失败', 500));
  }
});

// 获取客户详情
router.get('/:id', authenticate, tenantScope, async (req, res) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        agent: { select: { id: true, name: true } },
        recordings: {
          take: 20,
          orderBy: { callTime: 'desc' },
          include: {
            analysisResults: { orderBy: { createdAt: 'asc' } }
          }
        },
        followUps: {
          take: 10,
          orderBy: { createdAt: 'desc' }
        },
        _count: { select: { recordings: true, followUps: true } }
      }
    });

    if (!customer) {
      return res.status(404).json(error('客户不存在', 404));
    }

    res.json(success({
      ...customer,
      phone: maskPhone(customer.phone)
    }));
  } catch (err) {
    res.status(500).json(error('获取客户详情失败', 500));
  }
});

module.exports = router;
