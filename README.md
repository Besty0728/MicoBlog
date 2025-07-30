<img width="2549" height="1326" alt="屏幕截图 2025-07-30 021100" src="https://github.com/user-attachments/assets/08c9cd9f-c54c-4bb3-9eae-d5746b943fc6" />
<img width="2553" height="1324" alt="屏幕截图 2025-07-30 021119" src="https://github.com/user-attachments/assets/ad516248-d605-44c2-a590-fc51b6620a40" />
<img width="2559" height="1319" alt="屏幕截图 2025-07-30 020917" src="https://github.com/user-attachments/assets/db6d91cb-6038-4508-bb9f-3038128d957e" />

#  流转星个人博客 - 部署指南

欢迎使用流转星个人博客系统！这是一个功能完善、界面炫酷的前后端分离个人博客。本指南将引导你完成从零到一的完整部署过程。

## ✨ 项目亮点

- **全功能后台**: 提供一个用户友好的Web界面，用于管理所有网站内容，包括项目文章、资源分享、技能列表、个人信息和背景音乐。
- **高度可配置**: 无需修改代码！所有关键配置（如域名、API密钥、Nginx路径）均可在后台的“环境设置”页面中完成。
- **动态访客门户**: 前端页面 (`blogs.html`) 动态从后端加载所有内容，支持暗黑模式、背景音乐播放、文章评论和AI日报展示。
- **集成Cloudflare Turnstile**: 支持三种可配置的安全验证模式（强验证、弱验证、关闭），有效防止机器人滥用。
- **主动式IP安全监控**: 系统能自动监控Nginx日志，发现并标记可疑访问IP，管理员可一键封禁。
- **自动化内容管道**: 内置专用API，可与n8n等自动化工具无缝对接，实现如“AI日报”等内容的自动发布。
- **生产级Nginx集成**: 深度集成Nginx，实现IP黑名单的动态更新与即时生效。

## 🛠️ 技术栈

- **后端**: Node.js, Express.js
- **前端**: 原生 HTML, CSS, JavaScript (无框架)
- **数据库**: SQLite
- **富文本编辑器**: TinyMCE
- **核心依赖**: `cors, bcrypt, jsonwebtoken, multer, chokidar, execa`

## 🚀 部署流程 (Windows 环境)
本指南主要针对 Windows 10/11 或 Windows Server 系统。

### 1. 环境准备
在开始之前，请确保你已经安装了以下软件：

   Node.js

   Nginx

### 2. 获取代码与安装依赖
将本项目Relase下载的zip文件解压到一个你确定的目录。
打开 命令提示符 (cmd)，进入后端目录(backend)并安装依赖：
CMD
例如：cd C:\blog\backend

```bash
npm install
```

安装完成后，在blog目录下手动创建一个名为 uploads 的空文件夹！！！

### 3. 获取安全密钥 (Cloudflare)

   本博客使用 Cloudflare Turnstile 进行人机验证，你需要免费注册一个 Cloudflare 账号并获取密钥。

   登录 Cloudflare 账号，在左侧菜单进入 Turnstile。
   
   点击 Add site，填写你的网站名称，选择你的域名，然后点击 Create。

   在下一个页面，你会看到 Site Key (站点密钥) 和 Secret Key (私钥)。请将这两个值复制下来，稍后会用到。

### 4. 系统初始化配置

1.  **修改前端API地址**:
    *   打开blogs.html文件。
    *   找到文件顶部的 `<script>` 块，修改 `API_BASE_URL` 常量为您后端API的完整地址。
        ```javascript
        // 这是用户部署时唯一需要修改的地方
        const API_BASE_URL = 'https://api.example.com/api'; 
        ```
    
2.  **登录后台并完成配置**:
    *   通过您的后端域名访问后台，例如 `https://api.example.com/admin`。
    *   使用默认凭证登录：
        -   **用户名**: `admin`
        -   **密码**: `admin123`
    *   进入 **“环境设置”** Tab。
    *   **仔细填写所有字段**，特别是：
        -   `后端URL`: `https://api.example.com`
        -   `JWT密钥`: **强烈建议**修改为一个复杂的随机字符串。
        -   `Cloudflare Turnstile` 的 `Site Key` 和 `Secret Key`。
        -   所有 `Nginx 路径`，确保与您服务器上的实际路径完全一致。
    *   点击 **“保存所有设置”**。

3.  **修改管理员密码**:
    *   进入 **“功能设置”** Tab，修改默认的管理员密码。
### 5. 配置并启动 Nginx
在例如C:\nginx\conf 目录下，创建一个名为 blockips.conf 的空文件。这是给后端程序写入黑名单用的。

   用编辑器打开 C:\nginx\conf\nginx.conf 文件，参考示例代码进行修改：
   
```nginx
worker_processes  1;

# Nginx 错误日志路径，必须与后端中的Nginx错误路径一致
error_log  logs/error.log warn; 

events {
    worker_connections  1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile        on;
    keepalive_timeout  65;
    charset       utf-8;

    # --- IP 黑名单配置 ---
    geo $remote_addr $blocked_ip {
        default 0; 
        # 引入黑名单文件，路径必须与后端中的Nginx黑名单路径一致
        include C:/nginx/conf/blockips.conf;
    }
    
    # --- 速率限制 ---
    limit_req_zone $binary_remote_addr zone=loginlimit:10m rate=10r/m;
    limit_req_zone $binary_remote_addr zone=bloglimit:10m rate=20r/m;

    # --- 博客前端 (公开访问) ---
    server {
        listen 80;
        # 【替换】换成你的博客前端域名
        server_name blog.yourdomain.com; 

        # 如果IP在黑名单中，则拒绝访问
        if ($blocked_ip) {
            return 403;
        }
        
        # 应用速率限制
        limit_req zone=bloglimit burst=15 nodelay;

        # 【注意】项目根目录路径，如果你的项目不在 C:/blog，请修改这里
        root   C:/blog;
        index  blogs.html;

        # 代理上传文件的访问路径
        location /uploads {
            # 【注意】指向后端 uploads 目录的绝对路径
            alias C:/blog/backend/uploads; 
            expires 7d;
            add_header Cache-Control "public";
        }

        # 处理前端路由
        location / {
            try_files $uri $uri/ /blogs.html;
        }
        location ~* \.(jpg|jpeg|png|gif|ico|css|js|ttf|woff|woff2)$ {
            expires 7d;
            add_header Cache-Control "public, immutable";
            add_header Vary "Accept-Encoding";
        }

        # --- 音频文件专用配置 ---
        location ~* \.(mp3|flac|ogg|wav|m4a)$ {
            expires 30d;
            add_header Cache-Control "public, immutable";
            add_header Accept-Ranges bytes; # 支持断点续传
        }

        # --- HTML文件配置（包括AI日报页面） ---
        location ~* \.html$ {
            expires 1h;
            add_header Cache-Control "public, must-revalidate";
            try_files $uri $uri/ /blogs.html;
        }
    }

    # --- 博客后端 (管理后台) ---
    server {
        listen 80;
        # 【替换】换成你的博客后端域名
        server_name blog-admin.yourdomain.com;
        client_max_body_size 200M;

        # 如果IP在黑名单中，则拒绝访问
        if ($blocked_ip) {
            return 403;
        }

        # 重定向根路径到 /admin
        location = / {
               return 301 /admin;
        }
        
        # 对登录接口应用速率限制
        location = /api/auth/login {
            limit_req zone=loginlimit burst=5 nodelay;
            proxy_pass http://127.0.0.1:3001;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # 反向代理到 Node.js 服务
        location / {
            proxy_pass http://127.0.0.1:3001; 
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
    # ---如果启用n8n工作流则添加 n8n ---
    server {
        listen 80;
        # 【替换】换成你的n8n实例域名
        server_name yourdomain.com;
        client_max_body_size 100M; # 根据需要调整，n8n工作流可能处理大文件

        # 沿用IP黑名单机制
        if ($blocked_ip) {
              return 403;
        }

        location / {
            # 代理到本地的 n8n 实例
            proxy_pass http://127.0.0.1:5678;

            # --- 以下是代理 WebSocket 和长连接的关键配置 ---
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "Upgrade";

            # --- 传递必要的头部信息 ---
            proxy_set_header Host $host;
            # 传递真实客户端IP
            proxy_set_header X-Real-IP $http_x_forwarded_for;
            proxy_set_header X-Forwarded-For $http_x_forwarded_for;
            # 告知后端应用原始协议是HTTPS（如果前端有SSL）
            proxy_set_header X-Forwarded-Proto https;

            # --- 针对n8n的优化 ---
            # 禁用代理缓冲，对于事件流和长轮询很重要
            proxy_buffering off;
            # 延长超时时间，以防工作流执行时间过长
            proxy_connect_timeout 300s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;
        }
    }
}
```

【替换】 将上面配置中的 blog.yourdomain.com 和 blog-admin.yourdomain.com 以及换成你自己的域名。

默认启用速率限制，你也可以删除与他有关的模块，弃用速率限制。

# 附注：关于 Nginx 配置中的代理头部 (Proxy Headers)

你可能已经注意到，在 Nginx 配置的 location / 块中，有几行 proxy_set_header 的配置。这些配置非常重要，请保持原样。

它们的作用是将真实的访客信息传递给后端 Node.js 服务。

为什么需要它？

因为 Nginx 是一个反向代理（中间人），如果没有这些设置，你的后端应用会认为所有请求都来自服务器自己 (127.0.0.1)。这将导致 IP 黑名单、访问日志等功能完全失效。

它们做了什么？

X-Real-IP 和 X-Forwarded-For：将真实的访客 IP 地址告诉后端。

X-Forwarded-Proto：将访客使用的协议（http 或 https）告诉后端，这对于正确生成链接至关重要。

结论：你需要自定义配置你域名的（自定义头部携带客户端 IP 信息回源站），例如我使用的EdgeOne“客户端IP头部”，将名称设置为“X-Forwarded-For”

你不需要修改这些行。我们提供的 Nginx 配置已经为你正确设置好了，以确保所有功能正常工作。

打开命令提示符(cmd)，启动 Nginx：

CMD
cd C:\nginx
nginx -t      # 测试配置是否正确，必须显示ok以及successful
start nginx   # 启动 Nginx 服务

### 6. 启动后端服务
回到 C:\blog\backend 目录的命令提示符窗口。
启动后端服务：
CMD
node server.js
看到 服务器运行在 http://localhost:3001 等提示即表示成功。此窗口需要保持打开。（建议以管理员运行，或者给进程给予修改nginx黑名单文件的权限等）

### 7. 🚨 完成与安全设置
防火墙设置:

打开 Windows Defender 防火墙 -> 高级设置 -> 入站规则 -> 新建规则。

选择 "端口"，协议 "TCP"，特定本地端口 "80"，允许连接。

命名为 "Nginx HTTP" 并保存。

访问网站:

前端博客: http://blog.yourdomain.com

后台管理: http://blog-admin.yourdomain.com/admin

首次登录与修改密码:

默认用户名: admin

默认密码: admin123

## 在评论区启用博主特殊评论，在邮箱输入你的后台管理密码即可

### 8.如果启用AI早报(配合n8n)
请参照我们的处理格式
<img width="1423" height="559" alt="屏幕截图 2025-07-30 030051" src="https://github.com/user-attachments/assets/a58124e1-7ba7-46e5-a3a9-984715c93b43" />
<img width="2527" height="1255" alt="屏幕截图 2025-07-30 025759" src="https://github.com/user-attachments/assets/89f09a26-4ccc-45de-b189-f70cff6410c6" />
```javascript
// 从上一节点获取AI生成的内容
const aiContent = $input.first().json.output;

// 智能提取摘要函数
function extractSummary(content) {
  // 去除HTML标签
  let cleanText = content.replace(/<[^>]*>/g, '').trim();
  
  // 去除多余的换行和空格
  cleanText = cleanText.replace(/\s+/g, ' ');
  
  // 按句号分割句子
  const sentences = cleanText.split(/[。！？.!?]/);
  
  // 取前1-2个句子作为摘要
  let summary = sentences[0];
  if (summary.length < 50 && sentences[1]) {
    summary += '。' + sentences[1];
  }
  
  // 确保摘要长度不超过150字符
  if (summary.length > 150) {
    summary = summary.substring(0, 147) + '...';
  }
  
  // 如果摘要太短，使用默认摘要
  if (summary.length < 20) {
    summary = '今日AI行业重要动态汇总，包含最新技术进展和产品发布信息';
  }
  
  return summary;
}

// 计算亮点数量函数
function countHighlights(content) {
  // 统计特殊标记emoji的数量
  const emojiMarkers = content.match(/🌟|📊|🔬|💡|🚀|⭐|🔥|📈|⚡|🎯/g) || [];
  
  // 统计h3标题数量（通常代表不同类别）
  const h3Tags = content.match(/<h3[^>]*>/g) || [];
  
  // 统计news-item数量
  const newsItems = content.match(/news-item/g) || [];
  
  // 取最大值，但至少为1，最多为10
  const maxCount = Math.max(
    emojiMarkers.length,
    h3Tags.length,
    Math.floor(newsItems.length / 2)
  );
  
  return Math.min(Math.max(1, maxCount), 10);
}

// 生成格式化的日期和标题
function generateDateAndTitle() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  
  const reportDate = `${year}-${month}-${day}`;
  const title = `${year}年${month}月${day}日 AI日报`;
  
  return { reportDate, title };
}

// 验证和清理内容
function validateContent(content) {
  if (!content || content.trim().length < 50) {
    throw new Error('AI生成的内容太短，无法创建日报');
  }
  
  // 确保内容包含基本的HTML结构
  if (!content.includes('<div') && !content.includes('<h3')) {
    // 如果没有HTML结构，添加基本包装
    return `<div class="ai-report-content">
      <h3>🌟 今日AI亮点</h3>
      <div class="news-item">
        <p>${content}</p>
      </div>
    </div>`;
  }
  
  return content;
}

try {
  // 验证输入数据
  if (!aiContent) {
    throw new Error('未找到AI生成的内容');
  }
  
  // 清理和验证内容
  const cleanedContent = validateContent(aiContent);
  
  // 生成日期和标题
  const { reportDate, title } = generateDateAndTitle();
  
  // 提取摘要
  const summary = extractSummary(cleanedContent);
  
  // 计算亮点数量
  const highlightsCount = countHighlights(cleanedContent);
  
  // 返回格式化的请求体数据
  return [{
    json: {
      requestBody: {
        title: title,
        content: cleanedContent,
        summary: summary,
        report_date: reportDate,
        highlights_count: highlightsCount
      },
      // 添加调试信息
      debug: {
        originalContentLength: aiContent.length,
        summaryLength: summary.length,
        highlightsCount: highlightsCount,
        reportDate: reportDate
      }
    }
  }];
  
} catch (error) {
  // 错误处理
  console.error('处理AI日报数据时出错:', error.message);
  
  return [{
    json: {
      error: true,
      message: error.message,
      // 提供备用数据
      requestBody: {
        title: new Date().toISOString().split('T')[0] + ' AI日报（自动生成）',
        content: aiContent || '<div class="ai-report-content"><p>内容生成失败</p></div>',
        summary: '今日AI行业动态汇总',
        report_date: new Date().toISOString().split('T')[0],
        highlights_count: 1
      }
    }
  }];
}
```
<img width="961" height="1210" alt="屏幕截图 2025-07-30 030202" src="https://github.com/user-attachments/assets/c7c7b596-72b2-40ef-b5b1-4189b9eaba18" />
<img width="932" height="1099" alt="屏幕截图 2025-07-30 030211" src="https://github.com/user-attachments/assets/d72a9432-7f69-4123-94ca-e7cd8cc66bf7" />

```json
{
  "Content-Type": "application/json; charset=utf-8",
  "User-Agent": "n8n-ai-report-bot/1.0"
}
```

## 📝 注意事项

- **安全**: 首次部署后，请务必修改默认的管理员密码和JWT密钥。
- **备份**: 定期备份 `backend/database.db` 文件，它包含了您所有的数据。
- **Nginx路径**: 如果您在Windows上部署，请确保路径格式正确，例如 `C:/nginx/conf/blockips.conf`。
- **CORS**: 如果您决定将前端和后端部署在不同的主域名下（非子域名），您可能需要在 `server.js` 中调整CORS配置。

(可选) 使用 PM2 实现服务持久化（但我没试过）
