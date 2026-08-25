/**
 * 模拟盘账户 API
 * GET    /api/paper/account  - 获取账户信息
 * PUT    /api/paper/account  - 更新风控配置
 * POST   /api/paper/account  - 重置账户
 */
import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { z } from 'zod';
import {
  getAccountInfo,
  updateAccountConfig,
  resetAccount,
} from '@/shared/lib/paper-trading';

export const dynamic = 'force-dynamic';

const updateConfigSchema = z.object({
  leverage: z.number().int().min(1).max(125).optional(),
  positionPct: z.number().min(0.1).max(100).optional(),
  stopLossPct: z.number().min(0.1).max(50).optional(),
  takerFee: z.number().min(0).max(1).optional(),
  makerFee: z.number().min(0).max(1).optional(),
  slippage: z.number().min(0).max(1).optional(),
  autoTrade: z.boolean().optional(),
  // 用户当前选中的币种（前端切换币种时同步，引擎只对该币种自动开仓）
  currentSymbol: z.string().regex(/^[A-Z0-9]{4,20}$/).optional(),
});

export const GET = createHandler(async () => {
  const user = requireUser();
  const account = await getAccountInfo(user.userId);
  return apiSuccess(account);
});

export const PUT = createHandler(async ({ req }) => {
  const user = requireUser();
  const input = withZod(updateConfigSchema, await req.json());
  const account = await updateAccountConfig(user.userId, input);
  return apiSuccess(account);
});

export const POST = createHandler(async () => {
  const user = requireUser();
  const account = await resetAccount(user.userId);
  return apiSuccess(account);
});
