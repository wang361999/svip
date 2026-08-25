/**
 * AI 分析定时触发端点
 *
 * 由 cron-job.org 单独定时请求，与主引擎分开调用
 * 避免在主引擎的 10 秒限制内挤入 AI 分析
 *
 * 触发方式：cron-job.org 请求此端点
 * 鉴权：URL 参数 ?key= 或 Header X-Engine-Key
 *
 * 流程：
 * 1. 读取 AI 配置
 * 2. 遍历所有 autoTrade 币种
 * 3. 逐个调用 AI 分析，存储结果
 * 4. 如果开启 aiAutoTrade，记录 AI 信号供主引擎使用
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/shared/lib/prisma';
import { settingsService } from '@/features/settings/api/settings.service';
import { analyzeMarketWithAI, parseAiConfig } from '@/shared/lib/ai-analysis';
import { fetchPrice } from '@/shared/lib/market-data';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // AI 分析需要更长时间

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

  // 2. 读取 AI 配置
  const settings = await settingsService.getSettings();
  const config = parseAiConfig(settings as unknown as Record<string, string | null>);

  if (!config.enabled) {
    return NextResponse.json({
      success: true,
      data: { message: 'AI 分析未启用', analyzed: 0 },
    });
  }

  if (!config.apiUrl || !config.apiKey || !config.model) {
    return NextResponse.json({
      success: false,
      error: 'AI 模型配置不完整',
    }, { status: 500 });
  }

  // 3. 获取需要分析的币种（autoTrade 启用的）
  //    按最近分析时间升序（最久没分析的排前面）— 修复固定排序导致排序靠后的币种永远轮不到分析的饿死问题
  const symbols = await prisma.tradingSymbol.findMany({
    where: { active: true, autoTrade: true },
    orderBy: [{ isPopular: 'desc' }, { sortOrder: 'asc' }],
  });

  if (symbols.length === 0) {
    return NextResponse.json({
      success: true,
      data: { message: '没有启用自动交易的币种', analyzed: 0 },
    });
  }

  // 3b. 机会式清理：删除 14 天前的 AI 分析记录（防止 AiAnalysis 表无限膨胀）
  try {
    await prisma.aiAnalysis.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 14 * 24 * 3600 * 1000) } },
    });
  } catch {}

  // 3c. 按最近分析时间升序重排（最久没分析的排前面）
  //     修复：55 秒时间预算只够分析 2-3 个币，固定排序会让排序靠后的币种永远轮不到
  try {
    const latestTimes = await prisma.aiAnalysis.groupBy({
      by: ['symbol'],
      _max: { createdAt: true },
    });
    const timeMap = new Map(latestTimes.map((t) => [t.symbol, t._max.createdAt?.getTime() ?? 0]));
    symbols.sort((a, b) => {
      const ta = timeMap.get(a.symbol) ?? 0; // 从未分析过的最优先
      const tb = timeMap.get(b.symbol) ?? 0;
      if (ta !== tb) return ta - tb;
      return a.sortOrder - b.sortOrder;
    });
  } catch {}

  // 4. URL 参数可指定单个币种（调试用）
  const url = new URL(req.url);
  const targetSymbol = url.searchParams.get('symbol');

  const targetSymbols = targetSymbol
    ? symbols.filter((s) => s.symbol === targetSymbol)
    : symbols;

  // 5. 逐个分析
  const results: { symbol: string; ok: boolean; direction?: string; error?: string }[] = [];
  const startMs = Date.now();
  const SOFT_DEADLINE_MS = 55000; // 55秒软超时

  for (const sym of targetSymbols) {
    // 检查时间预算
    if (Date.now() - startMs > SOFT_DEADLINE_MS) {
      results.push({ symbol: sym.symbol, ok: false, error: '时间预算不足，跳过' });
      break;
    }

    try {
      // 获取当前价格
      const price = await fetchPrice(sym.symbol, sym.okxId);
      if (!price || price <= 0) {
        results.push({ symbol: sym.symbol, ok: false, error: '无法获取价格' });
        continue;
      }

      // 执行 AI 分析
      const result = await analyzeMarketWithAI(
        config,
        sym.symbol,
        sym.okxId,
        sym.label,
        price,
      );

      // 存储分析结果
      await prisma.aiAnalysis.create({
        data: {
          symbol: sym.symbol,
          direction: result.direction,
          confidence: result.confidence,
          summary: result.summary,
          entryPrice: result.entryPrice,
          stopLoss: result.stopLoss,
          takeProfit1: result.takeProfit1,
          takeProfit2: result.takeProfit2,
          reasoning: result.reasoning,
          keyLevels: result.keyLevels ? JSON.stringify(result.keyLevels) : null,
          riskWarning: result.riskWarning,
          provider: result.provider,
          model: result.model,
          rawResponse: result.rawResponse,
        },
      });

      results.push({
        symbol: sym.symbol,
        ok: true,
        direction: result.direction,
      });
    } catch (err) {
      results.push({
        symbol: sym.symbol,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const analyzed = results.filter((r) => r.ok).length;

  return NextResponse.json({
    success: true,
    data: {
      analyzed,
      total: targetSymbols.length,
      elapsed: `${elapsed}s`,
      results,
    },
  });
}
