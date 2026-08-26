/**
 * 结构分析 API
 *
 * GET /api/structure-analysis?symbol=ETHUSDT&refresh=1
 *
 * 流程：拉三周期 K 线 → 规则引擎算结构（数字层）→ LLM 生成解读（失败降级模板）→ 返回
 * 缓存：到下一个 4h 收盘 + 3 分钟（结构数据以 4h 收盘为基准，周期内不变）
 * 保护：requireUser（登录用户）
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { KlineData } from '@/shared/lib/market-data';
import { analyzeStructure, StructureAnalysis } from '@/shared/lib/structure-analysis';
import { generateNarrative, AnalysisNarrative } from '@/shared/lib/analysis-writer';
import { llmModelName } from '@/shared/lib/llm-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ==================== K 线获取（多源 fallback） ====================

const KLINES_HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision', // Binance 官方公共数据镜像（Vercel 出口常被主站拦时用）
  'https://api1.binance.com',
];

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<KlineData[]> {
  for (const host of KLINES_HOSTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length < 50) continue;
      return data.map((k: any[]) => ({
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch {
      continue; // 换下一个源
    }
  }
  return [];
}

// ==================== 缓存（模块级内存） ====================

interface CacheEntry {
  structure: StructureAnalysis;
  narrative: AnalysisNarrative;
  model: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 下一个 4h 收盘时刻 + 3 分钟（UTC 0/4/8/12/16/20 点收盘） */
function nextExpiry(): number {
  const now = Date.now();
  const FOUR_H = 4 * 3600 * 1000;
  const nextBar = Math.ceil((now + 60_000) / FOUR_H) * FOUR_H; // 下一根 4h 开始
  return nextBar + 3 * 60_000; // 收盘后 3 分钟，等数据落库
}

function getCache(symbol: string): CacheEntry | null {
  const entry = cache.get(symbol);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(symbol);
    return null;
  }
  return entry;
}

// ==================== 主逻辑 ====================

export const GET = createHandler(async ({ req }) => {
  requireUser();

  const url = new URL(req.url);
  const symbol = (url.searchParams.get('symbol') || 'ETHUSDT').toUpperCase();
  const forceRefresh = url.searchParams.get('refresh') === '1';

  // 缓存命中（非强制刷新）
  if (!forceRefresh) {
    const hit = getCache(symbol);
    if (hit) {
      return apiSuccess({
        ...hit.structure,
        narrative: hit.narrative,
        narrativeSource: hit.narrative.source,
        model: hit.model,
        cached: true,
      });
    }
  }

  // 并行拉三周期
  const [k4h, k1h, k15m] = await Promise.all([
    fetchKlines(symbol, '4h', 300),
    fetchKlines(symbol, '1h', 300),
    fetchKlines(symbol, '15m', 300),
  ]);

  if (k4h.length < 80 || k1h.length < 80 || k15m.length < 80) {
    return apiSuccess({ error: 'KLINE_UNAVAILABLE', message: '行情数据源暂不可用，请稍后重试' }, 200);
  }

  // 规则引擎（数字层，确定性）
  const structure = analyzeStructure({ symbol, k4h, k1h, k15m });

  // 文案层（AI 优先，失败降级模板）
  const narrative = await generateNarrative(structure);

  const entry: CacheEntry = {
    structure,
    narrative,
    model: narrative.source === 'ai' ? llmModelName() : 'template',
    expiresAt: nextExpiry(),
  };
  cache.set(symbol, entry);

  return apiSuccess({
    ...structure,
    narrative,
    narrativeSource: narrative.source,
    model: entry.model,
    cached: false,
  });
});
