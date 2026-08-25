/**
 * 交易币种管理 API
 * GET  /api/symbols?active=true          - 获取币种列表
 * POST /api/symbols                       - 手动添加币种（管理员）
 * POST /api/symbols?action=import         - 从 Binance 导入热门币对（管理员）
 * PATCH /api/symbols/:id                  - 更新币种（单独路由）
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { apiError } from '@/shared/api/response';
import { prisma } from '@/shared/lib/prisma';
import { fetchPrice } from '@/shared/lib/market-data';
import { z } from 'zod';
import { withZod } from '@/shared/api/validate';

export const dynamic = 'force-dynamic';

const AUTO_TRADE_DEFAULTS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

const FALLBACK_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT',
  'TRXUSDT', 'DOTUSDT', 'BCHUSDT', 'NEARUSDT', 'UNIUSDT', 'APTUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT', 'FILUSDT',
  'ATOMUSDT', 'ETCUSDT', 'INJUSDT', 'TIAUSDT', 'SEIUSDT', 'AAVEUSDT', 'MKRUSDT', 'RNDRUSDT', 'WLDUSDT', 'PEPEUSDT',
].map((symbol, index) => {
  const baseAsset = symbol.replace('USDT', '');
  return {
    symbol,
    baseAsset,
    okxId: `${baseAsset}-USDT`,
    label: `${baseAsset}/USDT`,
    quoteVolume: String(1000000 - index),
  };
});

const createSymbolSchema = z.object({
  symbol: z.string().min(1),        // BTCUSDT
  okxId: z.string().min(1),         // BTC-USDT
  label: z.string().min(1),         // BTC/USDT
  baseAsset: z.string().min(1),     // BTC
  quoteAsset: z.string().default('USDT'),
  pricePrecision: z.number().int().min(0).default(2),
  qtyPrecision: z.number().int().min(0).default(4),
  minQty: z.number().min(0).default(0),
  minNotional: z.number().min(0).default(5),
  active: z.boolean().default(true),
  autoTrade: z.boolean().default(false),
  isPopular: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

/** 按价格量级推断显示精度（无 exchangeInfo 时的兜底 — 低价币不至于全显示成 0.00） */
function inferPricePrecision(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 2;
  if (price >= 100) return 2;
  if (price >= 1) return 4;
  if (price >= 0.01) return 6;
  return 8;
}

function buildSymbolMeta(symbol: string, index: number, price?: number) {
  const baseAsset = symbol.replace('USDT', '');
  return {
    symbol,
    okxId: `${baseAsset}-USDT`,
    label: `${baseAsset}/USDT`,
    baseAsset,
    quoteAsset: 'USDT',
    pricePrecision: inferPricePrecision(price ?? 0),
    qtyPrecision: 4,
    minQty: 0,
    minNotional: 5,
    active: true,
    autoTrade: AUTO_TRADE_DEFAULTS.has(symbol),
    isPopular: index < 10,
    sortOrder: index,
  };
}

async function syncExistingTradeSymbols() {
  const [positionSymbols, tradeSymbols] = await Promise.all([
    prisma.paperPosition.findMany({
      distinct: ['symbol'],
      select: { symbol: true },
    }),
    prisma.paperTrade.findMany({
      distinct: ['symbol'],
      select: { symbol: true },
    }),
  ]);

  const symbols = Array.from(new Set([
    ...positionSymbols.map((p) => p.symbol),
    ...tradeSymbols.map((t) => t.symbol),
  ])).filter((s) => s && s.endsWith('USDT'));

  let created = 0;
  for (let index = 0; index < symbols.length; index++) {
    const symbol = symbols[index];
    const existing = await prisma.tradingSymbol.findUnique({ where: { symbol } });
    if (existing) continue;
    // 拉现价推断显示精度（低价币不会全建成精度2 — 建好后前端展示不截断）
    const baseAsset = symbol.replace('USDT', '');
    const price = (await fetchPrice(symbol, `${baseAsset}-USDT`).catch(() => null)) ?? 0;
    await prisma.tradingSymbol.create({
      data: buildSymbolMeta(symbol, 1000 + index, price),
    });
    created++;
  }
  return created;
}

/**
 * 热门币保障清单：交易页每次拉取 active 列表时幂等补建/标热门。
 * 精度参数取自 Binance exchangeInfo 实测（SNDKB tickSize 0.01 / stepSize 0.0001）。
 */
const HOT_ENSURE_SYMBOLS = [
  // 闪迪（SanDisk 代币化股票，2026-06 币安现货上线）
  {
    symbol: 'SNDKBUSDT', okxId: 'SNDKB-USDT', label: 'SNDKB/USDT', baseAsset: 'SNDKB',
    pricePrecision: 2, qtyPrecision: 4, minQty: 0.0001, sortOrder: 7,
  },
];

/** 进程内只跑一次（幂等：缺失补建，已存在但非热门则标记为热门） */
let hotEnsureDone = false;
async function ensureHotSymbols() {
  if (hotEnsureDone) return;
  for (const s of HOT_ENSURE_SYMBOLS) {
    const existing = await prisma.tradingSymbol.findUnique({ where: { symbol: s.symbol } });
    if (existing) {
      if (!existing.isPopular) {
        await prisma.tradingSymbol.update({ where: { symbol: s.symbol }, data: { isPopular: true } });
      }
      continue;
    }
    await prisma.tradingSymbol.create({
      data: {
        ...s,
        quoteAsset: 'USDT',
        minNotional: 5,
        active: true,
        autoTrade: false, // 代币化股票波动大，默认不参与自动交易，用户可自行开启
        isPopular: true,
      },
    });
  }
  hotEnsureDone = true;
}

/** GET - 获取币种列表 */
export const GET = createHandler(async ({ req }) => {
  const { searchParams } = new URL(req.url);
  const activeOnly = searchParams.get('active') === 'true';
  const popularOnly = searchParams.get('popular') === 'true';

  // 确保历史持仓/交易里已经出现过的币种，也能进入币种管理中心
  if (!activeOnly && !popularOnly) {
    await syncExistingTradeSymbols().catch(() => 0);
  }

  // 交易页拉取 active 列表时，幂等保障热门清单齐全（如新上线的闪迪）
  if (activeOnly) {
    await ensureHotSymbols().catch(() => 0);
  }

  const where: any = {};
  if (activeOnly) where.active = true;
  if (popularOnly) where.isPopular = true;

  const symbols = await prisma.tradingSymbol.findMany({
    where,
    orderBy: [{ isPopular: 'desc' }, { sortOrder: 'asc' }, { label: 'asc' }],
  });

  return apiSuccess(symbols);
});

/** POST - 添加币种 or 从 Binance 导入 */
export const POST = createHandler(async ({ req }) => {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');

  // 从 Binance 导入热门币对
  if (action === 'import') {
    return importFromBinance();
  }

  // 手动添加单个币种
  const body = await req.json();
  const input = withZod(createSymbolSchema, body);

  const existing = await prisma.tradingSymbol.findUnique({
    where: { symbol: input.symbol },
  });
  if (existing) {
    return apiError('SYMBOL_EXISTS', `币种 ${input.symbol} 已存在`, 409);
  }

  const symbol = await prisma.tradingSymbol.create({
    data: input,
  });

  return apiSuccess(symbol);
});

async function importSymbolPairs(
  pairs: Array<{ symbol: string; baseAsset: string; okxId: string; label: string }>,
  source: 'binance' | 'fallback',
) {
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    const { symbol, baseAsset, okxId, label } = pair;

    const existing = await prisma.tradingSymbol.findUnique({
      where: { symbol },
    });
    if (existing) {
      skipped++;
      continue;
    }

    try {
      let pricePrecision = 2;
      let qtyPrecision = 4;
      let minQty = 0;
      let minNotional = 5;

      if (source === 'binance') {
        try {
          const exchangeController = new AbortController();
          const exchangeTimer = setTimeout(() => exchangeController.abort(), 5000);
          const exchangeInfoRes = await fetch(
            `https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`,
            { signal: exchangeController.signal },
          );
          clearTimeout(exchangeTimer);

          if (exchangeInfoRes.ok) {
            const info = await exchangeInfoRes.json();
            const symInfo = info.symbols?.[0];
            if (symInfo) {
              const priceFilter = symInfo.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
              const lotSize = symInfo.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
              const notional = symInfo.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL');

              if (priceFilter?.tickSize) {
                const tickSize = parseFloat(priceFilter.tickSize);
                pricePrecision = tickSize < 1 ? Math.ceil(-Math.log10(tickSize)) : 0;
              }
              if (lotSize?.stepSize) {
                const stepSize = parseFloat(lotSize.stepSize);
                qtyPrecision = stepSize < 1 ? Math.ceil(-Math.log10(stepSize)) : 0;
                minQty = parseFloat(lotSize.minQty) || 0;
              }
              if (notional?.minNotional) {
                minNotional = parseFloat(notional.minNotional) || 5;
              }
            }
          }
        } catch {
          // 精度获取失败使用默认值
        }
      }

      await prisma.tradingSymbol.create({
        data: {
          symbol,
          okxId,
          label,
          baseAsset,
          quoteAsset: 'USDT',
          pricePrecision,
          qtyPrecision,
          minQty,
          minNotional,
          active: true,
          autoTrade: AUTO_TRADE_DEFAULTS.has(symbol),
          isPopular: index < 10,
          sortOrder: index,
        },
      });
      created++;
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    imported: created,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
    totalFromBinance: source === 'binance' ? pairs.length : 0,
    source,
  };
}

/** 从 Binance 导入热门 USDT 币对；如果 Binance 不可用，则使用内置热门列表兜底 */
async function importFromBinance() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr', {
      signal: controller.signal,
      headers: { 'accept': 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      const fallback = await importSymbolPairs(FALLBACK_SYMBOLS, 'fallback');
      return apiSuccess({
        ...fallback,
        warning: `Binance API 返回 ${res.status}，已改用内置热门币种列表`,
      });
    }

    const data = await res.json() as Array<{
      symbol: string;
      quoteVolume: string;
      lastPrice: string;
    }>;

    // 筛选 USDT 交易对，按 24h 成交额排序，取前 50
    const usdtPairs = data
      .filter((d) => d.symbol.endsWith('USDT') && !d.symbol.includes('UP') && !d.symbol.includes('DOWN') && !d.symbol.startsWith('USD'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 50)
      .map((pair) => {
        const baseAsset = pair.symbol.replace('USDT', '');
        return {
          symbol: pair.symbol,
          baseAsset,
          okxId: `${baseAsset}-USDT`,
          label: `${baseAsset}/USDT`,
        };
      });

    return apiSuccess(await importSymbolPairs(usdtPairs, 'binance'));
  } catch (err) {
    const fallback = await importSymbolPairs(FALLBACK_SYMBOLS, 'fallback');
    return apiSuccess({
      ...fallback,
      warning: `Binance API 不可用，已改用内置热门币种列表`,
    });
  }
}
