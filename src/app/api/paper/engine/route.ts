/**
 * 模拟盘交易引擎 API
 * POST /api/paper/engine  - 执行引擎（VPS / 虚拟主机每秒触发）
 *
 * 引擎逻辑：
 * 1. 获取当前价格
 * 2. 刷新所有持仓的浮盈浮亏
 * 3. 检查止损 / 止盈1（部分平仓）/ 止盈2（全平）
 * 4. 如果开启自动交易，检查策略信号并自动开仓
 *
 * 鉴权方式（二选一）：
 * A) 浏览器访问 — 自动读取 cookie 中的 JWT token
 * B) 外部触发 — 请求头携带 X-Engine-Key，匹配环境变量 ENGINE_API_KEY
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { getOptionalUser } from '@/shared/api/auth-guard';
import { AuthError } from '@/shared/api/errors';
import { runEngine } from '@/shared/lib/paper-trading';
import { prisma } from '@/shared/lib/prisma';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const POST = createHandler(async (ctx) => {
  let userId: string;

  // 方式 A：浏览器 cookie 鉴权
  const user = getOptionalUser();
  if (user) {
    userId = user.userId;
  } else {
    // 方式 B：外部 API Key 鉴权
    const engineKey = ctx.req.headers.get('x-engine-key') || 
                      new URL(ctx.req.url).searchParams.get('key');
    const expectedKey = process.env.ENGINE_API_KEY;

    if (!engineKey || !expectedKey || engineKey !== expectedKey) {
      throw new AuthError('AUTH_UNAUTHORIZED', '请先登录或提供有效的引擎密钥');
    }

    // 用 API Key 触发时，找到第一个开启了自动交易的账户
    // 或者用环境变量 ENGINE_USER_ID 指定用户
    const configuredUserId = process.env.ENGINE_USER_ID;
    if (configuredUserId) {
      userId = configuredUserId;
    } else {
      // 找第一个有 PaperAccount 的用户
      const account = await prisma.paperAccount.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      if (!account) {
        return apiSuccess({ checked: 0, opened: 0, closed: 0, errors: ['未找到模拟盘账户'] });
      }
      userId = account.userId;
    }
  }

  const result = await runEngine(userId);
  return apiSuccess(result);
});
