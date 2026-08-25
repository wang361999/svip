/**
 * 模拟盘核心业务逻辑
 * - 开仓 / 平仓 / 部分平仓
 * - 手续费 / 滑点计算
 * - 浮盈浮亏计算
 * - 账户管理
 */
import { prisma } from './prisma';
import { fetchPrice, fetchKlines } from './market-data';
import {
  computeAllSignals,
  normalizeStrategyConfig,
  type StrategyConfig,
} from './strategies';

// ==================== 类型定义 ====================

export interface PaperAccountInfo {
  id: string;
  balance: number;
  available: number;
  marginUsed: number;
  unrealizedPnl: number;
  realizedPnl: number;
  leverage: number;
  positionPct: number;
  stopLossPct: number;
  takerFee: number;
  makerFee: number;
  slippage: number;
  autoTrade: boolean;
}

export interface PaperPositionInfo {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  partialClosed: boolean;
  status: 'open' | 'closed';
  strategyId: string | null;
  signalPrice: number | null;
  entryFee: number;
  entrySlippage: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  createdAt: string;
  closedAt: string | null;
}

export interface PaperTradeInfo {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  pnl: number;
  pnlPercent: number;
  fee: number;
  slippage: number;
  totalCost: number;
  duration: number;
  closeReason: string;
  strategyId: string | null;
  createdAt: string;
  closedAt: string;
}

// ==================== 工具函数 ====================

/** 计算手续费（吃单） */
export function calcTakerFee(notional: number, feeRate: number): number {
  return notional * (feeRate / 100);
}

/** 计算滑点成本 */
export function calcSlippageCost(notional: number, slippageRate: number): number {
  return notional * (slippageRate / 100);
}

/** 计算持仓浮盈浮亏（已扣开仓费用，不含平仓费用） */
export function calcUnrealizedPnl(
  side: 'long' | 'short',
  entryPrice: number,
  currentPrice: number,
  quantity: number,
  leverage: number,
): { pnl: number; pnlPct: number } {
  const priceDiff = side === 'long'
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;
  const pnl = priceDiff * quantity;
  const margin = (entryPrice * quantity) / leverage;
  const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
  return { pnl, pnlPct };
}

// ==================== 账户操作 ====================

/** 获取或创建用户模拟盘账户 */
export async function getOrCreateAccount(userId: string) {
  let account = await prisma.paperAccount.findUnique({
    where: { userId },
  });
  if (!account) {
    account = await prisma.paperAccount.create({
      data: { userId },
    });
  }
  return account;
}

/** 获取账户信息 */
export async function getAccountInfo(userId: string): Promise<PaperAccountInfo> {
  const account = await getOrCreateAccount(userId);
  return {
    id: account.id,
    balance: account.balance,
    available: account.available,
    marginUsed: account.marginUsed,
    unrealizedPnl: account.unrealizedPnl,
    realizedPnl: account.realizedPnl,
    leverage: account.leverage,
    positionPct: account.positionPct,
    stopLossPct: account.stopLossPct,
    takerFee: account.takerFee,
    makerFee: account.makerFee,
    slippage: account.slippage,
    autoTrade: account.autoTrade,
  };
}

/** 更新账户风控配置 */
export async function updateAccountConfig(
  userId: string,
  config: {
    leverage?: number;
    positionPct?: number;
    stopLossPct?: number;
    takerFee?: number;
    makerFee?: number;
    slippage?: number;
    autoTrade?: boolean;
  },
): Promise<PaperAccountInfo> {
  const account = await getOrCreateAccount(userId);
  const updated = await prisma.paperAccount.update({
    where: { id: account.id },
    data: {
      ...(config.leverage !== undefined && { leverage: config.leverage }),
      ...(config.positionPct !== undefined && { positionPct: config.positionPct }),
      ...(config.stopLossPct !== undefined && { stopLossPct: config.stopLossPct }),
      ...(config.takerFee !== undefined && { takerFee: config.takerFee }),
      ...(config.makerFee !== undefined && { makerFee: config.makerFee }),
      ...(config.slippage !== undefined && { slippage: config.slippage }),
      ...(config.autoTrade !== undefined && { autoTrade: config.autoTrade }),
    },
  });
  // 记录日志
  await prisma.paperTradeLog.create({
    data: {
      accountId: account.id,
      userId,
      action: 'config',
      detail: JSON.stringify(config),
    },
  });
  return {
    id: updated.id,
    balance: updated.balance,
    available: updated.available,
    marginUsed: updated.marginUsed,
    unrealizedPnl: updated.unrealizedPnl,
    realizedPnl: updated.realizedPnl,
    leverage: updated.leverage,
    positionPct: updated.positionPct,
    stopLossPct: updated.stopLossPct,
    takerFee: updated.takerFee,
    makerFee: updated.makerFee,
    slippage: updated.slippage,
    autoTrade: updated.autoTrade,
  };
}

// ==================== 持仓操作 ====================

/** 开仓 */
export async function openPosition(
  userId: string,
  params: {
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    quantity?: number;
    margin?: number;
    leverage?: number;
    stopLoss?: number;
    takeProfit1?: number;
    takeProfit2?: number;
    strategyId?: string;
    signalPrice?: number;
  },
): Promise<PaperPositionInfo> {
  const account = await getOrCreateAccount(userId);
  const leverage = params.leverage || account.leverage;
  const takerFee = account.takerFee;
  const slippageRate = account.slippage;

  // 计算保证金和仓位
  let margin: number;
  let quantity: number;

  if (params.margin && params.margin > 0) {
    margin = params.margin;
    // 滑点调整入场价
    const slipDir = params.side === 'long' ? 1 : -1;
    const slippedPrice = params.entryPrice * (1 + (slipDir * slippageRate) / 100);
    quantity = (margin * leverage) / slippedPrice;
  } else if (params.quantity && params.quantity > 0) {
    quantity = params.quantity;
    margin = (params.entryPrice * quantity) / leverage;
  } else {
    // 默认：按仓位占比计算
    margin = account.available * (account.positionPct / 100);
    const slipDir = params.side === 'long' ? 1 : -1;
    const slippedPrice = params.entryPrice * (1 + (slipDir * slippageRate) / 100);
    quantity = (margin * leverage) / slippedPrice;
  }

  // 检查可用保证金
  if (margin > account.available) {
    throw new Error('可用保证金不足');
  }

  // 计算滑点成本和手续费
  const slipDir = params.side === 'long' ? 1 : -1;
  const actualEntryPrice = params.entryPrice * (1 + (slipDir * slippageRate) / 100);
  const notional = actualEntryPrice * quantity;
  const entryFee = calcTakerFee(notional, takerFee);
  const entrySlippage = calcSlippageCost(notional, slippageRate);
  const totalEntryCost = entryFee + entrySlippage;

  // 总成本从可用余额扣除
  if (margin + totalEntryCost > account.available) {
    throw new Error('可用保证金不足（含手续费和滑点）');
  }

  // 创建持仓
  const position = await prisma.paperPosition.create({
    data: {
      accountId: account.id,
      userId,
      symbol: params.symbol,
      side: params.side,
      entryPrice: actualEntryPrice,
      quantity,
      leverage,
      margin,
      stopLoss: params.stopLoss || null,
      takeProfit1: params.takeProfit1 || null,
      takeProfit2: params.takeProfit2 || null,
      strategyId: params.strategyId || null,
      signalPrice: params.signalPrice || null,
      entryFee,
      entrySlippage,
      currentPrice: actualEntryPrice,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
    },
  });

  // 更新账户
  await prisma.paperAccount.update({
    where: { id: account.id },
    data: {
      available: { decrement: margin + totalEntryCost },
      marginUsed: { increment: margin },
    },
  });

  // 记录日志
  await prisma.paperTradeLog.create({
    data: {
      accountId: account.id,
      userId,
      action: 'open',
      symbol: params.symbol,
      detail: JSON.stringify({
        positionId: position.id,
        side: params.side,
        entryPrice: actualEntryPrice,
        quantity,
        margin,
        leverage,
        stopLoss: params.stopLoss,
        takeProfit1: params.takeProfit1,
        takeProfit2: params.takeProfit2,
        entryFee,
        entrySlippage,
        strategyId: params.strategyId,
      }),
      price: actualEntryPrice,
    },
  });

  return positionToInfo(position);
}

/** 平仓（全平或部分平仓） */
export async function closePosition(
  positionId: string,
  exitPrice: number,
  closeReason: string = 'manual',
  closeRatio: number = 1, // 1=全平, 0.5=半平
): Promise<PaperTradeInfo> {
  const position = await prisma.paperPosition.findUnique({
    where: { id: positionId },
    include: { account: true },
  });
  if (!position) throw new Error('持仓不存在');
  if (position.status !== 'open') throw new Error('持仓已平仓');

  const account = position.account;
  const closeQuantity = position.quantity * closeRatio;

  // 滑点调整出场价
  const slipDir = position.side === 'long' ? -1 : 1; // 平多卖价更低，平空买价更高
  const actualExitPrice = exitPrice * (1 + (slipDir * account.slippage) / 100);
  const notional = actualExitPrice * closeQuantity;
  const closeFee = calcTakerFee(notional, account.takerFee);
  const closeSlippage = calcSlippageCost(notional, account.slippage);

  // 计算盈亏
  const { pnl } = calcUnrealizedPnl(
    position.side as 'long' | 'short',
    position.entryPrice,
    actualExitPrice,
    closeQuantity,
    position.leverage,
  );

  // 总成本 = 开仓费用按比例 + 平仓费用 + 平仓滑点
  const openCostRatio = (position.entryFee + position.entrySlippage) * closeRatio;
  const totalCost = openCostRatio + closeFee + closeSlippage;
  const netPnl = pnl - totalCost;

  // 退还保证金（按比例）
  const returnMargin = position.margin * closeRatio;
  const netReturn = returnMargin + netPnl;

  // 盈亏百分比（基于保证金）
  const pnlPercent = position.margin > 0
    ? (netPnl / (position.margin * closeRatio)) * 100
    : 0;

  // 持仓时长（秒）
  const duration = Math.floor((Date.now() - position.createdAt.getTime()) / 1000);

  // 创建交易记录
  const trade = await prisma.paperTrade.create({
    data: {
      positionId: position.id,
      accountId: account.id,
      userId: position.userId,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: actualExitPrice,
      quantity: closeQuantity,
      leverage: position.leverage,
      margin: position.margin * closeRatio,
      pnl: netPnl,
      pnlPercent,
      fee: closeFee,
      slippage: closeSlippage,
      totalCost,
      duration,
      closeReason,
      strategyId: position.strategyId,
    },
  });

  // 更新账户
  await prisma.paperAccount.update({
    where: { id: account.id },
    data: {
      available: { increment: netReturn },
      marginUsed: { decrement: returnMargin },
      realizedPnl: { increment: netPnl },
    },
  });

  // 更新或关闭持仓
  if (closeRatio >= 1) {
    await prisma.paperPosition.update({
      where: { id: positionId },
      data: {
        status: 'closed',
        closedAt: new Date(),
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
      },
    });
  } else {
    // 部分平仓
    await prisma.paperPosition.update({
      where: { id: positionId },
      data: {
        quantity: { decrement: closeQuantity },
        margin: { decrement: returnMargin },
        partialClosed: true,
      },
    });
  }

  // 记录日志
  await prisma.paperTradeLog.create({
    data: {
      accountId: account.id,
      userId: position.userId,
      action: closeRatio >= 1 ? 'close' : 'partial_close',
      symbol: position.symbol,
      detail: JSON.stringify({
        positionId: position.id,
        tradeId: trade.id,
        exitPrice: actualExitPrice,
        quantity: closeQuantity,
        pnl: netPnl,
        pnlPercent,
        closeReason,
        closeFee,
        closeSlippage,
      }),
      price: actualExitPrice,
    },
  });

  return tradeToInfo(trade);
}

/** 刷新所有持仓的浮盈浮亏（按币种） */
export async function refreshUnrealizedPnl(
  userId: string,
  symbolPrices: Record<string, number>,
): Promise<void> {
  const positions = await prisma.paperPosition.findMany({
    where: { userId, status: 'open' },
  });
  if (positions.length === 0) {
    // 重置账户浮盈
    await prisma.paperAccount.updateMany({
      where: { userId },
      data: { unrealizedPnl: 0 },
    });
    return;
  }

  let totalUnrealized = 0;
  for (const pos of positions) {
    const price = symbolPrices[pos.symbol];
    if (!price || price <= 0) continue;
    const { pnl, pnlPct } = calcUnrealizedPnl(
      pos.side as 'long' | 'short',
      pos.entryPrice,
      price,
      pos.quantity,
      pos.leverage,
    );
    totalUnrealized += pnl;
    await prisma.paperPosition.update({
      where: { id: pos.id },
      data: {
        currentPrice: price,
        unrealizedPnl: pnl,
        unrealizedPnlPct: pnlPct,
      },
    });
  }

  // 更新账户总浮盈
  await prisma.paperAccount.updateMany({
    where: { userId },
    data: { unrealizedPnl: totalUnrealized },
  });
}

// ==================== 查询操作 ====================

/** 获取持仓列表 */
export async function getPositions(userId: string): Promise<PaperPositionInfo[]> {
  const positions = await prisma.paperPosition.findMany({
    where: { userId, status: 'open' },
    orderBy: { createdAt: 'desc' },
  });
  return positions.map(positionToInfo);
}

/** 获取历史交易记录 */
export async function getTrades(userId: string, limit: number = 50): Promise<PaperTradeInfo[]> {
  const trades = await prisma.paperTrade.findMany({
    where: { userId },
    orderBy: { closedAt: 'desc' },
    take: limit,
  });
  return trades.map(tradeToInfo);
}

/** 获取统计数据 */
export async function getStats(userId: string) {
  const account = await getOrCreateAccount(userId);
  const trades = await prisma.paperTrade.findMany({
    where: { userId },
  });
  const openPositions = await prisma.paperPosition.count({
    where: { userId, status: 'open' },
  });

  const totalTrades = trades.length;
  const winTrades = trades.filter((t) => t.pnl > 0).length;
  const lossTrades = trades.filter((t) => t.pnl < 0).length;
  const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.totalCost, 0);
  const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
  const maxWin = trades.length > 0 ? Math.max(...trades.map((t) => t.pnl)) : 0;
  const maxLoss = trades.length > 0 ? Math.min(...trades.map((t) => t.pnl)) : 0;
  // 盈亏比
  const avgWin = winTrades > 0 ? trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / winTrades : 0;
  const avgLoss = lossTrades > 0 ? Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0) / lossTrades) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : 0;

  // 按策略分组统计胜率
  const strategyStats: Record<string, { name: string; count: number; wins: number; winRate: number; totalPnl: number; avgPnl: number }> = {};
  for (const t of trades) {
    const sid = t.strategyId || 'manual';
    if (!strategyStats[sid]) {
      strategyStats[sid] = { name: sid, count: 0, wins: 0, winRate: 0, totalPnl: 0, avgPnl: 0 };
    }
    strategyStats[sid].count++;
    if (t.pnl > 0) strategyStats[sid].wins++;
    strategyStats[sid].totalPnl += t.pnl;
  }
  for (const sid of Object.keys(strategyStats)) {
    const s = strategyStats[sid];
    s.winRate = s.count > 0 ? (s.wins / s.count) * 100 : 0;
    s.avgPnl = s.count > 0 ? s.totalPnl / s.count : 0;
    s.name = sid === 'manual' ? '手动交易' : sid;
  }

  return {
    balance: account.balance,
    available: account.available,
    marginUsed: account.marginUsed,
    unrealizedPnl: account.unrealizedPnl,
    realizedPnl: account.realizedPnl,
    equity: account.balance + account.unrealizedPnl,
    totalTrades,
    winTrades,
    lossTrades,
    winRate,
    totalPnl,
    totalFees,
    avgPnl,
    maxWin,
    maxLoss,
    profitFactor,
    openPositions,
    strategyStats,
  };
}

// ==================== 自动交易引擎 ====================

/** 引擎单次执行：检查止损止盈 + 自动开仓（多币种） */
export async function runEngine(userId: string): Promise<{
  checked: number;
  opened: number;
  closed: number;
  errors: string[];
}> {
  const result = { checked: 0, opened: 0, closed: 0, errors: [] as string[] };

  try {
    const account = await getOrCreateAccount(userId);

    // 获取允许自动交易的币种列表
    // active 只代表前台显示；autoTrade 才代表允许引擎自动开仓
    const symbols = await prisma.tradingSymbol.findMany({
      where: { active: true, autoTrade: true },
      orderBy: [{ isPopular: 'desc' }, { sortOrder: 'asc' }],
    });

    if (symbols.length === 0) {
      result.errors.push('没有启用自动交易的币种');
      return result;
    }

    // 并行获取所有币种价格
    const priceMap: Record<string, number> = {};
    const priceResults = await Promise.allSettled(
      symbols.map((s) => fetchPrice(s.symbol, s.okxId).then((price) => ({ symbol: s.symbol, price }))),
    );
    for (const r of priceResults) {
      if (r.status === 'fulfilled' && r.value.price && r.value.price > 0) {
        priceMap[r.value.symbol] = r.value.price;
      }
    }

    if (Object.keys(priceMap).length === 0) {
      result.errors.push('无法获取任何币种价格');
      return result;
    }

    // 2. 刷新浮盈（按币种）
    await refreshUnrealizedPnl(userId, priceMap);

    // 3. 检查止损止盈（遍历所有持仓）
    const positions = await prisma.paperPosition.findMany({
      where: { userId, status: 'open' },
    });
    result.checked = positions.length;

    // 持仓方向索引：symbol:side → 是否已持仓
    // 开仓成功后同步写入，防止同一次引擎运行内重复开同方向仓位
    // （原 bug：sameDir 只查循环前的快照，4 秒内连开 4 笔同方向 BTC 多单）
    const openDirKeys = new Set(
      positions.filter((p) => p.status === 'open').map((p) => `${p.symbol}:${p.side}`),
    );

    for (const pos of positions) {
      try {
        const price = priceMap[pos.symbol];
        if (!price || price <= 0) continue;

        const isLong = pos.side === 'long';
        const shouldStopLoss = pos.stopLoss && (
          (isLong && price <= pos.stopLoss) ||
          (!isLong && price >= pos.stopLoss)
        );
        const shouldTakeProfit2 = pos.takeProfit2 && (
          (isLong && price >= pos.takeProfit2) ||
          (!isLong && price <= pos.takeProfit2)
        );
        // 止盈1：部分平仓（仅一次）
        const shouldTakeProfit1 = pos.takeProfit1 && !pos.partialClosed && (
          (isLong && price >= pos.takeProfit1) ||
          (!isLong && price <= pos.takeProfit1)
        );

        if (shouldStopLoss) {
          await closePosition(pos.id, price, 'stop_loss');
          result.closed++;
        } else if (shouldTakeProfit2) {
          await closePosition(pos.id, price, 'take_profit_2');
          result.closed++;
        } else if (shouldTakeProfit1) {
          await closePosition(pos.id, price, 'take_profit_1', 0.5);
          result.closed++;
        }
      } catch (err) {
        result.errors.push(`持仓 ${pos.symbol} 处理失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. 自动开仓（如果开启）- 遍历每个币种计算信号
    if (account.autoTrade) {
      for (const sym of symbols) {
        const price = priceMap[sym.symbol];
        if (!price || price <= 0) continue;

        try {
          const signals = await computeAutoSignals(userId, sym.symbol, sym.okxId, price);
          for (const sig of signals) {
            if (sig.triggered && sig.direction !== 'neutral' && sig.entryPrice) {
              // 限制最大持仓数（全局）
              const openCount = await prisma.paperPosition.count({
                where: { userId, status: 'open' },
              });
              if (openCount >= 5) break;

              // 检查该币种同方向是否已有持仓（含本次运行内新开的）
              if (openDirKeys.has(`${sym.symbol}:${sig.direction}`)) continue;

              try {
                await openPosition(userId, {
                  symbol: sym.symbol,
                  side: sig.direction as 'long' | 'short',
                  entryPrice: sig.entryPrice,
                  stopLoss: sig.stopLoss,
                  takeProfit1: sig.takeProfit1,
                  takeProfit2: sig.takeProfit2,
                  strategyId: sig.strategyId,
                  signalPrice: sig.entryPrice,
                });
                openDirKeys.add(`${sym.symbol}:${sig.direction}`);
                result.opened++;
              } catch (err) {
                result.errors.push(`${sym.symbol} 自动开仓失败: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        } catch (err) {
          result.errors.push(`${sym.symbol} 信号计算失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 4b. AI 信号自动开仓（如果开启 aiAutoTrade）
    try {
      const { settingsService } = await import('@/features/settings/api/settings.service');
      const { parseAiConfig } = await import('./ai-analysis');
      const settings = await settingsService.getSettings();
      const aiConfig = parseAiConfig(settings as unknown as Record<string, string | null>);

      if (aiConfig.enabled && aiConfig.autoTrade && account.autoTrade) {
        for (const sym of symbols) {
          // 限制最大持仓数
          const openCount = await prisma.paperPosition.count({
            where: { userId, status: 'open' },
          });
          if (openCount >= 5) break;

          // 获取该币种最新的 AI 分析记录
          const latestAi = await prisma.aiAnalysis.findFirst({
            where: { symbol: sym.symbol },
            orderBy: { createdAt: 'desc' },
          });

          // 只使用 1 小时内的分析结果
          if (!latestAi) continue;
          const ageMs = Date.now() - latestAi.createdAt.getTime();
          if (ageMs > 3600000) continue; // 超过 1 小时的分析不使用

          // 只在方向明确且置信度 >= 60 时开仓
          if (latestAi.direction === 'neutral' || latestAi.confidence < 60) continue;

          // 检查该币种同方向是否已有持仓（含本次运行内新开的）
          if (openDirKeys.has(`${sym.symbol}:${latestAi.direction}`)) continue;

          const price = priceMap[sym.symbol];
          if (!price || price <= 0) continue;

          // ===== 风控闸门：止损必须存在且距离合理 =====
          // 止损距离占价格 0.3% ~ 25% 才视为有效；过近会被瞬时波动扫损，过远等于没有止损
          const MIN_SL_PCT = 0.003;
          const MAX_SL_PCT = 0.25;
          let stopLoss = latestAi.stopLoss;
          if (stopLoss != null) {
            const distPct = Math.abs(price - stopLoss) / price;
            if (distPct < MIN_SL_PCT || distPct > MAX_SL_PCT) stopLoss = null; // 距离不合理 → 丢弃 AI 的止损
          }
          // AI 没给有效止损时，按账户默认风险参数生成（不裸奔开仓）
          if (stopLoss == null) {
            const slPct = account.stopLossPct > 0 ? account.stopLossPct / 100 : 0.02;
            stopLoss = latestAi.direction === 'long'
              ? price * (1 - slPct)
              : price * (1 + slPct);
          }

          // 止盈同样校验方向；无效则按 1.5R / 3R（基于止损距离）生成
          const slDist = Math.abs(price - stopLoss);
          let takeProfit1 = latestAi.takeProfit1;
          if (takeProfit1 == null || (latestAi.direction === 'long' ? takeProfit1 <= price : takeProfit1 >= price)) {
            takeProfit1 = latestAi.direction === 'long' ? price + slDist * 1.5 : price - slDist * 1.5;
          }
          let takeProfit2 = latestAi.takeProfit2;
          if (takeProfit2 == null || (latestAi.direction === 'long' ? takeProfit2 <= price : takeProfit2 >= price)) {
            takeProfit2 = latestAi.direction === 'long' ? price + slDist * 3 : price - slDist * 3;
          }

          try {
            await openPosition(userId, {
              symbol: sym.symbol,
              side: latestAi.direction as 'long' | 'short',
              entryPrice: price, // 以当前价格入场（AI 分析时可能已变化）
              stopLoss,
              takeProfit1,
              takeProfit2,
              strategyId: `ai_${latestAi.provider}`,
              signalPrice: latestAi.entryPrice || price,
            });
            openDirKeys.add(`${sym.symbol}:${latestAi.direction}`);
            result.opened++;
          } catch (err) {
            result.errors.push(`${sym.symbol} AI 自动开仓失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      result.errors.push(`AI 信号处理异常: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4c. 引擎自动触发 AI 分析（基于 aiAnalysisInterval 配置）
    // analysisInterval > 0 时，检查各币种最新分析时间，超过间隔则触发
    try {
      const { settingsService: svc } = await import('@/features/settings/api/settings.service');
      const { parseAiConfig: parseCfg, analyzeMarketWithAI: analyzeAI } = await import('./ai-analysis');
      const settingsEngine = await svc.getSettings();
      const aiConfigEngine = parseCfg(settingsEngine as unknown as Record<string, string | null>);
      if (aiConfigEngine.enabled && aiConfigEngine.analysisInterval > 0) {
        // analysisInterval 单位：秒
        const intervalMs = aiConfigEngine.analysisInterval * 1000;
        const now = Date.now();

        for (const sym of symbols) {
          // 查询该币种最新的 AI 分析记录
          const latest = await prisma.aiAnalysis.findFirst({
            where: { symbol: sym.symbol },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          });

          const ageMs = latest ? now - latest.createdAt.getTime() : Infinity;
          if (ageMs < intervalMs) continue; // 还没到间隔时间

          const price = priceMap[sym.symbol];
          if (!price || price <= 0) continue;

          // 触发 AI 分析（fire-and-forget，不阻塞引擎）
          // 使用 Promise + timeout 防止卡住
          analyzeAI(aiConfigEngine, sym.symbol, sym.okxId, sym.label, price)
            .then(async (aiResult) => {
              try {
                await prisma.aiAnalysis.create({
                  data: {
                    symbol: sym.symbol,
                    direction: aiResult.direction,
                    confidence: aiResult.confidence,
                    summary: aiResult.summary,
                    entryPrice: aiResult.entryPrice,
                    stopLoss: aiResult.stopLoss,
                    takeProfit1: aiResult.takeProfit1,
                    takeProfit2: aiResult.takeProfit2,
                    reasoning: aiResult.reasoning,
                    keyLevels: aiResult.keyLevels ? JSON.stringify(aiResult.keyLevels) : null,
                    riskWarning: aiResult.riskWarning,
                    provider: aiResult.provider,
                    model: aiResult.model,
                    rawResponse: aiResult.rawResponse,
                  },
                });
              } catch {}
            })
            .catch(() => {
              // AI 分析失败不影响引擎主流程
            });

          // 只触发第一个需要分析的币种，避免并发过多
          break;
        }
      }
    } catch {
      // AI 分析触发失败不影响引擎
    }

    // 5. 每次引擎执行都记录日志（方便排查 Cron 触发是否正常）
    try {
      await prisma.paperTradeLog.create({
        data: {
          accountId: account.id,
          userId,
          action: 'engine',
          detail: JSON.stringify(result),
          price: priceMap[symbols[0]?.symbol] || 0,
        },
      });
    } catch {
      // 日志写入失败不影响引擎结果
    }
  } catch (err) {
    result.errors.push(`引擎执行失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/** 计算自动交易信号（指定币种） */
async function computeAutoSignals(userId: string, symbol: string, okxId: string, currentPrice: number) {
  // 获取用户策略配置
  let config: StrategyConfig;
  try {
    const { userService } = await import('@/features/user/api/user.service');
    const rawConfig = await userService.getStrategyConfig(userId);
    config = normalizeStrategyConfig(rawConfig);
  } catch {
    // 用户不存在或查询失败，视为无启用策略（不自动开仓）
    config = normalizeStrategyConfig(null);
  }

  // 修复：移除「全部关闭时强制启用默认策略」的逻辑。
  // 原逻辑：用户策略全部 disabled 时，引擎强制开启 trend_macd_ema 等 3 个默认策略，
  // 导致用户在策略中心明确关闭所有策略后仍然自动开仓，且与前端「尚未启用任何策略」
  // 的显示状态矛盾。
  // 现在：引擎严格遵循用户配置 — 用户启用了哪些策略就计算哪些信号；全部关闭 = 不开仓。
  const anyEnabled = Object.values(config).some((c) => c.enabled);
  if (!anyEnabled) {
    return []; // 用户未启用任何策略，不产生信号
  }

  // 获取K线数据
  const [k15m, k1h, k4h] = await Promise.all([
    fetchKlines(symbol, okxId, '15m'),
    fetchKlines(symbol, okxId, '1h').catch(() => []),
    fetchKlines(symbol, okxId, '4h').catch(() => []),
  ]);

  const signals = computeAllSignals(config, { k15m, k1h, k4h, currentPrice });
  return signals;
}

// ==================== 重置账户 ====================

/** 重置模拟盘账户（清空所有持仓和记录） */
export async function resetAccount(userId: string): Promise<PaperAccountInfo> {
  const account = await getOrCreateAccount(userId);

  // 删除所有交易记录
  await prisma.paperTrade.deleteMany({ where: { userId } });
  // 删除所有持仓
  await prisma.paperPosition.deleteMany({ where: { userId } });
  // 删除所有日志
  await prisma.paperTradeLog.deleteMany({ where: { userId } });
  // 重置账户
  const updated = await prisma.paperAccount.update({
    where: { id: account.id },
    data: {
      balance: 100000,
      available: 100000,
      marginUsed: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
    },
  });

  return {
    id: updated.id,
    balance: updated.balance,
    available: updated.available,
    marginUsed: updated.marginUsed,
    unrealizedPnl: updated.unrealizedPnl,
    realizedPnl: updated.realizedPnl,
    leverage: updated.leverage,
    positionPct: updated.positionPct,
    stopLossPct: updated.stopLossPct,
    takerFee: updated.takerFee,
    makerFee: updated.makerFee,
    slippage: updated.slippage,
    autoTrade: updated.autoTrade,
  };
}

// ==================== 类型转换 ====================

function positionToInfo(p: any): PaperPositionInfo {
  return {
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    entryPrice: p.entryPrice,
    quantity: p.quantity,
    leverage: p.leverage,
    margin: p.margin,
    stopLoss: p.stopLoss,
    takeProfit1: p.takeProfit1,
    takeProfit2: p.takeProfit2,
    partialClosed: p.partialClosed,
    status: p.status,
    strategyId: p.strategyId,
    signalPrice: p.signalPrice,
    entryFee: p.entryFee,
    entrySlippage: p.entrySlippage,
    currentPrice: p.currentPrice,
    unrealizedPnl: p.unrealizedPnl,
    unrealizedPnlPct: p.unrealizedPnlPct,
    createdAt: p.createdAt.toISOString(),
    closedAt: p.closedAt?.toISOString() || null,
  };
}

function tradeToInfo(t: any): PaperTradeInfo {
  return {
    id: t.id,
    symbol: t.symbol,
    side: t.side,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    leverage: t.leverage,
    margin: t.margin,
    pnl: t.pnl,
    pnlPercent: t.pnlPercent,
    fee: t.fee,
    slippage: t.slippage,
    totalCost: t.totalCost,
    duration: t.duration,
    closeReason: t.closeReason,
    strategyId: t.strategyId,
    createdAt: t.createdAt.toISOString(),
    closedAt: t.closedAt.toISOString(),
  };
}
