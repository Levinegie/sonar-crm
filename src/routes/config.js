/**
 * 配置管理路由
 * AI 模型配置、提示词管理、系统配置
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, authorize, tenantScope, success, error } = require('../utils/helpers');

const router = express.Router();
const prisma = new PrismaClient();

// 获取 AI 配置列表
router.get('/ai', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const configs = await prisma.aIConfig.findMany({
      where: { tenantId: req.tenantId },
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

// 更新 AI 配置
router.put('/ai/:id', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const { id } = req.params;
    const { model, apiUrl, apiKey, systemPrompt, isActive, priority } = req.body;

    const updateData = {};
    if (model) updateData.model = model;
    if (apiUrl) updateData.apiUrl = apiUrl;
    if (systemPrompt) updateData.systemPrompt = systemPrompt;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (priority) updateData.priority = priority;

    // 如果提供了新 API Key，则更新
    if (apiKey && apiKey !== '***') {
      updateData.apiKey = apiKey;
    }

    const config = await prisma.aIConfig.update({
      where: { id, tenantId: req.tenantId },
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
      result[c.key] = c.type === 'json' ? JSON.parse(c.value || '{}') : c.value;
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
      const type = typeof value === 'object' ? 'json' : 'string';

      await prisma.tenantConfig.upsert({
        where: { tenantId_key: { tenantId: req.tenantId, key } },
        update: { value: stringValue, type },
        create: { tenantId: req.tenantId, key, value: stringValue, type }
      });
    }

    res.json(success(null, '配置已保存'));
  } catch (err) {
    res.status(500).json(error('保存配置失败', 500));
  }
});

// 获取违禁词列表
router.get('/forbidden-words', authenticate, authorize('admin', 'boss'), tenantScope, async (req, res) => {
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
router.post('/forbidden-words', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    const { word, severity = 'medium', description } = req.body;

    // 检查是否存在
    const exists = await prisma.forbiddenWord.findUnique({
      where: { tenantId_word: { tenantId: req.tenantId, word } }
    });

    if (exists) {
      return res.status(400).json(error('该违禁词已存在', 400));
    }

    const result = await prisma.forbiddenWord.create({
      data: { tenantId: req.tenantId, word, severity, description }
    });

    res.json(success(result, '添加成功'));
  } catch (err) {
    res.status(500).json(error('添加违禁词失败', 500));
  }
});

// 删除违禁词
router.delete('/forbidden-words/:id', authenticate, authorize('admin'), tenantScope, async (req, res) => {
  try {
    await prisma.forbiddenWord.delete({
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
router.post('/channels', authenticate, authorize('admin'), tenantScope, async (req, res) => {
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

module.exports = router;
