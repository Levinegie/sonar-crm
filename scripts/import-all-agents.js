/**
 * 批量导入所有客服的最新录音（每人最多 10 条）
 */
require('dotenv').config();
const OSS = require('ali-oss');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const oss = new OSS({
  region: process.env.OSS_REGION,
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
});

const TENANT_NAME = '交换空间';
const PER_AGENT = 10;

function parsePhoneFromFilename(filename) {
  // 格式1: 18537679772(18537679772)_20260315.mp3
  const m1 = filename.match(/^(\d{7,15})\(/);
  if (m1) return m1[1];
  // 格式2: 花之馨(15333970103)_20260314.mp3 or _13507609995_
  const m2 = filename.match(/[_(](\d{11})[)_]/);
  if (m2) return m2[1];
  // 格式3: 18537679772_20260315.mp3
  const m3 = filename.match(/^(\d{7,15})_/);
  if (m3) return m3[1];
  // 格式4: 192 1397 3948_20260315.m4a (spaces in number)
  const stripped = filename.replace(/\s/g, '');
  const m4 = stripped.match(/^(\d{11})[_\s]/);
  if (m4) return m4[1];
  // 格式5: 18238263666-2603032034.mp3
  const m5 = filename.match(/^(\d{11})-/);
  if (m5) return m5[1];
  return '';
}

async function listRecentFiles(prefix, max) {
  const files = [];
  let marker = null;
  do {
    const result = await oss.list({ prefix, 'max-keys': 1000, marker });
    if (result.objects) {
      for (const obj of result.objects) {
        if (obj.name.match(/\.(mp3|wav|m4a|ogg|flac)$/i)) {
          files.push(obj);
        }
      }
    }
    marker = result.nextMarker;
  } while (marker);

  // Sort by lastModified desc, take most recent
  files.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  return files.slice(0, max);
}

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { name: TENANT_NAME } });
  if (!tenant) { console.error('Tenant not found:', TENANT_NAME); process.exit(1); }

  const agents = await prisma.user.findMany({
    where: { role: 'agent', tenantId: tenant.id, ossFolder: { not: null } },
    select: { id: true, name: true, ossFolder: true }
  });

  console.log(`Found ${agents.length} agents in ${TENANT_NAME}`);

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const agent of agents) {
    const prefix = `${TENANT_NAME}/${agent.ossFolder}/`;
    console.log(`\n[${agent.name}] Listing OSS: ${prefix}`);

    let files;
    try {
      files = await listRecentFiles(prefix, PER_AGENT);
    } catch (e) {
      console.error(`  OSS list failed:`, e.message);
      continue;
    }

    console.log(`  Found ${files.length} recent files`);
    let created = 0;

    for (const file of files) {
      const fileName = file.name.split('/').pop();
      const ossKey = file.name;
      const phone = parsePhoneFromFilename(fileName);

      // Skip if already imported
      const exists = await prisma.recording.findFirst({ where: { ossKey } });
      if (exists) { totalSkipped++; continue; }

      await prisma.recording.create({
        data: {
          tenantId: tenant.id,
          agentId: agent.id,
          fileName,
          ossKey,
          ossUrl: `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossKey}`,
          customerPhone: phone,
          analysisStatus: 'pending',
          duration: 0,
          fileSize: file.size || 0,
        }
      });
      created++;
      totalCreated++;
      console.log(`  + ${fileName} (phone: ${phone || 'unknown'})`);
    }

    console.log(`  Created: ${created}`);
  }

  console.log(`\nDone. Total created: ${totalCreated}, skipped (already exists): ${totalSkipped}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
