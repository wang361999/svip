/**
 * Vercel 定时触发端点（Hobby 免费版兼容）
 * 
 * 触发方式：cron-job.org 直接请求此端点
 * 鉴权：URL 参数 ?key= 或 Header X-Engine-Key
 * 
 * 核心优化：单次请求内安全执行引擎
 * - Hobby 10秒限制，默认只跑 1 次，避免 cron-job.org 因 504 自动禁用任务
 * - 循环次数和间隔从 SiteSetting 读取（后台可配置）
 * - 接近超时前提前返回成功结果，不再硬跑到 Vercel 超时
 * - 每次触发自动清理过期日志
 */
import { NextResponse } from 'next/server';
import { runEngine } from '@/shared/lib/paper-trading';
import { prisma } from '@/shared/lib/prisma';

export const dynamic = 'force-dynamic';
// Hobby 免费版最大 10 秒
export const maxDuration = 10;

/** 安全休眠 */
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Vercel Hobby 通常 10 秒超时，这里预留缓冲，避免返回 504 */
const SOFT_DEADLINE_MS = 7600;
/** 单次 runEngine 通常 2-3 秒，剩余时间不足时不再开启下一轮 */
const MIN_NEXT_LOOP_BUDGET_MS = 3200;

function readIntParam(value: string | null, fallback: number) {
  if (value === null || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(req: Request) {
  return handleCron(req);
}

export async function POST(req: Request) {
  return handleCron(req);
}

async function handleCron(req: Request) {
  // 1. 鉴权
  const engineKeyHeader = req.headers.get('x-engine-key');
  const urlKey = new URL(req.url).searchParams.get('key');
  const engineApiKey = process.env.ENGINE_API_KEY;

  if (!engineApiKey) {
    return NextResponse.json(
      { success: false, error: 'ENGINE_API_KEY 未配置' },
      { status: 500 },
    );
  }

  const isValid =
    (engineKeyHeader && engineKeyHeader === engineApiKey) ||
    (urlKey && urlKey === engineApiKey);

  if (!isValid) {
    return NextResponse.json(
      { success: false, error: '鉴权失败' },
      { status: 401 },
    );
  }

  // 2. 读取 SiteSetting 中的 cron 配置
  let settingLoops = 1;
  let settingInterval = 0;
  let settingLogTtl = 1;
  try {
    const setting = await prisma.siteSetting.findUnique({ where: { id: 'main' } });
    if (setting) {
      settingLoops = Math.max(1, Math.min(3, readIntParam(setting.cronLoops ?? null, 1)));
      settingInterval = Math.max(0, Math.min(2000, readIntParam(setting.cronInterval ?? null, 0)));
      settingLogTtl = Math.max(1, Math.min(72, readIntParam(setting.cronLogTtl ?? null, 1)));
    }
  } catch {}

  // 3. 自动清理过期日志（每次触发都检查，低开销）
  try {
    const cutoff = new Date(Date.now() - settingLogTtl * 3600000);
    await prisma.paperTradeLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
  } catch {}

  // 4. 找到目标用户
  const configuredUserId = process.env.ENGINE_USER_ID;
  let userId: string;

  if (configuredUserId) {
    userId = configuredUserId;
  } else {
    const account = await prisma.paperAccount.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (!account) {
      return NextResponse.json({
        success: true,
        data: { loops: 0, checked: 0, opened: 0, closed: 0, errors: ['未找到模拟盘账户'] },
      });
    }
    userId = account.userId;
  }

  // 5. 循环执行引擎（使用后台配置的参数）
  // URL 参数可临时覆盖（调试用）
  const url = new URL(req.url);
  const maxLoops = Math.max(1, Math.min(3, readIntParam(url.searchParams.get('loops'), settingLoops)));
  const interval = Math.max(0, Math.min(2000, readIntParam(url.searchParams.get('interval'), settingInterval)));

  const totalChecked: number[] = [];
  const totalOpened: number[] = [];
  const totalClosed: number[] = [];
  const allErrors: string[] = [];
  const startMs = Date.now();
  let stoppedByDeadline = false;

  for (let i = 0; i < maxLoops; i++) {
    const elapsedMs = Date.now() - startMs;
    const remainingMs = SOFT_DEADLINE_MS - elapsedMs;

    if (remainingMs < MIN_NEXT_LOOP_BUDGET_MS) {
      stoppedByDeadline = true;
      break;
    }

    if (i > 0 && interval > 0) {
      const waitMs = Math.min(interval, Math.max(0, SOFT_DEADLINE_MS - MIN_NEXT_LOOP_BUDGET_MS - (Date.now() - startMs)));
      if (waitMs > 100) {
        await sleep(waitMs);
      }

      if (SOFT_DEADLINE_MS - (Date.now() - startMs) < MIN_NEXT_LOOP_BUDGET_MS) {
        stoppedByDeadline = true;
        break;
      }
    }

    try {
      const result = await runEngine(userId);
      totalChecked.push(result.checked);
      totalOpened.push(result.opened);
      totalClosed.push(result.closed);
      allErrors.push(...result.errors.map(e => `[${i + 1}] ${e}`));
    } catch (err) {
      allErrors.push(`[${i + 1}] 引擎异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const actualLoops = totalChecked.length;
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  return NextResponse.json({
    success: true,
    data: {
      loops: actualLoops,
      maxLoops,
      intervalMs: interval,
      elapsed: `${elapsed}s`,
      stoppedByDeadline,
      logTtlHours: settingLogTtl,
      checked: totalChecked.reduce((a, b) => a + b, 0),
      opened: totalOpened.reduce((a, b) => a + b, 0),
      closed: totalClosed.reduce((a, b) => a + b, 0),
      perLoop: totalChecked.map((c, i) => ({
        n: i + 1,
        checked: c,
        opened: totalOpened[i],
        closed: totalClosed[i],
      })),
      errors: allErrors.length > 0 ? allErrors : undefined,
    },
  });
}
