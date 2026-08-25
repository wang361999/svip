/**
 * 模拟盘核心业务逻辑
 * - 开仓 / 平仓 / 部分平仓
 * - 手续费 / 滑点计算
 * - 浮盈浮亏计算
 * - 账户管理
 */
import { prisma } from './prisma';
import { fetchPrice } from './market-data';

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
    currentSymbol?: string;
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
      ...(config.currentSymbol !== undefined && { currentSymbol: config.currentSymbol }),
    },
  });
  // 币种切换是高频操作，只更新 currentSymbol 时不记日志（避免刷屏）
  if (config.currentSymbol !== undefined && Object.keys(config).length === 1) {
    return getAccountInfo(userId);
  }
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
    /** AI 开仓时的模型信息 JSON（provider/model/confidence），用于准确率统计 */
    aiMeta?: string;
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
      aiMeta: params.aiMeta || null,
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

  // AI 准确率统计：AI 来源的仓位在全平时记录方向对错（净盈亏>0=正确）
  // 部分平仓（止盈1 的 50%）不记录，等全平才有最终结论
  let aiMetaOut: string | null = null;
  let aiCorrect: boolean | null = null;
  if (closeRatio >= 1 && position.strategyId?.startsWith('ai_')) {
    aiMetaOut = position.aiMeta ?? null;
    aiCorrect = netPnl > 0;
  }

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
      aiMeta: aiMetaOut,
      aiCorrect,
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

    // 获取前台可见的币种列表（价格与元数据来源）
    // active 只代表前台显示；autoTrade 才代表允许引擎自动开仓
    const allSymbols = await prisma.tradingSymbol.findMany({
      where: { active: true },
      orderBy: [{ isPopular: 'desc' }, { sortOrder: 'asc' }],
    });

    if (allSymbols.length === 0) {
      result.errors.push('没有可用的币种');
      return result;
    }

    // 自动开仓目标币种：仅「用户当前选中」且管理员允许自动交易的币种。
    // 修复：此前引擎遍历所有 autoTrade 币种开仓，会开出用户没在看的币种的仓位。
    // 当前选中币种由前端切换币种时写入 account.currentSymbol。
    const targetSymbolMeta = account.currentSymbol
      ? allSymbols.find((s) => s.symbol === account.currentSymbol && s.autoTrade)
      : undefined;
    const autoTargets = targetSymbolMeta ? [targetSymbolMeta] : [];

    // 3. 检查止损止盈（遍历所有持仓）— 提前查询，供下方精准取价
    const positions = await prisma.paperPosition.findMany({
      where: { userId, status: 'open' },
    });
    result.checked = positions.length;

    // 并行获取「需要的」币种价格：持仓币种（止损止盈巡检 + 浮盈刷新）+ 当前选中币种（自动开仓/引擎日志）
    // 优化：此前每 5 秒全量拉取所有前台币种价格，是免费版 CPU 配额的最大消耗源；持仓外的价格从未被使用
    const neededSymbols = new Set<string>(positions.map((p) => p.symbol));
    if (account.currentSymbol) neededSymbols.add(account.currentSymbol);
    if (targetSymbolMeta && targetSymbolMeta.symbol !== account.currentSymbol) neededSymbols.add(targetSymbolMeta.symbol);
    const priceMap: Record<string, number> = {};
    const priceResults = await Promise.allSettled(
      Array.from(neededSymbols).map((sym) => {
        const meta = allSymbols.find((s) => s.symbol === sym);
        return fetchPrice(sym, meta?.okxId || sym.replace('USDT', '-USDT')).then((price) => ({ symbol: sym, price }));
      }),
    );
    for (const r of priceResults) {
      if (r.status === 'fulfilled' && r.value.price && r.value.price > 0) {
        priceMap[r.value.symbol] = r.value.price;
      }
    }

    // 持仓巡检需要价格，一个都拿不到时才视为行情异常
    const heldSymbols = new Set(positions.map((p) => p.symbol));
    if (heldSymbols.size > 0 && Array.from(heldSymbols).every((s) => !priceMap[s])) {
      result.errors.push('无法获取持仓币种价格');
      return result;
    }

    // 2. 刷新浮盈（按币种）
    await refreshUnrealizedPnl(userId, priceMap);

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

        // ===== 快引擎时间止损（4 小时未到止盈即市价离场 — 快进快出，不恋战） =====
        // 回测口径：16 根 15m；此处按开仓时间实时判定（引擎每 5-8 秒巡检）
        try {
          const m = pos.aiMeta ? JSON.parse(pos.aiMeta) : null;
          if (m?.engine === 'fast' && Date.now() - pos.createdAt.getTime() >= 4 * 60 * 60 * 1000) {
            await closePosition(pos.id, price, 'time_stop');
            result.closed++;
            continue;
          }
        } catch {
          // aiMeta 解析失败不影响常规止损止盈巡检
        }

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

          // ===== 职业标配：TP1 成交后止损移到入场价（保本单）=====
          // 剩余半仓已锁定利润，此后最差结果是保本离场，直接消灭「浮盈变亏损」的交易
          // （long: 入场价必然低于 TP1 及现价；short: 入场价必然高于 TP1 及现价，方向恒成立）
          try {
            await prisma.paperPosition.update({
              where: { id: pos.id },
              data: { stopLoss: pos.entryPrice },
            });
            await prisma.paperTradeLog.create({
              data: {
                accountId: account.id,
                userId,
                action: 'breakeven',
                symbol: pos.symbol,
                detail: JSON.stringify({
                  positionId: pos.id,
                  stopLoss: pos.stopLoss,
                  newStopLoss: pos.entryPrice,
                  note: 'TP1成交后止损移至入场价（保本单）',
                }),
                price,
              },
            });
          } catch {
            // 保本单更新失败不影响已完成的 TP1 平仓
          }
          result.closed++;
        }
      } catch (err) {
        result.errors.push(`持仓 ${pos.symbol} 处理失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3.5 读取当前币种最新 AI 分析的市场状态（regime + A+清单），统一闸门用
    //     - chop（碎波）状态下禁止一切自动开仓：碎波日反复扫损是短线最大的亏损来源
    //     - atr15m 用于止损无效点校验
    const aiMeta: {
      regime: string;
      atr15m: number | null;
      checklist: Record<string, boolean> | null;
    } = {
      regime: '', atr15m: null, checklist: null,
    };
    try {
      const latest = autoTargets.length > 0
        ? await prisma.aiAnalysis.findFirst({
            where: { symbol: autoTargets[0].symbol },
            orderBy: { createdAt: 'desc' },
          })
        : null;
      if (latest?.meta && Date.now() - latest.createdAt.getTime() <= 15 * 60 * 1000) {
        const m = JSON.parse(latest.meta);
        aiMeta.regime = typeof m.regime === 'string' ? m.regime : '';
        aiMeta.atr15m = typeof m.atr15m === 'number' && Number.isFinite(m.atr15m) ? m.atr15m : null;
        aiMeta.checklist = m.aPlusChecklist && typeof m.aPlusChecklist === 'object' ? m.aPlusChecklist : null;
      }
    } catch {
      // meta 解析失败按无状态处理（不阻塞开仓）
    }
    const regimeIsChop = aiMeta.regime === 'chop';

    // 4. 自动开仓入口说明：
    //    策略信号开仓已随策略页面/面板下线而移除（无 UI 可配置的策略不应再隐形开仓）。
    //    现在自动开仓只来源于 AI 信号（见下方 4b 段），受 regime/清单/ATR 多重闸门约束。
    if (account.autoTrade && autoTargets.length === 0) {
      result.errors.push(
        account.currentSymbol
          ? `币种 ${account.currentSymbol} 未启用自动交易，跳过自动开仓`
          : '未记录当前选中币种（打开交易页后会自动记录），跳过自动开仓',
      );
    }
    // 碎波市拦截：AI 判定 chop 时暂停一切自动开仓（反复扫损是短线最大亏损来源）
    if (account.autoTrade && regimeIsChop) {
      result.errors.push('AI 判定市场状态为碎波(chop)，本轮暂停自动开仓（短线风控）');
    }

    // 4b. AI 信号自动开仓（如果开启 aiAutoTrade）
    try {
      const { settingsService } = await import('@/features/settings/api/settings.service');
      const { parseAiConfig } = await import('./ai-analysis');
      const settings = await settingsService.getSettings();
      const aiConfig = parseAiConfig(settings as unknown as Record<string, string | null>);

      if (aiConfig.enabled && aiConfig.autoTrade && account.autoTrade) {
        // ===== 置信度动态校准：按模型已复盘的真实胜率提高开仓门槛 =====
        // 原理：若模型 70-79 分段历史胜率只有 40%，硬编码 60 门槛照开仓 = 亏钱
        // 校准只在战绩差时收紧门槛，战绩好不放松纪律（门槛只升不降）
        const { getCalibratedThreshold, evaluatePendingPredictions } = await import('./ai-feedback');
        evaluatePendingPredictions().catch(() => {}); // 引擎轮询顺手评估到期预测
        const calib = await getCalibratedThreshold(aiConfig.model, 60).catch(() => ({ threshold: 60, winRate: null, sample: 0 }));
        if (calib.threshold > 60) {
          result.errors.push(`置信度门槛校准：${aiConfig.model || '当前模型'} 历史胜率不足（样本 ${calib.sample}，胜率 ${calib.winRate}%），开仓门槛 60 → ${calib.threshold}`);
        }

        // AI 自动开仓同样只针对当前选中币种
        // （修复：原来遍历所有币种，1 小时内的旧 AI 分析记录会被拿去开非当前币种的仓）
        for (const sym of autoTargets) {
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

          // 只使用 15 分钟内的分析结果（短线节奏：AI 面板 30 秒级刷新，旧信号快速失效）
          if (!latestAi) continue;
          const ageMs = Date.now() - latestAi.createdAt.getTime();
          if (ageMs > 15 * 60 * 1000) continue; // 超过 15 分钟的分析不使用

          // 只在方向明确且置信度 >= 60 时开仓
          if (latestAi.direction === 'neutral' || latestAi.confidence < 60) continue;

          const price = priceMap[sym.symbol];
          if (!price || price <= 0) continue;

          // ===== 正常模式：信号通过全部闸门即按现价市价进场 =====
          // （原限价模式：等价格触达八分位挂单价±0.3%才成交，价格不回踩分位就永远不开仓）
          const execPrice = price;

          // ===== 距离闸门：追价保护（现价偏离建议挂单价过远不追） =====
          // 整套规则按分位挂单设计：止损=分型极值、止盈=分位。追价进场会拉大止损距离、
          // 压扁止盈距离（TP1 可能比进场价还近），盈亏比严重倒挂 — 成交率换不来期望值。
          // 判定：现价距 AI 建议挂单价 > 半个分位（区间宽度/16，从分析 meta 的 gann.rangePct
          // 自适应读取，无 gann 时兜底 0.2%）→ 本轮等待，等回踩半个分位内再进场。
          if (latestAi.entryPrice && latestAi.entryPrice > 0) {
            let gannRangePct = 0;
            try {
              const m = JSON.parse(latestAi.meta || '{}');
              gannRangePct = Number(m?.gann?.rangePct) || 0;
            } catch {}
            const halfDivPct = gannRangePct > 0 ? gannRangePct / 16 : 0.2;
            const distPct = (Math.abs(price - latestAi.entryPrice) / latestAi.entryPrice) * 100;
            if (distPct > halfDivPct) continue; // 偏离过远：等回踩（引擎每轮重查，回踩到位自动进）
          }

          // ===== 市场状态闸门：不同行情用不同开仓门槛 =====
          // chop 碎波：禁止开仓（AI 侧同样拦截，与策略侧双保险）
          if (aiMeta.regime === 'chop') continue;
          // range 区间：只有区间边缘的高把握交易才值得做 → 置信度 ≥ 70
          // event 事件：等事件消化，方向明确才进场 → 置信度 ≥ 75
          // calib.threshold：按模型真实胜率校准的动态门槛（战绩差自动提高）
          const confGate = Math.max(
            aiMeta.regime === 'range' ? 70 : aiMeta.regime === 'event' ? 75 : 60,
            calib.threshold,
          );
          if (latestAi.confidence < confGate) continue;

          // ===== A+ 清单闸门：五项核心检查至少 4 项通过，且市场状态必须明确 =====
          // （清单缺失时放行 — 兼容旧记录/模型未按格式返回，避免开仓死锁）
          if (aiMeta.checklist) {
            const cl = aiMeta.checklist;
            const passed = [cl.regimeClear, cl.timeframeAligned, cl.fundingNotExtreme, cl.volumeConfirmed, cl.nearInvalidation]
              .filter(Boolean).length;
            if (passed < 4 || !cl.regimeClear) continue;
          }

          // ===== 连续开仓三重防护（数据库实时状态为准，不受引擎快照/并发竞态影响） =====
          // 防护1：同币种单仓（任意方向）— 防止 AI 方向翻转时长短仓对冲叠开，也杀掉并发竞态
          //         （cron 引擎与前端引擎同时运行时，内存级 openDirKeys 互不可见，曾导致同方向连开多笔）
          const symOpenCount = await prisma.paperPosition.count({
            where: { userId, symbol: sym.symbol, status: 'open' },
          });
          if (symOpenCount > 0) continue;

          // 防护2：平仓冷却 — 同币种平仓后 15 分钟内不再开仓
          //         （止损后价格在挂单分位 ±0.3% 容差内反复震荡 → 旧信号每 5 秒重进一次来回扫损）
          const lastClosed = await prisma.paperPosition.findFirst({
            where: { userId, symbol: sym.symbol, status: 'closed' },
            orderBy: { closedAt: 'desc' },
          });
          if (lastClosed?.closedAt && Date.now() - lastClosed.closedAt.getTime() < 15 * 60 * 1000) continue;

          // 防护3：分析防重放 — 同一条 AI 分析只允许驱动一次开仓
          //         （一条分析在 15 分钟有效期内会被引擎检查上百次，无此约束等于无限次进场机会）
          const replayCount = await prisma.paperPosition.count({
            where: { userId, aiMeta: { contains: `"analysisId":"${latestAi.id}"` } },
          });
          if (replayCount > 0) continue;

          // ===== 止损：直接采用信号止损（趋势回调策略=分型极值±0.3%缓冲） =====
          // 仅当信号未给止损时按账户默认百分比兜底
          let stopLoss = latestAi.stopLoss;
          if (stopLoss == null || stopLoss <= 0) {
            const slDist0 = execPrice * (account.stopLossPct > 0 ? account.stopLossPct / 100 : 0.02);
            stopLoss = latestAi.direction === 'long'
              ? execPrice - slDist0
              : execPrice + slDist0;
          }

          // 止盈同样校验方向；无效则按 1.5R / 3R（基于止损距离）生成
          // （趋势回调策略固定给 1R/2R，此处兜底一般不触发）
          const slDist = Math.abs(execPrice - stopLoss);
          let takeProfit1 = latestAi.takeProfit1;
          if (takeProfit1 == null || (latestAi.direction === 'long' ? takeProfit1 <= execPrice : takeProfit1 >= execPrice)) {
            takeProfit1 = latestAi.direction === 'long' ? execPrice + slDist * 1.5 : execPrice - slDist * 1.5;
          }
          let takeProfit2 = latestAi.takeProfit2;
          if (takeProfit2 == null || (latestAi.direction === 'long' ? takeProfit2 <= execPrice : takeProfit2 >= execPrice)) {
            takeProfit2 = latestAi.direction === 'long' ? execPrice + slDist * 3 : execPrice - slDist * 3;
          }

          try {
          // ===== 置信度联动仓位：高把握重仓，低把握轻仓 =====
          // 置信度 >= 80：用满 positionPct；60-79：只用 65%（凯利公式简化版）
          // 快引擎再乘 0.4（单笔优势薄 +0.052R，仓位必须显著小于主引擎 — 双引擎独立风控）
          const confScale = latestAi.confidence >= 80 ? 1 : 0.65;
          const isFastEngine = latestAi.model === 'ema-reclaim-15m-v1';
          const engineScale = isFastEngine ? 0.4 : 1;
          const aiMargin = account.available * (account.positionPct / 100) * confScale * engineScale;

          await openPosition(userId, {
            symbol: sym.symbol,
            side: latestAi.direction as 'long' | 'short',
            entryPrice: execPrice, // 正常模式：信号通过闸门即按现价成交
            margin: aiMargin > 0 ? aiMargin : undefined,
            stopLoss,
            takeProfit1,
            takeProfit2,
            strategyId: isFastEngine ? 'fast-ema-reclaim' : `ai_${latestAi.provider}`,
            signalPrice: latestAi.entryPrice || execPrice, // 保留引擎建议的限价挂单价作参考
            // 记录开仓时的模型信息 + 分析ID + 引擎标识，平仓后用于准确率统计；analysisId 供防护3防重放
            aiMeta: JSON.stringify({
              provider: latestAi.provider,
              model: latestAi.model,
              engine: isFastEngine ? 'fast' : 'trend',
              confidence: latestAi.confidence,
              entryType: 'market', // 正常模式：市价进场
              analysisId: latestAi.id,
            }),
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

    // 4c. AI 分析只由前端面板对「当前选中币种」触发（POST /api/ai-analysis），
    //     引擎不再批量分析所有币种（避免烧 AI 额度、分析用户没在看的币种）。
    //     引擎只消费已有分析结果做自动开仓判断（上面的 4b 段）。

    // 5. 每次引擎执行都记录日志（方便排查 Cron 触发是否正常）
    try {
      await prisma.paperTradeLog.create({
        data: {
          accountId: account.id,
          userId,
          action: 'engine',
          detail: JSON.stringify(result),
          price: priceMap[account.currentSymbol || allSymbols[0]?.symbol] || 0,
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

/** 计算自动交易信号（指定币种）
 *  已随策略系统下线移除 — 自动开仓现只来源于 AI 信号（见 runEngine 4b 段）
 */

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
