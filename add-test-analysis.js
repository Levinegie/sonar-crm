const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function addAnalysisResults() {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { slug: 'default' } });

    // 取本月所有有效录音（每个客服前30条）
    const recordings = await prisma.recording.findMany({
      where: {
        tenantId: tenant.id,
        isValid: true,
        analysisStatus: 'completed'
      },
      select: { id: true, agentId: true, customerId: true },
      take: 150
    });

    if (recordings.length === 0) {
      console.log('❌ 没有已完成的有效录音，请先运行 add-test-recordings.js');
      return;
    }

    // 每个录音生成一条分析结果（含6维评分）
    const agentScoreBase = {};
    let created = 0;

    for (const rec of recordings) {
      // 已有分析结果则跳过
      const exists = await prisma.analysisResult.findFirst({ where: { recordingId: rec.id } });
      if (exists) continue;

      // 为每个客服生成略有差异的基准分
      if (!agentScoreBase[rec.agentId]) {
        agentScoreBase[rec.agentId] = {
          opening:    6.5 + Math.random() * 2.5,
          needs:      6.0 + Math.random() * 3.0,
          value:      6.5 + Math.random() * 2.5,
          objection:  5.5 + Math.random() * 3.5,
          invitation: 6.0 + Math.random() * 3.0,
          retention:  6.0 + Math.random() * 2.5,
        };
      }
      const base = agentScoreBase[rec.agentId];

      // 每条录音在基准分上波动 ±0.8
      const jitter = () => (Math.random() - 0.5) * 1.6;
      const clamp = (v) => Math.round(Math.min(10, Math.max(1, v + jitter())) * 10) / 10;

      const scores = {
        opening:    clamp(base.opening),
        needs:      clamp(base.needs),
        value:      clamp(base.value),
        objection:  clamp(base.objection),
        invitation: clamp(base.invitation),
        retention:  clamp(base.retention),
      };

      await prisma.analysisResult.create({
        data: {
          recordingId: rec.id,
          customerId: rec.customerId,
          stage: 'scoring',
          lineType: 'line_a2',
          scores,
          summary: '通话整体流畅，客户需求挖掘到位，邀约环节需加强。',
          redFlag: false,
        }
      });
      created++;
    }

    console.log(`✅ 创建了 ${created} 条 AI 分析结果（含6维评分）`);

    // 验证：按客服汇总均值
    const agents = await prisma.user.findMany({
      where: { tenantId: tenant.id, role: 'agent' },
      select: { id: true, name: true }
    });
    console.log('\n📊 各客服6维评分均值预览：');
    for (const agent of agents) {
      const rows = await prisma.analysisResult.findMany({
        where: { recording: { tenantId: tenant.id, agentId: agent.id }, scores: { not: null } },
        select: { scores: true }
      });
      if (rows.length === 0) { console.log(`  ${agent.name}: 暂无数据`); continue; }
      const keys = ['opening','needs','value','objection','invitation','retention'];
      const sums = {};
      keys.forEach(k => sums[k] = 0);
      rows.forEach(r => { keys.forEach(k => { sums[k] += (r.scores[k] || 0); }); });
      const avg = keys.map(k => (sums[k] / rows.length).toFixed(1));
      console.log(`  ${agent.name} (${rows.length}条): 开场白${avg[0]} 需求${avg[1]} 价值${avg[2]} 异议${avg[3]} 邀约${avg[4]} 私域${avg[5]}`);
    }
  } catch (e) {
    console.error('❌ 失败:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

addAnalysisResults();
