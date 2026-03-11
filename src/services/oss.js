/**
 * 阿里云 OSS 服务
 */

const OSS = require('ali-oss');

let ossClient = null;

/**
 * 初始化 OSS 客户端
 */
function initOSS() {
  if (ossClient) return ossClient;

  ossClient = new OSS({
    region: process.env.OSS_REGION || 'oss-cn-hangzhou',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || 'rec-upload-hz'
  });

  return ossClient;
}

/**
 * 上传文件到 OSS
 */
async function uploadToOSS(buffer, key, contentType) {
  const client = initOSS();

  const result = await client.put(key, buffer, {
    mime: contentType
  });

  return result.url;
}

/**
 * 从 OSS 删除文件
 */
async function deleteFromOSS(key) {
  try {
    const client = initOSS();
    await client.delete(key);
    return true;
  } catch (err) {
    console.error('Delete from OSS failed:', err);
    return false;
  }
}

/**
 * 获取 OSS 文件签名 URL
 */
async function getSignedUrl(key, expires = 3600) {
  const client = initOSS();
  const url = client.signatureUrl(key, { expires });
  return url;
}

/**
 * 列出 OSS 文件
 */
async function listFiles(prefix) {
  const client = initOSS();
  const result = await client.list({
    prefix,
    'max-keys': 1000
  });
  return result.objects || [];
}

module.exports = {
  initOSS,
  uploadToOSS,
  deleteFromOSS,
  getSignedUrl,
  listFiles
};
