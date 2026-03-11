# 声纳 CRM - 部署指南

## 方式一：Sealos 云平台部署（推荐，最简单）

### 第一步：注册 Sealos
1. 打开 https://sealos.run
2. 点击「登录/注册」
3. 微信扫码登录

### 第二步：创建数据库
1. 点击「App Launchpad」→「Database」
2. 选择「PostgreSQL」
3. 填写：
   - 名称：sonar-db
   - 用户名：sonar
   - 密码：（自动生成，记下来）
4. 点击「创建」
5. 创建后，复制「连接地址」

### 第三步：部署应用
1. 点击「App Launchpad」
2. 点击「新建应用」
3. 填写：
   - 应用名：sonar-crm
   - 镜像名：先空着（下面有步骤）
   - CPU：0.5 核
   - 内存：512 MB

4. 滚动到「环境变量」，添加：
```
DATABASE_URL=postgresql://sonar:密码@数据库地址:5432/sonar
JWT_SECRET=sonar-crm-2024-abc123
OSS_ACCESS_KEY_ID=你的阿里云Key
OSS_ACCESS_KEY_SECRET=你的阿里云Secret
OSS_BUCKET=rec-upload-hz
OSS_REGION=oss-cn-hangzhou
AI_API_KEY=你的AI API Key
```

### 第四步：上传代码到 GitHub
1. 在 GitHub 创建新仓库 sonar-crm
2. 在本地：
```bash
cd /Users/duyilin/sonar-crm
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/你的用户名/sonar-crm.git
git push -u origin main
```

3. 回到 Sealos，在应用设置里选择「从 GitHub 构建」
4. 选择你的仓库，点击部署

---

## 方式二：本地开发测试

### 1. 安装 PostgreSQL（本地）
```bash
# Mac
brew install postgresql
brew services start postgresql

# 创建数据库
createdb sonar_crm
```

### 2. 配置环境变量
```bash
cd /Users/duyilin/sonar-crm
cp .env.example .env
# 编辑 .env 填入你的配置
```

### 3. 初始化数据库
```bash
npm run db:push
```

### 4. 启动服务
```bash
npm run dev
```

### 5. 访问
打开浏览器 http://localhost:3000

---

## 默认账号

首次部署后，需要手动创建管理员账号。

在 Sealos 的「Terminal」里执行：
```bash
node -e "
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createAdmin() {
  const hash = await bcrypt.hash('admin123', 10);
  await prisma.user.create({
    data: {
      username: 'admin',
      password: hash,
      name: '管理员',
      role: 'admin'
    }
  });
  console.log('管理员创建成功！');
  console.log('用户名: admin');
  console.log('密码: admin123');
}
createAdmin();
"
```

---

## 常见问题

### Q: 数据库连接失败？
A: 检查 DATABASE_URL 格式是否正确

### Q: OSS 上传失败？
A: 检查阿里云 OSS 的 AccessKey 是否正确

### Q: AI 分析失败？
A: 检查 AI API Key 是否正确，API URL 是否能访问

---

需要帮助？联系开发者
