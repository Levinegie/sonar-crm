const { PrismaClient } = require('@prisma/client');
const { analyzeRecording } = require('./ai');

const prisma = new PrismaClient();

const POLL_INTERVAL_MS = 5000;
const MAX_CONCURRENT = 5;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;

let activeCount = 0;
let workerTimer = null;

// Parse retry count from analysisError field, e.g. "retry:2/3" → 2
function getRetryCount(analysisError) {
  if (!analysisError) return 0;
  const match = analysisError.match(/^retry:(\d+)\/\d+/);
  return match ? parseInt(match[1], 10) : 0;
}

// Recover tasks stuck in processing (crashed mid-flight)
async function recoverStalledTasks() {
  const cutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
  const stalled = await prisma.recording.findMany({
    where: {
      analysisStatus: 'processing',
      updatedAt: { lt: cutoff }
    },
    select: { id: true, analysisError: true }
  });

  for (const rec of stalled) {
    const retries = getRetryCount(rec.analysisError);
    if (retries >= MAX_RETRIES) {
      await prisma.recording.update({
        where: { id: rec.id },
        data: { analysisStatus: 'failed', analysisError: `retry:${retries}/${MAX_RETRIES} - max retries exceeded` }
      });
      console.log(`[Queue] Recording ${rec.id} exceeded max retries, marked failed`);
    } else {
      await prisma.recording.update({
        where: { id: rec.id },
        data: {
          analysisStatus: 'pending',
          analysisError: `retry:${retries + 1}/${MAX_RETRIES}`
        }
      });
      console.log(`[Queue] Recovered stalled recording ${rec.id} (retry ${retries + 1}/${MAX_RETRIES})`);
    }
  }
}

async function processBatch() {
  if (activeCount >= MAX_CONCURRENT) return;

  const slots = MAX_CONCURRENT - activeCount;

  // Claim pending tasks atomically by updating status to processing
  const pending = await prisma.recording.findMany({
    where: { analysisStatus: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: slots,
    select: { id: true, analysisError: true }
  });

  for (const rec of pending) {
    // Optimistic lock: only proceed if still pending
    const claimed = await prisma.recording.updateMany({
      where: { id: rec.id, analysisStatus: 'pending' },
      data: { analysisStatus: 'processing' }
    });
    if (claimed.count === 0) continue; // Another worker claimed it

    // Check file size - skip if too short (< 150KB ≈ 30 seconds)
    const recording = await prisma.recording.findUnique({
      where: { id: rec.id },
      select: { fileSize: true }
    });
    if (recording && recording.fileSize < 150000) {
      await prisma.recording.update({
        where: { id: rec.id },
        data: {
          analysisStatus: 'completed',
          isValid: false,
          analyzedAt: new Date(),
          analysisError: '录音过短（<30秒），无分析价值'
        }
      });
      console.log(`[Queue] Recording ${rec.id} too short (${recording.fileSize} bytes), skipped`);
      continue;
    }

    activeCount++;
    analyzeRecording(rec.id)
      .catch(async (err) => {
        console.error(`[Queue] Analysis failed for recording ${rec.id}:`, err.message);
        const retries = getRetryCount(rec.analysisError);
        if (retries >= MAX_RETRIES) {
          await prisma.recording.update({
            where: { id: rec.id },
            data: { analysisStatus: 'failed', analysisError: `retry:${retries}/${MAX_RETRIES} - ${err.message}` }
          });
        } else {
          await prisma.recording.update({
            where: { id: rec.id },
            data: {
              analysisStatus: 'pending',
              analysisError: `retry:${retries + 1}/${MAX_RETRIES}`
            }
          });
        }
      })
      .finally(() => {
        activeCount--;
      });
  }
}

async function poll() {
  try {
    await recoverStalledTasks();
    await processBatch();
  } catch (err) {
    console.error('[Queue] Poll error:', err.message);
  }
}

function startWorker() {
  if (workerTimer) return;
  console.log('[Queue] Worker started (poll interval: 5s, max concurrent: 5)');
  // Run immediately on start to recover any stalled tasks
  poll();
  workerTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    console.log('[Queue] Worker stopped');
  }
}

module.exports = { startWorker, stopWorker };
