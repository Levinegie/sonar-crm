/**
 * 配置管理路由
 * AI 模型配置、提示词管理、系统配置
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const { success, error } = require('../utils/helpers');
const { authenticate, authorize, tenantScope, platformOnly } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// 获取 AI 配置列表（平台管理员可通过 ?tenantId= 查看其他租户）
router.get('/ai', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    let targetTenantId = req.tenantId;

    // 平台管理员可查看指定租户的配置
    if (req.query.tenantId) {
      const userTenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
      if (userTenant?.slug === 'default') {
        targetTenantId = req.query.tenantId;
      }
    }

    const configs = await prisma.aIConfig.findMany({
      where: { tenantId: targetTenantId },
      orderBy: { name: 'asc' }
    });

    // 脱敏处理
    const sanitized = configs.map(c => ({
      ...c,
      apiKey: c.apiKey ? '***' + c.apiKey.slice(-4) : null
    }));

    res.json(success(sanitized));
  } catch (err) {
    res.status(500).json(error('获取配置失败', 500));
  }
});

// 更新 AI 配置（平台管理员可更新任意租户的配置）
router.put('/ai/:id', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { model, apiUrl, apiKey, systemPrompt, isActive, priority } = req.body;

    // 验证配置归属：平台管理员可编辑任意配置，普通管理员只能编辑自己租户的
    const existing = await prisma.aIConfig.findUnique({ where: { id } });
    if (!existing) return res.status(404).json(error('配置不存在', 404));

    const userTenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
    if (userTenant?.slug !== 'default' && existing.tenantId !== req.tenantId) {
      return res.status(403).json(error('无权修改此配置', 403));
    }

    const updateData = {};
    if (model) updateData.model = model;
    if (apiUrl) updateData.apiUrl = apiUrl;
    if (systemPrompt !== undefined) updateData.systemPrompt = systemPrompt;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (priority) updateData.priority = priority;

    // 如果提供了新 API Key，则更新
    if (apiKey && apiKey !== '***') {
      updateData.apiKey = apiKey;
    }

    const config = await prisma.aIConfig.update({
      where: { id },
      data: updateData
    });

    res.json(success({ ...config, apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : null }, '更新成功'));
  } catch (err) {
    res.status(500).json(error('更新配置失败', 500));
  }
});

// 获取系统配置
router.get('/system', authenticate, tenantScope, async (req, res) => {
  try {
    const configs = await prisma.tenantConfig.findMany({
      where: { tenantId: req.tenantId }
    });

    const result = {};
    configs.forEach(c => {
      result[c.key] = c.value;
    });

    res.json(success(result));
  } catch (err) {
    res.status(500).json(error('获取配置失败', 500));
  }
});

// 更新系统配置
router.put('/system', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const configs = req.body;

    for (const [key, value] of Object.entries(configs)) {
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

      await prisma.tenantConfig.upsert({
        where: { tenantId_key: { tenantId: req.tenantId, key } },
        update: { value: stringValue },
        create: { tenantId: req.tenantId, key, value: stringValue }
      });
    }

    res.json(success(null, '配置已保存'));
  } catch (err) {
    res.status(500).json(error('保存配置失败', 500));
  }
});

// 获取违禁词列表
router.get('/forbidden-words', authenticate, authorize('admin', 'boss', 'agent'), tenantScope, async (req, res) => {
  try {
    const words = await prisma.forbiddenWord.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' }
    });

    res.json(success(words));
  } catch (err) {
    res.status(500).json(error('获取违禁词失败', 500));
  }
});

// 添加违禁词
router.post('/forbidden-words', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    const { word, category = 'general', description } = req.body;

    // 检查是否存在
    const exists = await prisma.forbiddenWord.findFirst({
      where: { tenantId: req.tenantId, word }
    });

    if (exists) {
      return res.status(400).json(error('该违禁词已存在', 400));
    }

    const result = await prisma.forbiddenWord.create({
      data: { tenantId: req.tenantId, word, category, description }
    });

    res.json(success(result, '添加成功'));
  } catch (err) {
    res.status(500).json(error('添加违禁词失败', 500));
  }
});

// 删除违禁词
router.delete('/forbidden-words/:id', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    await prisma.forbiddenWord.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId }
    });

    res.json(success(null, '删除成功'));
  } catch (err) {
    res.status(500).json(error('删除失败', 500));
  }
});

// 获取渠道列表
router.get('/channels', authenticate, tenantScope, async (req, res) => {
  try {
    const channels = await prisma.channel.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' }
    });

    res.json(success(channels));
  } catch (err) {
    res.status(500).json(error('获取渠道失败', 500));
  }
});

// 添加渠道
router.post('/channels', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    const { name, code, type } = req.body;

    const channel = await prisma.channel.create({
      data: { tenantId: req.tenantId, name, code, type }
    });

    res.json(success(channel, '添加成功'));
  } catch (err) {
    res.status(500).json(error('添加渠道失败', 500));
  }
});

// 删除渠道
router.delete('/channels/:id', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;

    // 确保只能删除自己租户的渠道
    const channel = await prisma.channel.findFirst({
      where: { id, tenantId: req.tenantId }
    });

    if (!channel) {
      return res.status(404).json(error('渠道不存在', 404));
    }

    await prisma.channel.delete({ where: { id } });
    res.json(success(null, '删除成功'));
  } catch (err) {
    res.status(500).json(error('删除渠道失败', 500));
  }
});

// =====================================================
// AI 模型测试端点
// =====================================================
router.post('/ai/test', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { message, configId } = req.body;

    if (!message || !configId) {
      return res.status(400).json(error('请提供测试消息和配置 ID', 400));
    }

    const config = await prisma.aIConfig.findUnique({ where: { id: configId } });
    if (!config) {
      return res.status(404).json(error('配置不存在', 404));
    }

    if (!config.apiKey || !config.apiUrl) {
      return res.status(400).json(error('该配置缺少 API Key 或 API URL', 400));
    }

    const messages = [
      ...(config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }] : []),
      { role: 'user', content: message }
    ];

    const response = await axios.post(
      `${config.apiUrl}/v1/chat/completions`,
      {
        model: config.model,
        messages,
        temperature: 0.7,
        max_tokens: 2048
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        timeout: 30000
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content || '无响应';
    res.json(success({ reply, model: config.model, provider: config.provider }));
  } catch (err) {
    console.error('AI test error:', err.response?.data || err.message);
    res.status(500).json(error('测试失败: ' + (err.response?.data?.error?.message || err.message), 500));
  }
});

module.exports = router;
