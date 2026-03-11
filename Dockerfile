FROM node:20-alpine

WORKDIR /app

# 安装 OpenSSL（Prisma 需要）
RUN apk add --no-cache openssl

# 安装依赖
COPY package*.json ./
RUN npm install

# 复制代码
COPY . .

# 生成 Prisma 客户端
RUN npx prisma generate

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "src/index.js"]
