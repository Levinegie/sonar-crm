/**
 * Queue load test — 50 mock recordings, watch them drain in real time.
 * Usage: node scripts/test-queue.js
 *
 * Uses a mock analyzeRecording (1-4s delay, 10% random failure) so no real
 * AI calls are made. Cleans up all test rows on exit.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();
const BATCH = 50;

// ── Mock analyzeRecording ────────────────────────────────────────────────────
async function mockAnalyzeRecording(recordingId) {
  const delay = 1000 + Math.random() * 3000; // 1–4 s
  await new Promise(r => setTimeout(r, delay));

  if (Math.random() < 0.1) {
    throw new Error('mock timeout');
  }

  await prisma.recording.update({
    where: { id: recordingId },
    data: { analysisStatus: 'pending_confirm', analyzedAt: new Date(), analysisError: null }
  });
}

// Patch require cache BEFORE loading queue.js
const aiPath = require.resolve('../src/services/ai');
require.cache[aiPath] = {
  id: aiPath, filename: aiPath, loaded: true,
  exports: { analyzeRecording: mockAnalyzeRecording, runConfirmCardAnalysis: async () => {}, callGemini: async () => '' }
};

const { startWorker, stopWorker } = require('../src/services/queue');

// ── Helpers ──────────────────────────────────────────────────────────────────
function bar(done, total, width = 30) {
  const filled = Math.round((done / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function getStatusCounts(ids) {
  const rows = await prisma.recording.groupBy({
    by: ['analysisStatus'],
    where: { id: { in: ids } },
    _count: true
  });
  const m = {};
  for (const r of rows) m[r.analysisStatus] = r._count;
  return m;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { status: 'active' } });
  const user   = await prisma.user.findFirst({ where: { tenantId: tenant?.id } });

  if (!tenant || !user) {
    console.error('No active tenant/user found. Seed the DB first.');
    process.exit(1);
  }

  console.log(`Tenant : ${tenant.name}`);
  console.log(`Agent  : ${user.name}`);
  console.log(`\nInserting ${BATCH} test recordings...`);

  const ids = [];
  for (let i = 0; i < BATCH; i++) {
    const rec = await prisma.recording.create({
      data: {
        tenantId: tenant.id,
        fileName: `queue-test-${String(i + 1).padStart(3, '0')}.m4a`,
        ossUrl: 'https://test.invalid/test.m4a',
        ossKey: `test/${uuidv4()}.m4a`,
        fileSize: 1024,
        customerPhone: `138${String(i).padStart(8, '0')}`,
        agentId: user.id,
        callTime: new Date(),
        analysisStatus: 'pending'
      }
    });
    ids.push(rec.id);
  }

  console.log(`Inserted. Starting worker (max 5 concurrent, poll 5s)...\n`);

  const startTime = Date.now();
  startWorker();

  // Live progress bar
  const ticker = setInterval(async () => {
    const s = await getStatusCounts(ids);
    const done    = (s.pending_confirm || 0);
    const failed  = (s.failed || 0);
    const active  = (s.processing || 0);
    const waiting = (s.pending || 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    process.stdout.write(
      `\r[${bar(done + failed, BATCH)}] ` +
      `${done + failed}/${BATCH}  ` +
      `active:${active}  pending:${waiting}  failed:${failed}  ${elapsed}s   `
    );

    if (done + failed >= BATCH) {
      clearInterval(ticker);
      stopWorker();

      const elapsed2 = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n\n✓ ${done} succeeded  ✗ ${failed} failed  in ${elapsed2}s`);
      console.log(`  throughput: ${(BATCH / elapsed2).toFixed(2)} rec/s`);

      console.log('\nCleaning up test rows...');
      await prisma.recording.deleteMany({ where: { id: { in: ids } } });
      console.log('Done.');
      await prisma.$disconnect();
      process.exit(0);
    }
  }, 400);

  // Safety exit after 5 minutes
  setTimeout(async () => {
    clearInterval(ticker);
    stopWorker();
    console.log('\n\nTimeout — cleaning up...');
    await prisma.recording.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
    process.exit(1);
  }, 5 * 60 * 1000);
}

main().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
