FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装基本工具和构建依赖
RUN apk add --no-cache \
    bash \
    curl \
    python3 \
    make \
    g++ \
    sqlite

# 复制 package.json 和 package-lock.json
COPY backend/package*.json ./

# 安装依赖，但降级 execa 到兼容 CommonJS 的版本
RUN npm ci --only=production --unsafe-perm && \
    npm install execa@5.1.1 --save

# 复制项目根目录文件（包括前端和静态资源）
COPY blogs.html ./
COPY tinymce/ ./tinymce/
COPY images/ ./images/
COPY fonts/ ./fonts/

# 复制后端代码
COPY backend/ ./backend/

# 设置工作目录到 backend（模拟原来的结构）
WORKDIR /app/backend

# 删除可能冲突的 node_modules
RUN rm -rf node_modules

# 重新安装依赖以确保 native 模块正确编译
RUN npm ci --only=production --unsafe-perm && \
    npm install execa@5.1.1 --save

# 创建必要的目录
RUN mkdir -p /app/backend/uploads /app/backend/data

# 设置权限
RUN chown -R node:node /app

# 切换到非 root 用户
USER node

# 暴露端口 3001（与原版本相同）
EXPOSE 3001

# 启动命令（在 backend 目录运行）
CMD ["node", "server.js"]
