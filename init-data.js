/**
 * 初始化数据库数据
 * 运行方式：node init-data.js
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function init() {
  console.log('🚀 开始初始化数据库...\n');

  try {
    // 1. 创建默认租户
    console.log('📦 创建默认租户...');
    let tenant = await prisma.tenant.findFirst({
      where: { slug: 'default' }
    });

    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: {
          name: '默认租户',
          slug: 'default',
          maxUsers: 50,
          status: 'active'
        }
      });
      console.log('✅ 默认租户创建成功:', tenant.name);
    } else {
      console.log('✅ 默认租户已存在:', tenant.name);
    }

    const tenantId = tenant.id;

    // 2. 创建管理员账号
    console.log('\n👤 创建管理员账号...');
    const hashedPassword = await bcrypt.hash('admin123', 10);

    let admin = await prisma.user.findFirst({
      where: { tenantId, username: 'admin' }
    });

    if (!admin) {
      admin = await prisma.user.create({
        data: {
          tenantId,
          username: 'admin',
          password: hashedPassword,
          name: '系统管理员',
          role: 'admin',
          phone: '13800138000',
          isActive: true,
          maxCustomers: 1000
        }
      });
      console.log('✅ 管理员创建成功: admin / admin123');
    } else {
      console.log('✅ 管理员已存在: admin');
    }

    // 3. 创建测试客服
    console.log('\n👥 创建测试客服...');
    const agents = [
      { username: 'agent1', name: '客服小李', phone: '13800138001' },
      { username: 'agent2', name: '客服小王', phone: '13800138002' },
      { username: 'agent3', name: '客服小张', phone: '13800138003' }
    ];

    for (const agentData of agents) {
      let agent = await prisma.user.findFirst({
        where: { tenantId, username: agentData.username }
      });

      if (!agent) {
        agent = await prisma.user.create({
          data: {
            tenantId,
            username: agentData.username,
            password: hashedPassword,
            name: agentData.name,
            role: 'agent',
            phone: agentData.phone,
            isActive: true,
            maxCustomers: 50
          }
        });
        console.log(`✅ 客服创建成功: ${agentData.username} / admin123`);
      } else {
        console.log(`✅ 客服已存在: ${agentData.username}`);
      }
    }

    // 4. 创建测试老板账号
    console.log('\n👔 创建测试老板账号...');
    let boss = await prisma.user.findFirst({
      where: { tenantId, username: 'boss' }
    });

    if (!boss) {
      boss = await prisma.user.create({
        data: {
          tenantId,
          username: 'boss',
          password: hashedPassword,
          name: '老板',
          role: 'boss',
          phone: '13800138099',
          isActive: true,
          maxCustomers: 1000
        }
      });
      console.log('✅ 老板创建成功: boss / admin123');
    } else {
      console.log('✅ 老板已存在: boss');
    }

    // 5. 创建 AI 配置
    console.log('\n🤖 创建 AI 配置...');

    const aiConfigs = [
      {
        name: 'line_a1',
        description: '首通客户 - 第一阶段：录音解析',
        provider: 'gemini',
        model: 'gemini-3.1-flash-preview',
        apiUrl: 'https://yunwu.ai',
        isActive: true,
        priority: 100
      },
      {
        name: 'line_a2',
        description: '首通客户 - 第二阶段：深度诊断',
        provider: 'gemini',
        model: 'gemini-3.1-flash-preview',
        apiUrl: 'https://yunwu.ai',
        isActive: true,
        priority: 100
      },
      {
        name: 'line_b1',
        description: '跟进客户 - 第一阶段：录音解析',
        provider: 'gemini',
        model: 'gemini-3.1-flash-preview',
        apiUrl: 'https://yunwu.ai',
        isActive: true,
        priority: 100
      },
      {
        name: 'line_b2',
        description: '跟进客户 - 第二阶段：深度诊断',
        provider: 'gemini',
        model: 'gemini-3.1-flash-preview',
        apiUrl: 'https://yunwu.ai',
        isActive: true,
        priority: 100
      }
    ];

    for (const configData of aiConfigs) {
      let config = await prisma.aIConfig.findFirst({
        where: { tenantId, name: configData.name }
      });

      if (!config) {
        config = await prisma.aIConfig.create({
          data: {
            tenantId,
            ...configData
          }
        });
        console.log(`✅ AI 配置创建成功: ${configData.name}`);
      } else {
        console.log(`✅ AI 配置已存在: ${configData.name}`);
      }
    }

    // 6. 创建测试客户
    console.log('\n👨‍👩‍👧‍👦 创建测试客户...');
    const customers = [
      { name: '张先生', phone: '13900001111', community: '万科城市花园', area: 120, budget: '30-50万', level: 'A', status: 'pending' },
      { name: '李女士', phone: '13900002222', community: '恒大绿洲', area: 98, budget: '20-30万', level: 'B', status: 'invited' },
      { name: '王先生', phone: '13900003333', community: '碧桂园', area: 150, budget: '50-80万', level: 'S', status: 'visited' },
      { name: '赵女士', phone: '13900004444', community: '保利国际', area: 88, budget: '15-25万', level: 'C', status: 'pending' },
      { name: '刘先生', phone: '13900005555', community: '龙湖地产', area: 110, budget: '25-40万', level: 'A', status: 'signed' }
    ];

    const agents_list = await prisma.user.findMany({
      where: { tenantId, role: 'agent' }
    });

    for (let i = 0; i < customers.length; i++) {
      const cust = customers[i];
      const phone = cust.phone;
      const phoneMasked = phone.slice(0, 3) + '****' + phone.slice(-4);
      const agent = agents_list[i % agents_list.length];

      let customer = await prisma.customer.findFirst({
        where: { tenantId, phone }
      });

      if (!customer) {
        customer = await prisma.customer.create({
          data: {
            tenantId,
            name: cust.name,
            phone,
            phoneMasked,
            community: cust.community,
            area: cust.area,
            budget: cust.budget,
            level: cust.level,
            status: cust.status,
            source: '测试数据',
            agentId: agent.id,
            portrait: {
              community: cust.community,
              area: cust.area,
              budget: cust.budget
            }
          }
        });
        console.log(`✅ 客户创建成功: ${cust.name} (${cust.phone}) - 归属: ${agent.name}`);
      } else {
        console.log(`✅ 客户已存在: ${cust.name}`);
      }
    }

    // 7. 创建系统配置
    console.log('\n⚙️ 创建系统配置...');
    const systemConfigs = [
      { key: 'max_customers_per_agent', value: '50', category: 'agent', description: '每个客服最大客户数' },
      { key: 'auto_claim_enabled', value: 'true', category: 'general', description: '自动抢单功能' },
      { key: 'sea_release_days', value: '7', category: 'general', description: '公海释放天数' },
      { key: 'call_reminder_hours', value: '24', category: 'followup', description: '跟进提醒小时数' }
    ];

    for (const config of systemConfigs) {
      let existing = await prisma.tenantConfig.findFirst({
        where: { tenantId, key: config.key }
      });

      if (!existing) {
        await prisma.tenantConfig.create({
          data: {
            tenantId,
            ...config
          }
        });
        console.log(`✅ 系统配置创建成功: ${config.key}`);
      } else {
        console.log(`✅ 系统配置已存在: ${config.key}`);
      }
    }

    // 8. 创建渠道
    console.log('\n📢 创建渠道...');
    const channels = [
      { name: '百度推广', code: 'baidu', description: '百度搜索引擎推广' },
      { name: '抖音', code: 'douyin', description: '抖音短视频平台' },
      { name: '小红书', code: 'xiaohongshu', description: '小红书内容平台' },
      { name: '老客户介绍', code: 'referral', description: '老客户转介绍' },
      { name: '自然进店', code: 'walkin', description: '门店自然客流' }
    ];

    for (const channel of channels) {
      let existing = await prisma.channel.findFirst({
        where: { tenantId, code: channel.code }
      });

      if (!existing) {
        await prisma.channel.create({
          data: {
            tenantId,
            ...channel
          }
        });
        console.log(`✅ 渠道创建成功: ${channel.name}`);
      } else {
        console.log(`✅ 渠道已存在: ${channel.name}`);
      }
    }

    // 9. 创建违禁词
    console.log('\n🚫 创建违禁词...');
    const forbiddenWords = [
      { word: '最低价', category: 'price' },
      { word: '保证签单', category: 'promise' },
      { word: '百分百', category: 'promise' },
      { word: '绝对', category: 'promise' },
      { word: '第一', category: 'ranking' }
    ];

    for (const fw of forbiddenWords) {
      let existing = await prisma.forbiddenWord.findFirst({
        where: { tenantId: null, word: fw.word }
      });

      if (!existing) {
        await prisma.forbiddenWord.create({
          data: {
            tenantId: null,
            ...fw
          }
        });
        console.log(`✅ 违禁词创建成功: ${fw.word}`);
      } else {
        console.log(`✅ 违禁词已存在: ${fw.word}`);
      }
    }

    console.log('\n🎉 数据库初始化完成！\n');
    console.log('📋 默认账号信息:');
    console.log('   管理员: admin / admin123');
    console.log('   老板: boss / admin123');
    console.log('   客服: agent1, agent2, agent3 / admin123\n');

  } catch (error) {
    console.error('❌ 初始化失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

init();
