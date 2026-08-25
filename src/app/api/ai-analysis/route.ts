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
import { ensureAiAnalysisColumns } from '@/shared/lib/ai-feedback';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** GET — 获取最新分析记录 */
export const GET = createHandler(async ({ req }) => {
  requireUser();

  // 自迁移：确保 outcome 系列列存在（幂等，每个实例只跑一次）
  await ensureAiAnalysisColumns().catch(() => {});

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

  // 读取 AI 配置中的分析间隔（秒），供前端倒计时使用
  let analysisIntervalSec = 30;
  try {
    const settings = await settingsService.getSettings();
    const cfg = parseAiConfig(settings as unknown as Record<string, string | null>);
    analysisIntervalSec = cfg.analysisInterval > 0 ? cfg.analysisInterval : 30;
  } catch {}

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
          // 数据库以 TEXT 存储 JSON，必须解析后返回；前端直接 .map() 会崩溃
          keyLevels: parseKeyLevels(latest.keyLevels),
          pullback: parsePullback(latest.pullback),
          meta: parseMeta(latest.meta),
          riskWarning: latest.riskWarning,
          provider: latest.provider,
          model: latest.model,
          createdAt: latest.createdAt.toISOString(),
        }
      : null,
    history,
    analysisIntervalSec,
  });
});

/** 将数据库 TEXT 列安全解析为 keyLevels 数组 */
function parseKeyLevels(raw: string | null): { price: number; type: string; note: string }[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((lv: unknown) => lv != null && typeof lv === 'object')
      .slice(0, 8)
      .map((lv: any) => ({
        price: Number(lv.price) || 0,
        type: String(lv.type || '未知'),
        note: String(lv.note || ''),
      }));
  } catch {
    return null;
  }
}

/** 将数据库 TEXT 列安全解析为 pullback 对象（回调预判） */
function parsePullback(raw: string | null): NonNullable<AiAnalysisResult['pullback']> | null {
  if (!raw) return null;
  try {
    const pb = JSON.parse(raw);
    if (!pb || typeof pb !== 'object') return null;
    const expected = ['high', 'medium', 'low', 'none'].includes(pb.expected) ? pb.expected : 'none';
    const targets = Array.isArray(pb.targets)
      ? pb.targets
          .filter((t: any) => t != null && typeof t === 'object' && Number(t.price) > 0)
          .slice(0, 3)
          .map((t: any) => ({
            price: Number(t.price),
            strength: ['strong', 'medium', 'weak'].includes(t.strength) ? t.strength : 'medium',
            basis: String(t.basis || '未标注依据'),
          }))
      : [];
    return {
      expected,
      trigger: String(pb.trigger || ''),
      targets,
      invalidation: Number(pb.invalidation) > 0 ? Number(pb.invalidation) : null,
      rationale: String(pb.rationale || ''),
    };
  } catch {
    return null;
  }
}

/** 将数据库 TEXT 列安全解析为 meta 对象（regime / checklist / atr15m） */
function parseMeta(raw: string | null): {
  regime: string;
  aPlusChecklist: Record<string, boolean>;
  atr15m: number | null;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      regime: String(parsed.regime || 'unknown'),
      aPlusChecklist:
        parsed.aPlusChecklist && typeof parsed.aPlusChecklist === 'object'
          ? parsed.aPlusChecklist
          : {},
      atr15m: typeof parsed.atr15m === 'number' && Number.isFinite(parsed.atr15m) ? parsed.atr15m : null,
    };
  } catch {
    return null;
  }
}

/** POST — 触发新的 AI 分析 */
const analyzeSchema = z.object({
  symbol: z.string().min(1),
  okxId: z.string().min(1),
  label: z.string().min(1),
  currentPrice: z.number().positive().optional(),
});

export const POST = createHandler(async ({ req }) => {
  requireUser();

  // 自迁移：确保 outcome 系列列存在（幂等，每个实例只跑一次）
  await ensureAiAnalysisColumns().catch(() => {});

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
      pullback: result.pullback ? JSON.stringify(result.pullback) : null,
      meta: JSON.stringify(result.meta),
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
    pullback: result.pullback,
    meta: result.meta,
    riskWarning: saved.riskWarning,
    provider: saved.provider,
    model: saved.model,
    createdAt: saved.createdAt.toISOString(),
  });
});
