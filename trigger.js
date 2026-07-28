/**
 * 模拟盘引擎触发脚本（VPS 部署版）
 *
 * 功能：每秒向 Vercel 部署的 /api/paper/engine 发送 POST 请求，
 *       驱动模拟盘引擎执行止损止盈检查和自动开仓。
 *
 * 使用方法：
 *   1. 将此文件上传到 VPS
 *   2. 修改下面的配置（URL、Cookie/Token）
 *   3. 安装依赖：npm install node-fetch（Node 18+ 内置 fetch，无需安装）
 *   4. 运行：node trigger.js
 *   5. 后台运行：nohup node trigger.js > trigger.log 2>&1 &
 *
 * 注意：
 *   - Vercel 免费版函数有并发限制，建议间隔 2-3 秒
 *   - 需要有效的登录 Cookie（从浏览器复制）
 *   - 可配合 pm2 做进程守护：pm2 start trigger.js --name paper-trigger
 */

// ==================== 配置区 ====================

const CONFIG = {
  // Vercel 部署的 API 地址（替换为你的域名）
  API_URL: 'https://your-domain.vercel.app/api/paper/engine',

  // 登录凭证（从浏览器 Cookie 中复制）
  // 方法：浏览器 F12 → Application → Cookies → 复制 token 的值
  AUTH_COOKIE: 'your-auth-token-here',

  // 触发间隔（毫秒），建议 2000-3000ms
  INTERVAL: 2000,

  // 请求超时（毫秒）
  TIMEOUT: 10000,

  // 是否输出详细日志
  VERBOSE: true,

  // 最大连续失败次数（超过后暂停 30 秒）
  MAX_FAILURES: 10,
};

// ==================== 核心逻辑 ====================

let failCount = 0;
let successCount = 0;
let lastSuccess = null;

async function trigger() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

  try {
    const response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `token=${CONFIG.AUTH_COOKIE}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    failCount = 0;
    successCount++;

    if (data.success && data.data) {
      const r = data.data;
      lastSuccess = new Date().toISOString();

      // 只在有操作时输出日志
      if (r.opened > 0 || r.closed > 0 || (CONFIG.VERBOSE && r.errors.length > 0)) {
        console.log(
          `[${lastSuccess}] ✓ 成功 #${successCount} | ` +
          `检查 ${r.checked} 持仓 | 开仓 ${r.opened} | 平仓 ${r.closed}` +
          (r.errors.length > 0 ? ` | 错误: ${r.errors.join('; ')}` : '')
        );
      } else if (CONFIG.VERBOSE && successCount % 30 === 0) {
        // 每 30 次输出一次心跳
        console.log(`[${lastSuccess}] ♥ 心跳 #${successCount} | 持仓 ${r.checked} | 一切正常`);
      }
    }
  } catch (error) {
    clearTimeout(timer);
    failCount++;

    const msg = error.name === 'AbortError' ? '请求超时' : error.message;
    console.error(`[${new Date().toISOString()}] ✗ 失败 #${failCount}: ${msg}`);

    if (failCount >= CONFIG.MAX_FAILURES) {
      console.error(`连续失败 ${failCount} 次，暂停 30 秒...`);
      await sleep(30000);
      failCount = 0;
      console.log('恢复触发...');
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 启动 ====================

console.log('========================================');
console.log('  模拟盘引擎触发器');
console.log('========================================');
console.log(`API: ${CONFIG.API_URL}`);
console.log(`间隔: ${CONFIG.INTERVAL}ms`);
console.log(`启动时间: ${new Date().toISOString()}`);
console.log('----------------------------------------');
console.log('按 Ctrl+C 停止');
console.log('');

// 立即执行一次
trigger();

// 定时触发
setInterval(trigger, CONFIG.INTERVAL);

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n停止触发器...');
  console.log(`统计: 成功 ${successCount} 次, 最后成功 ${lastSuccess || '无'}`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n收到终止信号，停止触发器...');
  process.exit(0);
});
