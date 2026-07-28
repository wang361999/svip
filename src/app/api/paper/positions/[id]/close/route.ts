/**
 * 模拟盘手动平仓 API
 * POST /api/paper/positions/[id]/close  - 手动平仓
 *
 * body: { exitPrice: number, closeRatio?: number }
 */
import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { z } from 'zod';
import { closePosition } from '@/shared/lib/paper-trading';

export const dynamic = 'force-dynamic';

const closeSchema = z.object({
  exitPrice: z.number().positive(),
  closeRatio: z.number().min(0.01).max(1).default(1),
});

export const POST = createHandler(async ({ req, params }) => {
  const user = requireUser();
  const input = withZod(closeSchema, await req.json());
  const positionId = params.id as string;
  const trade = await closePosition(positionId, input.exitPrice, 'manual', input.closeRatio);
  return apiSuccess(trade);
});
