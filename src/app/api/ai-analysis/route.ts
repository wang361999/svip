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

/** 将数据库 meta TEXT 列安全解析为 meta 对象（regime / checklist / atr15m / evidence / plans / noTradeZone） */
function parseMeta(raw: string | null): {
  regime: string;
  aPlusChecklist: Record<string, boolean>;
  atr15m: number | null;
  evidence?: { dimension: string; data: string; signal: string; note: string }[];
  plans?: {
    name: string; style: string; recommended: boolean;
    entry: number | null; stopLoss: number | null;
    takeProfit1: number | null; takeProfit2: number | null;
    rr1: number | null; rr2: number | null; condition: string;
    entryType?: 'limit_pull' | 'limit_break' | 'market';
    cancelIf?: { price: number; reason: string } | null;
    validFor?: string;
  }[];
  noTradeZone?: { from: number; to: number; reason: string } | null;
  gann?: {
    swingHigh: number; swingLow: number; rangePct: number;
    positionPct: number; zoneLabel: string;
    levels: { division: string; index: number; price: number; distPct: number; meaning: string }[];
  } | null;
  fractal?: {
    lastTop: { price: number; barsAgo: number; strong: boolean; nearDivision: string } | null;
    lastBottom: { price: number; barsAgo: number; strong: boolean; nearDivision: string } | null;
    topBroken: boolean;
    bottomBroken: boolean;
  } | null;
  structure?: {
    m15: 'up' | 'down' | 'range' | 'unknown';
    h1: 'up' | 'down' | 'range' | 'unknown';
    h4: 'up' | 'down' | 'range' | 'unknown';
  } | null;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    // 证据表清洗
    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence
          .filter((e: any) => e != null && typeof e === 'object')
          .slice(0, 8)
          .map((e: any) => ({
            dimension: String(e.dimension || '未命名'),
            data: String(e.data || ''),
            signal: ['bullish', 'bearish', 'neutral'].includes(e.signal) ? e.signal : 'neutral',
            note: String(e.note || ''),
          }))
      : [];

    // 双计划清洗
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const plans = Array.isArray(parsed.plans)
      ? parsed.plans
          .filter((p: any) => p != null && typeof p === 'object')
          .slice(0, 2)
          .map((p: any) => ({
            name: String(p.name || '计划'),
            style: String(p.style || ''),
            recommended: p.recommended === true,
            entry: num(p.entry),
            stopLoss: num(p.stopLoss),
            takeProfit1: num(p.takeProfit1),
            takeProfit2: num(p.takeProfit2),
            rr1: Number.isFinite(Number(p.rr1)) ? Number(Number(p.rr1).toFixed(1)) : null,
            rr2: Number.isFinite(Number(p.rr2)) ? Number(Number(p.rr2).toFixed(1)) : null,
            condition: String(p.condition || ''),
            entryType: ['limit_pull', 'limit_break', 'market'].includes(p.entryType) ? p.entryType : undefined,
            cancelIf:
              p.cancelIf && typeof p.cancelIf === 'object' && Number(p.cancelIf.price) > 0
                ? { price: Number(p.cancelIf.price), reason: String(p.cancelIf.reason || '') }
                : null,
            validFor: String(p.validFor || ''),
          }))
      : [];

    // 不做区清洗
    let noTradeZone: { from: number; to: number; reason: string } | null = null;
    if (parsed.noTradeZone && typeof parsed.noTradeZone === 'object') {
      const from = num(parsed.noTradeZone.from);
      const to = num(parsed.noTradeZone.to);
      if (from != null && to != null) {
        noTradeZone = { from: Math.min(from, to), to: Math.max(from, to), reason: String(parsed.noTradeZone.reason || '') };
      }
    }

    // 江恩八分位透传（服务端客观计算回填的 meta，非 AI 生成）
    let gann: {
      swingHigh: number; swingLow: number; rangePct: number;
      positionPct: number; zoneLabel: string;
      levels: { division: string; index: number; price: number; distPct: number; meaning: string }[];
    } | null = null;
    if (parsed.gann && typeof parsed.gann === 'object' && Array.isArray(parsed.gann.levels)) {
      const levels = parsed.gann.levels
        .filter((l: any) => l != null && typeof l === 'object' && Number(l.price) > 0)
        .slice(0, 8)
        .map((l: any) => ({
          division: String(l.division || ''),
          index: Number(l.index) > 0 ? Number(l.index) : 0,
          price: Number(l.price),
          distPct: Number.isFinite(Number(l.distPct)) ? Number(l.distPct) : 0,
          meaning: String(l.meaning || ''),
        }));
      if (levels.length > 0 && num(parsed.gann.swingHigh) && num(parsed.gann.swingLow)) {
        gann = {
          swingHigh: num(parsed.gann.swingHigh)!,
          swingLow: num(parsed.gann.swingLow)!,
          rangePct: Number(parsed.gann.rangePct) || 0,
          positionPct: Number.isFinite(Number(parsed.gann.positionPct)) ? Number(parsed.gann.positionPct) : 50,
          zoneLabel: String(parsed.gann.zoneLabel || ''),
          levels,
        };
      }
    }

    // 顶底分型透传（服务端客观计算回填的 meta，非 AI 生成）
    let fractal: {
      lastTop: { price: number; barsAgo: number; strong: boolean; nearDivision: string } | null;
      lastBottom: { price: number; barsAgo: number; strong: boolean; nearDivision: string } | null;
      topBroken: boolean;
      bottomBroken: boolean;
    } | null = null;
    if (parsed.fractal && typeof parsed.fractal === 'object') {
      const pt = (x: unknown) =>
        x && typeof x === 'object' && Number((x as any).price) > 0
          ? {
              price: Number((x as any).price),
              barsAgo: Number((x as any).barsAgo) > 0 ? Number((x as any).barsAgo) : 0,
              strong: (x as any).strong === true,
              nearDivision: String((x as any).nearDivision || ''),
            }
          : null;
      fractal = {
        lastTop: pt(parsed.fractal.lastTop),
        lastBottom: pt(parsed.fractal.lastBottom),
        topBroken: parsed.fractal.topBroken === true,
        bottomBroken: parsed.fractal.bottomBroken === true,
      };
    }

    // 多周期结构透传（服务端客观计算回填的 meta，非 AI 生成；d1=日线趋势锚，旧记录可能缺失）
    let structure: {
      m15: 'up' | 'down' | 'range' | 'unknown';
      h1: 'up' | 'down' | 'range' | 'unknown';
      h4: 'up' | 'down' | 'range' | 'unknown';
      d1: 'up' | 'down' | 'range' | 'unknown';
    } | null = null;
    if (parsed.structure && typeof parsed.structure === 'object') {
      const trendOf = (v: unknown): 'up' | 'down' | 'range' | 'unknown' =>
        v === 'up' || v === 'down' || v === 'range' ? v : 'unknown';
      structure = {
        m15: trendOf(parsed.structure.m15),
        h1: trendOf(parsed.structure.h1),
        h4: trendOf(parsed.structure.h4),
        d1: trendOf(parsed.structure.d1),
      };
    }

    // A+ 清单透传（引擎闸门用，规则引擎确定性计算）
    let aPlusChecklist: Record<string, boolean> | null = null;
    if (parsed.aPlusChecklist && typeof parsed.aPlusChecklist === 'object') {
      aPlusChecklist = parsed.aPlusChecklist as Record<string, boolean>;
    }

    // 趋势回调策略状态透传（前端展示挂单生命周期）
    let strategy: Record<string, unknown> | null = null;
    if (parsed.strategy && typeof parsed.strategy === 'object') {
      strategy = parsed.strategy as Record<string, unknown>;
    }

    // 快引擎（EMA价值区回踩收复）状态透传（前端展示快进快出生命周期）
    let fastStrategy: Record<string, unknown> | null = null;
    if (parsed.fastStrategy && typeof parsed.fastStrategy === 'object') {
      fastStrategy = parsed.fastStrategy as Record<string, unknown>;
    }

    return {
      regime: String(parsed.regime || 'unknown'),
      aPlusChecklist:
        parsed.aPlusChecklist && typeof parsed.aPlusChecklist === 'object'
          ? parsed.aPlusChecklist
          : {},
      atr15m: typeof parsed.atr15m === 'number' && Number.isFinite(parsed.atr15m) ? parsed.atr15m : null,
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(plans.length > 0 ? { plans } : {}),
      ...(noTradeZone ? { noTradeZone } : {}),
      ...(gann ? { gann } : {}),
      ...(fractal ? { fractal } : {}),
      ...(structure ? { structure } : {}),
      ...(aPlusChecklist ? { aPlusChecklist } : {}),
      ...(strategy ? { strategy } : {}),
      ...(fastStrategy ? { fastStrategy } : {}),
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
  /** 手动「立即分析」= true 时绕过冷却强制重新分析 */
  force: z.boolean().optional(),
});

/**
 * 分析冷却（Vercel 免费 CPU 配额优化）：
 * - 自动分析间隔 ≥ 30 秒，冷却 25 秒不影响正常节奏，只拦多标签页/切币回切等重复触发
 * - 进行中的同币种分析共享同一次 AI 调用，避免并发重复计算
 */
const ANALYSIS_COOLDOWN_MS = 25_000;
const inflightAnalyses = new Map<string, Promise<AnalysisResponse>>();

/** 数据库记录 → 前端响应结构（TEXT 列解析 + 字段对齐） */
type AnalysisRecord = {
  id: string;
  symbol: string;
  direction: string;
  confidence: number;
  summary: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  reasoning: string;
  keyLevels: string | null;
  meta: string | null;
  riskWarning: string | null;
  provider: string | null;
  model: string | null;
  createdAt: Date;
};
type AnalysisResponse = Omit<AnalysisRecord, 'keyLevels' | 'meta' | 'createdAt'> & {
  keyLevels: { price: number; type: string; note: string }[] | null;
  meta: ReturnType<typeof parseMeta>;
  createdAt: string;
};

function recordToResponse(rec: AnalysisRecord): AnalysisResponse {
  return {
    id: rec.id,
    symbol: rec.symbol,
    direction: rec.direction,
    confidence: rec.confidence,
    summary: rec.summary,
    entryPrice: rec.entryPrice,
    stopLoss: rec.stopLoss,
    takeProfit1: rec.takeProfit1,
    takeProfit2: rec.takeProfit2,
    reasoning: rec.reasoning,
    keyLevels: parseKeyLevels(rec.keyLevels),
    meta: parseMeta(rec.meta),
    riskWarning: rec.riskWarning,
    provider: rec.provider,
    model: rec.model,
    createdAt: rec.createdAt.toISOString(),
  };
}

export const POST = createHandler(async ({ req }) => {
  requireUser();

  // 自迁移：确保 outcome 系列列存在（幂等，每个实例只跑一次）
  await ensureAiAnalysisColumns().catch(() => {});

  const input = analyzeSchema.parse(await req.json());

  // 1. 读取 AI 配置（只需总开关 — 信号由规则引擎生成，不再依赖外部 AI 接口地址/密钥/模型）
  const settings = await settingsService.getSettings();
  const config = parseAiConfig(settings as unknown as Record<string, string | null>);

  if (!config.enabled) {
    return apiError('AI_DISABLED', 'AI 分析功能未启用，请在后台设置中开启', 400);
  }

  // 1.5 并发去重：同币种分析进行中，直接共享这一次的结果
  const inflight = inflightAnalyses.get(input.symbol);
  if (inflight) {
    return apiSuccess(await inflight);
  }

  // 1.6 冷却：非 force 请求在冷却期内直接返回上次结果（自动触发防重复；手动分析传 force 绕过）
  if (!input.force) {
    const latest = await prisma.aiAnalysis.findFirst({
      where: { symbol: input.symbol },
      orderBy: { createdAt: 'desc' },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < ANALYSIS_COOLDOWN_MS) {
      return apiSuccess(recordToResponse(latest));
    }
  }

  // 2. 执行 AI 分析（登记 in-flight，期间到达的同币种请求共享）
  const task = (async (): Promise<AnalysisResponse> => {
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
      throw new Error(`AI 分析失败: ${message}`);
    }

    // 3. 存储分析结果（rawResponse 为调试字段且无读取方，不再每次落库，省序列化与写入）
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
        meta: JSON.stringify(result.meta),
        riskWarning: result.riskWarning,
        provider: result.provider,
        model: result.model,
        rawResponse: null,
      },
    });

    // 4. 返回结果（不含 rawResponse，减少传输量）
    return recordToResponse(saved);
  })();

  inflightAnalyses.set(input.symbol, task);
  try {
    return apiSuccess(await task);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError('AI_ANALYSIS_FAILED', message, 500);
  } finally {
    inflightAnalyses.delete(input.symbol);
  }
});

