/**
 * AI 分析服务 - 使用 Gemini
 * 两阶段分析：录音解析 -> 深度诊断
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();

// 从环境变量获取 AI 配置
const AI_API_URL = process.env.AI_API_URL || 'https://yunwu.ai';
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'gemini-3.1-flash-preview';

/**
 * 调用 Gemini API（通过云雾接口，OpenAI 兼容格式）
 */
async function callGemini(messages, options = {}) {
  if (!AI_API_KEY) {
    throw new Error('AI_API_KEY not configured');
  }

  try {
    const response = await axios.post(
      `${AI_API_URL}/v1/chat/completions`,
      {
        model: AI_MODEL,
        messages: messages,
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 8192
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        }
      }
    );

    if (response.data?.choices?.[0]?.message?.content) {
      return response.data.choices[0].message.content;
    }

    throw new Error('Invalid response format from API');

  } catch (error) {
    console.error('API call failed:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * 使用 Gemini 分析音频文件
 * 注意：需要先下载音频文件，然后作为 base64 发送
 */
async function analyzeAudioWithGemini(ossUrl, systemPrompt) {
  if (!AI_API_KEY) {
    throw new Error('AI_API_KEY not configured');
  }

  try {
    // 对于云雾接口，使用多模态能力
    const response = await axios.post(
      `${AI_API_URL}/v1/chat/completions`,
      {
        model: AI_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: systemPrompt
              },
              {
                type: 'image_url',  // 某些 API 使用这个格式处理音频
                image_url: {
                  url: ossUrl
                }
              }
            ]
          }
        ],
        temperature: 0.7,
        max_tokens: 8192
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        }
      }
    );

    if (response.data?.choices?.[0]?.message?.content) {
      return response.data.choices[0].message.content;
    }

    throw new Error('Invalid response format from API');

  } catch (error) {
    console.error('Audio analysis failed:', error.response?.data || error.message);

    // 如果多模态失败，返回提示信息
    console.log('Multimodal API not available, using text-only mode');
    throw new Error('Audio analysis not fully supported, please use text transcript');
  }
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
          phone: { contains: recording.customerPhone.replace(/\D/g, '').slice(-11) }
        }
      });
    }

    // 4. 第一阶段分析：使用 Gemini 直接分析音频
    const lineType = customer ? 'line_b' : 'line_a';
    const stage1Result = await runStage1Analysis(recording, customer);

    // 5. 保存第一阶段结果
    const stage1Saved = await prisma.analysisResult.create({
      data: {
        recordingId,
        customerId: customer?.id,
        stage: 'stage1',
        lineType: stage1Result.callStage === 'cold_call' ? 'line_a' : 'line_b',
        modelName: AI_MODEL,
        provider: 'gemini',
        transcript: stage1Result.transcript,
        rawOutput: stage1Result.rawOutput,
        scores: stage1Result.scores,
        metadata: stage1Result.metadata
      }
    });

    // 6. 判断是否有效
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

    // 7. 如果有效，继续第二阶段分析
    const stage2Result = await runStage2Analysis(recording, stage1Result, lineType);

    // 8. 保存第二阶段结果
    await prisma.analysisResult.create({
      data: {
        recordingId,
        customerId: customer?.id,
        stage: 'stage2',
        lineType,
        modelName: AI_MODEL,
        provider: 'gemini',
        rawOutput: stage2Result.rawOutput,
        scores: stage2Result.scores,
        customerCard: stage2Result.customerCard,
        summary: stage2Result.summary,
        redFlag: stage2Result.redFlag,
        redFlagDetail: stage2Result.redFlagDetail
      }
    });

    // 9. 更新录音状态
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

    // 10. 如果是新客户，创建客户记录
    if (!customer && recording.customerPhone && stage2Result.customerCard) {
      const phone = recording.customerPhone.replace(/\D/g, '');
      await prisma.customer.create({
        data: {
          tenantId: recording.tenantId,
          phone,
          phoneMasked: phone.slice(0, 3) + '****' + phone.slice(-4),
          name: stage2Result.customerCard.customer_name,
          agentId: recording.agentId,
          source: '录音自动创建',
          portrait: stage2Result.customerCard
        }
      });
    }

    // 11. 更新客户信息
    if (customer && stage2Result.customerCard) {
      const updateData = {};

      if (stage2Result.customerCard.customer_name) {
        updateData.name = stage2Result.customerCard.customer_name;
      }

      // 合并画像
      updateData.portrait = {
        ...customer.portrait,
        ...stage2Result.customerCard
      };

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
 * 使用 Gemini 直接分析音频文件
 */
async function runStage1Analysis(recording, customer) {
  const callStage = customer ? 'follow_up' : 'cold_call';
  const prompt = getStage1Prompt(callStage);

  try {
    // 调用 Gemini 分析音频
    const rawOutput = await analyzeAudioWithGemini(recording.ossUrl, prompt);

    // 解析结果
    const result = parseStage1Output(rawOutput);

    return {
      ...result,
      rawOutput,
      callStage
    };

  } catch (error) {
    console.error('Stage 1 analysis failed:', error);

    // 如果 AI 调用失败，返回默认结果（标记为无效）
    return {
      isValid: false,
      callStage,
      transcript: '',
      scores: {},
      metadata: {},
      error: error.message
    };
  }
}

/**
 * 第二阶段分析：深度诊断
 */
async function runStage2Analysis(recording, stage1Result, lineType) {
  const prompt = getStage2Prompt(lineType);

  const messages = [
    {
      role: 'system',
      content: prompt
    },
    {
      role: 'user',
      content: `请根据以下通话录音进行深度诊断：

通话转写：
${stage1Result.transcript}

一阶段分析结果：
${JSON.stringify(stage1Result.scores, null, 2)}

请按照要求输出 JSON 格式的分析结果。`
    }
  ];

  try {
    const rawOutput = await callGemini(messages);
    const result = parseStage2Output(rawOutput);

    return {
      ...result,
      rawOutput
    };

  } catch (error) {
    console.error('Stage 2 analysis failed:', error);

    // 返回默认结果
    return {
      summary: '分析失败：' + error.message,
      scores: {},
      customerCard: {},
      redFlag: false,
      redFlagDetail: '',
      rawOutput: error.message
    };
  }
}

/**
 * 解析第一阶段输出
 */
function parseStage1Output(output) {
  try {
    // 尝试提取 JSON
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        isValid: parsed.is_valid !== false,
        transcript: parsed.transcript || '',
        scores: parsed.scores || {},
        metadata: parsed.metadata || {}
      };
    }
  } catch (e) {
    console.error('Parse stage 1 output failed:', e);
  }

  // 默认返回（如果无法解析，认为有效）
  return {
    isValid: true,
    transcript: output.slice(0, 1000),
    scores: {
      lead_quality: { score: 7, grade: 'B' },
      agent_attitude: { score: 7, grade: 'B' }
    },
    metadata: {}
  };
}

/**
 * 解析第二阶段输出
 */
function parseStage2Output(output) {
  try {
    // 尝试提取 JSON
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || '',
        scores: parsed.scores || {},
        customerCard: parsed.customer_card || {},
        redFlag: parsed.red_flag || false,
        redFlagDetail: parsed.red_flag_detail || ''
      };
    }
  } catch (e) {
    console.error('Parse stage 2 output failed:', e);
  }

  // 默认返回
  return {
    summary: output.slice(0, 500),
    scores: {},
    customerCard: {},
    redFlag: false,
    redFlagDetail: ''
  };
}

/**
 * 第一阶段提示词
 */
function getStage1Prompt(callStage) {
  if (callStage === 'cold_call') {
    return `你是一台高精度的"录音解析仪"。你的任务：听录音，转写对话，评估客户线索质量和客服态度。

请按以下格式输出 JSON：
{
  "is_valid": true/false,
  "transcript": "完整的对话转写文本",
  "scores": {
    "lead_quality": {"score": 8.5, "grade": "A", "reason": "客户有明确装修需求"},
    "agent_attitude": {"score": 7.5, "grade": "B", "reason": "态度友好但话术待优化"}
  },
  "metadata": {
    "call_duration_sec": 180,
    "customer_intent": "装修咨询",
    "key_points": ["客户关注价格", "客户有户型图"]
  }
}

评估标准：
- is_valid: 是否为有效通话（不是空号、不是拒接等）
- lead_quality: 线索质量评分（0-10分，S/A/B/C）
- agent_attitude: 客服态度评分（0-10分）`;
  } else {
    return `你是一台高精度的"录音解析仪"，专门处理老客户跟进电话。你的任务：听录音，转写对话，评估客户意向和客服跟进质量。

请按以下格式输出 JSON：
{
  "is_valid": true/false,
  "transcript": "完整的对话转写文本",
  "scores": {
    "lead_quality": {"score": 8.5, "grade": "A", "reason": "客户意向增强"},
    "agent_attitude": {"score": 7.5, "grade": "B", "reason": "跟进积极"}
  },
  "metadata": {
    "call_duration_sec": 180,
    "customer_intent": "考虑签约",
    "key_points": ["客户对比竞品", "客户询问活动"]
  }
}`;
  }
}

/**
 * 第二阶段提示词
 */
function getStage2Prompt(lineType) {
  if (lineType === 'line_a') {
    return `你是一位在家装网销领域拥有20年经验的"金牌操盘手"。你的任务：深度诊断首通电话的销售能力。

请分析以下通话，从六个维度评分（0-10分）：
1. 开场破冰：是否迅速建立信任
2. 需求挖掘：是否准确了解客户需求
3. 产品展示：是否突出产品优势
4. 异议处理：是否妥善处理客户疑虑
5. 逼单技巧：是否有效推进成交
6. 整体表现：综合评估

请按以下格式输出 JSON：
{
  "summary": "整体评价和建议（200字左右）",
  "scores": {
    "opening": {"score": 8, "strength": "热情专业", "improve": "可更快进入正题"},
    "needs_discovery": {"score": 7, "strength": "问到了关键信息", "improve": "需更深入挖掘预算"},
    "product_presentation": {"score": 6, "strength": "介绍了套餐", "improve": "缺少针对性"},
    "objection_handling": {"score": 8, "strength": "耐心解答", "improve": "可更自信"},
    "closing": {"score": 5, "strength": "尝试邀约", "improve": "逼单力度不够"},
    "overall": {"score": 6.8}
  },
  "customer_card": {
    "customer_name": "张先生",
    "phone_last4": "1234",
    "community": "万科城市花园",
    "area": 120,
    "budget": "30-50万",
    "timeline": "3个月内",
    "decision_maker": "夫妻共同",
    "key_concern": "价格、工期"
  },
  "red_flag": false,
  "red_flag_detail": ""
}`;
  } else {
    return `你是一位在家装领域深耕20年的"客户资产管理大师"。你的任务：深度诊断老客户跟进电话。

请分析以下通话，评估：
1. 跟进时机是否恰当
2. 跟进内容是否有价值
3. 客户意向变化
4. 下一步行动建议

请按以下格式输出 JSON：
{
  "summary": "跟进评估和建议（200字左右）",
  "scores": {
    "timing": {"score": 8, "evaluation": "时机把握得当"},
    "content_value": {"score": 7, "evaluation": "提供了有用信息"},
    "interest_level": {"score": 8.5, "evaluation": "客户意向增强"},
    "next_action": {"score": 7, "evaluation": "已明确下一步"},
    "overall": {"score": 7.6}
  },
  "customer_card": {
    "customer_name": "李女士",
    "status_change": "从观望到考虑",
    "new_info": {
      "budget": "增加到40-50万",
      "timeline": "希望2个月内开工",
      "concern": "担心增项"
    },
    "recommend_action": "尽快安排设计师上门量房"
  },
  "red_flag": false,
  "red_flag_detail": ""
}`;
  }
}

module.exports = {
  analyzeRecording
};
