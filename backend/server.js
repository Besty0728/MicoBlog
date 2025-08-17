console.log(`[PROOF] Server process started with latest code at: ${new Date().toISOString()}`);
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');

const chokidar = require('chokidar');
const readLastLines = require('read-last-lines');
let ipMonitoringWatcher = null;
let isIpMonitoringEnabled = true;
const app = express();
const { execa } = require('execa');

let AppConfig = {
    PORT: process.env.PORT || 3001,
    DB_FILE: process.env.DB_FILE || 'database.db',// 数据库文件名
    JWT_SECRET: process.env.JWT_SECRET || 'default-weak-secret-for-initial-login-please-change-me',// 默认JWT密钥
    BACKEND_URL: process.env.BACKEND_URL || '',
    CLOUDFLARE_SITE_KEY: process.env.CLOUDFLARE_SITE_KEY || '',
    CLOUDFLARE_SECRET_KEY: process.env.CLOUDFLARE_SECRET_KEY || '',
    NGINX_ERROR_LOG_PATH: process.env.NGINX_ERROR_LOG_PATH || '/nginx/logs/error.log',
    NGINX_BLOCK_IP_FILE: process.env.NGINX_BLOCK_IP_FILE || '/nginx/conf/blocked_ips.conf',
    NGINX_EXE_PATH: process.env.NGINX_EXE_PATH || '/usr/sbin/nginx',
    NGINX_CWD: process.env.NGINX_CWD || '/nginx/conf',
    AI_REPORTS_API_KEY: process.env.AI_REPORTS_API_KEY || 'ai-report-2025-secret-key-9527' // AI日报API密钥
};

// 从数据库加载配置的函数
async function loadConfigFromDb() {
    return new Promise((resolve, reject) => {
        db.all('SELECT key, value FROM configurations', (err, rows) => {
            if (err) {
                console.error('[Config] Error loading from DB:', err);
                return resolve(); // 出错时继续使用默认配置
            }
            if (rows) {
                const dbConfig = {};
                rows.forEach(row => {
                    if (row.value) { // 只加载非空的值
                        dbConfig[row.key] = row.value;
                    }
                });
                // 将数据库配置合并到全局配置，数据库的值会覆盖默认值
                AppConfig = { ...AppConfig, ...dbConfig };
                console.log('[Config] Configuration loaded from database.');
            }
            // 确保 PORT 是数字
            AppConfig.PORT = parseInt(AppConfig.PORT, 10) || 3001;
            resolve();
        });
    });
}
// 中间件配置
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// 设置所有响应的字符编码
app.use((req, res, next) => {
    res.charset = 'utf-8';
    next();
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, '..')));
app.use('/admin', express.static(__dirname));
app.use('/tinymce', express.static(path.join(__dirname, '..', 'tinymce')));

// 创建上传目录
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// 数据库初始化
const db = new sqlite3.Database('database.db');
db.run("PRAGMA encoding = 'UTF-8'");
db.run("PRAGMA foreign_keys = ON;");

// 创建表
db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 项目表
    db.run(`CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        category TEXT,
        excerpt TEXT,
        content TEXT,
        views INTEGER DEFAULT 0,
        comments INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 使用 try-catch 避免在字段已存在时重启服务器出错
    db.run("ALTER TABLE projects ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP", (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error("Failed to add updated_at column to projects:", err);
        } else {
            console.log("Column 'updated_at' in projects table checked/added.");
        }
    });

    // 设置表
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        bgm_url TEXT,
        bgm_name TEXT,
        profile_name TEXT,
        profile_role TEXT,
        profile_motto TEXT,
        profile_location TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 网站表
    db.run(`CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT,
        description TEXT,
        icon TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 资源表
    db.run(`CREATE TABLE IF NOT EXISTS resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT,
        description TEXT,
        icon TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 技能表
    db.run(`CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        display_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 创建配置表
    db.run(`CREATE TABLE IF NOT EXISTS configurations (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT,
        description TEXT,
        is_secret INTEGER DEFAULT 0, -- 标记是否为敏感信息
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 初始化管理员账户
    const adminPassword = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT OR IGNORE INTO users (username, password) VALUES ('admin', ?)`, [adminPassword]);

    // 初始化设置
    db.run(`INSERT OR IGNORE INTO settings (id, profile_name, profile_role, profile_motto, profile_location) 
            VALUES (1, '流转星', 'Unity个人开发者', '爱我宝宝，用心去对待事情', '中国山东')`);

    // 只在技能表为空时初始化默认技能
    db.get('SELECT COUNT(*) as count FROM skills', (err, row) => {
        if (!err && row.count === 0) {
            const defaultSkills = ['C#', 'Node.js', 'Python', 'Git', 'Linux', 'Docker', 'Web'];
            const stmt = db.prepare('INSERT INTO skills (name, display_order) VALUES (?, ?)');
            defaultSkills.forEach((skill, index) => {
                stmt.run(skill, index);
            });
            stmt.finalize();
            console.log('Default skills initialized');
        }
    });
    // 评论表，is_owner 字段用于标记评论是否为项目所有者发布
    db.run(`CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            nickname TEXT NOT NULL,
            email TEXT,
            content TEXT NOT NULL,
            ip_address TEXT NOT NULL,
            user_agent TEXT,
            status INTEGER DEFAULT 1,
            is_owner INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);
    // IP封禁表
    db.run(`CREATE TABLE IF NOT EXISTS banned_ips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address TEXT UNIQUE NOT NULL,
            reason TEXT,
            banned_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS suspicious_ips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address TEXT UNIQUE NOT NULL,
            reason TEXT,
            hit_count INTEGER DEFAULT 1,
            first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'pending' -- pending, banned, ignored
    )`);
    // ---添加 Turnstile 开关字段 ---
    // 使用 try-catch 避免在字段已存在时重启服务器出错
    db.run("ALTER TABLE projects ADD COLUMN updated_at DATETIME", (err) => {
        if (err) {
            // 如果错误是“列已存在”，则忽略，这是正常情况。
            if (!err.message.includes('duplicate column name')) {
                console.error("向 projects 表添加 updated_at 列时出错:", err.message);
            }
        } else {
            // 如果列是刚刚成功添加的，说明它之前不存在。
            // 为所有现有行填充初始值（使用创建时间作为默认更新时间）。
            console.log("成功添加 updated_at 列，正在为现有数据填充默认值...");
            db.run("UPDATE projects SET updated_at = created_at WHERE updated_at IS NULL", (updateErr) => {
                if (updateErr) {
                    console.error("填充 updated_at 列时出错:", updateErr.message);
                } else {
                    console.log("成功为现有项目填充了 updated_at 值。");
                }
            });
        }
    });
    // AI日报表
    db.run(`CREATE TABLE IF NOT EXISTS ai_daily_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        report_date DATE NOT NULL UNIQUE,
        highlights_count INTEGER DEFAULT 0,
        status INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run("ALTER TABLE settings ADD COLUMN ai_reports_enabled INTEGER DEFAULT 1", (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error("添加 ai_reports_enabled 字段失败:", err);
        }
    });

    db.run("ALTER TABLE settings ADD COLUMN ip_monitoring_enabled INTEGER DEFAULT 1", (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error("添加 ip_monitoring_enabled 字段失败:", err);
        }
    });

    db.run("ALTER TABLE settings ADD COLUMN turnstile_validation_mode INTEGER DEFAULT 2", (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error("添加 turnstile_validation_mode 字段失败:", err);
        } else {
            console.log("验证模式字段检查完成");
        }
    });

    db.run("ALTER TABLE settings ADD COLUMN background_mode TEXT DEFAULT 'default'", (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error("添加 background_mode 字段失败:", err);
        }
    });

    db.run("ALTER TABLE settings ADD COLUMN local_background_list TEXT", (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error("添加 local_background_list 字段失败:", err);
        }
    });

    db.run("ALTER TABLE settings ADD COLUMN random_background_api_url TEXT", (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error("添加 random_background_api_url 字段失败:", err);
        }
    });
    db.run("ALTER TABLE settings ADD COLUMN default_background_image TEXT", (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error("添加 default_background_image 字段失败:", err);
        }
    });
});

// 文件上传配置 - 保留原始文件名信息
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        // 保留原始文件信息
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ext = path.extname(originalName);
        const nameWithoutExt = path.basename(originalName, ext);

        // 创建唯一但可读的文件名
        const timestamp = Date.now();
        const safeFileName = `${timestamp}_${nameWithoutExt.substring(0, 50)}${ext}`;

        cb(null, safeFileName);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 200 * 1024 * 1024, // 200MB
        fieldSize: 200 * 1024 * 1024,
        files: 1,
        parts: 10
    },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'audio/mpeg',
            'audio/mp3',
            'audio/flac',
            'audio/ogg',
            'audio/wav',
            'audio/x-flac',
            'audio/x-wav',
            'audio/x-m4a',
            'audio/mp4'
        ];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的音频格式'));
        }
    }
});

const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const imagesUploadDir = path.join(__dirname, 'uploads', 'images');
        if (!fs.existsSync(imagesUploadDir)) {
            fs.mkdirSync(imagesUploadDir, { recursive: true });
        }
        cb(null, imagesUploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'image-' + uniqueSuffix + ext);
    }
});

const uploadImage = multer({
    storage: imageStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的图片格式'), false);
        }
    }
});

// 认证中间件 - 添加调试信息
function authMiddleware(req, res, next) {
    const authHeader = req.header('Authorization');
    //console.log('收到的Authorization header:', authHeader);

    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
        console.log('没有找到token');
        return res.status(401).json({ message: '未授权 - 缺少token' });
    }

    try {
        const decoded = jwt.verify(token, AppConfig.JWT_SECRET);
        console.log('Token验证成功，用户ID:', decoded.id);
        req.userId = decoded.id;
        next();
    } catch (error) {
        console.log('Token验证失败:', error.message);
        res.status(401).json({ message: '无效的token - ' + error.message });
    }
}

// 根路径
app.get('/', (req, res) => {
    res.send(`
        <h1>博客后端服务运行中</h1>
        <p>管理后台地址: <a href="/admin">/admin</a></p>
        <p>API文档:</p>
        <ul>
            <li>GET /api/settings - 获取设置</li>
            <li>GET /api/projects - 获取项目列表</li>
            <li>POST /api/auth/login - 登录</li>
        </ul>
    `);
});

// API 根路径
app.get('/api', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
        message: 'Blog API v1.0',
        endpoints: {
            auth: '/api/auth/login',
            settings: '/api/settings',
            projects: '/api/projects',
            sites: '/api/sites',
            resources: '/api/resources',
            skills: '/api/skills'
        }
    });
});

// --- 入口验证API ---
app.post('/api/verify-entry', async (req, res) => {
    //console.log('[验证入口] 收到验证请求');

    // 获取验证模式设置
    db.get('SELECT turnstile_validation_mode FROM settings WHERE id = 1', async (err, settings) => {
        if (err) {
            console.error('[验证入口] 读取设置失败:', err);
            return res.status(500).json({ success: false, message: '无法读取服务器设置' });
        }

        // 确保验证模式是整数类型
        const validationMode = parseInt(settings?.turnstile_validation_mode ?? 2);
        //console.log('[验证入口] 当前验证模式:', validationMode);

        // 0: 关闭验证 - 直接通过
        if (validationMode === 0) {
            //console.log('[验证入口] 验证已关闭，直接通过');
            return res.json({
                success: true,
                message: '验证已通过（验证已关闭）',
                mode: 'disabled',
                modeValue: validationMode
            });
        }

        // 1: 弱验证 - 只要有token就通过，不验证Secret Key
        if (validationMode === 1) {
            const turnstileToken = req.body['cf-turnstile-response'];
            //console.log('[验证入口] 弱验证模式，检查token存在性');

            if (!turnstileToken) {
                return res.status(400).json({
                    success: false,
                    message: '缺少验证信息',
                    mode: 'weak',
                    modeValue: validationMode
                });
            }
            return res.json({
                success: true,
                message: '弱验证通过',
                mode: 'weak',
                modeValue: validationMode
            });
        }

        // 2: 强验证 - 使用Secret Key验证
        //console.log('[验证入口] 强验证模式');
        const turnstileToken = req.body['cf-turnstile-response'];
        const ip = getRealIP(req);

        if (!turnstileToken) {
            return res.status(400).json({
                success: false,
                message: '缺少验证信息',
                mode: 'strong',
                modeValue: validationMode
            });
        }

        try {
            const secretKey = AppConfig.CLOUDFLARE_SECRET_KEY;
            if (!secretKey) {
                console.warn('[验证入口] Cloudflare Secret Key 未配置，强验证将失败。');
                return res.status(500).json({ success: false, message: '服务器未配置验证密钥' });
            }

            const formData = new URLSearchParams();
            formData.append('secret', secretKey);
            formData.append('response', turnstileToken);
            formData.append('remoteip', ip);

            const turnstileResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                method: 'POST',
                body: formData,
            });

            const outcome = await turnstileResponse.json();
            //console.log('[验证入口] Cloudflare验证结果:', outcome.success);

            if (outcome.success) {
                res.json({
                    success: true,
                    message: '强验证成功',
                    mode: 'strong',
                    modeValue: validationMode
                });
            } else {
                console.warn('[验证入口] 强验证失败:', outcome['error-codes']);
                res.status(403).json({
                    success: false,
                    message: '强验证失败',
                    mode: 'strong',
                    modeValue: validationMode,
                    errors: outcome['error-codes']
                });
            }
        } catch (error) {
            console.error('[验证入口] 强验证错误:', error);
            res.status(500).json({
                success: false,
                message: '验证服务出错',
                mode: 'strong',
                modeValue: validationMode
            });
        }
    });
});

// 图片上传接口
app.post('/api/upload/image', authMiddleware, uploadImage.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: '没有上传图片文件' });
    }
    // 返回图片的完整访问路径
    const imageUrl = `${AppConfig.BACKEND_URL}/uploads/images/${req.file.filename}`;
    res.json({ message: '图片上传成功', imageUrl: imageUrl });
});

// 登录
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err || !user) {
            return res.status(400).json({ message: '用户名或密码错误' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ message: '用户名或密码错误' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, AppConfig.JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username } });
    });
});

// 修改密码
app.put('/api/auth/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: '请填写所有字段' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: '新密码至少需要6个字符' });
        }

        db.get('SELECT * FROM users WHERE id = ?', [req.userId], async (err, user) => {
            if (err || !user) {
                return res.status(400).json({ message: '用户不存在' });
            }

            const validPassword = await bcrypt.compare(currentPassword, user.password);
            if (!validPassword) {
                return res.status(400).json({ message: '当前密码错误' });
            }

            const hashedPassword = await bcrypt.hash(newPassword, 10);

            db.run('UPDATE users SET password = ? WHERE id = ?',
                [hashedPassword, req.userId],
                (err) => {
                    if (err) {
                        return res.status(500).json({ message: '密码更新失败' });
                    }
                    res.json({ message: '密码修改成功' });
                });
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// 获取设置
app.get('/api/settings', (req, res) => {
    // 从旧的 settings 表中读取个人信息等
    db.get('SELECT * FROM settings WHERE id = 1', (err, legacySettings) => {
        if (err) {
            console.error('Error fetching from settings table:', err);
            return res.status(500).json({ message: '获取设置失败' });
        }

        // 将内存中的 AppConfig (包含环境配置) 
        // 和从数据库读出的 legacySettings (包含个人信息) 合并
        const combinedSettings = {
            ...AppConfig,
            ...(legacySettings || {})
        };

        // console.log('Returning combined settings, Site Key is:', combinedSettings.CLOUDFLARE_SITE_KEY);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(combinedSettings);
    });
});

// 更新设置
app.put('/api/settings', authMiddleware, (req, res) => {
    //console.log('[设置更新] 收到请求体:', req.body);

    const {
        profile_name,
        profile_role,
        profile_motto,
        profile_location,
        turnstile_validation_mode,
        ai_reports_enabled,
        ip_monitoring_enabled,
        background_mode,
        random_background_api_url,
        local_background_list,
        default_background_image
    } = req.body;

    // 首先检查settings表是否存在记录
    db.get('SELECT * FROM settings WHERE id = 1', (err, settings) => {
        if (err) {
            console.error('[设置更新] 查询失败:', err);
            return res.status(500).json({ message: '查询设置失败' });
        }

        if (!settings) {
            console.log('[设置更新] 设置记录不存在，创建新记录');
            // 如果不存在，先创建一条记录
            db.run(`INSERT INTO settings (id, profile_name, profile_role, profile_motto, profile_location) 
                    VALUES (1, '流转星', 'Unity个人开发者', '爱我宝宝，用心去对待事情', '中国山东')`,
                (insertErr) => {
                    if (insertErr) {
                        console.error('[设置更新] 创建记录失败:', insertErr);
                        return res.status(500).json({ message: '创建设置记录失败' });
                    }
                    // 创建成功后继续更新
                    performUpdate();
                });
        } else {
            // 记录存在，直接更新
            performUpdate();
        }
    });

    function performUpdate() {
        // 构建动态的SQL语句和参数数组
        const fieldsToUpdate = [];
        const params = [];

        if (profile_name !== undefined) {
            fieldsToUpdate.push('profile_name = ?');
            params.push(profile_name);
        }
        if (profile_role !== undefined) {
            fieldsToUpdate.push('profile_role = ?');
            params.push(profile_role);
        }
        if (profile_motto !== undefined) {
            fieldsToUpdate.push('profile_motto = ?');
            params.push(profile_motto);
        }
        if (profile_location !== undefined) {
            fieldsToUpdate.push('profile_location = ?');
            params.push(profile_location);
        }

        // 特别处理验证模式
        if (turnstile_validation_mode !== undefined) {
            const modeInt = parseInt(turnstile_validation_mode);
            //console.log('[设置更新] 验证模式转换:', turnstile_validation_mode, '->', modeInt);
            if (!isNaN(modeInt) && modeInt >= 0 && modeInt <= 2) {
                fieldsToUpdate.push('turnstile_validation_mode = ?');
                params.push(modeInt);
            }
        }

        if (ai_reports_enabled !== undefined) {
            fieldsToUpdate.push('ai_reports_enabled = ?');
            params.push(parseInt(ai_reports_enabled) || 0);
        }

        if (ip_monitoring_enabled !== undefined) {
            fieldsToUpdate.push('ip_monitoring_enabled = ?');
            params.push(parseInt(ip_monitoring_enabled) || 0);
        }

        // --- 随机背景图的更新逻辑 ---
        if (background_mode !== undefined) { fieldsToUpdate.push('background_mode = ?'); params.push(background_mode); }
        if (random_background_api_url !== undefined) { fieldsToUpdate.push('random_background_api_url = ?'); params.push(random_background_api_url); }
        if (local_background_list !== undefined) {
            // 确保传入的是字符串
            const listString = Array.isArray(local_background_list) ? JSON.stringify(local_background_list) : '[]';
            fieldsToUpdate.push('local_background_list = ?');
            params.push(listString);
        }

        if (default_background_image !== undefined) {
            fieldsToUpdate.push('default_background_image = ?');
            params.push(default_background_image);
        }

        if (fieldsToUpdate.length === 0) {
            return res.json({ message: '没有需要更新的字段' });
        }

        // 时间戳更新
        fieldsToUpdate.push('updated_at = CURRENT_TIMESTAMP');

        const sql = `UPDATE settings SET ${fieldsToUpdate.join(', ')} WHERE id = 1`;
        //console.log('[设置更新] SQL:', sql);
        //console.log('[设置更新] 参数:', params);

        db.run(sql, params, function (err) {
            if (err) {
                console.error('[设置更新] 数据库更新失败:', err);
                return res.status(500).json({ message: '数据库更新失败: ' + err.message });
            }

            //console.log('[设置更新] 影响行数:', this.changes);

            // 验证更新结果
            db.get('SELECT * FROM settings WHERE id = 1', (verifyErr, updatedSettings) => {
                if (verifyErr) {
                    console.error('[设置更新] 验证失败:', verifyErr);
                } else {
                    //console.log('[设置更新] 更新后的设置:', updatedSettings);
                    //console.log('[设置更新] 验证模式最终值:', updatedSettings.turnstile_validation_mode);
                }
            });

            // 更新成功后，同步IP监控状态
            if (ip_monitoring_enabled !== undefined) {
                setTimeout(() => {
                    updateIpMonitoringStatus();
                }, 100);
            }

            res.json({ message: '设置更新成功' });
        });
    }
});

// 上传背景音乐
app.post('/api/settings/bgm', authMiddleware, (req, res) => {
    upload.single('bgm')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ message: '文件太大，请选择小于200MB的文件' });
            }
            return res.status(400).json({ message: '上传错误: ' + err.message });
        } else if (err) {
            console.error('Upload error:', err);
            return res.status(400).json({ message: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ message: '没有上传文件' });
        }

        const bgmUrl = `/uploads/${req.file.filename}`;
        // 正确处理中文文件名
        const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        const bgmName = req.body.bgmName || originalName;

        console.log('Uploaded file:', {
            filename: req.file.filename,
            originalname: originalName,
            bgmName: bgmName,
            size: req.file.size
        });

        db.run('UPDATE settings SET bgm_url = ?, bgm_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
            [bgmUrl, bgmName],
            (err) => {
                if (err) {
                    console.error('Database update error:', err);
                    return res.status(500).json({ message: '更新失败' });
                }
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.json({
                    bgmUrl,
                    bgmName,
                    fileSize: (req.file.size / 1024 / 1024).toFixed(2) + 'MB',
                    message: '音乐上传成功'
                });
            });
    });
});

//获取本地图片列表
app.get('/api/admin/local-images', authMiddleware, (req, res) => {
    const imagesDir = path.join(__dirname, '..', 'images');
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

    fs.readdir(imagesDir, (err, files) => {
        if (err) {
            console.error('读取 /images 目录失败:', err);
            return res.status(500).json({ message: '无法读取图片目录' });
        }

        const imageFiles = files.filter(file => {
            return allowedExtensions.includes(path.extname(file).toLowerCase());
        });

        res.json(imageFiles);
    });
});

// 公开的背景获取接口
app.get('/api/backgrounds', (req, res) => {
    db.get('SELECT background_mode, random_background_api_url, local_background_list, default_background_image FROM settings WHERE id = 1', (err, settings) => {
        if (err || !settings) {
            return res.json({ mode: 'default', url: null }); // 默认情况
        }

        const { background_mode, random_background_api_url, local_background_list, default_background_image } = settings;

        if (background_mode === 'random_api' && random_background_api_url) {
            return res.json({ mode: 'api', url: random_background_api_url });
        }

        if (background_mode === 'random_local' && local_background_list) {
            try {
                const imageList = JSON.parse(local_background_list);
                if (imageList && imageList.length > 0) {
                    const randomImage = imageList[Math.floor(Math.random() * imageList.length)];
                    return res.json({ mode: 'local', url: `/images/${randomImage}` });
                }
            } catch (e) { /* 忽略错误，降级处理 */ }
        }

        // --- 自定义的默认背景 ---
        if (background_mode === 'default' && default_background_image) {
            return res.json({ mode: 'default_custom', url: `/images/${default_background_image}` });
        }

        // 所有其他情况，都返回真正的默认模式（使用CSS中的背景）
        return res.json({ mode: 'default', url: null });
    });
});

// 获取所有项目
app.get('/api/projects', (req, res) => {
    db.all('SELECT * FROM projects ORDER BY created_at DESC', (err, projects) => {
        if (err) {
            return res.status(500).json({ message: '获取项目失败' });
        }
        const formattedProjects = projects.map(p => ({
            ...p,
            created_at: new Date(p.created_at + 'Z').toISOString(),
            updated_at: p.updated_at ? new Date(p.updated_at + 'Z').toISOString() : null
        }));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(formattedProjects);
    });
});

// 获取单个项目
app.get('/api/projects/:id', (req, res) => {
    db.get('SELECT * FROM projects WHERE id = ?', [req.params.id], (err, project) => {
        if (err) {
            return res.status(500).json({ message: '获取项目失败' });
        }
        if (!project) {
            return res.status(404).json({ message: '项目不存在' });
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(project);
    });
});

// 创建项目
app.post('/api/projects', authMiddleware, (req, res) => {
    const { title, category, excerpt, content } = req.body;

    if (!title || !category || !excerpt || !content) {
        return res.status(400).json({ message: '请填写所有必填字段' });
    }

    db.run('INSERT INTO projects (title, category, excerpt, content) VALUES (?, ?, ?, ?)',
        [title, category, excerpt, content],
        function (err) {
            if (err) {
                return res.status(500).json({ message: '创建失败' });
            }
            res.json({ id: this.lastID, message: '创建成功' });
        });
});

// 增加项目浏览量（不需要认证）
app.post('/api/projects/:id/view', (req, res) => {
    const projectId = req.params.id;

    db.run('UPDATE projects SET views = views + 1 WHERE id = ?', [projectId], (err) => {
        if (err) {
            return res.status(500).json({ message: '更新浏览量失败' });
        }

        // 返回更新后的浏览量
        db.get('SELECT views FROM projects WHERE id = ?', [projectId], (err, row) => {
            if (err) {
                return res.status(500).json({ message: '获取浏览量失败' });
            }
            res.json({ views: row ? row.views : 0 });
        });
    });
});

// 更新项目
app.put('/api/projects/:id', authMiddleware, (req, res) => {
    const { title, category, excerpt, content } = req.body;

    if (!title || !category || !excerpt || !content) {
        return res.status(400).json({ message: '请填写所有必填字段' });
    }

    db.run(`UPDATE projects SET 
            title = ?,
            category = ?,
            excerpt = ?,
            content = ?,
            updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
        [title, category, excerpt, content, req.params.id],
        function (err) {
            if (err) {
                return res.status(500).json({ message: '更新失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ message: '未找到要更新的项目' });
            }
            res.json({ message: '项目更新成功' });
        });
});

// 删除项目
app.delete('/api/projects/:id', authMiddleware, (req, res) => {
    db.run('DELETE FROM projects WHERE id = ?', [req.params.id], (err) => {
        if (err) {
            return res.status(500).json({ message: '删除失败' });
        }
        res.json({ message: '删除成功' });
    });
});

// 获取所有网站
app.get('/api/sites', (req, res) => {
    db.all('SELECT * FROM sites ORDER BY created_at DESC', (err, sites) => {
        if (err) {
            return res.status(500).json({ message: '获取网站失败' });
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(sites);
    });
});

// 添加网站
app.post('/api/sites', authMiddleware, (req, res) => {
    const { name, url, description, icon } = req.body;

    if (!name || !url || !description || !icon) {
        return res.status(400).json({ message: '请填写所有字段' });
    }

    db.run('INSERT INTO sites (name, url, description, icon) VALUES (?, ?, ?, ?)',
        [name, url, description, icon],
        function (err) {
            if (err) {
                return res.status(500).json({ message: '添加失败' });
            }
            res.json({ id: this.lastID, message: '添加成功' });
        });
});

// 删除网站
app.delete('/api/sites/:id', authMiddleware, (req, res) => {
    db.run('DELETE FROM sites WHERE id = ?', [req.params.id], (err) => {
        if (err) {
            return res.status(500).json({ message: '删除失败' });
        }
        res.json({ message: '删除成功' });
    });
});

// 获取所有资源
app.get('/api/resources', (req, res) => {
    db.all('SELECT * FROM resources ORDER BY created_at DESC', (err, resources) => {
        if (err) {
            return res.status(500).json({ message: '获取资源失败' });
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(resources);
    });
});

// 添加资源
app.post('/api/resources', authMiddleware, (req, res) => {
    const { name, url, description, icon } = req.body;

    if (!name || !url || !description || !icon) {
        return res.status(400).json({ message: '请填写所有字段' });
    }

    db.run('INSERT INTO resources (name, url, description, icon) VALUES (?, ?, ?, ?)',
        [name, url, description, icon],
        function (err) {
            if (err) {
                return res.status(500).json({ message: '添加失败' });
            }
            res.json({ id: this.lastID, message: '添加成功' });
        });
});

// 删除资源
app.delete('/api/resources/:id', authMiddleware, (req, res) => {
    db.run('DELETE FROM resources WHERE id = ?', [req.params.id], (err) => {
        if (err) {
            return res.status(500).json({ message: '删除失败' });
        }
        res.json({ message: '删除成功' });
    });
});

// 获取所有技能
app.get('/api/skills', (req, res) => {
    db.all('SELECT * FROM skills ORDER BY display_order, created_at', (err, skills) => {
        if (err) {
            return res.status(500).json({ message: '获取技能失败' });
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(skills);
    });
});

// 添加技能
app.post('/api/skills', authMiddleware, (req, res) => {
    const { name } = req.body;

    if (!name) {
        return res.status(400).json({ message: '请输入技能名称' });
    }

    db.run('INSERT INTO skills (name) VALUES (?)', [name], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ message: '该技能已存在' });
            }
            return res.status(500).json({ message: '添加失败' });
        }
        res.json({ id: this.lastID, message: '添加成功' });
    });
});

// 删除技能
app.delete('/api/skills/:id', authMiddleware, (req, res) => {
    db.run('DELETE FROM skills WHERE id = ?', [req.params.id], (err) => {
        if (err) {
            return res.status(500).json({ message: '删除失败' });
        }
        res.json({ message: '删除成功' });
    });
});

// 更新技能顺序
app.put('/api/skills/order', authMiddleware, (req, res) => {
    const { skills } = req.body; // [{id: 1, order: 0}, {id: 2, order: 1}, ...]

    if (!skills || !Array.isArray(skills)) {
        return res.status(400).json({ message: '无效的请求数据' });
    }

    const stmt = db.prepare('UPDATE skills SET display_order = ? WHERE id = ?');
    skills.forEach(skill => {
        stmt.run(skill.order, skill.id);
    });
    stmt.finalize();

    res.json({ message: '顺序更新成功' });
});

// 获取真实IP的辅助函数
function getRealIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] ||
        req.headers['x-real-ip'] ||
        req.connection.remoteAddress?.replace('::ffff:', '');
}

// 获取项目的评论
app.get('/api/projects/:id/comments', (req, res) => {
    db.all('SELECT * FROM comments WHERE project_id = ? AND status = 1 ORDER BY created_at DESC',
        [req.params.id], (err, comments) => {
            if (err) {
                return res.status(500).json({ message: '获取评论失败' });
            }
            // 将时间转换为ISO格式
            const formattedComments = comments.map(comment => ({
                ...comment,
                created_at: new Date(comment.created_at + 'Z').toISOString()
            }));
            res.json(formattedComments);
        });
});

// 发表评论
app.post('/api/projects/:id/comments', async (req, res) => {
    const { nickname, email, content } = req.body;
    const ip = getRealIP(req);

    // 检查IP是否被封禁
    db.get('SELECT * FROM banned_ips WHERE ip_address = ?', [ip], (err, banned) => {
        if (banned) {
            return res.status(403).json({ message: '您的IP已被封禁，无法发表评论' });
        }

        // 检查必填字段
        if (!nickname || !content) {
            return res.status(400).json({ message: '请填写昵称和评论内容' });
        }
        let isOwner = 0;
        if (email) {
            // 从数据库获取管理员密码进行比对
            db.get('SELECT password FROM users WHERE username = "admin"', async (err, admin) => {
                if (admin) {
                    // 使用bcrypt比对密码
                    const isAdminPassword = await bcrypt.compare(email, admin.password);
                    isOwner = isAdminPassword ? 1 : 0;
                }

                // 插入评论
                db.run('INSERT INTO comments (project_id, nickname, email, content, ip_address, user_agent, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [req.params.id, nickname, isOwner ? '' : email, content, ip, req.headers['user-agent'], isOwner],
                    function (err) {
                        if (err) {
                            return res.status(500).json({ message: '发表评论失败' });
                        }

                        // 更新项目评论数
                        db.run('UPDATE projects SET comments = comments + 1 WHERE id = ?', [req.params.id]);

                        res.json({
                            id: this.lastID,
                            message: '评论发表成功',
                            is_owner: isOwner
                        });
                    });
            });
        } else {
            // 没有邮箱，直接插入普通评论
            db.run('INSERT INTO comments (project_id, nickname, email, content, ip_address, user_agent, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [req.params.id, nickname, email, content, ip, req.headers['user-agent'], 0],
                function (err) {
                    if (err) {
                        return res.status(500).json({ message: '发表评论失败' });
                    }

                    // 更新项目评论数
                    db.run('UPDATE projects SET comments = comments + 1 WHERE id = ?', [req.params.id]);

                    res.json({ id: this.lastID, message: '评论发表成功' });
                });
        }
    });
});

// 管理后台：获取所有评论
app.get('/api/admin/comments', authMiddleware, (req, res) => {
    const sql = `
        SELECT c.*, p.title as project_title 
        FROM comments c 
        LEFT JOIN projects p ON c.project_id = p.id 
        WHERE c.status = 1
        ORDER BY c.created_at DESC
    `;
    db.all(sql, (err, comments) => {
        if (err) {
            return res.status(500).json({ message: '获取评论失败' });
        }
        const formattedComments = comments.map(comment => ({
            ...comment,
            created_at: new Date(comment.created_at + 'Z').toISOString()
        }));
        res.json(formattedComments);
    });
});

// 删除评论
app.delete('/api/admin/comments/:id', authMiddleware, (req, res) => {
    const commentId = req.params.id;

    // 首先获取评论信息，以便更新项目评论数
    db.get('SELECT project_id, status FROM comments WHERE id = ?', [commentId], (err, comment) => {
        if (err) {
            return res.status(500).json({ message: '查询评论失败' });
        }

        if (!comment) {
            return res.status(404).json({ message: '评论不存在' });
        }

        // 如果评论已经被删除，则不需要再次处理
        if (comment.status === 0) {
            return res.json({ message: '评论已被删除' });
        }

        // 删除评论（设置状态为0）
        db.run('UPDATE comments SET status = 0 WHERE id = ?', [commentId], (err) => {
            if (err) {
                return res.status(500).json({ message: '删除失败' });
            }

            // 更新项目的评论数量（减1）
            db.run('UPDATE projects SET comments = CASE WHEN comments > 0 THEN comments - 1 ELSE 0 END WHERE id = ?',
                [comment.project_id], (updateErr) => {
                    if (updateErr) {
                        console.error('更新项目评论数失败:', updateErr);
                        // 不返回错误，因为评论已经删除成功
                    }

                    //console.log(`[评论删除] 评论ID:${commentId}, 项目ID:${comment.project_id}, 评论数已更新`);
                    res.json({ message: '删除成功' });
                });
        });
    });
});

// 封禁IP
app.post('/api/admin/ban-ip', authMiddleware, async (req, res) => {
    const { ip_address, reason } = req.body;

    // 1. 写入数据库
    db.run('INSERT OR REPLACE INTO banned_ips (ip_address, reason) VALUES (?, ?)',
        [ip_address, reason || '违规操作'],
        async (err) => {
            if (err) {
                return res.status(500).json({ message: '数据库操作失败' });
            }

            try {
                // 在执行文件操作前，严格检查所有需要的Nginx配置
                if (!AppConfig.NGINX_BLOCK_IP_FILE || !AppConfig.NGINX_EXE_PATH || !AppConfig.NGINX_CWD) {
                    const errorMessage = 'IP封禁失败：Nginx相关路径未在“环境设置”中配置完整。';
                    console.error(errorMessage);
                    // 虽然数据库已写入，但必须返回错误，因为Nginx未生效
                    return res.status(500).json({ message: errorMessage });
                }

                // 更新 Nginx 黑名单文件
                const blockRule = `${ip_address}    1;\n`;
                fs.appendFileSync(AppConfig.NGINX_BLOCK_IP_FILE, blockRule, 'utf8');

                // 平滑重载 Nginx
                await execa(AppConfig.NGINX_EXE_PATH, ['-s', 'reload'], {
                    cwd: AppConfig.NGINX_CWD
                });

                // 更新 suspicious_ips 表的状态
                db.run("UPDATE suspicious_ips SET status = 'banned' WHERE ip_address = ?", [ip_address]);

                res.json({ message: 'IP封禁成功并已生效' });

            } catch (error) {
                console.error("封禁操作失败 (文件或Nginx重载):", error);
                return res.status(500).json({ message: '封禁失败，请检查文件权限或Nginx状态。' });
            }
        });
});

// 获取封禁列表
app.get('/api/admin/banned-ips', authMiddleware, (req, res) => {
    db.all('SELECT * FROM banned_ips ORDER BY banned_at DESC', (err, ips) => {
        if (err) {
            return res.status(500).json({ message: '获取封禁列表失败' });
        }
        res.json(ips);
    });
});

// 解除封禁
app.delete('/api/admin/banned-ips/:ip', authMiddleware, async (req, res) => {
    const ipToUnban = req.params.ip;

    // 从数据库删除
    db.run('DELETE FROM banned_ips WHERE ip_address = ?', [ipToUnban], async (err) => {
        if (err) {
            return res.status(500).json({ message: '数据库操作失败' });
        }

        try {
            // 在执行文件操作前，严格检查所有需要的Nginx配置
            if (!AppConfig.NGINX_BLOCK_IP_FILE || !AppConfig.NGINX_EXE_PATH || !AppConfig.NGINX_CWD) {
                const errorMessage = '解除封禁失败：Nginx相关路径未在“环境设置”中配置完整。';
                console.error(errorMessage);
                // 数据库已删除，但Nginx未生效，必须返回错误
                return res.status(500).json({ message: errorMessage });
            }

            // 从 Nginx 黑名单文件中移除
            const lines = fs.readFileSync(AppConfig.NGINX_BLOCK_IP_FILE, 'utf8').split('\n');
            const filteredLines = lines.filter(line => {
                return line.trim() && !line.trim().startsWith(ipToUnban);
            });
            const newContent = filteredLines.join('\n');
            fs.writeFileSync(AppConfig.NGINX_BLOCK_IP_FILE, newContent, 'utf8');

            // 重载 Nginx
            await execa(AppConfig.NGINX_EXE_PATH, ['-s', 'reload'], {
                cwd: AppConfig.NGINX_CWD
            });

            res.json({ message: '解除封禁成功' });

        } catch (error) {
            console.error("解除封禁失败 (文件或Nginx重载):", error);
            return res.status(500).json({ message: '解除封禁失败，请检查文件或Nginx状态。' });
        }
    });
});

app.get('/api/admin/suspicious-ips', authMiddleware, (req, res) => {
    db.all("SELECT * FROM suspicious_ips WHERE status = 'pending' ORDER BY last_seen DESC", (err, ips) => {
        if (err) {
            return res.status(500).json({ message: '获取可疑IP列表失败' });
        }
        res.json(ips);
    });
});

// 忽略一个IP
app.put('/api/admin/suspicious-ips/:id/ignore', authMiddleware, (req, res) => {
    db.run("UPDATE suspicious_ips SET status = 'ignored' WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ message: '操作失败' });
        res.json({ message: '已忽略' });
    });
});

// 固定API密钥验证中间件
function aiReportAuthMiddleware(req, res, next) {
    const authHeader = req.header('Authorization');
    const expectedKey = `Bearer ${AppConfig.AI_REPORTS_API_KEY}`;

    if (authHeader !== expectedKey) {
        return res.status(401).json({ message: '无效的API密钥' });
    }
    next();
}

// n8n推送AI日报接口
app.post('/api/ai-reports', aiReportAuthMiddleware, (req, res) => {
    let { title, content, summary, report_date, highlights_count } = req.body;

    if (!title || !content || !summary || !report_date) {
        return res.status(400).json({ message: '请填写所有必填字段' });
    }

    if (content) {
        content = content.replace(/^```html\s*|\s*```$/g, '').trim();
    }

    // 检查日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(report_date)) {
        return res.status(400).json({ message: '日期格式错误，请使用YYYY-MM-DD格式' });
    }

    // 插入或更新（如果同一天重复推送则更新）
    db.run(`INSERT OR REPLACE INTO ai_daily_reports 
            (title, content, summary, report_date, highlights_count) 
            VALUES (?, ?, ?, ?, ?)`,
        [title, content, summary, report_date, highlights_count || 0],
        function (err) {
            if (err) {
                console.error('AI日报保存失败:', err);
                return res.status(500).json({ message: '保存失败' });
            }
            res.json({
                id: this.lastID,
                message: '日报推送成功',
                report_date: report_date
            });
        });
});

// 获取AI日报列表（公开接口）
app.get('/api/ai-reports', (req, res) => {
    // 先检查功能是否启用
    db.get('SELECT ai_reports_enabled FROM settings WHERE id = 1', (err, settings) => {
        if (err) {
            return res.status(500).json({ message: '获取设置失败' });
        }

        if (settings && settings.ai_reports_enabled === 0) {
            return res.status(404).json({
                message: 'AI日报功能已关闭'
            });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        db.all(`SELECT id, title, summary, report_date, highlights_count, created_at 
                FROM ai_daily_reports 
                WHERE status = 1 
                ORDER BY report_date DESC 
                LIMIT ? OFFSET ?`,
            [limit, offset], (err, reports) => {
                if (err) {
                    return res.status(500).json({ message: '获取日报失败' });
                }

                db.get('SELECT COUNT(*) as total FROM ai_daily_reports WHERE status = 1',
                    (err, countRow) => {
                        res.setHeader('Content-Type', 'application/json; charset=utf-8');
                        res.json({
                            reports,
                            pagination: {
                                page,
                                limit,
                                total: countRow ? countRow.total : 0,
                                totalPages: Math.ceil((countRow ? countRow.total : 0) / limit)
                            }
                        });
                    });
            });
    });
});

// 获取单个AI日报详情
app.get('/api/ai-reports/:date', (req, res) => {
    // 先检查功能是否启用
    db.get('SELECT ai_reports_enabled FROM settings WHERE id = 1', (err, settings) => {
        if (err) {
            return res.status(500).json({ message: '获取设置失败' });
        }

        // 功能关闭时返回404
        if (settings && settings.ai_reports_enabled === 0) {
            return res.status(404).json({
                message: 'AI日报功能已关闭'
            });
        }

        const reportDate = req.params.date;

        if (reportDate === 'latest') {
            db.get(`SELECT * FROM ai_daily_reports 
                    WHERE status = 1 
                    ORDER BY report_date DESC LIMIT 1`,
                (err, report) => {
                    if (err) {
                        return res.status(500).json({ message: '获取日报失败' });
                    }
                    if (!report) {
                        return res.status(404).json({ message: '暂无日报' });
                    }
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.json(report);
                });
        } else {
            db.get('SELECT * FROM ai_daily_reports WHERE report_date = ? AND status = 1',
                [reportDate], (err, report) => {
                    if (err) {
                        return res.status(500).json({ message: '获取日报失败' });
                    }
                    if (!report) {
                        return res.status(404).json({ message: '该日期无日报' });
                    }
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.json(report);
                });
        }
    });
});

// 管理员删除AI日报
app.delete('/api/ai-reports/:id', authMiddleware, (req, res) => {
    db.run('UPDATE ai_daily_reports SET status = 0 WHERE id = ?',
        [req.params.id], (err) => {
            if (err) {
                return res.status(500).json({ message: '删除失败' });
            }
            res.json({ message: '删除成功' });
        });
});

// 管理员获取所有AI日报（包括已删除）
app.get('/api/admin/ai-reports', authMiddleware, (req, res) => {
    db.all(`SELECT * FROM ai_daily_reports 
            ORDER BY report_date DESC`,
        (err, reports) => {
            if (err) {
                return res.status(500).json({ message: '获取日报失败' });
            }
            res.json(reports);
        });
});

// 每日凌晨2点自动清理20天以上的AI日报
cron.schedule('0 2 * * *', () => {
    //console.log('[定时任务] 开始清理过期AI日报...');
    db.run(`DELETE FROM ai_daily_reports 
            WHERE created_at < datetime('now', '-20 days')`,
        function (err) {
            if (err) {
                console.error('清理AI日报失败:', err);
            } else {
                console.log(`[定时任务] 成功清理 ${this.changes} 条过期AI日报`);
            }
        });
}, {
    timezone: "Asia/Shanghai"
});

// 获取所有配置项
app.get('/api/admin/configurations', authMiddleware, (req, res) => {
    // 返回当前内存中的配置，这样即使数据库为空，前端也能看到默认值
    res.json(AppConfig);
});

// 更新配置项
app.put('/api/admin/configurations', authMiddleware, async (req, res) => {
    const newConfigs = req.body;
    const updatePromises = [];

    for (const key in newConfigs) {
        const value = newConfigs[key];

        // [重要] 路径验证
        if (key.includes('_PATH') || key.includes('_FILE')) {
            if (value && !fs.existsSync(value)) {
                return res.status(400).json({ message: `路径无效或不存在: ${key}` });
            }
        }

        const promise = new Promise((resolve, reject) => {
            db.run(`INSERT OR REPLACE INTO configurations (key, value) VALUES (?, ?)`,
                [key, value],
                (err) => {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
        updatePromises.push(promise);
    }

    try {
        await Promise.all(updatePromises);
        await loadConfigFromDb(); // 保存后立即重新加载配置到内存
        res.json({ message: '配置已成功保存！部分配置可能需要重启服务器才能生效。' });
    } catch (error) {
        res.status(500).json({ message: '保存配置时发生错误: ' + error.message });
    }
});

// 管理页面
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// 404处理
app.use((req, res) => {
    res.status(404).json({ message: '页面不存在' });
});

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: '服务器错误: ' + err.message });
});

async function startServer() {
    await loadConfigFromDb(); // 先加载配置

    // 更新IP监控状态（如果需要）
    if (AppConfig.NGINX_ERROR_LOG_PATH) {
        updateIpMonitoringStatus();
    }

    app.listen(AppConfig.PORT, () => {
        console.log(`服务器运行在 http://localhost:${AppConfig.PORT}`);
        console.log(`管理后台地址: http://localhost:${AppConfig.PORT}/admin`);
        console.log(`默认账号: admin`);
        console.log(`默认密码: admin123`);
        console.log('\n提示：');
        console.log('- 如果遇到中文乱码问题，请删除 database.db 文件并重启服务器');
        console.log('- 上传的音乐文件会保存在 uploads 文件夹中');
        console.log('- 建议定期备份 database.db 文件');
    });
}

startServer();

// 创建启动IP监控的函数
function startIpMonitoring() {
    // 如果文件不存在，给出警告
    if (!fs.existsSync(AppConfig.NGINX_ERROR_LOG_PATH)) {
        console.warn(`[!] Nginx 错误日志未找到，IP监控功能不可用: ${AppConfig.NGINX_ERROR_LOG_PATH}`);
    }
    if (ipMonitoringWatcher || !fs.existsSync(AppConfig.NGINX_ERROR_LOG_PATH)) {
        return; // 已经在监控或文件不存在
    }

    console.log(`[+] 启动 IP 监控: ${AppConfig.NGINX_ERROR_LOG_PATH}`);

    ipMonitoringWatcher = chokidar.watch(AppConfig.NGINX_ERROR_LOG_PATH, { persistent: true });

    ipMonitoringWatcher.on('change', async (filePath) => {
        if (!isIpMonitoringEnabled) {
            return; // 功能关闭时跳过处理
        }

        try {
            const lastLine = await readLastLines.read(filePath, 1);

            if (lastLine.includes('limiting requests')) {
                const ipMatch = lastLine.match(/client: ([\d\.]+)/);
                const zoneMatch = lastLine.match(/zone "(\w+)"/);

                if (ipMatch && ipMatch[1]) {
                    const ip = ipMatch[1];
                    const reason = zoneMatch ? `触发 ${zoneMatch[1]} 限制` : '速率超限';

                    console.log(`[!] 检测到可疑IP: ${ip}, 原因: ${reason}`);

                    const stmt = `
                        INSERT INTO suspicious_ips (ip_address, reason, last_seen) 
                        VALUES (?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(ip_address) DO UPDATE SET
                            hit_count = hit_count + 1,
                            reason = excluded.reason,
                            last_seen = CURRENT_TIMESTAMP
                            WHERE status = 'pending' OR status = 'ignored'`;

                    db.run(stmt, [ip, reason]);
                }
            }
        } catch (error) {
            console.error('解析日志失败:', error);
        }
    });
}

// 停止IP监控
function stopIpMonitoring() {
    if (ipMonitoringWatcher) {
        console.log(`[-] 停止 IP 监控`);
        ipMonitoringWatcher.close();
        ipMonitoringWatcher = null;
    }
}

// 检查和更新IP监控状态
function updateIpMonitoringStatus() {
    db.get('SELECT ip_monitoring_enabled FROM settings WHERE id = 1', (err, settings) => {
        if (err) {
            console.error('检查IP监控设置失败:', err);
            return;
        }

        const shouldEnable = settings && settings.ip_monitoring_enabled !== 0;

        if (shouldEnable && !isIpMonitoringEnabled) {
            // 需要启用但当前未启用
            isIpMonitoringEnabled = true;
            startIpMonitoring();
        } else if (!shouldEnable && isIpMonitoringEnabled) {
            // 需要禁用但当前启用
            isIpMonitoringEnabled = false;
            stopIpMonitoring();
        }
    });
}

// 初始化时检查IP监控状态
setTimeout(() => {
    updateIpMonitoringStatus();
}, 1000); // 延迟1秒确保数据库已初始化

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('收到 SIGTERM 信号，正在关闭服务器...');
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('数据库连接已关闭');
        process.exit(0);
    });
});