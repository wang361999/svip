/**
 * AI 行情分析 API
 *
 * GET  /api/ai-analysis?symbol=ETHUSDT  — 获取指定币种的最新 AI 分析
 * POST /api/ai-analysis                  — 触发新的 AI 分析 { symbol, okxId, label }
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { z } from 'zod';
import { prisma } from '@/shared/lib/prisma';
import { settingsService } from '@/features/settings/api/settings.service';
import { analyzeMarketWithAI, parseAiConfig, type AiAnalysisResult } from '@/shared/lib/ai-analysis';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** GET — 获取最新分析记录 */
export const GET = createHandler(async ({ req }) => {
  requireUser();

  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol');

  if (!symbol) {
    return apiError('VALIDATION_ERROR', '缺少 symbol 参数', 400);
  }

  // 获取该币种最新的一条分析记录
  const latest = await prisma.aiAnalysis.findFirst({
    where: { symbol },
    orderBy: { createdAt: 'desc' },
  });

  // 获取近 20 条历史
  const history = await prisma.aiAnalysis.findMany({
    where: { symbol },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      direction: true,
      confidence: true,
      summary: true,
      entryPrice: true,
      stopLoss: true,
      takeProfit1: true,
      takeProfit2: true,
      createdAt: true,
    },
  });

  return apiSuccess({
    latest: latest
      ? {
          id: latest.id,
          symbol: latest.symbol,
          direction: latest.direction,
          confidence: latest.confidence,
          summary: latest.summary,
          entryPrice: latest.entryPrice,
          stopLoss: latest.stopLoss,
          takeProfit1: latest.takeProfit1,
          takeProfit2: latest.takeProfit2,
          reasoning: latest.reasoning,
          keyLevels: latest.keyLevels,
          riskWarning: latest.riskWarning,
          provider: latest.provider,
          model: latest.model,
          createdAt: latest.createdAt.toISOString(),
        }
      : null,
    history,
  });
});

/** POST — 触发新的 AI 分析 */
const analyzeSchema = z.object({
  symbol: z.string().min(1),
  okxId: z.string().min(1),
  label: z.string().min(1),
  currentPrice: z.number().positive().optional(),
});

export const POST = createHandler(async ({ req }) => {
  requireUser();

  const input = analyzeSchema.parse(await req.json());

  // 1. 读取 AI 配置
  const settings = await settingsService.getSettings();
  const config = parseAiConfig(settings as unknown as Record<string, string | null>);

  if (!config.enabled) {
    return apiError('AI_DISABLED', 'AI 分析功能未启用，请在后台设置中开启', 400);
  }
  if (!config.apiUrl || !config.apiKey || !config.model) {
    return apiError('AI_NOT_CONFIGURED', 'AI 模型配置不完整，请检查 API 地址、Key 和模型名称', 400);
  }

  // 2. 执行 AI 分析
  let result: AiAnalysisResult;
  try {
    result = await analyzeMarketWithAI(
      config,
      input.symbol,
      input.okxId,
      input.label,
      input.currentPrice,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError('AI_ANALYSIS_FAILED', `AI 分析失败: ${message}`, 500);
  }

  // 3. 存储分析结果
  const saved = await prisma.aiAnalysis.create({
    data: {
      symbol: input.symbol,
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

  // 4. 返回结果（不含 rawResponse，减少传输量）
  return apiSuccess({
    id: saved.id,
    symbol: saved.symbol,
    direction: saved.direction,
    confidence: saved.confidence,
    summary: saved.summary,
    entryPrice: saved.entryPrice,
    stopLoss: saved.stopLoss,
    takeProfit1: saved.takeProfit1,
    takeProfit2: saved.takeProfit2,
    reasoning: saved.reasoning,
    keyLevels: result.keyLevels,
    riskWarning: saved.riskWarning,
    provider: saved.provider,
    model: saved.model,
    createdAt: saved.createdAt.toISOString(),
  });
});
