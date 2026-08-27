/**
 * 结构分析 API
 *
 * GET /api/structure-analysis?symbol=ETHUSDT&refresh=1&narrative=1
 *
 * 流程：拉三周期 K 线 → 规则引擎算结构（数字层，实时）→ 返回
 *       结构解读（LLM 文案层）只在 narrative=1 时生成（手动触发，省钱省时）
 * 缓存（分两层）：
 *   - structure：60 秒（数字层实时性，同时保护上游 K 线接口）
 *   - narrative：跟随 structure 缓存条目（手动生成后短时间内复用，不重复调 LLM）
 * 保护：requireUser（登录用户）
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { KlineData } from '@/shared/lib/market-data';
import { analyzeStructure, StructureAnalysis } from '@/shared/lib/structure-analysis';
import { generateNarrative, AnalysisNarrative } from '@/shared/lib/analysis-writer';
import { fetchFundingHistory, FundingPoint } from '@/shared/lib/funding-data';
import { llmModelName } from '@/shared/lib/llm-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ==================== K 线获取（多源 fallback） ====================

// 公共数据镜像优先：主站 API 对受限地区（含 Vercel hkg1 香港出口）返回 451，
// data-api.binance.vision 不受地域封锁且服务端出口稳定可达
const KLINES_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
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

// ==================== 缓存（模块级内存，分两层） ====================

interface CacheEntry {
  /** 规则引擎产出的数字层（每次到期重算） */
  structure: StructureAnalysis;
  /** LLM 结构解读（手动触发生成；未生成时为 null） */
  narrative: AnalysisNarrative | null;
  /** narrative 生成时对应的 structure.generatedAt，用于前端标注解读快照时刻 */
  narrativeAt: number | null;
  model: string;
  /** 数字层缓存到期时刻（60s，实时性 + 保护上游） */
  expiresAt: number;
}

/** 数字层缓存 TTL：60 秒（前端 30s 轮询命中率高，K 线拉取最多 1 次/分钟/币） */
const STRUCTURE_TTL_MS = 60 * 1000;

const cache = new Map<string, CacheEntry>();

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
  const wantNarrative = url.searchParams.get('narrative') === '1';

  // 数字层：短缓存命中即返回；但手动要求解读且尚未生成过时，仍需补调 LLM
  const hit = forceRefresh ? null : getCache(symbol);
  if (hit) {
    if (wantNarrative && !hit.narrative) {
      const narrative = await generateNarrative(hit.structure);
      hit.narrative = narrative;
      hit.narrativeAt = Date.now();
      hit.model = narrative.source === 'ai' ? llmModelName() : 'template';
    }
    return apiSuccess({
      ...hit.structure,
      narrative: hit.narrative,
      narrativeAt: hit.narrativeAt,
      narrativeSource: hit.narrative?.source || null,
      model: hit.model,
      cached: true,
    });
  }

  // 并行拉三周期 + 资金费率（费率失败不阻塞，指标降级为"不可用"）
  const [k4h, k1h, k15m, funding] = await Promise.all([
    fetchKlines(symbol, '4h', 300),
    fetchKlines(symbol, '1h', 300),
    fetchKlines(symbol, '15m', 300),
    fetchFundingHistory(symbol).catch(() => [] as FundingPoint[]),
  ]);

  if (k4h.length < 80 || k1h.length < 80 || k15m.length < 80) {
    return apiSuccess({ error: 'KLINE_UNAVAILABLE', message: '行情数据源暂不可用，请稍后重试' }, 200);
  }

  // 规则引擎（数字层，确定性）
  const structure = analyzeStructure({ symbol, k4h, k1h, k15m, funding });

  // 文案层（结构解读）：默认不生成；narrative=1 手动触发时才调 LLM（失败降级模板）
  let narrative: AnalysisNarrative | null = null;
  let narrativeAt: number | null = null;
  let model = 'rule-engine';
  if (wantNarrative) {
    narrative = await generateNarrative(structure);
    narrativeAt = Date.now();
    model = narrative.source === 'ai' ? llmModelName() : 'template';
  }

  const entry: CacheEntry = {
    structure,
    narrative,
    narrativeAt,
    model,
    expiresAt: Date.now() + STRUCTURE_TTL_MS,
  };
  cache.set(symbol, entry);

  return apiSuccess({
    ...structure,
    narrative,
    narrativeAt,
    narrativeSource: narrative?.source || null,
    model: entry.model,
    cached: false,
  });
});
