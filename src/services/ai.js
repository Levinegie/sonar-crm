/**
 * AI 分析服务 - 使用 Gemini
 * 两阶段分析：录音解析 -> 深度诊断
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const { getSignedUrl } = require('./oss');

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
        temperature: 0.7,
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

    // 3. 查找是否已有客户（用于判断是首通还是跟进）
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
  if (dbPrompt) return dbPrompt;

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
async function getStage2Prompt(lineType, tenantId) {
  const configName = lineType === 'line_a' ? 'line_a2' : 'line_b2';
  const dbPrompt = tenantId ? await getPromptFromDB(tenantId, configName) : null;
  if (dbPrompt) return dbPrompt;

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

/**
 * 待确认卡片识别提示词
 * 从录音转写中提取结构化信息，生成待确认卡片
 */
async function getConfirmCardPrompt(tenantId) {
  const dbPrompt = tenantId ? await getPromptFromDB(tenantId, 'confirm_card') : null;
  if (dbPrompt) return dbPrompt;

  return `你是一位专业的家装客服助手。你的任务是从通话录音转写中提取客户信息，生成待确认卡片。

请仔细分析通话内容，提取以下信息：

## 基础信息（有就填写，没有就填 null）
- customer_name: 客户姓名
- customer_phone: 客户电话号码
- community: 小区名称
- area: 房屋面积（数字，单位平方米）
- budget: 预算金额（如"25万"）

## 客户画像（从对话中推断，没有就填 null）
- house_type: 房屋类型（商品房/自建房/别墅/二手房）
- house_usage: 房屋用途（���住/出租/办公）
- house_state: 房屋现状（毛坯/简装/精装翻新）
- family_members: 家庭成员（如"夫妻+1孩"、"三代同堂"）
- profession: 客户职业
- habits: 生活习惯或特殊需求
- awareness: 了解程度（小白/百家咨询/有装修经验）
- position: 装修定位（一线品牌/中等品牌/小公司/游击队）
- budget_detail: 预算细节（如"25万全包"）
- timeline: 装修时间节点（如"3个月后交房"）
- focus_points: 客户关注点（工程质量/工期/价格/材料/设计）
- style_preference: 风格偏好或设计师要求

## 客户等级判断（重要！）
根据以下标准判断客户等级：
- S级: 别墅/大户型(180㎡+) + 高预算(30万+) + 明确需求
- A级: 有明确装修需求 + 预算合理 + 有时间节点
- B级: 有意向但需求模糊/预算偏低
- C级: 意向弱/只是问问/没有明确需求
- 无效: 外卖/推销/打错电话/完全不相关/态度恶劣明确拒绝

## 下次跟进时间
- next_follow: 如果对话中提到具体跟进时间，提取出来
- 选项: 明天/后天/3天后/1周后
- 如果没提到，默认填"明天"

## 承诺事项
- promise: 客服在对话中承诺的事情（如"下周二带方案上门"、"发案例给您"）

请严格按照以下 JSON 格式输出：
{
  "basic_info": {
    "customer_name": "张先生",
    "customer_phone": "13812345678",
    "community": "万科城市花园",
    "area": 120,
    "budget": "25-30万"
  },
  "portrait": {
    "house_type": "商品房",
    "house_usage": "自住",
    "house_state": "毛坯",
    "family_members": "夫妻+1孩",
    "profession": "工程师",
    "habits": null,
    "awareness": "百家咨询",
    "position": "一线品牌",
    "budget_detail": "25万全包",
    "timeline": "3个月后交房",
    "focus_points": "工程质量、工期",
    "style_preference": "现代简约"
  },
  "customer_level": "A",
  "level_reason": "客户有明确装修需求，预算合理，3个月后交房时间明确",
  "next_follow": "后天",
  "promise": "发同类案例给客户",
  "call_summary": "客户咨询装修，120平三房，预算25万左右，3个月后交房，正在对比多家公司，关注工程质量和工期"
}`;
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
  runConfirmCardAnalysis
};
