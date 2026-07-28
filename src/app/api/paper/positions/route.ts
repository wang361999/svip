/**
 * 模拟盘持仓 API
 * GET  /api/paper/positions  - 获取持仓列表
 * POST /api/paper/positions  - 手动开仓
 */
import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { z } from 'zod';
import { getPositions, openPosition } from '@/shared/lib/paper-trading';

export const dynamic = 'force-dynamic';

const openPositionSchema = z.object({
  symbol: z.string().default('ETHUSDT'),
  side: z.enum(['long', 'short']),
  entryPrice: z.number().positive(),
  quantity: z.number().positive().optional(),
  margin: z.number().positive().optional(),
  leverage: z.number().int().min(1).max(125).optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit1: z.number().positive().optional(),
  takeProfit2: z.number().positive().optional(),
  strategyId: z.string().optional(),
  signalPrice: z.number().positive().optional(),
});

export const GET = createHandler(async () => {
  const user = requireUser();
  const positions = await getPositions(user.userId);
  return apiSuccess(positions);
});

export const POST = createHandler(async ({ req }) => {
  const user = requireUser();
  const input = withZod(openPositionSchema, await req.json());
  const position = await openPosition(user.userId, input);
  return apiSuccess(position);
});
