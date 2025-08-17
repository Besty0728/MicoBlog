# Docker 多环境部署说明

## 环境配置对比

### Windows 环境 (混合部署)
使用 `docker-compose.yml` 配置：
- 后端：Docker 容器
- Nginx：宿主机运行
- 数据库：容器内部，通过卷映射持久化

```bash
# Windows 环境启动
docker-compose up -d
```

#### Windows 路径配置：
- 数据库：`d:\data\micoblog\database.db`
- 文件上传：`d:\data\micoblog\uploads\`
- Nginx 日志：`d:\Betsy\blog_github\MicoBlog\docker\nginx\logs\`

### Linux 环境 (完全容器化)
使用 `docker-compose-linux.yml` 配置：
- 后端：Docker 容器
- Nginx：Docker 容器
- 数据库：容器内部，通过卷映射持久化

```bash
# Linux 环境启动
docker-compose -f docker-compose-linux.yml up -d
```

#### Linux 路径配置：
- 数据库：`/var/lib/micoblog/database.db`
- 文件上传：`/var/lib/micoblog/uploads/`
- Nginx 配置：`./nginx/nginx.conf`
- IP 黑名单：`./nginx/blocked_ips.conf`

## 环境变量说明

### 通用环境变量
- `NODE_ENV`: 运行环境 (production/development)
- `PORT`: 应用端口 (默认3000)
- `DB_FILE`: 数据库文件路径

### Windows 特定
- `NGINX_LOG_PATH`: Nginx 日志路径 (用于 IP 监控)
- `NGINX_ACCESS_LOG`: 访问日志文件名

### Linux 特定
- 使用容器内部路径
- Nginx 通过 upstream 连接后端服务

## 网络配置

### Windows 环境
- 后端容器映射到 `127.0.0.1:3000`
- 宿主机 Nginx 代理到容器服务

### Linux 环境
- 内部网络：`micoblog-network`
- Nginx 容器通过服务名访问后端：`micoblog-backend:3000`
- 外部只暴露 80/443 端口

## 数据持久化

### 卷映射策略
```yaml
# Windows
volumes:
  - d:\data\micoblog:/app/data

# Linux  
volumes:
  - /var/lib/micoblog:/app/data
```

## 部署步骤

### 首次部署 (Windows)
1. 确保宿主机 Nginx 已配置
2. 创建数据目录：`mkdir d:\data\micoblog`
3. 启动容器：`docker-compose up -d`
4. 检查服务：`docker-compose ps`

### 首次部署 (Linux)
1. 克隆项目到服务器
2. 进入 docker-deploy 目录
3. 配置 IP 黑名单：编辑 `nginx/blocked_ips.conf`
4. 启动服务：`docker-compose -f docker-compose-linux.yml up -d`
5. 检查服务：`docker-compose -f docker-compose-linux.yml ps`

## 故障排除

### 常见问题
1. **数据库锁定**：检查卷权限和路径是否正确
2. **静态文件 404**：确认 Nginx 配置中的路径映射
3. **IP 监控失效**：检查日志文件路径和权限

### 日志查看
```bash
# Windows 环境
docker-compose logs -f micoblog-backend

# Linux 环境  
docker-compose -f docker-compose-linux.yml logs -f micoblog-backend
docker-compose -f docker-compose-linux.yml logs -f nginx
```

## 升级部署

### 更新应用
```bash
# 停止服务
docker-compose down

# 重新构建镜像
docker-compose build --no-cache

# 启动新版本
docker-compose up -d
```

### 数据备份
```bash
# 备份数据库
docker exec micoblog-backend cp /app/data/database.db /app/data/database.db.backup

# 导出卷数据
docker run --rm -v micoblog-data:/data -v $(pwd):/backup alpine tar czf /backup/micoblog-backup.tar.gz -C /data .
```
确认 `docker-compose.yml` 中的 Nginx 路径与实际安装路径一致。

### 构建失败
确保 Docker Desktop 正常运行，网络连接正常。

## ⚠️ 注意事项

1. **数据隔离**: Docker 版本默认使用独立的数据目录
2. **权限问题**: 在 Windows 上可能需要调整文件夹权限
3. **Nginx 路径**: 请根据实际情况调整 Nginx 挂载路径
4. **端口唯一性**: 确保同时只运行一个版本（Windows 或 Docker）
