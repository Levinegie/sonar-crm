/**
 * 同步默认 AI 提示词到数据库
 * 用法：node scripts/seed-prompts.js
 * 对所有 active 租户执行 upsert，已有的也会更新。
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const {
  PROMPT_LINE_A1, PROMPT_LINE_B1,
  PROMPT_LINE_A2, PROMPT_LINE_B2,
  PROMPT_CONFIRM_CARD,
} = require('../src/config/defaultPrompts');

const prisma = new PrismaClient();

const AI_MODEL  = process.env.AI_DEFAULT_MODEL   || 'gemini-3.1-flash-lite-preview';
const AI_API_URL = process.env.AI_API_URL         || 'https://yunwu.ai';
const AI_API_KEY = process.env.AI_API_KEY         || '';
const AI_PROV   = process.env.AI_DEFAULT_PROVIDER || 'openai';

const CONFIGS = [
  { name: 'line_a1',      description: '首通电话录音转写 + 线索质量 + 客服态度评分',  systemPrompt: PROMPT_LINE_A1 },
  { name: 'line_b1',      description: '跟进电话录音转写 + 意向评分 + 跟进质量评分',  systemPrompt: PROMPT_LINE_B1 },
  { name: 'line_a2',      description: '首通电话六维销售能力诊断 + 客户档案提取',     systemPrompt: PROMPT_LINE_A2 },
  { name: 'line_b2',      description: '跟进电话深度诊断 + 意向变化 + 下一步建议',    systemPrompt: PROMPT_LINE_B2 },
  { name: 'confirm_card', description: '从通话中提取并核实客户基础信息完整度',        systemPrompt: PROMPT_CONFIRM_CARD },
];

async function main() {
  const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });
  console.log(`找到 ${tenants.length} 个活跃租户`);

  for (const tenant of tenants) {
    console.log(`\n处理租户: ${tenant.name} (${tenant.id})`);
    for (const cfg of CONFIGS) {
      await prisma.aIConfig.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: cfg.name } },
        update: {
          description:  cfg.description,
          systemPrompt: cfg.systemPrompt,
          model:        AI_MODEL,
          apiUrl:       AI_API_URL,
          apiKey:       AI_API_KEY,
        },
        create: {
          tenantId:     tenant.id,
          name:         cfg.name,
          description:  cfg.description,
          systemPrompt: cfg.systemPrompt,
          provider:     AI_PROV,
          model:        AI_MODEL,
          apiUrl:       AI_API_URL,
          apiKey:       AI_API_KEY,
          isActive:     true,
        },
      });
      console.log(`  ✓ ${cfg.name}`);
    }
  }

  console.log('\n完成！');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
