/**
 * 代理请求鉴权模块
 * 为代理请求添加基于 PASSWORD 的鉴权机制
 */

// 从全局配置获取密码哈希（如果存在）
let cachedPasswordHash = null;

/**
 * 获取当前会话的密码哈希
 */
async function getPasswordHash() {
    // 服务端会在 HTML 中注入当前密码哈希。它必须优先于浏览器旧缓存，
    // 否则修改 PASSWORD 后，老用户会一直携带过期哈希并收到 401。
    const serverPasswordHash = window.__ENV__ && window.__ENV__.PASSWORD;
    if (serverPasswordHash) {
        cachedPasswordHash = serverPasswordHash;
        if (localStorage.getItem('proxyAuthHash') !== serverPasswordHash) {
            localStorage.setItem('proxyAuthHash', serverPasswordHash);
        }
        return serverPasswordHash;
    }

    if (cachedPasswordHash) {
        return cachedPasswordHash;
    }

    // 1. 从已存储的代理鉴权哈希获取
    const storedHash = localStorage.getItem('proxyAuthHash');
    if (storedHash) {
        cachedPasswordHash = storedHash;
        return storedHash;
    }
    
    // 2. 尝试从密码验证状态获取（password.js 验证后存储的哈希）
    const passwordVerified = localStorage.getItem('passwordVerified');
    const storedPasswordHash = localStorage.getItem('passwordHash');
    if (passwordVerified === 'true' && storedPasswordHash) {
        localStorage.setItem('proxyAuthHash', storedPasswordHash);
        cachedPasswordHash = storedPasswordHash;
        return storedPasswordHash;
    }
    
    // 3. 尝试从用户输入的密码生成哈希
    const userPassword = localStorage.getItem('userPassword');
    if (userPassword) {
        try {
            // 动态导入 sha256 函数
            const { sha256 } = await import('./sha256.js');
            const hash = await sha256(userPassword);
            localStorage.setItem('proxyAuthHash', hash);
            cachedPasswordHash = hash;
            return hash;
        } catch (error) {
            console.error('生成密码哈希失败:', error);
        }
    }
    
    return null;
}

/**
 * 为代理请求URL添加鉴权参数
 */
async function addAuthToProxyUrl(url) {
    try {
        const hash = await getPasswordHash();
        if (!hash) {
            console.warn('无法获取密码哈希，代理请求可能失败');
            return url;
        }
        
        // 添加时间戳防止重放攻击
        const timestamp = Date.now();
        
        // 检查URL是否已包含查询参数
        const separator = url.includes('?') ? '&' : '?';
        
        return `${url}${separator}auth=${encodeURIComponent(hash)}&t=${timestamp}`;
    } catch (error) {
        console.error('添加代理鉴权失败:', error);
        return url;
    }
}

/**
 * 验证代理请求的鉴权
 */
function validateProxyAuth(authHash, serverPasswordHash, timestamp) {
    if (!authHash || !serverPasswordHash) {
        return false;
    }
    
    // 验证哈希是否匹配
    if (authHash !== serverPasswordHash) {
        return false;
    }
    
    // 验证时间戳（10分钟有效期）
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10分钟
    
    if (timestamp && (now - parseInt(timestamp)) > maxAge) {
        console.warn('代理请求时间戳过期');
        return false;
    }
    
    return true;
}

/**
 * 清除缓存的鉴权信息
 */
function clearAuthCache() {
    cachedPasswordHash = null;
    localStorage.removeItem('proxyAuthHash');
}

// 监听密码变化，清除缓存
window.addEventListener('storage', (e) => {
    if (e.key === 'userPassword' || (window.PASSWORD_CONFIG && e.key === window.PASSWORD_CONFIG.localStorageKey)) {
        clearAuthCache();
    }
});

// 导出函数
window.ProxyAuth = {
    addAuthToProxyUrl,
    validateProxyAuth,
    clearAuthCache,
    getPasswordHash
};
