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

# 健康检查（每30秒，失败3次才标记 unhealthy）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# 启动脚本（先同步数据库结构再启动应用）
RUN chmod +x start.sh
CMD ["sh", "start.sh"]
