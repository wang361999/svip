import { NextResponse } from 'next/server';
import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { z } from 'zod';
import { getHistoricalKlines, get24hrStats } from '@/shared/lib/binance';

export const dynamic = 'force-dynamic';

const marketQuerySchema = z.object({
  interval: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']).default('1h'),
  limit: z.coerce.number().int().min(50).max(1000).default(500),
});

export const GET = createHandler(async ({ req }) => {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') || 'ETHUSDT';
  const { interval, limit } = withZod(marketQuerySchema, Object.fromEntries(searchParams));
  const [klines, stats] = await Promise.all([
    getHistoricalKlines(symbol, interval, limit),
    get24hrStats(symbol),
  ]);
  return NextResponse.json({ klines, stats, symbol });
});
