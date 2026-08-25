'use client';

/**
 * 模拟盘面板组件
 * - 账户概览（总资产、可用、浮盈浮亏）
 * - 持仓管理（开仓/平仓/部分平仓）
 * - 交易记录（复盘）
 * - 风控配置（杠杆、仓位、手续费、滑点）
 * - 统计数据（胜率、盈亏比）
 */
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { apiGet, apiPost, apiPut } from '@/shared/api/client';
import usePriceStore from '@/store/priceStore';
import useSymbolStore from '@/store/symbolStore';

// ==================== 开仓来源名称映射 ====================

// 历史策略 ID 映射保留用于展示旧交易记录；新开仓来源只有「手动」和「AI 信号」。
const LEGACY_STRATEGY_NAME_MAP: Record<string, string> = {
  trend_macd_ema: '双线趋势流',
  bollinger_squeeze: '布林带收缩突破',
  rsi_divergence: 'RSI 背离反转',
  smc_orderflow: '机构订单流',
  multi_tf_resonance: '多周期共振',
  atr_breakout: 'ATR 波动率突破',
  fibonacci_retracement: '斐波那契回撤',
  momentum_surge: '动量脉冲',
  super_trend: '超级趋势追踪',
  zscore_mean_reversion: 'Z-Score 量化回归',
  ichimoku_cloud: '一目均衡云图',
  turtle_breakout: '海龟交易法则',
  td_sequential: 'TD Sequential 完美计数',
  volume_divergence: '量价背离猎手',
  triple_filter: '三重滤网系统',
  extreme_reversion: '极值惩罚均值回归',
};

function getStrategyName(id: string | null): string {
  if (!id) return '手动';
  if (id.startsWith('ai_')) return `AI 信号（${id.slice(3).toUpperCase()}）`;
  return LEGACY_STRATEGY_NAME_MAP[id] || id;
}

// ==================== 类型 ====================

interface PaperAccount {
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

interface PaperPosition {
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
  status: string;
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

interface PaperTrade {
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

interface PaperStats {
  balance: number;
  available: number;
  marginUsed: number;
  unrealizedPnl: number;
  realizedPnl: number;
  equity: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  totalPnl: number;
  totalFees: number;
  avgPnl: number;
  maxWin: number;
  maxLoss: number;
  profitFactor: number;
  openPositions: number;
  strategyStats?: Record<string, {
    name: string;
    count: number;
    wins: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
  }>;
}

// ==================== 工具函数 ====================

function fp(n?: number | null, digits = 2): string {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 价格格式化 hook：按当前币种精度显示（低价币 0.12345 不再截成 0.12/0.00） */
function useFpPrice() {
  const precision = useSymbolStore((s) => s.pricePrecision);
  return useCallback(
    (n?: number | null) => fp(n, Math.max(0, Math.min(8, precision))),
    [precision],
  );
}

function fmtUsd(n: number): string {
  const sign = n >= 0 ? '' : '-';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const CLOSE_REASON_MAP: Record<string, string> = {
  stop_loss: '止损',
  take_profit_1: '止盈1',
  take_profit_2: '止盈2',
  manual: '手动',
  auto: '自动',
};

// ==================== 主组件 ====================

export default function PaperTradingPanel() {
  const currentPrice = usePriceStore((s) => s.currentPrice);
  const { symbol, okxId } = useSymbolStore();
  const fpPrice = useFpPrice();

  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [stats, setStats] = useState<PaperStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'positions' | 'history' | 'config'>('positions');
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 开仓表单
  const [openForm, setOpenForm] = useState({
    side: 'long' as 'long' | 'short',
    margin: 1000,
    leverage: 10,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
  });

  // 配置表单
  const [configForm, setConfigForm] = useState({
    leverage: 10,
    positionPct: 10,
    stopLossPct: 2,
    takerFee: 0.05,
    makerFee: 0.02,
    slippage: 0.05,
    autoTrade: false,
  });

  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 加载数据
  const loadData = useCallback(async () => {
    try {
      const [acct, pos, trd, st] = await Promise.all([
        apiGet<PaperAccount>('/api/paper/account').catch(() => null),
        apiGet<PaperPosition[]>('/api/paper/positions').catch(() => []),
        apiGet<PaperTrade[]>('/api/paper/trades?limit=50').catch(() => []),
        apiGet<PaperStats>('/api/paper/stats').catch(() => null),
      ]);
      setAccount(acct);
      setPositions(pos || []);
      setTrades(trd || []);
      setStats(st || null);
      if (acct) {
        setConfigForm({
          leverage: acct.leverage,
          positionPct: acct.positionPct,
          stopLossPct: acct.stopLossPct,
          takerFee: acct.takerFee,
          makerFee: acct.makerFee,
          slippage: acct.slippage,
          autoTrade: acct.autoTrade,
        });
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    refreshTimer.current = setInterval(loadData, 5000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [loadData]);

  // 浏览器自动触发引擎 — 当自动交易开启时，每 5 秒触发一次引擎
  // 这样浏览器开着就能驱动自动开仓/止损止盈，不依赖外部 Cron
  const engineTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [browserEngineCount, setBrowserEngineCount] = useState(0);

  useEffect(() => {
    // 只有自动交易开启时才触发
    if (!configForm.autoTrade) {
      if (engineTimer.current) {
        clearInterval(engineTimer.current);
        engineTimer.current = null;
      }
      return;
    }

    // 立即触发一次
    const fireEngine = async () => {
      try {
        await apiPost('/api/paper/engine', {});
        setBrowserEngineCount((c) => c + 1);
      } catch {
        // 静默失败，不打扰用户
      }
    };
    fireEngine();

    // 每 5 秒触发一次（与数据刷新同步）
    engineTimer.current = setInterval(fireEngine, 5000);

    return () => {
      if (engineTimer.current) clearInterval(engineTimer.current);
    };
  }, [configForm.autoTrade]);

  // 显示消息
  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  // 手动开仓
  const handleOpenPosition = async () => {
    if (!currentPrice || currentPrice <= 0) {
      showMsg('error', '无法获取当前价格');
      return;
    }
    setActionLoading(true);
    try {
      const side = openForm.side;
      const entry = currentPrice;
      // 自动计算止损止盈（如果用户没填）
      const riskDist = entry * (configForm.stopLossPct / 100);
      const stopLoss = openForm.stopLoss > 0 ? openForm.stopLoss
        : side === 'long' ? entry - riskDist : entry + riskDist;
      const takeProfit1 = openForm.takeProfit1 > 0 ? openForm.takeProfit1
        : side === 'long' ? entry + riskDist * 1.5 : entry - riskDist * 1.5;
      const takeProfit2 = openForm.takeProfit2 > 0 ? openForm.takeProfit2
        : side === 'long' ? entry + riskDist * 2.5 : entry - riskDist * 2.5;

      await apiPost('/api/paper/positions', {
        symbol: symbol,
        side,
        entryPrice: entry,
        margin: openForm.margin,
        leverage: openForm.leverage,
        stopLoss,
        takeProfit1,
        takeProfit2,
      });
      showMsg('success', `${side === 'long' ? '做多' : '做空'}开仓成功`);
      await loadData();
    } catch (err: any) {
      showMsg('error', err?.message || '开仓失败');
    } finally {
      setActionLoading(false);
    }
  };

  // 平仓
  const handleClose = async (positionId: string, ratio: number = 1, exitPrice?: number) => {
    const closePrice = exitPrice && exitPrice > 0 ? exitPrice : currentPrice;
    if (!closePrice || closePrice <= 0) {
      showMsg('error', '无法获取当前价格');
      return;
    }
    setActionLoading(true);
    try {
      await apiPost(`/api/paper/positions/${positionId}/close`, {
        exitPrice: closePrice,
        closeRatio: ratio,
      });
      showMsg('success', ratio >= 1 ? '平仓成功' : '部分平仓成功');
      await loadData();
    } catch (err: any) {
      showMsg('error', err?.message || '平仓失败');
    } finally {
      setActionLoading(false);
    }
  };

  // 保存配置
  const handleSaveConfig = async () => {
    setActionLoading(true);
    try {
      await apiPut('/api/paper/account', configForm);
      showMsg('success', '配置已保存');
      await loadData();
    } catch (err: any) {
      showMsg('error', err?.message || '保存失败');
    } finally {
      setActionLoading(false);
    }
  };

  // 切换自动交易
  const handleToggleAuto = async () => {
    setActionLoading(true);
    try {
      await apiPut('/api/paper/account', { autoTrade: !configForm.autoTrade });
      setConfigForm((prev) => ({ ...prev, autoTrade: !prev.autoTrade }));
      showMsg('success', `自动交易已${!configForm.autoTrade ? '开启' : '关闭'}`);
      await loadData();
    } catch (err: any) {
      showMsg('error', err?.message || '操作失败');
    } finally {
      setActionLoading(false);
    }
  };

  // 重置账户
  const handleReset = async () => {
    if (!confirm('确定要重置模拟盘吗？所有持仓和交易记录将被清空，余额恢复为 100,000 USDT。')) return;
    setActionLoading(true);
    try {
      await apiPost('/api/paper/account');
      showMsg('success', '账户已重置');
      await loadData();
    } catch (err: any) {
      showMsg('error', err?.message || '重置失败');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="glass-card p-4">
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="glass-card p-4">
        <div className="text-center text-dark-400 text-sm py-4">模拟盘未启用</div>
      </div>
    );
  }

  const equity = (account.balance || 0) + (account.unrealizedPnl || 0);
  const pnlRate = account.balance > 0 ? ((equity - 100000) / 100000) * 100 : 0;

  return (
    <div className="glass-card p-4 space-y-3">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-dark-700/30 pb-2.5">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
            <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h3 className="text-white font-bold text-sm tracking-wide">模拟盘</h3>
            <span className="text-[10px] text-dark-500">{symbol} · 杠杆 {configForm.leverage}x</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 自动交易开关 */}
          <button
            onClick={handleToggleAuto}
            disabled={actionLoading}
            className={`text-[10px] px-2.5 py-1 rounded-md border transition-all flex items-center gap-1.5 ${
              configForm.autoTrade
                ? 'bg-green-500/10 border-green-500/30 text-green-400'
                : 'bg-dark-800 border-dark-600 text-dark-400 hover:text-white'
            }`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${configForm.autoTrade ? 'bg-green-400 animate-pulse' : 'bg-dark-500'}`} />
            {configForm.autoTrade ? '自动交易' : '手动模式'}
          </button>
          {configForm.autoTrade && (
            <span className="text-[9px] text-green-400/60 font-mono" title="浏览器正在驱动引擎">
              引擎 {browserEngineCount}
            </span>
          )}
          <button
            onClick={handleReset}
            disabled={actionLoading}
            className="text-[10px] px-2 py-1 rounded-md bg-dark-800 hover:bg-dark-700 text-dark-300 hover:text-white border border-dark-600 transition-colors"
          >
            重置
          </button>
        </div>
      </div>

      {/* 消息提示 */}
      {message && (
        <div className={`px-3 py-2 rounded-md text-xs ${
          message.type === 'success'
            ? 'bg-green-500/10 border border-green-500/30 text-green-400'
            : 'bg-red-500/10 border border-red-500/30 text-red-400'
        }`}>
          {message.text}
        </div>
      )}

      {/* 账户概览 */}
      <div className="grid grid-cols-4 gap-px bg-dark-700/20 rounded-lg overflow-hidden">
        <div className="bg-dark-800/60 p-2.5">
          <div className="text-[9px] text-dark-500 uppercase">权益</div>
          <div className="text-sm font-bold text-white font-mono">{fmtUsd(equity)}</div>
          <div className={`text-[9px] ${pnlRate >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {pnlRate >= 0 ? '+' : ''}{pnlRate.toFixed(2)}%
          </div>
        </div>
        <div className="bg-dark-800/60 p-2.5">
          <div className="text-[9px] text-dark-500 uppercase">可用</div>
          <div className="text-sm font-bold text-white font-mono">{fmtUsd(account.available)}</div>
          <div className="text-[9px] text-dark-500">保证金 {fmtUsd(account.marginUsed)}</div>
        </div>
        <div className="bg-dark-800/60 p-2.5">
          <div className="text-[9px] text-dark-500 uppercase">浮盈浮亏</div>
          <div className={`text-sm font-bold font-mono ${
            account.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'
          }`}>
            {account.unrealizedPnl >= 0 ? '+' : ''}{fmtUsd(account.unrealizedPnl)}
          </div>
          <div className="text-[9px] text-dark-500">{positions.length} 个持仓</div>
        </div>
        <div className="bg-dark-800/60 p-2.5">
          <div className="text-[9px] text-dark-500 uppercase">已实现</div>
          <div className={`text-sm font-bold font-mono ${
            account.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'
          }`}>
            {account.realizedPnl >= 0 ? '+' : ''}{fmtUsd(account.realizedPnl)}
          </div>
          <div className="text-[9px] text-dark-500">{stats?.totalTrades || 0} 笔交易</div>
        </div>
      </div>

      {/* 统计数据条 */}
      {stats && stats.totalTrades > 0 && (
        <div className="flex items-center gap-4 px-3 py-1.5 rounded-md bg-dark-800/40 text-[10px]">
          <span className="text-dark-400">胜率 <span className="text-white font-bold">{stats.winRate.toFixed(1)}%</span></span>
          <span className="text-dark-400">盈 <span className="text-green-400">{stats.winTrades}</span></span>
          <span className="text-dark-400">亏 <span className="text-red-400">{stats.lossTrades}</span></span>
          <span className="text-dark-400">盈亏比 <span className="text-amber-400 font-bold">{stats.profitFactor.toFixed(2)}</span></span>
          <span className="text-dark-400">总手续费 <span className="text-dark-300">{fmtUsd(stats.totalFees)}</span></span>
          <span className="text-dark-400 ml-auto">当前价 <span className="text-white font-mono">{fpPrice(currentPrice)}</span></span>
        </div>
      )}

      {/* 开仓来源胜率统计（手动 / AI 信号） */}
      {stats && stats.strategyStats && Object.keys(stats.strategyStats).length > 0 && (
        <div className="rounded-xl border border-dark-600/30 bg-dark-800/20 p-3 space-y-2">
          <div className="text-[10px] text-dark-400 font-medium uppercase tracking-wider">开仓来源胜率</div>
          <div className="grid grid-cols-1 gap-1">
            {Object.entries(stats.strategyStats)
              .sort(([, a], [, b]) => b.count - a.count)
              .map(([sid, s]) => {
                const displayName = getStrategyName(sid === 'manual' ? null : sid);
                const isProfitable = s.totalPnl >= 0;
                return (
                  <div key={sid} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-dark-900/40 hover:bg-dark-800/40">
                    <span className="text-[10px] text-white min-w-[80px] truncate" title={displayName}>{displayName}</span>
                    <div className="flex-1 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-dark-700 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${s.winRate >= 50 ? 'bg-green-500' : 'bg-red-500'}`}
                          style={{ width: `${Math.min(s.winRate, 100)}%` }}
                        />
                      </div>
                    </div>
                    <span className={`text-[10px] font-bold ${s.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>{s.winRate.toFixed(0)}%</span>
                    <span className="text-[9px] text-dark-500 w-12 text-right">{s.wins}/{s.count}</span>
                    <span className={`text-[9px] font-mono w-16 text-right ${isProfitable ? 'text-green-400/80' : 'text-red-400/80'}`}>
                      {isProfitable ? '+' : ''}{fmtUsd(s.totalPnl)}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 border-b border-dark-700/30">
        {([
          { key: 'positions', label: '持仓', count: positions.length },
          { key: 'history', label: '交易记录', count: trades.length },
          { key: 'config', label: '风控配置' },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? 'text-blue-400 border-blue-500'
                : 'text-dark-400 border-transparent hover:text-white'
            }`}
          >
            {tab.label}
            {'count' in tab && tab.count !== undefined && (
              <span className="ml-1 text-[9px] text-dark-500">({tab.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      {activeTab === 'positions' && (
        <PositionsTab
          positions={positions}
          currentPrice={currentPrice}
          onClose={handleClose}
          actionLoading={actionLoading}
          openForm={openForm}
          setOpenForm={setOpenForm}
          onOpen={handleOpenPosition}
          configForm={configForm}
        />
      )}

      {activeTab === 'history' && (
        <HistoryTab trades={trades} />
      )}

      {activeTab === 'config' && (
        <ConfigTab
          configForm={configForm}
          setConfigForm={setConfigForm}
          onSave={handleSaveConfig}
          actionLoading={actionLoading}
        />
      )}

      {/* 底部声明 */}
      <div className="text-center text-dark-600 text-[10px] pt-1">
        模拟盘数据每 5 秒刷新 · 仅供学习复盘，不构成投资建议
      </div>
    </div>
  );
}

// ==================== 持仓 Tab ====================

function PositionsTab({
  positions,
  currentPrice,
  onClose,
  actionLoading,
  openForm,
  setOpenForm,
  onOpen,
  configForm,
}: {
  positions: PaperPosition[];
  currentPrice: number;
  onClose: (id: string, ratio?: number, exitPrice?: number) => void;
  actionLoading: boolean;
  openForm: any;
  setOpenForm: (fn: any) => void;
  onOpen: () => void;
  configForm: any;
}) {
  const fpPrice = useFpPrice();
  return (
    <div className="space-y-3">
      {/* 快速开仓 */}
      <div className="rounded-xl border border-dark-600/40 bg-dark-800/30 p-3 space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-dark-400 font-medium">手动开仓</span>
          <span className="text-[9px] text-dark-600">当前价 {fpPrice(currentPrice)}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {/* 方向 */}
          <button
            onClick={() => setOpenForm((f: any) => ({ ...f, side: 'long' }))}
            className={`px-3 py-1.5 rounded-md text-xs font-bold border transition-all ${
              openForm.side === 'long'
                ? 'bg-green-500/15 border-green-500/40 text-green-400'
                : 'bg-dark-800 border-dark-600 text-dark-400 hover:text-white'
            }`}
          >
            做多
          </button>
          <button
            onClick={() => setOpenForm((f: any) => ({ ...f, side: 'short' }))}
            className={`px-3 py-1.5 rounded-md text-xs font-bold border transition-all ${
              openForm.side === 'short'
                ? 'bg-red-500/15 border-red-500/40 text-red-400'
                : 'bg-dark-800 border-dark-600 text-dark-400 hover:text-white'
            }`}
          >
            做空
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[9px] text-dark-500 block mb-0.5">保证金 (USDT)</label>
            <input
              type="number"
              value={openForm.margin}
              onChange={(e) => setOpenForm((f: any) => ({ ...f, margin: parseFloat(e.target.value) || 0 }))}
              className="w-full bg-dark-800 border border-dark-600 rounded-md px-2 py-1 text-xs text-white font-mono focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="text-[9px] text-dark-500 block mb-0.5">杠杆</label>
            <select
              value={openForm.leverage}
              onChange={(e) => setOpenForm((f: any) => ({ ...f, leverage: parseInt(e.target.value) }))}
              className="w-full bg-dark-800 border border-dark-600 rounded-md px-2 py-1 text-xs text-white focus:border-blue-500 outline-none"
            >
              {[1, 2, 3, 5, 10, 20, 25, 50, 75, 100].map((l) => (
                <option key={l} value={l}>{l}x</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[9px] text-dark-500 block mb-0.5">仓位价值</label>
            <div className="px-2 py-1 text-xs text-blue-400 font-mono">
              {fp(openForm.margin * openForm.leverage, 0)}
            </div>
          </div>
        </div>
        <button
          onClick={onOpen}
          disabled={actionLoading || !currentPrice}
          className={`w-full py-1.5 rounded-md text-xs font-bold transition-all ${
            openForm.side === 'long'
              ? 'bg-green-500/20 border border-green-500/40 text-green-400 hover:bg-green-500/30'
              : 'bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30'
          } disabled:opacity-50`}
        >
          {actionLoading ? '处理中...' : `${openForm.side === 'long' ? '做多' : '做空'}开仓`}
        </button>
      </div>

      {/* 持仓列表 */}
      {positions.length === 0 ? (
        <div className="text-center text-dark-500 text-xs py-6">
          暂无持仓
        </div>
      ) : (
        <div className="space-y-2">
          {positions.map((pos) => (
            <PositionCard
              key={pos.id}
              position={pos}
              onClose={onClose}
              actionLoading={actionLoading}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== 持仓卡片 ====================

function PositionCard({
  position,
  onClose,
  actionLoading,
}: {
  position: PaperPosition;
  onClose: (id: string, ratio?: number, exitPrice?: number) => void;
  actionLoading: boolean;
}) {
  const fpPrice = useFpPrice();
  const isLong = position.side === 'long';
  const markPrice = position.currentPrice > 0 ? position.currentPrice : position.entryPrice;
  const livePnl = markPrice > 0
    ? (isLong ? markPrice - position.entryPrice : position.entryPrice - markPrice) * position.quantity
    : position.unrealizedPnl;
  const livePnlPct = position.margin > 0 ? (livePnl / position.margin) * 100 : 0;
  const liqPrice = isLong
    ? position.entryPrice * (1 - 1 / position.leverage)
    : position.entryPrice * (1 + 1 / position.leverage);

  return (
    <div className={`rounded-xl border overflow-hidden ${
      isLong ? 'border-green-500/20 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'
    }`}>
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
            isLong ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {isLong ? '多' : '空'} {position.leverage}x
          </span>
          <span className="text-xs text-white font-medium">{position.symbol}</span>
          {position.partialClosed && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400">已部分平仓</span>
          )}
        </div>
        <span className="text-[9px] text-dark-500">{fmtTime(position.createdAt)}</span>
      </div>

      {/* 价位信息 */}
      <div className="grid grid-cols-5 gap-px bg-dark-700/20">
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">入场价</span>
          <span className="text-[11px] text-white font-mono font-bold">{fpPrice(position.entryPrice)}</span>
        </div>
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">标记价</span>
          <span className="text-[11px] text-blue-400 font-mono font-bold">{fpPrice(markPrice)}</span>
        </div>
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">止损</span>
          <span className="text-[11px] text-red-400 font-mono">{fpPrice(position.stopLoss)}</span>
        </div>
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">止盈1</span>
          <span className="text-[11px] text-green-400 font-mono">{fpPrice(position.takeProfit1)}</span>
        </div>
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">止盈2</span>
          <span className="text-[11px] text-emerald-400 font-mono">{fpPrice(position.takeProfit2)}</span>
        </div>
      </div>

      {/* 盈亏信息 */}
      <div className="grid grid-cols-4 gap-px bg-dark-700/20 border-t border-dark-700/30">
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">数量</span>
          <span className="text-[11px] text-white font-mono">{fp(position.quantity, 4)}</span>
        </div>
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">保证金</span>
          <span className="text-[11px] text-white font-mono">{fmtUsd(position.margin)}</span>
        </div>
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">浮盈浮亏</span>
          <span className={`text-[11px] font-mono font-bold ${
            livePnl >= 0 ? 'text-green-400' : 'text-red-400'
          }`}>
            {livePnl >= 0 ? '+' : ''}{fmtUsd(livePnl)}
          </span>
          <span className={`text-[8px] block ${livePnlPct >= 0 ? 'text-green-400/70' : 'text-red-400/70'}`}>
            {livePnlPct >= 0 ? '+' : ''}{livePnlPct.toFixed(2)}%
          </span>
        </div>
        <div className="bg-dark-800/60 p-2 text-center">
          <span className="text-[8px] text-dark-500 block">预估强平</span>
          <span className="text-[11px] text-amber-400/80 font-mono">{fpPrice(liqPrice)}</span>
        </div>
      </div>

      {/* 开仓费用 */}
      <div className="flex items-center justify-between px-3 py-1 text-[9px] text-dark-500 border-t border-dark-700/20">
        <span>开仓手续费 {fmtUsd(position.entryFee)}</span>
        <span>开仓滑点 {fmtUsd(position.entrySlippage)}</span>
        {position.strategyId && <span className="text-blue-400/60">{getStrategyName(position.strategyId)}</span>}
      </div>

      {/* 操作按钮 */}
      <div className="flex gap-1.5 p-2 border-t border-dark-700/20">
        <button
          onClick={() => onClose(position.id, 0.5, markPrice)}
          disabled={actionLoading || position.partialClosed}
          className="flex-1 py-1 rounded-md text-[10px] font-medium bg-dark-700/50 hover:bg-dark-600 text-dark-300 hover:text-white border border-dark-600 transition-colors disabled:opacity-30"
        >
          平半仓
        </button>
        <button
          onClick={() => onClose(position.id, 1, markPrice)}
          disabled={actionLoading}
          className="flex-1 py-1 rounded-md text-[10px] font-bold bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition-colors disabled:opacity-50"
        >
          全部平仓
        </button>
      </div>
    </div>
  );
}

// ==================== 交易记录 Tab ====================

function HistoryTab({ trades }: { trades: PaperTrade[] }) {
  const fpPrice = useFpPrice();
  if (trades.length === 0) {
    return (
      <div className="text-center text-dark-500 text-xs py-6">
        暂无交易记录
      </div>
    );
  }

  return (
    <div className="space-y-1.5 max-h-96 overflow-y-auto">
      {trades.map((trade) => {
        const isLong = trade.side === 'long';
        const isWin = trade.pnl >= 0;
        const strategyName = getStrategyName(trade.strategyId);
        const strategyClass = trade.strategyId
          ? 'bg-blue-500/15 text-blue-400'
          : 'bg-dark-700/50 text-dark-500';
        return (
          <div key={trade.id} className={`rounded-lg border p-2.5 ${
            isWin ? 'border-green-500/15 bg-green-500/5' : 'border-red-500/15 bg-red-500/5'
          }`}>
            {/* 第一行：方向 + 盈亏 */}
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                  isLong ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                }`}>
                  {isLong ? '多' : '空'} {trade.leverage}x
                </span>
                <span className="text-xs text-white font-medium">{trade.symbol}</span>
                <span className="text-[9px] px-1 py-0.5 rounded bg-dark-700/50 text-dark-400">
                  {CLOSE_REASON_MAP[trade.closeReason] || trade.closeReason}
                </span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${strategyClass}`}>
                  {strategyName}
                </span>
              </div>
              <div className="text-right">
                <div className={`text-sm font-bold font-mono ${
                  isWin ? 'text-green-400' : 'text-red-400'
                }`}>
                  {isWin ? '+' : ''}{fmtUsd(trade.pnl)}
                </div>
                <div className={`text-[9px] ${isWin ? 'text-green-400/70' : 'text-red-400/70'}`}>
                  {isWin ? '+' : ''}{trade.pnlPercent.toFixed(2)}%
                </div>
              </div>
            </div>
            {/* 第二行：价位 */}
            <div className="grid grid-cols-4 gap-2 text-[10px]">
              <div>
                <span className="text-dark-500">入场 </span>
                <span className="text-white font-mono">{fpPrice(trade.entryPrice)}</span>
              </div>
              <div>
                <span className="text-dark-500">出场 </span>
                <span className="text-white font-mono">{fpPrice(trade.exitPrice)}</span>
              </div>
              <div>
                <span className="text-dark-500">数量 </span>
                <span className="text-white font-mono">{fp(trade.quantity, 4)}</span>
              </div>
              <div>
                <span className="text-dark-500">时长 </span>
                <span className="text-white font-mono">{fmtDuration(trade.duration)}</span>
              </div>
            </div>
            {/* 第三行：费用 */}
            <div className="flex items-center justify-between mt-1 pt-1 border-t border-dark-700/20 text-[9px] text-dark-500">
              <span>手续费 {fmtUsd(trade.fee)}</span>
              <span>滑点 {fmtUsd(trade.slippage)}</span>
              <span>总成本 {fmtUsd(trade.totalCost)}</span>
              <span>{fmtTime(trade.closedAt)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== 风控配置 Tab ====================

function ConfigTab({
  configForm,
  setConfigForm,
  onSave,
  actionLoading,
}: {
  configForm: any;
  setConfigForm: (fn: any) => void;
  onSave: () => void;
  actionLoading: boolean;
}) {
  return (
    <div className="space-y-3">
      {/* 杠杆和仓位 */}
      <div className="rounded-xl border border-dark-600/40 bg-dark-800/30 p-3 space-y-3">
        <div className="text-[10px] text-dark-400 font-medium uppercase tracking-wider">仓位管理</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-dark-500 block mb-1">默认杠杆</label>
            <select
              value={configForm.leverage}
              onChange={(e) => setConfigForm((f: any) => ({ ...f, leverage: parseInt(e.target.value) }))}
              className="w-full bg-dark-800 border border-dark-600 rounded-md px-2 py-1.5 text-xs text-white focus:border-blue-500 outline-none"
            >
              {[1, 2, 3, 5, 10, 20, 25, 50, 75, 100].map((l) => (
                <option key={l} value={l}>{l}x</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-dark-500 block mb-1">单笔仓位占比 %</label>
            <input
              type="number"
              value={configForm.positionPct}
              min="0.1"
              max="100"
              step="0.1"
              onChange={(e) => setConfigForm((f: any) => ({ ...f, positionPct: parseFloat(e.target.value) || 0 }))}
              className="w-full bg-dark-800 border border-dark-600 rounded-md px-2 py-1.5 text-xs text-white font-mono focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-dark-500 block mb-1">单笔风险占比 %</label>
            <input
              type="number"
              value={configForm.stopLossPct}
              min="0.1"
              max="50"
              step="0.1"
              onChange={(e) => setConfigForm((f: any) => ({ ...f, stopLossPct: parseFloat(e.target.value) || 0 }))}
              className="w-full bg-dark-800 border border-dark-600 rounded-md px-2 py-1.5 text-xs text-white font-mono focus:border-blue-500 outline-none"
            />
            <span className="text-[9px] text-dark-600 mt-0.5 block">用于自动计算止损距离</span>
          </div>
        </div>
      </div>

      {/* 手续费和滑点 */}
      <div className="rounded-xl border border-dark-600/40 bg-dark-800/30 p-3 space-y-3">
        <div className="text-[10px] text-dark-400 font-medium uppercase tracking-wider">交易成本</div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] text-dark-500 block mb-1">吃单手续费 %</label>
            <input
              type="number"
              value={configForm.takerFee}
              min="0"
              max="1"
              step="0.01"
              onChange={(e) => setConfigForm((f: any) => ({ ...f, takerFee: parseFloat(e.target.value) || 0 }))}
              className="w-full bg-dark-800 border border-dark-600 rounded-md px-2 py-1.5 text-xs text-white font-mono focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-dark-500 block mb-1">挂单手续费 %</label>
            <input
              type="number"
              value={configForm.makerFee}
              min="0"
              max="1"
              step="0.01"
              onChange={(e) => setConfigForm((f: any) => ({ ...f, makerFee: parseFloat(e.target.value) || 0 }))}
              className="w-full bg-dark-800 border border-dark-600 rounded-md px-2 py-1.5 text-xs text-white font-mono focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-dark-500 block mb-1">滑点 %</label>
            <input
              type="number"
              value={configForm.slippage}
              min="0"
              max="1"
              step="0.01"
              onChange={(e) => setConfigForm((f: any) => ({ ...f, slippage: parseFloat(e.target.value) || 0 }))}
              className="w-full bg-dark-800 border border-dark-600 rounded-md px-2 py-1.5 text-xs text-white font-mono focus:border-blue-500 outline-none"
            />
          </div>
        </div>
        <div className="text-[9px] text-dark-600">
          默认值参照 Binance 永续合约：吃单 0.05%，挂单 0.02%，滑点 0.05%
        </div>
      </div>

      {/* 自动交易说明 */}
      <div className={`rounded-xl border p-3 ${
        configForm.autoTrade
          ? 'border-green-500/20 bg-green-500/5'
          : 'border-dark-600/40 bg-dark-800/30'
      }`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-dark-400 font-medium uppercase tracking-wider">自动交易</span>
          <span className={`text-[10px] font-bold ${configForm.autoTrade ? 'text-green-400' : 'text-dark-500'}`}>
            {configForm.autoTrade ? '已开启' : '已关闭'}
          </span>
        </div>
        <p className="text-[10px] text-dark-500 leading-relaxed">
          开启后，引擎将根据 AI 信号自动开仓（受多周期趋势、白名单、ATR 波动闸门约束，碎波市自动暂停）。需在 VPS 上部署 trigger 脚本持续触发 /api/paper/engine。
          最多同时持有 5 个仓位，同方向不重复开仓。
        </p>
      </div>

      <button
        onClick={onSave}
        disabled={actionLoading}
        className="w-full py-2 rounded-md text-xs font-bold bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/25 transition-all disabled:opacity-50"
      >
        {actionLoading ? '保存中...' : '保存配置'}
      </button>
    </div>
  );
}
