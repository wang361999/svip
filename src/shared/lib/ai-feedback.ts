/**
 * AI 预测反馈闭环
 *
 * 核心思想：LLM 无状态，不喂历史它永远不「长记性」。
 * 1. evaluatePendingPredictions(): 每条 AI 分析在 N 分钟后用真实行情验证
 *    （触止损/触止盈1/触止盈2/到期），结果写回 AiAnalysis.outcome
 * 2. getRecentFeedbackText(): 把「你最近 10 次预测 X 对 Y 错」注入下次 prompt
 * 3. getCalibratedThreshold(): 按模型历史战绩动态校准自动开仓的置信度门槛
 *
 * 评估口径（保守）：
 * - 多单：K线 low <= 止损 视为触损；high >= 止盈 视为触盈；空单反向
 * - 同一根 K 线同时触及损与盈：无法判断先后，按触损计（宁可错杀不可乐观）
 * - 到期未触任何价位：按方向对错判定（涨幅 >= 0.2% 才算有效方向）
 * - neutral 无可验证内容，直接标记跳过
 */
import { prisma } from './prisma';
import { fetchKlines } from './market-data';

// ==================== 自迁移（幂等，无需人工改库） ====================
/**
 * AiAnalysis 表自动补齐反馈闭环所需列（outcome 系列）。
 * 设计：SQL 全部幂等（IF NOT EXISTS），模块级标记保证每个实例只跑一次；
 * 首次请求时自动执行，之后零开销。失败静默（列缺失时后续查询会自然降级）。
 */
let migratePromise: Promise<void> | null = null;

/** 自迁移入口（幂等）：任何访问 AiAnalysis 的路由都应先 await 它 */
export function ensureAiAnalysisColumns(): Promise<void> {
  if (!migratePromise) {
    migratePromise = (async () => {
      const stmts = [
        `CREATE TABLE IF NOT EXISTS "AiAnalysis" (
          "id" TEXT NOT NULL,
          "symbol" TEXT NOT NULL,
          "direction" TEXT NOT NULL,
          "confidence" INTEGER NOT NULL,
          "summary" TEXT NOT NULL,
          "entryPrice" DOUBLE PRECISION,
          "stopLoss" DOUBLE PRECISION,
          "takeProfit1" DOUBLE PRECISION,
          "takeProfit2" DOUBLE PRECISION,
          "reasoning" TEXT NOT NULL,
          "keyLevels" TEXT,
          "meta" TEXT,
          "riskWarning" TEXT,
          "provider" TEXT,
          "model" TEXT,
          "rawResponse" TEXT,
          "outcome" TEXT,
          "outcomePrice" DOUBLE PRECISION,
          "outcomeAt" TIMESTAMP(3),
          "outcomeNote" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
        )`,
        `CREATE INDEX IF NOT EXISTS "AiAnalysis_symbol_idx" ON "AiAnalysis"("symbol")`,
        `CREATE INDEX IF NOT EXISTS "AiAnalysis_createdAt_idx" ON "AiAnalysis"("createdAt")`,
        `CREATE INDEX IF NOT EXISTS "AiAnalysis_direction_idx" ON "AiAnalysis"("direction")`,
        `CREATE INDEX IF NOT EXISTS "AiAnalysis_outcome_idx" ON "AiAnalysis"("outcome")`,
        `ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "keyLevels" TEXT`,
        `ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "pullback" TEXT`,
        `ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "meta" TEXT`,
        `ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "outcome" TEXT`,
        `ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "outcomePrice" DOUBLE PRECISION`,
        `ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "outcomeAt" TIMESTAMP(3)`,
        `ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "outcomeNote" TEXT`,
      ];
      for (const sql of stmts) {
        try {
          await prisma.$executeRawUnsafe(sql);
        } catch {
          // 单条失败不阻断（如权限不足时静默跳过，靠 Neon 手动兜底）
        }
      }
    })();
  }
  return migratePromise;
}

/** 分析生成后等待多少分钟再评估（给行情走出来的时间） */
export const EVAL_DELAY_MIN = 30;
/** 评估窗口：超过此时长仍未触价位的按到期处理（小时） */
export const EVAL_WINDOW_HOURS = 4;
/** 单轮最多评估条数（防雪崩） */
const EVAL_BATCH = 30;

type Outcome = 'hit_tp1' | 'hit_tp2' | 'hit_sl' | 'expired' | 'correct' | 'wrong' | 'neutral_skip';

interface EvalResult {
  outcome: Outcome;
  outcomePrice: number;
  note: string;
}

/** 判定单条预测的结果（传入分析生成之后的 5m K 线序列） */
function judgePrediction(
  direction: string,
  entryPrice: number | null,
  stopLoss: number | null,
  takeProfit1: number | null,
  takeProfit2: number | null,
  klines: { time: number; open: number; high: number; low: number; close: number }[],
): EvalResult | null {
  const last = klines[klines.length - 1];
  const basePrice = entryPrice && entryPrice > 0 ? entryPrice : klines[0]?.open ?? last.close;

  const isLong = direction === 'long';

  // 逐根 K 线按时间顺序扫描，先触哪个算哪个
  for (const k of klines) {
    const touchSl = stopLoss != null && (isLong ? k.low <= stopLoss : k.high >= stopLoss);
    const touchTp1 = takeProfit1 != null && (isLong ? k.high >= takeProfit1 : k.low <= takeProfit1);
    const touchTp2 = takeProfit2 != null && (isLong ? k.high >= takeProfit2 : k.low <= takeProfit2);
    const touchTp = touchTp2 || touchTp1;

    if (touchSl && touchTp) {
      // 同根 K 线都触了：无法判断先后，保守按触损
      return { outcome: 'hit_sl', outcomePrice: last.close, note: `单根K线同时触及损与盈，保守计触损（评估价 ${last.close}）` };
    }
    if (touchSl) {
      return { outcome: 'hit_sl', outcomePrice: last.close, note: '行情先触及止损无效点' };
    }
    if (touchTp2) {
      return { outcome: 'hit_tp2', outcomePrice: last.close, note: '触及第二止盈目标' };
    }
    if (touchTp1) {
      return { outcome: 'hit_tp1', outcomePrice: last.close, note: '触及第一止盈目标' };
    }
  }

  // 到期未触价位：按方向有效性判定（需 >= 0.2% 才算真方向，避免噪音）
  const movePct = ((last.close - basePrice) / basePrice) * 100;
  const dirOk = isLong ? movePct >= 0.2 : movePct <= -0.2;
  const mins = klines.length * 5;
  return {
    outcome: dirOk ? 'correct' : 'wrong',
    outcomePrice: last.close,
    note: `${mins} 分钟内未触任何价位，期间波动 ${movePct.toFixed(2)}%（相对入场），方向${dirOk ? '正确' : '错误'}`,
  };
}

/**
 * 评估所有到期未评估的预测（入口：AI 分析触发时顺手调用 / 引擎轮询时调用）
 * @returns 本轮评估条数
 */
export async function evaluatePendingPredictions(): Promise<number> {
  await ensureAiAnalysisColumns().catch(() => {});
  const cutoff = new Date(Date.now() - EVAL_DELAY_MIN * 60_000);
  const expireBefore = new Date(Date.now() - EVAL_WINDOW_HOURS * 3600_000);

  // neutral 直接跳过（无可验证内容），避免反复扫描
  await prisma.aiAnalysis.updateMany({
    where: { outcome: null, direction: 'neutral', createdAt: { lt: cutoff } },
    data: { outcome: 'neutral_skip', outcomeAt: new Date() },
  });

  const pending = await prisma.aiAnalysis.findMany({
    where: {
      outcome: null,
      direction: { in: ['long', 'short'] },
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: EVAL_BATCH,
    select: {
      id: true, symbol: true, direction: true,
      entryPrice: true, stopLoss: true, takeProfit1: true, takeProfit2: true, createdAt: true,
    },
  });

  let evaluated = 0;
  for (const p of pending) {
    try {
      const trading = await prisma.tradingSymbol.findUnique({
        where: { symbol: p.symbol },
        select: { okxId: true },
      });
      const okxId = trading?.okxId || `${p.symbol.replace(/USDT$/, '')}-USDT`;

      // 5m × 200 根 ≈ 16.6 小时，足够覆盖评估窗口
      const klines = await fetchKlines(p.symbol, okxId, '5m', 200);
      const since = p.createdAt.getTime();
      const after = klines.filter((k) => k.time >= since);

      // 评估窗口已过的：用窗口内全部K线判定到期
      const isExpired = p.createdAt < expireBefore;
      const windowBars = isExpired
        ? after.slice(0, Math.ceil((EVAL_WINDOW_HOURS * 60) / 5))
        : after;

      if (windowBars.length === 0) continue; // K线未覆盖，下轮再试

      const result = judgePrediction(
        p.direction, p.entryPrice, p.stopLoss, p.takeProfit1, p.takeProfit2, windowBars,
      );
      if (!result) continue;

      await prisma.aiAnalysis.update({
        where: { id: p.id },
        data: {
          outcome: result.outcome,
          outcomePrice: result.outcomePrice,
          outcomeAt: new Date(),
          outcomeNote: result.note,
        },
      });
      evaluated++;
    } catch {
      // 单条失败不影响其它
    }
  }
  return evaluated;
}

/** 判定结果是否算「对」 */
function isWin(outcome: string | null): boolean {
  return outcome === 'hit_tp1' || outcome === 'hit_tp2' || outcome === 'correct';
}

/**
 * 构建近期战绩文本（注入 prompt 的反馈闭环）
 * 优先取同币种，不足用全局补齐
 */
export async function getRecentFeedbackText(symbol: string): Promise<string> {
  await ensureAiAnalysisColumns().catch(() => {});
  const PICK = 10;
  const own = await prisma.aiAnalysis.findMany({
    where: { symbol, outcome: { in: ['hit_tp1', 'hit_tp2', 'hit_sl', 'correct', 'wrong'] } },
    orderBy: { createdAt: 'desc' },
    take: PICK,
    select: { symbol: true, direction: true, confidence: true, outcome: true, outcomeNote: true, createdAt: true },
  });
  let records = own;
  if (own.length < PICK) {
    const others = await prisma.aiAnalysis.findMany({
      where: {
        symbol: { not: symbol },
        outcome: { in: ['hit_tp1', 'hit_tp2', 'hit_sl', 'correct', 'wrong'] },
      },
      orderBy: { createdAt: 'desc' },
      take: PICK - own.length,
      select: { symbol: true, direction: true, confidence: true, outcome: true, outcomeNote: true, createdAt: true },
    });
    records = [...own, ...others];
  }

  if (records.length === 0) {
    return '=== 你的近期预测战绩 ===\n暂无已复盘记录（系统刚开始跟踪），按你的标准判断即可。';
  }

  const wins = records.filter((r) => isWin(r.outcome)).length;
  const winRate = Math.round((wins / records.length) * 100);

  const outcomeLabel: Record<string, string> = {
    hit_tp1: '✓ 触止盈1',
    hit_tp2: '✓ 触止盈2',
    hit_sl: '✗ 触止损',
    correct: '✓ 方向对',
    wrong: '✗ 方向错',
  };

  const lines = records.slice(0, 10).map((r) => {
    const t = new Date(r.createdAt);
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    const dir = r.direction === 'long' ? '做多' : '做空';
    const mark = isWin(r.outcome) ? '✓' : '✗';
    return `- ${hh}:${mm}(UTC) ${r.symbol} ${dir} 置信${r.confidence} → ${outcomeLabel[r.outcome || ''] || r.outcome} ${mark}${r.outcomeNote ? `（${r.outcomeNote}）` : ''}`;
  });

  // 错误模式归纳：被扫损占比高 = 提示止损太近/碎波误判
  const slCount = records.filter((r) => r.outcome === 'hit_sl').length;
  const wrongCount = records.filter((r) => r.outcome === 'wrong').length;
  const hints: string[] = [];
  if (records.length >= 5 && slCount / records.length >= 0.4) {
    hints.push('你近期被扫损比例偏高 — 检查是否把止损设得太近、或把碎波误判成了趋势');
  }
  if (records.length >= 5 && wrongCount / records.length >= 0.4) {
    hints.push('你近期方向判断错误率高 — 在信号矛盾时优先给 neutral，不要强行选边');
  }
  if (winRate >= 60 && records.length >= 5) {
    hints.push('近期战绩良好，保持当前严谨度即可，不要因连胜而放宽标准');
  }

  return `=== 你的近期预测战绩（系统复盘，真实结果） ===
最近 ${records.length} 次（优先本币种）：${wins} 对 ${records.length - wins} 错，胜率 ${winRate}%
${lines.join('\n')}
${hints.length > 0 ? `战绩提示：${hints.join('；')}` : ''}
要求：认真吸收以上错误模式。若近期同类错误频发，主动下调置信度或给 neutral；战绩是真实复盘，不是让你机械跟随。`;
}

/**
 * 置信度动态校准：按该模型已复盘记录计算实际胜率
 * 返回「该模型历史胜率 >= 50% 所需的最低置信度」，供引擎提高开仓门槛
 */
export async function getCalibratedThreshold(
  model: string | null,
  baseThreshold: number,
): Promise<{ threshold: number; winRate: number | null; sample: number }> {
  await ensureAiAnalysisColumns().catch(() => {});
  const records = await prisma.aiAnalysis.findMany({
    where: {
      model: model || undefined,
      outcome: { in: ['hit_tp1', 'hit_tp2', 'hit_sl', 'correct', 'wrong'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { confidence: true, outcome: true },
  });

  // 样本不足不校准（避免小样本过拟合）
  if (records.length < 8) {
    return { threshold: baseThreshold, winRate: null, sample: records.length };
  }

  const overallWinRate = records.filter((r) => isWin(r.outcome)).length / records.length;

  // 找到使胜率 >= 50% 的最低置信度档（从高到低试探）
  const bands = [90, 80, 70, 60];
  for (const b of bands) {
    const subset = records.filter((r) => r.confidence >= b);
    if (subset.length >= 5) {
      const wr = subset.filter((r) => isWin(r.outcome)).length / subset.length;
      if (wr >= 0.5) {
        // 校准门槛不低于基础门槛（历史好不能放松纪律，只收紧）
        return { threshold: Math.max(baseThreshold, b), winRate: Number((wr * 100).toFixed(0)), sample: subset.length };
      }
    }
  }

  // 所有档位胜率都 < 50%：提到最高档
  return { threshold: Math.max(baseThreshold, 90), winRate: Number((overallWinRate * 100).toFixed(0)), sample: records.length };
}
