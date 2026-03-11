/**
 * OSS 相关路由
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { success, error } = require('../utils/helpers');
const { authenticate, tenantScope } = require('../middleware/auth');
const { getSignedUrl, listFiles } = require('../services/oss');

const router = express.Router();
const prisma = new PrismaClient();

// 获取 OSS 上传签名
router.post('/upload-sign', authenticate, tenantScope, async (req, res) => {
  try {
    const { fileName, fileType } = req.body;

    // 生成 OSS 路径
    const key = `recordings/${req.tenantId}/${Date.now()}-${fileName}`;

    // 这里返回可以直接上传的 URL（需要后端支持签名上传）
    // 简化处理，直接返回路径

    res.json(success({
      key,
      uploadUrl: `/api/recordings/upload`
    }));
  } catch (err) {
    res.status(500).json(error('获取上传签名失败', 500));
  }
});

module.exports = router;
