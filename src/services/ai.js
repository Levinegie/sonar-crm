/**
 * AI 分析服务 - 使用 Gemini
 * 两阶段分析：录音解析 -> 深度诊断
 */

const {
  PROMPT_LINE_A1, PROMPT_LINE_B1,
  PROMPT_LINE_A2, PROMPT_LINE_B2,
  PROMPT_CONFIRM_CARD,
} = require('../config/defaultPrompts');
const axios = require('axios');
const { getSignedUrl } = require('./oss');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// 从环境变量获取 AI 配置
const AI_API_URL = process.env.AI_API_URL || 'https://yunwu.ai';
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_DEFAULT_MODEL || process.env.AI_MODEL || 'gemini-3.1-flash-lite-preview';

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
    // 1. 下载音频文件并转为 base64
    console.log('Downloading audio from OSS:', ossUrl);
    const audioResponse = await axios.get(ossUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const base64Audio = Buffer.from(audioResponse.data).toString('base64');

    // 根据文件扩展名判断 MIME 类型
    const ext = ossUrl.split('.').pop().toLowerCase().split('?')[0];
    const mimeMap = { mp3: 'audio/mp3', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac' };
    const mimeType = mimeMap[ext] || 'audio/mp3';

    console.log(`Audio downloaded, size: ${audioResponse.data.byteLength} bytes, type: ${mimeType}`);

    // 2. 通过 OpenAI 兼容格式发送音频（base64 内联）
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
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Audio}`
                }
              }
            ]
          }
        ],
        temperature: 0.3,
        max_tokens: 8192
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        timeout: 120000
      }
    );

    if (response.data?.choices?.[0]?.message?.content) {
      return response.data.choices[0].message.content;
    }

    throw new Error('Invalid response format from API');

  } catch (error) {
    console.error('Audio analysis failed:', error.response?.data || error.message);
    throw new Error('音频分析失败: ' + (error.response?.data?.error?.message || error.message));
  }
}

/**
 * 主分析函数
 * 被录音上传时调用
 *
 * 新流程：
 * 1. 第一阶段：录音转写 + 基础分析
 * 2. 待确认识别：提取客户信息生成确认卡片
 * 3. 第二阶段：深度诊断（金牌教练）
 * 4. 等待客服确认后再创建/更新客户
 */
async function analyzeRecording(recordingId) {
  console.log(`Starting analysis for recording: ${recordingId}`);

  // 1. 获取录音信息
  const recording = await prisma.recording.findUnique({
    where: { id: recordingId }
  });

  if (!recording) {
    throw new Error('Recording not found');
  }

  // 2. 查找是否已有客户（用于判断是首通还是跟进）
    let existingCustomer = null;
    if (recording.customerPhone) {
      const phone = recording.customerPhone.replace(/\D/g, '');
      existingCustomer = await prisma.customer.findFirst({
        where: {
          tenantId: recording.tenantId,
          phone: phone.length >= 11 ? phone : { contains: phone }
        }
      });
    }

    const lineType = existingCustomer ? 'line_b' : 'line_a';
    const callStage = existingCustomer ? 'follow_up' : 'cold_call';

    // 4. 生成签名 URL（OSS bucket 不允许公开访问）
    const signedUrl = await getSignedUrl(recording.ossKey, 600);
    console.log('Generated signed URL for audio download');

    // 5. 第一阶段分析：录音转写 + 基础评分
    console.log('Stage 1: Audio transcription and basic analysis...');
    const stage1Result = await runStage1Analysis({ ...recording, ossUrl: signedUrl }, existingCustomer);

    // 5. 保存第一阶段结果
    const stage1Record = await prisma.analysisResult.create({
      data: {
        recordingId,
        customerId: existingCustomer?.id,
        stage: 'stage1',
        lineType,
        modelName: AI_MODEL,
        provider: 'gemini',
        transcript: stage1Result.transcript,
        rawOutput: stage1Result.rawOutput,
        scores: stage1Result.scores,
        metadata: stage1Result.metadata
      }
    });

    // 5.5 违禁词检测
    if (stage1Result.isValid && stage1Result.transcript) {
      await checkForbiddenWords(stage1Result.transcript, recording.tenantId, recordingId, recording.agentId, stage1Record.id);
    }

    // 6. 判断是否有效通话
    if (!stage1Result.isValid) {
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          isValid: false,
          analysisStatus: 'completed',
          analyzedAt: new Date()
        }
      });
      console.log('Recording marked as invalid');
      return;
    }

    // 7. 【新增】待确认卡片识别
    console.log('Confirm Card: Extracting customer info...');
    const confirmCard = await runConfirmCardAnalysis(stage1Result.transcript, recording.tenantId);

    // 8. 【新增】保存待确认卡片（作为分析结果的一个特殊 stage）
    await prisma.analysisResult.create({
      data: {
        recordingId,
        customerId: existingCustomer?.id,
        stage: 'confirm_card',
        lineType,
        modelName: AI_MODEL,
        provider: 'gemini',
        rawOutput: JSON.stringify(confirmCard),
        customerCard: {
          basicInfo: confirmCard.basicInfo,
          portrait: confirmCard.portrait,
          customerLevel: confirmCard.customerLevel,
          levelReason: confirmCard.levelReason,
          nextFollow: confirmCard.nextFollow,
          promise: confirmCard.promise,
          callSummary: confirmCard.callSummary,
          isNewCustomer: !existingCustomer,
          existingCustomerId: existingCustomer?.id || null
        },
        summary: confirmCard.callSummary
      }
    });

    // 9. 继续第二阶段分析：深度诊断（金牌教练）
    console.log('Stage 2: Deep analysis...');
    const stage2Result = await runStage2Analysis(recording, stage1Result, lineType);

    // 10. 保存第二阶段结果
    await prisma.analysisResult.create({
      data: {
        recordingId,
        customerId: existingCustomer?.id,
        stage: 'stage2',
        lineType,
        modelName: AI_MODEL,
        provider: 'gemini',
        rawOutput: stage2Result.rawOutput,
        scores: stage2Result.scores,
        summary: stage2Result.summary,
        redFlag: stage2Result.redFlag,
        redFlagDetail: stage2Result.redFlagDetail
      }
    });

    // 11. 更新录音状态 - 标记为"待确认"
    await prisma.recording.update({
      where: { id: recordingId },
      data: {
        isValid: true,
        callStage,
        analysisStatus: 'pending_confirm',  // 新状态：等待客服确认
        customerId: existingCustomer?.id,
        analyzedAt: new Date()
      }
    });

    console.log(`Analysis completed, waiting for confirmation: ${recordingId}`);
}

/**
 * 第一阶段分析：录音解析
 * 使用 Gemini 直接分析音频文件
 */
async function runStage1Analysis(recording, customer) {
  const callStage = customer ? 'follow_up' : 'cold_call';
  const prompt = await getStage1Prompt(callStage, recording.tenantId);

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
  const prompt = await getStage2Prompt(lineType, recording.tenantId);

  // 如果是跟进客户，查询历史通话记录
  let historyContext = '';
  if (lineType === 'line_b' && recording.customerId) {
    const historyRecordings = await prisma.recording.findMany({
      where: {
        customerId: recording.customerId,
        id: { not: recording.id }, // 排除当前录音
        isValid: true,
        analysisStatus: { in: ['completed', 'pending_confirm'] }
      },
      orderBy: { createdAt: 'asc' },
      take: 5, // 最多取最近5次
      include: {
        analysisResults: {
          where: { stage: 'confirm_card' },
          select: {
            customerCard: true,
            summary: true,
            createdAt: true
          }
        }
      }
    });

    if (historyRecordings.length > 0) {
      historyContext = '\n\n【客户历史跟进记录】\n';
      historyRecordings.forEach((rec, index) => {
        const card = rec.analysisResults[0];
        if (card) {
          historyContext += `\n第${index + 1}次通话（${new Date(rec.createdAt).toLocaleDateString()}）：\n`;
          historyContext += `- 通话摘要：${card.summary || '无'}\n`;
          if (card.customerCard?.nextFollow) {
            historyContext += `- 下次跟进计划：${card.customerCard.nextFollow}\n`;
          }
          if (card.customerCard?.promise) {
            historyContext += `- 客户承诺：${card.customerCard.promise}\n`;
          }
          if (card.customerCard?.customerLevel) {
            historyContext += `- 客户等级：${card.customerCard.customerLevel}（${card.customerCard.levelReason || ''}）\n`;
          }
        }
      });
      historyContext += '\n请结合以上历史记录，分析本次跟进的效果和改进建议。\n';
    }
  }

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
${JSON.stringify(stage1Result.scores, null, 2)}${historyContext}

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
    // 先尝试提取 ===SCORE_JSON_START=== 和 ===SCORE_JSON_END=== 之间的 JSON
    const jsonBlockMatch = output.match(/===SCORE_JSON_START===\s*([\s\S]*?)\s*===SCORE_JSON_END===/);
    if (jsonBlockMatch) {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      const scoreData = parsed.score_summary || {};
      const customerData = parsed.customer_card_update || {};

      // 提取 markdown 报告内容（JSON 之前的部分）
      const reportContent = output.split('===SCORE_JSON_START===')[0].trim();

      // 从 markdown 中提取每个维度的详细内容
      const extractDimension = (dimNumber, dimName) => {
        const dimRegex = new RegExp(`### ${dimNumber}\\. ${dimName}([\\s\\S]*?)(?=### \\d+\\.|## |===|$)`, 'm');
        const dimMatch = reportContent.match(dimRegex);
        if (!dimMatch) return { strength: '', improve: '' };

        const dimContent = dimMatch[1];

        // 提取深度诊断（完整句子）
        const diagnosisMatch = dimContent.match(/\*\s+\*\*深度诊断\*\*[：:]\s*([^\n]+)/);
        // 提取优化话术（在同一行，支持中英文引号）
        const optimizeMatch = dimContent.match(/\*\s+\*\*优化话术\*\*[：:]\s*[""]([^"""]+?)[""]/) ||
                             dimContent.match(/\*\s+\*\*优化话术\*\*[：:]\s*"([^"]+?)"/);

        return {
          strength: optimizeMatch ? optimizeMatch[1].trim() : '',
          improve: diagnosisMatch ? diagnosisMatch[1].trim() : ''
        };
      };

      const dim1 = extractDimension(1, '情绪账户充值');
      const dim2 = extractDimension(2, '卡点精准试探');
      const dim3 = extractDimension(3, '新变量注入');
      const dim5 = extractDimension(5, '异议降维打击');
      const dim6 = extractDimension(6, '备胎计划与留存');

      // 提取金句
      const goldQuoteMatch = reportContent.match(/## 💎 金句萃取\s*["""]([\\s\\S]*?)["""]/);
      const goldQuote = goldQuoteMatch ? goldQuoteMatch[1].trim() : '';

      // 提取综合提升指导
      const guidanceMatch = reportContent.match(/\*\*提升方向\*\*[：:]\s*([\s\S]*?)(?=---|##|===|$)/);
      const guidance = guidanceMatch ? guidanceMatch[1].trim() : '';

      return {
        summary: scoreData.one_line_summary || reportContent.slice(0, 200),
        scores: {
          opening: { score: scoreData.dim1_emotional_deposit || 0, strength: dim1.strength, improve: dim1.improve },
          needs_discovery: { score: scoreData.dim2_stall_diagnosis || 0, strength: dim2.strength, improve: dim2.improve },
          product_presentation: { score: scoreData.dim3_new_variable || 0, strength: dim3.strength, improve: dim3.improve },
          objection_handling: { score: scoreData.dim5_objection_deescalation || 0, strength: dim5.strength, improve: dim5.improve },
          closing: { score: scoreData.dim6_nurture_exit || 0, strength: dim6.strength, improve: dim6.improve },
          overall: { score: scoreData.follow_up_score || 0 },
          gold_quote: goldQuote,
          next_action: customerData.next_action || guidance
        },
        customerCard: customerData,
        redFlag: scoreData.red_flag_triggered || false,
        redFlagDetail: scoreData.red_flag_detail || '',
        metadata: {
          fullReport: reportContent,
          followUpGrade: scoreData.follow_up_grade,
          personalGrade: scoreData.personal_grade
        }
      };
    }

    // 兼容旧格式：直接匹配 JSON
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
 * 从数据库获取租户的 systemPrompt，没有则返回 null
 */
async function getPromptFromDB(tenantId, configName) {
  try {
    const config = await prisma.aIConfig.findFirst({
      where: { tenantId, name: configName, isActive: true }
    });
    return config?.systemPrompt || null;
  } catch (e) {
    console.error('Failed to load prompt from DB:', e);
    return null;
  }
}

/**
 * 第一阶段提示词
 */
async function getStage1Prompt(callStage, tenantId) {
  const configName = callStage === 'cold_call' ? 'line_a1' : 'line_b1';
  const dbPrompt = tenantId ? await getPromptFromDB(tenantId, configName) : null;
  return dbPrompt || (callStage === 'cold_call' ? PROMPT_LINE_A1 : PROMPT_LINE_B1);
}

/**
 * 第二阶段提示词
 */
async function getStage2Prompt(lineType, tenantId) {
  const configName = lineType === 'line_a' ? 'line_a2' : 'line_b2';
  const dbPrompt = tenantId ? await getPromptFromDB(tenantId, configName) : null;
  return dbPrompt || (lineType === 'line_a' ? PROMPT_LINE_A2 : PROMPT_LINE_B2);
}

/**
 * 待确认卡片识别提示词
 * 从录音转写中提取结构化信息，生成待确认卡片
 */
async function getConfirmCardPrompt(tenantId) {
  const dbPrompt = tenantId ? await getPromptFromDB(tenantId, 'confirm_card') : null;
  return dbPrompt || PROMPT_CONFIRM_CARD;
}

/**
 * 解析待确认卡片输出
 */
function parseConfirmCardOutput(output) {
  try {
    // 尝试提取 JSON
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        basicInfo: {
          customerName: parsed.basic_info?.customer_name || null,
          customerPhone: parsed.basic_info?.customer_phone || null,
          community: parsed.basic_info?.community || null,
          area: parsed.basic_info?.area || null,
          budget: parsed.basic_info?.budget || null
        },
        portrait: {
          houseType: parsed.portrait?.house_type || null,
          houseUsage: parsed.portrait?.house_usage || null,
          houseState: parsed.portrait?.house_state || null,
          familyMembers: parsed.portrait?.family_members || null,
          profession: parsed.portrait?.profession || null,
          habits: parsed.portrait?.habits || null,
          awareness: parsed.portrait?.awareness || null,
          position: parsed.portrait?.position || null,
          budgetDetail: parsed.portrait?.budget_detail || null,
          timeline: parsed.portrait?.timeline || null,
          focusPoints: parsed.portrait?.focus_points || null,
          stylePreference: parsed.portrait?.style_preference || null
        },
        customerLevel: parsed.customer_level || 'C',
        levelReason: parsed.level_reason || '',
        nextFollow: parsed.next_follow || '明天',
        promise: parsed.promise || null,
        callSummary: parsed.call_summary || '',
        rawOutput: output
      };
    }
  } catch (e) {
    console.error('Parse confirm card output failed:', e);
  }

  // 默认返回
  return {
    basicInfo: {
      customerName: null,
      customerPhone: null,
      community: null,
      area: null,
      budget: null
    },
    portrait: {},
    customerLevel: 'C',
    levelReason: '',
    nextFollow: '明天',
    promise: null,
    callSummary: '',
    rawOutput: output
  };
}

/**
 * 执行待确认卡片识别
 * @param {string} transcript - 第一阶段分析得到的转写文本
 * @returns {Promise<object>} - 待确认卡片数据
 */
async function runConfirmCardAnalysis(transcript, tenantId) {
  const prompt = await getConfirmCardPrompt(tenantId);

  const messages = [
    {
      role: 'system',
      content: prompt
    },
    {
      role: 'user',
      content: `请分析以下通话录音转写，提取客户信息生成待确认卡片：

${transcript}

请严格按照 JSON 格式输出分析结果。`
    }
  ];

  try {
    const rawOutput = await callGemini(messages);
    const result = parseConfirmCardOutput(rawOutput);
    return result;
  } catch (error) {
    console.error('Confirm card analysis failed:', error);
    // 返回默认空卡片
    return {
      basicInfo: {},
      portrait: {},
      customerLevel: 'C',
      levelReason: '',
      nextFollow: '明天',
      promise: null,
      callSummary: '分析失败：' + error.message,
      rawOutput: ''
    };
  }
}

/**
 * 违禁词检测
 * 在 transcript 中匹配租户的违禁词，命中则写入 Notification 并标记 redFlag
 */
async function checkForbiddenWords(transcript, tenantId, recordingId, agentId, stage1ResultId) {
  try {
    // 查询该租户的所有 active 违禁词（含全局的 tenantId=null）
    const words = await prisma.forbiddenWord.findMany({
      where: {
        OR: [
          { tenantId },
          { tenantId: null }
        ],
        isActive: true
      }
    });

    if (!words.length) return;

    const matched = [];
    for (const fw of words) {
      if (transcript.includes(fw.word)) {
        // 提取上下文（前后各 20 字）
        const idx = transcript.indexOf(fw.word);
        const start = Math.max(0, idx - 20);
        const end = Math.min(transcript.length, idx + fw.word.length + 20);
        const context = transcript.slice(start, end);
        matched.push({ word: fw.word, category: fw.category, context });
      }
    }

    if (!matched.length) return;

    console.log(`Forbidden words detected in recording ${recordingId}:`, matched.map(m => m.word));

    // 写入 Notification
    await prisma.notification.create({
      data: {
        tenantId,
        userId: agentId,
        type: 'violation',
        title: '违禁词预警',
        content: JSON.stringify({
          recordingId,
          agentId,
          words: matched
        }),
        link: `/recordings/${recordingId}`
      }
    });

    // 更新 stage1 AnalysisResult 的 redFlag
    await prisma.analysisResult.update({
      where: { id: stage1ResultId },
      data: {
        redFlag: true,
        redFlagDetail: `检测到违禁词：${matched.map(m => m.word).join('、')}`
      }
    });
  } catch (err) {
    console.error('Forbidden word check failed:', err);
    // 不阻断主流程
  }
}

module.exports = {
  analyzeRecording,
  runConfirmCardAnalysis,
  callGemini
};
