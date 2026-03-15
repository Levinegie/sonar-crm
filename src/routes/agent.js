const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { success, error } = require('../utils/helpers');

// ==================== 获取今日待办 ====================
router.get('/todos', async (req, res) => {
  try {
    const { agentId } = req.query;

    if (!agentId) {
      return res.status(400).json(error('缺少 agentId 参数', 400));
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 获取今日任务
    const tasks = await prisma.dailyTask.findMany({
      where: {
        agentId,
        date: today,
        status: { not: 'completed' }
      },
      include: {
        customer: {
          include: {
            recordings: {
              where: { analysisStatus: 'completed' },
              orderBy: { callTime: 'desc' },
              take: 1
            }
          }
        }
      },
      orderBy: [
        { priority: 'asc' },
        { sortOrder: 'asc' }
      ]
    });

    // 统计数据
    const stats = {
      overdue: tasks.filter(t => t.priority === 'P0').length,
      today: tasks.filter(t => ['P1', 'P2'].includes(t.priority)).length,
      done: await prisma.dailyTask.count({
        where: { agentId, date: today, status: 'completed' }
      })
    };

    // 格式化任务数据
    const formattedTasks = tasks.map(task => {
      const customer = task.customer;
      const lastRecording = customer.recordings[0];

      return {
        id: task.id,
        customerId: customer.id,
        name: customer.name,
        phone: customer.phone,
        level: customer.level,
        community: customer.community,
        area: customer.area,
        budget: customer.budget,
        priority: task.priority,
        overdueDays: task.overdueDays,
        nextFollowDate: customer.nextFollowDate,
        portrait: customer.portrait,
        aiTip: lastRecording?.aiFollowup || '暂无AI建议'
      };
    });

    res.json(success({ stats, tasks: formattedTasks }));
  } catch (err) {
    console.error('[API Error] /agent/todos:', err);
    res.status(500).json(error('获取待办失败', 500));
  }
});

// ==================== 获取待确认录音 ====================
router.get('/pending-confirmations', async (req, res) => {
  try {
    const { agentId } = req.query;

    if (!agentId) {
      return res.status(400).json(error('缺少 agentId 参数', 400));
    }

    // 获取待确认的录音
    const recordings = await prisma.recording.findMany({
      where: {
        agentId,
        analysisStatus: 'pending'
      },
      include: {
        customer: true
      },
      orderBy: { callTime: 'desc' }
    });

    // 格式化数据
    const formattedRecordings = recordings.map(rec => {
      const customer = rec.customer;
      const isFirstCall = customer ? (customer.callCount === 1) : false;

      return {
        id: rec.id,
        customerId: customer?.id,
        customerName: customer?.name || '未知客户',
        phone: rec.customerPhone,
        callTime: rec.callTime,
        duration: rec.duration,
        isFirstCall,
        callNumber: customer?.callCount || 1,
        aiAnalysis: {
          level: rec.aiLevel,
          portrait: rec.aiPortrait,
          needs: rec.aiNeeds,
          concerns: rec.aiConcerns,
          followup: rec.aiFollowup
        }
      };
    });

    res.json(success({ recordings: formattedRecordings }));
  } catch (err) {
    console.error('[API Error] /agent/pending-confirmations:', err);
    res.status(500).json(error('获取待确认录音失败', 500));
  }
});

// ==================== 确认录音分析 ====================
router.post('/confirm', async (req, res) => {
  try {
    const { recordingId, confirmed, corrections } = req.body;

    if (!recordingId) {
      return res.status(400).json(error('缺少 recordingId 参数', 400));
    }

    // 更新录音状态
    const recording = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        analysisStatus: confirmed ? 'confirmed' : 'rejected',
        ...(corrections && { aiCorrections: JSON.stringify(corrections) })
      },
      include: { customer: true }
    });

    // 如果确认，更新客户信息
    if (confirmed && recording.customer) {
      await prisma.customer.update({
        where: { id: recording.customer.id },
        data: {
          level: recording.aiLevel || recording.customer.level,
          portrait: recording.aiPortrait || recording.customer.portrait,
          needs: recording.aiNeeds || recording.customer.needs,
          concerns: recording.aiConcerns || recording.customer.concerns
        }
      });
    }

    res.json(success({ recording }));
  } catch (err) {
    console.error('[API Error] /agent/confirm:', err);
    res.status(500).json(error('确认录音失败', 500));
  }
});

// ==================== 完成任务 ====================
router.post('/complete-task', async (req, res) => {
  try {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json(error('缺少 taskId 参数', 400));
    }

    // 更新任务状态
    const task = await prisma.dailyTask.update({
      where: { id: taskId },
      data: {
        status: 'completed',
        completedAt: new Date()
      }
    });

    res.json(success({ task }));
  } catch (err) {
    console.error('[API Error] /agent/complete-task:', err);
    res.status(500).json(error('完成任务失败', 500));
  }
});

module.exports = router;
