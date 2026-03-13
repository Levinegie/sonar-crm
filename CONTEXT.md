# 声纳 CRM 项目完整上下文

> 最后更新：2026-03-13
> 项目状态：开发中 - 功能1（待确认卡片）已完成并部署，AI音频分析已联调

---

## 📋 项目信息

| 项目 | 内容 |
|------|------|
| **项目路径** | `/Users/duyilin/sonar-crm` |
| **部署地址** | `https://onxojqoosjou.sealoshzh.site` |
| **GitHub** | `https://github.com/Levinegie/sonar-crm` |
| **Docker Hub** | `daveycrm123/sonar-crm:latest` |
| **产品定位** | 基于AI语音分析的家装行业CRM系统 |

---

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | 纯 HTML/JS/CSS（���于原始 Demo） |
| **后端** | Node.js + Express |
| **ORM** | Prisma |
| **数据库** | PostgreSQL (Sealos 云数据库) |
| **存储** | 阿里云 OSS |
| **AI 服务** | Gemini（通过国内中转） |
| **部署** | Docker + Sealos 云平台 |

---

## 🎯 三端设计

| 端 | 路径 | 文件 | 行数 | 用途 | 状态 |
|----|------|------|------|------|------|
| **客服端** | `/agent/` | `public/agent/index.html` | ~2320 | 客服日常工作：待确认卡片、客户管理、公海抢单、录音上传 | ✅ 核心功能完成 |
| **老板端** | `/boss/` | `public/boss/index.html` | 1866 | 数据看板、团队统计、转化漏斗 | ⚠️ 待完善 API 调用 |
| **管理端** | `/admin/` | `public/admin/index.html` | 737 | 系统管理、用户管理、配置管理 | ✅ 基本完成 |

---

## 👥 角色���限

| 角色 | 代码 | 权限 |
|------|------|------|
| **超级管理员** | `admin` | 全部功能 |
| **老板/主管** | `boss` | 数据查看、客户分配、统计数据 |
| **客服** | `agent` | 客户管理、录音上传、公海抢单 |

### 默认账号
- **用户名**: `admin`
- **密码**: `admin123`

---

## 🗄️ 数据库表结构

| 表名 | 用途 | 状态 |
|------|------|------|
| `tenants` | 租户表 | ✅ 已创建 |
| `users` | 用户表 | ✅ 已创建 |
| `customers` | 客户表 | ✅ 已创建 |
| `recordings` | 录音表 | ✅ 已创建 |
| `analysis_results` | 分析结果表 | ✅ 已创建 |
| `follow_ups` | 跟进记录表 | ✅ 已创建 |
| `ai_configs` | AI 配置表 | ✅ 已创建 |
| `notifications` | 通知消息表 | ✅ 已创建 |
| `targets` | 目标管理表 | ✅ 已创建 |
| `dashboard_configs` | 仪表盘配置表 | ✅ 已创建 |
| `import_tasks` | 批量导入任务表 | ✅ 已创建 |
| `audit_logs` | 审计日志表 | ✅ 已创建 |
| `tenant_configs` | 系统配置表 | ✅ 已在 schema 中定义（待 migrate） |
| `forbidden_words` | 违禁词表 | ✅ 已在 schema 中定义（待 migrate） |
| `channels` | 渠道表 | ✅ 已在 schema 中定义（待 migrate） |

---

## 📁 原始 Demo

| 文件 | 路径 | 行数 |
|------|------|------|
| **Demo HTML** | `/Users/duyilin/Downloads/声纳AI客服助手_Demo_v5.html` | 1782 |
| **技术文档** | `/Users/duyilin/Downloads/声纳AI客服助手_技术文档.md` | - |

---

## ✅ 已完成功能

### 功能1：待确认卡片 ✅（已部署）
**流程**：录音上传 → OSS存储 → 下载音频(签名URL) → Gemini分析 → 生成待确认卡片 → 客服确认/标记无效 → 客户入库/进入无效公海

| 组件 | 文件 | 说明 |
|------|------|------|
| AI待确认识别 | `src/services/ai.js` | `getConfirmCardPrompt()`, `runConfirmCardAnalysis()`, `parseConfirmCardOutput()` |
| 音频分析 | `src/services/ai.js` | `analyzeAudioWithGemini()` - 下载音频→base64编码→内联发送给Gemini |
| OSS签名URL | `src/services/oss.js` | `getSignedUrl()` - 生成临时访问URL（OSS bucket为私有） |
| 待确认API | `src/routes/recordings.js` | `GET /pending/confirm`, `POST /:id/confirm` |
| 无效公海API | `src/routes/customers.js` | `GET /invalid-sea` |
| 测试数据API | `src/routes/recordings.js` | `POST /seed/confirm-cards`（临时，仅admin可用） |
| 客服端前端 | `public/agent/index.html` | 待确认卡片渲染、确认/标记无效表单、导航红点动态计数 |

**AI分析三阶段流程**：
1. Stage 1：音频转写 + 基础评分（`runStage1Analysis`）
2. 待确认卡片：提取客户信息（`runConfirmCardAnalysis`）
3. Stage 2：深度诊断/金牌教练（`runStage2Analysis`）
4. 录音状态设为 `pending_confirm` → 出现在客服端待确认列表

**前端交互**：
- 所有字段（基础信息、客户画像、等级、承诺事项）均由 AI 预填，客服核对后提交
- 导航栏红点数字跟随实际待确认数量动态变化
- 客户等级下拉：S级、A级、B级、C级、无效
- 下次跟进：明天、后天、3天后、1周后

**已知问题（已修复）**：
- ~~OSS bucket 私有导致音频下载403~~ → 改用签名URL
- ~~音频传参用 image_url 直接传 OSS URL~~ → 改为下载后 base64 内联
- ~~等级下拉"无效"显示为"无效级"~~ → 修复判断条件
- ~~导航红点写死数字~~ → 改为动态计数

---

### 后端 API
- ✅ 用户认证（登录、登出、Token 刷新）
- ✅ 客户管理（列表、详情、创建、更新、删除）
- ✅ 公海管理（抢单、转移、分配、无效公海）
- ✅ 录音管理（上传、列表、删除）
- ✅ AI 分析（两阶段分析框架 + 待确认卡片识别）
- ✅ 统计数据（仪表盘、漏斗、趋势、ROI）
- ✅ 用户管理（客服列表、创建、更新、删除、重置密码）
- ✅ AI 配置管理

### 前端
- ✅ 管理端完整实现
- ✅ 客服端核心功能（待确认卡片、客户管理、公海抢单、录音上传）
- ⚠️ 老板端 API 调用待实现

---

## ❌ 已知问题

### 🔴 待修复
1. **数据库表未 migrate**：`tenant_configs`, `forbidden_words`, `channels` 已在 schema.prisma 定义但未执行 `prisma db push`，导致配置管理 API 报错
2. **OSS 文件扩展名**：上传时统一用 `.m4a` 扩展名（`ossKey` 写死），但实际文件可能是 `.mp3`，不影响功能但不规范

### 🟡 待验证
1. **AI 音频分析**：已修复签名URL和base64编码，但尚未验证完整流程（上传→AI分析→生成卡片），需要重启服务器后测试
2. **大文件音频**：超过 20MB 的音频 base64 编码后可能超出 API 请求限制

---

## 🔧 环境配置需求

### 环境变量 `.env`（已配置完成）
```bash
# 数据库（Sealos 内网地址，本地无法直连）
DATABASE_URL="<your-database-url>"
JWT_SECRET="<your-jwt-secret>"

# 阿里云 OSS（bucket 为私有，需用签名URL访问）
OSS_REGION=oss-cn-hangzhou
OSS_ACCESS_KEY_ID=<your-oss-access-key-id>
OSS_ACCESS_KEY_SECRET=<your-oss-access-key-secret>
OSS_BUCKET=rec-upload-hz
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com

# AI 服务（Gemini - 云雾接口，OpenAI兼容格式）
AI_API_URL=https://yunwu.ai
AI_API_KEY=<your-ai-api-key>
AI_MODEL=gemini-3.1-flash-preview

# 服务端口
PORT=3000
```

**重要说明**：
- 数据库在 Sealos 内网，本地开发无法直连，需通过线上 API 操作数据
- OSS bucket 为私有权限，代码中已通过 `getSignedUrl()` 生成临时访问URL
- AI API 通过云雾接口中转，支持 OpenAI 兼容格式，支持音频 base64 内联分析

---

## 🌐 API 端点完整列表

### 认证 (`/api/auth`)
- `POST /api/auth/login` - 登录
- `GET /api/auth/me` - 获取当前用户
- `POST /api/auth/refresh` - 刷新 Token
- `POST /api/auth/logout` - 登出

### 客户管理 (`/api/customers`)
- `GET /api/customers` - 客户列表（支持分页、搜索、筛选）
- `GET /api/customers/sea` - 公海客户
- `GET /api/customers/invalid-sea` - 无效公海客户
- `GET /api/customers/:id` - 客户详情
- `POST /api/customers` - 创建客户
- `PUT /api/customers/:id` - 更新客户
- `DELETE /api/customers/:id` - 删除客户（管理员）
- `POST /api/customers/:id/claim` - 抢单
- `POST /api/customers/:id/to-sea` - 转移到公海（管理员）
- `POST /api/customers/:id/assign` - 分配客户（管理员）

### 录音管理 (`/api/recordings`)
- `GET /api/recordings` - 录音列表（支持分页、搜索、筛选）
- `GET /api/recordings/:id` - 录音详情
- `POST /api/recordings/upload` - 上传录音（自动触发 AI 分析）
- `POST /api/recordings/:id/analyze` - 手动触发分析
- `DELETE /api/recordings/:id` - 删除录音
- `GET /api/recordings/pending/confirm` - 待确认卡片列表
- `POST /api/recordings/:id/confirm` - 确认卡片（创建/更新客户或标记无效）
- `POST /api/recordings/seed/confirm-cards` - 插入测试数据（临时，仅admin）

### AI 分析 (`/api/analysis`)
- `GET /api/analysis/:recordingId` - 获取分析结果
- `GET /api/analysis/customer/:customerId` - 客户分析历史

### 统计数据 (`/api/stats`)
- `GET /api/stats/dashboard` - 仪表盘概览
- `GET /api/stats/funnel` - 转化漏斗
- `GET /api/stats/trend` - 趋势图
- `GET /api/stats/roi` - 渠道 ROI

### 用户管理 (`/api/users`)
- `GET /api/users/agents` - 客服列表
- `POST /api/users` - 创建用户（管理员）
- `PUT /api/users/:id` - 更新用户（管理员）
- `DELETE /api/users/:id` - 删除用户（管理员）
- `POST /api/users/:id/reset-password` - 重置密码

### 配置管理 (`/api/config`)
- `GET /api/config/ai` - 获取 AI 配置
- `PUT /api/config/ai/:id` - 更新 AI 配置
- `GET /api/config/system` - 获取系统配置（❌ 待修复）
- `PUT /api/config/system` - 更新系统配置（❌ 待修复）
- `GET /api/config/forbidden-words` - 违禁词列表（❌ 待修复）
- `POST /api/config/forbidden-words` - 添加违禁词（❌ 待修复）
- `DELETE /api/config/forbidden-words/:id` - 删除违禁词（❌ 待修复）
- `GET /api/config/channels` - 渠道列表（❌ 待修复）
- `POST /api/config/channels` - 添加渠道（❌ 待修复）

### OSS (`/api/oss`)
- `POST /api/oss/upload-sign` - 获取上传签名

### 其他
- `GET /api/health` - 健康检查

---

## 🚀 部署信息

### Docker 配置
- **Dockerfile**: `/Users/duyilin/sonar-crm/Dockerfile`
- **基础镜像**: `node:20-alpine`
- **端口**: 3000
- **启动命令**: `node src/index.js`

### CI/CD
- **GitHub Actions**: `.github/workflows/docker-build.yml`
- **触发条件**: push 到 main 分支
- **自动构建**: 推送到 `daveycrm123/sonar-crm:latest`

### Sealos 部署
- **数据库**: PostgreSQL (Sealos 云数据库，内网地址)
- **域名**: `https://onxojqoosjou.sealoshzh.site`
- **状态**: ✅ 已部署运行
- **部署流程**: `git push → GitHub Actions 构建 Docker 镜像 → 推送 Docker Hub → Sealos 手动重启拉取最新镜像`

### 测试录音
- **路径**: `/Users/duyilin/Downloads/何111/`
- **数量**: 50 个 mp3 文件
- **文件名格式**: `电话号码(电话号码)_日期时间.mp3`
- **大小范围**: 14KB ~ 2.5MB

---

## 📝 待办事项（按优先级）

### 🔴 P0 - 核心功能（必须完成）
1. [ ] 执行 `prisma db push` 创建缺失的数据库表（tenant_configs, forbidden_words, channels）
2. [ ] 修复配置管理 API
3. [x] 实现客服端前端 API 调用（待确认卡片已完成）
4. [x] AI 音频分析功能（Gemini base64 内联分析，签名URL下载）
5. [x] 添加测试数据（种子API + 手动上传录音）
6. [ ] 端到端验证：上传真实录音 → AI分析 → 生成待确认卡片（重启服务器后测试）
7. [ ] 实现老板端前端 API 调用

### 🟡 P1 - 重要功能
1. [x] 补充环境变量配置（OSS、AI）- 已配置
2. [x] 部署到 Sealos - 已部署运行
3. [ ] 客服端：搜索查重功能
4. [ ] 客服端：重点客户功能
5. [ ] 客服端：优秀案例库

### 🟢 P2 - 优化功能
1. [ ] 添加错误处理和用户提示
2. [ ] 优化 UI/UX
3. [ ] 性能优化
4. [ ] 清理临时种子数据 API

---

## 💡 关键设计决策

### AI 分析方案（已实现）
- **API**: 云雾接口 (`yunwu.ai`)，OpenAI 兼容格式，模型 `gemini-3.1-flash-preview`
- **音频处理**: 从 OSS 下载音频（签名URL）→ base64 编码 → `data:audio/mp3;base64,...` 内联发送
- **支持格式**: mp3, wav, m4a, ogg, flac（自动识别 MIME 类型）
- **超时**: 音频分析 120 秒，普通文本 30 秒
- **三阶段分析**：
  - Stage 1: 音频转写 + 基础评分（`runStage1Analysis` → `analyzeAudioWithGemini`）
  - 待确认卡片: 从转写文本提取客户信息（`runConfirmCardAnalysis` → `callGemini`）
  - Stage 2: 深度诊断/金牌教练话术优化（`runStage2Analysis` → `callGemini`）
- **状态流转**: `pending` → `processing` → `pending_confirm`（等待客服确认）→ `completed`
- **失败处理**: Stage 1 失败时标记 `isValid: false`，直接 `completed`

### 数据隔离
- **多租户架构**：每个租户数据完全隔离
- **基于租户 ID 的所有查询**

### 客户状态流转
```
pending（待跟进）→ invited（已邀约）→ visited（已到店）→ signed（已签单）
                ↓
              sea（公海）→ invalid（无效公海）
```

### 客户等级（AI 自动判断，客服可调整）
- **S级**：别墅/大户型(180㎡+) + 高预算(30万+) + 明确需求 + 强意向
- **A级**：有明确装修需求 + 预算合理 + 有时间节点
- **B级**：有意向但需求模糊/预算偏低
- **C级**：意向弱/只是问问/没有明确需求
- **无效**：外卖/推销/打错电话/完全不相关/态度恶劣明确拒绝

### 客户画像字段（AI 提取）
| 字段 | key | 说明 |
|------|-----|------|
| 房屋类型 | houseType | 商品房/自建房/别墅/二手房 |
| 房屋用途 | houseUsage | 自住/出租/办公 |
| 房屋现状 | houseState | 毛坯/简装/精装翻新 |
| 家庭成员 | familyMembers | 如"夫妻+1孩" |
| 职业 | profession | 客户职业 |
| 生活习惯 | habits | 特殊需求 |
| 了解程度 | awareness | 小白/百家咨询/有装修经验 |
| 装修定位 | position | 一线品牌/中等品牌/小公司 |
| 预算细节 | budgetDetail | 如"25万全包" |
| 时间节点 | timeline | 如"3个月后交房" |
| 关注点 | focusPoints | 工程质量/工期/价格/材料/设计 |
| 风格偏好 | stylePreference | 现代简约/北欧/新中式等 |

---

## 📞 联系方式
如需帮助，请查看：
- GitHub Issues: `https://github.com/Levinegie/sonar-crm/issues`
- 项目文档: `/Users/duyilin/Downloads/声纳AI客服助手_技术文档.md`

---

**最后备注**: 本文档用于上下文恢复，确保项目进度不会丢失。每次重大进展后请更新此文档。

---

## 📂 关键文件索引

| 文件 | 说明 |
|------|------|
| `src/index.js` | 应用入口，Express 配置，路由挂载 |
| `src/services/ai.js` | AI 分析核心：音频分析、三阶段分析、待确认卡片识别 |
| `src/services/oss.js` | 阿里云 OSS：上传、删除、签名URL、列表 |
| `src/routes/recordings.js` | 录音管理：上传、列表、分析、待确认卡片、确认提交 |
| `src/routes/customers.js` | 客户管理：CRUD、公海、无效公海、抢单、分配 |
| `src/routes/auth.js` | 认证：登录、登出、Token 刷新 |
| `src/routes/stats.js` | 统计：仪表盘、漏斗、趋势、ROI |
| `src/routes/users.js` | 用户管理：客服列表、创建、更新、删除 |
| `src/routes/config.js` | 配置管理：AI 配置、系统配置（部分待修复） |
| `src/middleware/auth.js` | 认证中间件：JWT 验证、租户隔离 |
| `src/utils/helpers.js` | 工具函数：响应格式、分页 |
| `public/agent/index.html` | 客服端前端（~2320行） |
| `public/boss/index.html` | 老板端前端（1866行） |
| `public/admin/index.html` | 管理端前端（737行） |
| `prisma/schema.prisma` | 数据库 schema（382行，15个模型） |
| `.env` | 环境变量（已配置完成） |
| `Dockerfile` | Docker 构建配置 |
| `.github/workflows/docker-build.yml` | CI/CD 自动构建 |
