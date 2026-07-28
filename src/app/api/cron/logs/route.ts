/**
 * 引擎日志查询 API（管理员）
 * GET /api/cron/logs?limit=50&offset=0
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireAdmin } from '@/shared/api/auth-guard';
import { prisma } from '@/shared/lib/prisma';

export const dynamic = 'force-dynamic';

export const GET = createHandler(async ({ req }) => {
  requireAdmin();
  const url = new URL(req.url);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)), 200);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  // 查引擎日志（action='engine'）
  const [logs, total] = await Promise.all([
    prisma.paperTradeLog.findMany({
      where: { action: 'engine' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        createdAt: true,
        price: true,
        detail: true,
      },
    }),
    prisma.paperTradeLog.count({ where: { action: 'engine' } }),
  ]);

  // 解析 detail 字段
  const items = logs.map((log) => {
    let parsed: any = {};
    try {
      parsed = JSON.parse(log.detail || '{}');
    } catch {}
    return {
      id: log.id,
      time: log.createdAt.toISOString(),
      price: log.price,
      checked: parsed.checked || 0,
      opened: parsed.opened || 0,
      closed: parsed.closed || 0,
      errors: parsed.errors || [],
    };
  });

  // 今日统计
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayLogs = await prisma.paperTradeLog.findMany({
    where: {
      action: 'engine',
      createdAt: { gte: todayStart },
    },
    select: { id: true, detail: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  let todayChecked = 0;
  let todayOpened = 0;
  let todayClosed = 0;
  let todayErrors = 0;
  let todaySuccess = 0;

  for (const tl of todayLogs) {
    let p: any = {};
    try { p = JSON.parse(tl.detail || '{}'); } catch {}
    todayChecked += p.checked || 0;
    todayOpened += p.opened || 0;
    todayClosed += p.closed || 0;
    if (p.errors && p.errors.length > 0) todayErrors++;
    else todaySuccess++;
  }

  // 最近一小时统计
  const oneHourAgo = new Date(Date.now() - 3600000);
  const hourCount = await prisma.paperTradeLog.count({
    where: { action: 'engine', createdAt: { gte: oneHourAgo } },
  });

  // 最后一次执行时间
  const lastLog = todayLogs[0];
  const lastExecutedAt = lastLog?.createdAt?.toISOString() || null;

  // 解析最近一条的 detail 看是否有 loops（循环次数）
  let lastLoops = 1;
  if (lastLog) {
    try {
      const ld = JSON.parse(lastLog.detail || '{}');
      // 如果 detail 里有 loops 字段说明是新的循环版
      if (ld.loops) lastLoops = ld.loops;
    } catch {}
  }

  return apiSuccess({
    items,
    total,
    stats: {
      todayTriggers: todayLogs.length,
      todayChecked,
      todayOpened,
      todayClosed,
      todayErrors,
      todaySuccess,
      hourTriggers: hourCount,
      lastExecutedAt,
      lastLoops,
      // 估算每分钟触发频率
      estimatedInterval: hourCount > 1 ? Math.round(60 / hourCount) : 0,
    },
  });
});
