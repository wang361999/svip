/**
 * 币种状态切换 API
 * POST /api/symbols/toggle
 * Body: { id: string, active?: boolean, autoTrade?: boolean }
 */
import { NextResponse } from 'next/server';
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { prisma } from '@/shared/lib/prisma';
import { z } from 'zod';
import { withZod } from '@/shared/api/validate';

export const dynamic = 'force-dynamic';

const toggleSchema = z.object({
  id: z.string().min(1),
  active: z.boolean().optional(),
  autoTrade: z.boolean().optional(),
});

export const POST = createHandler(async ({ req }) => {
  const body = await req.json();
  const input = withZod(toggleSchema, body);

  const data: { active?: boolean; autoTrade?: boolean } = {};
  if (input.active !== undefined) data.active = input.active;
  if (input.autoTrade !== undefined) data.autoTrade = input.autoTrade;

  const updated = await prisma.tradingSymbol.update({
    where: { id: input.id },
    data,
  });

  return apiSuccess(updated);
});
