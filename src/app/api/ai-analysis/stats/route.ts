/**
 * AI 准确率统计 API（管理员）
 * GET /api/ai-analysis/stats — 按模型和置信度分层统计 AI 自动开仓的胜率
 *
 * 数据来源：PaperTrade 表中 aiCorrect 非空的记录（AI 仓位全平时回填）
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireAdmin } from '@/shared/api/auth-guard';
import { prisma } from '@/shared/lib/prisma';

export const dynamic = 'force-dynamic';

interface Agg {
  total: number;
  wins: number;
  pnlSum: number;
  pnlList: number[];
}

const EMPTY_AGG = (): Agg => ({ total: 0, wins: 0, pnlSum: 0, pnlList: [] });

function finalize(agg: Agg) {
  return {
    total: agg.total,
    wins: agg.wins,
    winRate: agg.total > 0 ? Math.round((agg.wins / agg.total) * 100) : 0,
    avgPnl: agg.total > 0 ? Number((agg.pnlSum / agg.total).toFixed(2)) : 0,
    sumPnl: Number(agg.pnlSum.toFixed(2)),
    // 平均盈亏比 = 平均盈利 / 平均亏损绝对值
    avgWin: agg.pnlList.filter((p) => p > 0).length > 0
      ? Number((agg.pnlList.filter((p) => p > 0).reduce((s, p) => s + p, 0) / agg.pnlList.filter((p) => p > 0).length).toFixed(2))
      : 0,
    avgLoss: agg.pnlList.filter((p) => p < 0).length > 0
      ? Number((agg.pnlList.filter((p) => p < 0).reduce((s, p) => s + p, 0) / agg.pnlList.filter((p) => p < 0).length).toFixed(2))
      : 0,
  };
}

export const GET = createHandler(async () => {
  requireAdmin();

  // 取最近的 AI 已平仓记录（足够统计，避免全表扫描）
  const trades = await prisma.paperTrade.findMany({
    where: { aiCorrect: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 1000,
    select: { pnl: true, aiCorrect: true, aiMeta: true, createdAt: true },
  });

  const byModel = new Map<string, Agg>();
  const bands: { key: string; label: string; min: number; max: number; agg: Agg }[] = [
    { key: '60-69', label: '60-69', min: 60, max: 70, agg: EMPTY_AGG() },
    { key: '70-79', label: '70-79', min: 70, max: 80, agg: EMPTY_AGG() },
    { key: '80-89', label: '80-89', min: 80, max: 90, agg: EMPTY_AGG() },
    { key: '90-100', label: '90-100', min: 90, max: 101, agg: EMPTY_AGG() },
  ];
  const overall = EMPTY_AGG();

  for (const t of trades) {
    const win = t.aiCorrect === true;

    // 解析开仓时的模型信息
    let model = '未知模型';
    let confidence: number | null = null;
    if (t.aiMeta) {
      try {
        const meta = JSON.parse(t.aiMeta);
        if (meta.model) model = String(meta.model);
        if (meta.confidence != null) confidence = Number(meta.confidence);
      } catch {}
    }

    const record = (agg: Agg) => {
      agg.total++;
      if (win) agg.wins++;
      agg.pnlSum += t.pnl;
      agg.pnlList.push(t.pnl);
    };

    record(overall);

    const m = byModel.get(model) || EMPTY_AGG();
    record(m);
    byModel.set(model, m);

    if (confidence != null) {
      const band = bands.find((b) => confidence >= b.min && confidence < b.max);
      if (band) record(band.agg);
    }
  }

  // ===== 预测级准确率（反馈闭环）：AiAnalysis.outcome 复盘结果 =====
  // 与交易级统计互补：不依赖是否开仓，覆盖 AI 的每一次方向判断
  const predictions = await prisma.aiAnalysis.findMany({
    where: { outcome: { in: ['hit_tp1', 'hit_tp2', 'hit_sl', 'correct', 'wrong'] } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { outcome: true, confidence: true, model: true, createdAt: true },
  });

  const predWin = (o: string) => o === 'hit_tp1' || o === 'hit_tp2' || o === 'correct';
  const predByModel = new Map<string, Agg>();
  const predBands = bands.map((b) => ({ band: b.label, min: b.min, max: b.max, agg: EMPTY_AGG() }));
  const predOverall = EMPTY_AGG();
  const outcomeDist: Record<string, number> = {};

  for (const p of predictions) {
    const oc = p.outcome || 'unknown';
    outcomeDist[oc] = (outcomeDist[oc] || 0) + 1;
    const win = predWin(oc);
    const model = p.model || '未知模型';
    const record = (agg: Agg) => {
      agg.total++;
      if (win) agg.wins++;
    };
    record(predOverall);
    const m = predByModel.get(model) || EMPTY_AGG();
    record(m);
    predByModel.set(model, m);
    const band = predBands.find((b) => p.confidence >= b.min && p.confidence < b.max);
    if (band) record(band.agg);
  }

  return apiSuccess({
    sampleSize: trades.length,
    overall: finalize(overall),
    byModel: Array.from(byModel.entries()).map(([model, agg]) => ({
      model,
      ...finalize(agg),
    })).sort((a, b) => b.total - a.total),
    byConfidence: bands.map((b) => ({ band: b.label, ...finalize(b.agg) })),
    // 预测级统计（每条 AI 分析的复盘结果，无需开仓）
    predictions: {
      sampleSize: predictions.length,
      winRate: predOverall.total > 0 ? Math.round((predOverall.wins / predOverall.total) * 100) : 0,
      outcomeDist, // hit_tp1 / hit_tp2 / hit_sl / correct / wrong 各多少条
      byModel: Array.from(predByModel.entries()).map(([model, agg]) => ({
        model,
        total: agg.total,
        winRate: agg.total > 0 ? Math.round((agg.wins / agg.total) * 100) : 0,
      })).sort((a, b) => b.total - a.total),
      byConfidence: predBands.map((b) => ({
        band: b.band,
        total: b.agg.total,
        winRate: b.agg.total > 0 ? Math.round((b.agg.wins / b.agg.total) * 100) : 0,
      })),
    },
  });
});
