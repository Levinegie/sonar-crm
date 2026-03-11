/**
 * AI 分析服务
 * 两阶段分析：录音解析 -> 深度诊断
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// 初始化 OSS 和 OpenAI
let openai = null;

async function getOpenAI(config) {
  if (!openai) {
    const OpenAI = require('openai');
    openai = new OpenAI({
      baseURL: config.apiUrl || 'https://api.openai.com/v1',
      apiKey: config.apiKey
    });
  }
  return openai;
}

/**
 * 主分析函数
 * 被录音上传时调用
 */
async function analyzeRecording(recordingId) {
  console.log(`Starting analysis for recording: ${recordingId}`);

  try {
    // 1. 获取录音信息
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId }
    });

    if (!recording) {
      throw new Error('Recording not found');
    }

    // 2. 更新状态为处理中
    await prisma.recording.update({
      where: { id: recordingId },
      data: { analysisStatus: 'processing' }
    });

    // 3. 获取客户信息（如果存在）
    let customer = null;
    if (recording.customerPhone) {
      customer = await prisma.customer.findFirst({
        where: {
          tenantId: recording.tenantId,
          phone: { contains: recording.customerPhone.replace(/\D/g, '').slice(-11, -1) }
        }
      });
    }

    // 4. 获取 OSS 录音文件
    // 这里需要下载录音文件或获取 URL

    // 5. 第一阶段分析：录音解析
    const stage1Result = await runStage1Analysis(recording, customer);

    // 6. 保存第一阶段结果
    const stage1Saved = await prisma.analysisResult.create({
      data: {
        recordingId,
        customerId: customer?.id,
        stage: 'stage1',
        lineType: stage1Result.callStage === 'cold_call' ? 'line_a' : 'line_b',
        modelName: stage1Result.modelName,
        provider: stage1Result.provider,
        transcript: stage1Result.transcript,
        rawOutput: stage1Result.rawOutput,
        scores: stage1Result.scores,
        metadata: stage1Result.metadata
      }
    });

    // 7. 判断是否有效
    if (!stage1Result.isValid) {
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          isValid: false,
          analysisStatus: 'completed',
          analyzedAt: new Date()
        }
      });
      return;
    }

    // 8. 如果有效，继续第二阶段分析
    const lineType = stage1Result.callStage === 'cold_call' ? 'line_a' : 'line_b';
    const stage2Result = await runStage2Analysis(recording, stage1Result, lineType);

    // 9. 保存第二阶段结果
    await prisma.analysisResult.create({
      data: {
        recordingId,
        customerId: customer?.id,
        stage: 'stage2',
        lineType,
        modelName: stage2Result.modelName,
        provider: stage2Result.provider,
        rawOutput: stage2Result.rawOutput,
        scores: stage2Result.scores,
        customerCard: stage2Result.customerCard,
        summary: stage2Result.summary,
        redFlag: stage2Result.redFlag,
        redFlagDetail: stage2Result.redFlagDetail
      }
    });

    // 10. 更新录音状态
    await prisma.recording.update({
      where: { id: recordingId },
      data: {
        isValid: true,
        callStage: stage1Result.callStage,
        analysisStatus: 'completed',
        customerId: customer?.id,
        analyzedAt: new Date()
      }
    });

    // 11. 如果是新客户，创建客户记录
    if (!customer && recording.customerPhone) {
      const phone = recording.customerPhone.replace(/\D/g, '');
      await prisma.customer.create({
        data: {
          tenantId: recording.tenantId,
          phone,
          phoneMasked: phone.slice(0, 3) + '****' + phone.slice(-4),
          name: stage2Result.customerCard?.customer_name,
          agentId: recording.agentId,
          source: '录音自动创建'
        }
      });
    }

    // 12. 更新客户信息
    if (customer && stage2Result.customerCard) {
      const updateData = {};

      if (stage2Result.customerCard.customer_name) {
        updateData.name = stage2Result.customerCard.customer_name;
      }

      // 更新画像
      if (stage2Result.customerCard) {
        updateData.portrait = {
          ...customer.portrait,
          ...stage2Result.customerCard
        };
      }

      // 更新级别
      if (stage2Result.scores?.lead_quality) {
        const score = stage2Result.scores.lead_quality;
        if (score >= 8.5) updateData.level = 'S';
        else if (score >= 7) updateData.level = 'A';
        else if (score >= 5) updateData.level = 'B';
        else updateData.level = 'C';
      }

      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          ...updateData,
          callCount: { increment: 1 },
          lastCallAt: recording.callTime
        }
      });
    }

    console.log(`Analysis completed for recording: ${recordingId}`);

  } catch (err) {
    console.error(`Analysis failed for recording ${recordingId}:`, err);

    await prisma.recording.update({
      where: { id: recordingId },
      data: {
        analysisStatus: 'failed',
        analysisError: err.message
      }
    });
  }
}

/**
 * 第一阶段分析：录音解析
 */
async function runStage1Analysis(recording, customer) {
  // 获取 AI 配置
  const lineType = customer ? 'line_b1' : 'line_a1';
  const config = await getAIConfig(recording.tenantId, lineType);

  if (!config) {
    throw new Error('AI config not found');
  }

  // 构建提示词
  const systemPrompt = config.systemPrompt || getDefaultPrompt(lineType);

  // 调用处理，实际需要 AI（这里简化先转文字）
  // const transcript = await speechToText(recording.ossUrl);

  // 模拟结果
  const result = {
    isValid: true,
    callStage: customer ? 'follow_up' : 'cold_call',
    transcript: '模拟转写内容...',
    scores: {
      lead_quality: { score: 7.5, grade: 'A' },
      agent_attitude: { score: 8.0, grade: 'A' }
    },
    metadata: {
      call_duration_sec: 180,
      call_type: 'outbound',
      total_turns: 20
    },
    modelName: config.model,
    provider: config.provider
  };

  return result;
}

/**
 * 第二阶段分析：深度诊断
 */
async function runStage2Analysis(recording, stage1Result, lineType) {
  const config = await getAIConfig(recording.tenantId, lineType + '2');

  if (!config) {
    throw new Error('AI config not found');
  }

  const systemPrompt = config.systemPrompt || getDefaultPrompt(lineType + '2');

  // 构建请求
  const prompt = `${systemPrompt}

通话转写：
${stage1Result.transcript}

一阶段分析结果：
${JSON.stringify(stage1Result.scores, null, 2)}
`;

  // 调用 AI
  const openaiClient = await getOpenAI(config);
  const response = await openaiClient.chat.completions.create({
    model: config.model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: '请分析这段通话' }
    ],
    temperature: 0.7
  });

  const rawOutput = response.choices[0].message.content;

  // 解析 JSON 结果
  const result = parseAIOutput(rawOutput, lineType);

  return {
    ...result,
    rawOutput,
    modelName: config.model,
    provider: config.provider
  };
}

/**
 * 获取 AI 配置
 */
async function getAIConfig(tenantId, name) {
  return await prisma.aIConfig.findFirst({
    where: { tenantId, name, isActive: true },
    orderBy: { priority: 'desc' }
  });
}

/**
 * 解析 AI 输出
 */
function parseAIOutput(output, lineType) {
  // 尝试提取 JSON
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('Parse JSON failed:', e);
    }
  }

  // 默认返回
  return {
    summary: output.slice(0, 200),
    scores: {},
    customerCard: {},
    redFlag: false
  };
}

/**
 * 默认提示词
 */
function getDefaultPrompt(type) {
  const prompts = {
    line_a1: `你是一台高精度的"录音解析仪"。你的任务：听录音，转写对话，评估客户线索质量和客服态度。...`,
    line_a2: `你是一位在家装网销领域拥有20年经验的"金牌操盘手"。你的任务：深度诊断首通电话的销售能力。...`,
    line_b1: `你是一台高精度的"录音解析仪"，专门处理老客户跟进电话。...`,
    line_b2: `你是一位在家装领域深耕20年的"客户资产管理大师"。你的任务：深度诊断老客户跟进电话。...`
  };
  return prompts[type] || '';
}

module.exports = {
  analyzeRecording
};
