'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchKlines, KlineData, INTERVALS } from '@/shared/lib/market-data';
import useChartStore from '@/store/chartStore';
import useSymbolStore from '@/store/symbolStore';

/** 拉取根数：分型预览 + 足够历史窗口 */
const BAR_COUNT = 300;
/** 刷新间隔（ms）：fetchKlines 自带分级 TTL 缓存，30s 巡检不重复打行情源 */
const REFRESH_MS = 30_000;
/** 折叠状态持久化 */
const COLLAPSE_KEY = 'trading-sim-collapsed';
/** 手续费单边 0.05% × 2，满仓保证金 */
const FEE = 0.0005;
const POSRATIO = 1;

type KT = KlineData;

/** 与线上 KlineChart.drawFractalDivergMarkers 一致的"未确认分型预览"判定（n-3 / n-2 两格） */
function isPreview(arr: KT[], i: number): 'H' | 'L' | null {
  const n = arr.length;
  if (i < n - 3 || i > n - 2) return null;
  let top = true, bot = true;
  for (let j = 1; j <= 3; j++) {
    const li = i - j, ri = i + j;
    if (li >= 0) {
      if (arr[i].high < arr[li].high) top = false;
      if (arr[i].low > arr[li].low) bot = false;
    }
    if (ri < n) {
      if (arr[i].high <= arr[ri].high) top = false;
      if (arr[i].low >= arr[ri].low) bot = false;
    }
  }
  return top ? 'H' : bot ? 'L' : null;
}

interface Trade {
  time: number;
  dir: 'LONG' | 'SHORT';        // 持仓方向
  act: 'OPEN' | 'CLOSE';        // 开仓 / 平仓
  price: number; size: number;  // 成交价 / 数量
  sigType: string;              // 预底分型 / 预顶分型 / 反手 / 强平 / 期末平仓
  pnl?: number;
}
interface Pos { dir: 'LONG' | 'SHORT'; qty: number; entry: number; margin: number; }

/**
 * 双向多空回放：预底分型→做多、预顶分型→做空；与当前持仓反向的信号先平旧再反手开新（顶底信号都不落空）。
 * 本金 + 杠杆可自定，满仓、含爆仓强平。同向信号忽略，避免连续加仓。
 */
function runPaper(kl: KT[], capital: number, leverage: number) {
  const n = kl.length;
  const trades: Trade[] = [];
  let balance = capital;
  let pos: Pos | null = null;
  const fired = new Set<string>();

  const open = (dir: 'LONG' | 'SHORT', price: number, time: number, sigType: string) => {
    const margin = balance * POSRATIO;
    const qty = margin * leverage / price; // 名义 = 保证金 × 杠杆
    balance -= margin;
    pos = { dir, qty, entry: price, margin };
    trades.push({ time, dir, act: 'OPEN', price, size: qty, sigType });
  };
  const close = (price: number, time: number, sigType: string, force: boolean) => {
    if (!pos) return;
    const pnl = force ? -pos.margin
      : (price - pos.entry) * pos.qty * (pos.dir === 'LONG' ? 1 : -1)
        - pos.qty * price * FEE - pos.qty * pos.entry * FEE;
    balance += pos.margin + pnl;
    trades.push({ time, dir: pos.dir, act: 'CLOSE', price, size: pos.qty, sigType, pnl });
    pos = null;
  };
  // 反手：平旧仓 + 开新仓（同一根开盘成交）
  const reverse = (newDir: 'LONG' | 'SHORT', price: number, time: number, sigType: string) => {
    if (pos) close(price, time, '反手平' + (pos.dir === 'LONG' ? '多' : '空'), false);
    open(newDir, price, time, sigType);
  };

  for (let t = 30; t < n; t++) {
    const win = kl.slice(0, t + 1), prevWin = kl.slice(0, t);
    for (const x of [t - 2, t - 1]) {
      if (x < 0 || x >= n) continue;
      const sig = isPreview(win, x);
      if (!sig) continue;
      if (isPreview(prevWin, x)) continue;
      const key = `${x}:${sig}`;
      if (fired.has(key)) continue;
      fired.add(key);
      const bar = kl[x + 1];
      if (!bar) continue;
      if (sig === 'L') {
        // 预底分型：空仓→开多；持空→平空反手开多；持多→同向忽略
        if (!pos) open('LONG', bar.open, bar.time, '预底分型');
        else if (pos.dir === 'SHORT') reverse('LONG', bar.open, bar.time, '预底分型');
      } else {
        // 预顶分型：空仓→开空；持多→平多反手开空；持空→同向忽略
        if (!pos) open('SHORT', bar.open, bar.time, '预顶分型');
        else if (pos.dir === 'LONG') reverse('SHORT', bar.open, bar.time, '预顶分型');
      }
    }
    // 爆仓强平：当根价格触及爆仓价（1/杠杆 波动）
    if (pos) {
      const k = kl[t];
      const liq = pos.dir === 'LONG' ? pos.entry * (1 - 1 / leverage) : pos.entry * (1 + 1 / leverage);
      const hit = pos.dir === 'LONG' ? k.low <= liq : k.high >= liq;
      if (hit) close(liq, k.time, '强平', true);
    }
  }
  // 期末强制平仓
  if (pos) close(kl[n - 1].close, kl[n - 1].time, '期末平仓', true);
  return { trades, finalEquity: balance, n };
}

function loadCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

const fmtT = (t: number) => {
  const d = new Date(t * 1000), p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const money = (v: number) => '$' + v.toFixed(2);
const clsOf = (v: number) => (v >= 0 ? 'text-green-400' : 'text-red-400');

/** 方向 + 开平 → 徽标 */
function dirBadge(dir: 'LONG' | 'SHORT', act: 'OPEN' | 'CLOSE') {
  const isOpen = act === 'OPEN';
  if (dir === 'LONG') {
    return {
      text: isOpen ? '开多' : '平多',
      cls: isOpen ? 'bg-green-500/15 text-green-400' : 'text-slate-300',
    };
  }
  return {
    text: isOpen ? '开空' : '平空',
    cls: isOpen ? 'bg-red-500/15 text-red-400' : 'text-slate-300',
  };
}

export default function TradingSimCard() {
  const interval = useChartStore((s) => s.interval);
  const symbol = useSymbolStore((s) => s.symbol);
  const okxId = useSymbolStore((s) => s.okxId);
  const symbolLabel = useSymbolStore((s) => s.label);
  const pricePrecision = useSymbolStore((s) => s.pricePrecision);

  const [klines, setKlines] = useState<KT[] | null>(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [cap, setCap] = useState(10000);
  const [lev, setLev] = useState(1);
  const [inCap, setInCap] = useState('10000');
  const [inLev, setInLev] = useState('1');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  const load = useCallback(async () => {
    try {
      const k = await fetchKlines(symbol, okxId, interval, BAR_COUNT);
      if (k && k.length > 0) {
        setKlines(k);
        setError(null);
      }
    } catch (e: any) {
      setError(e?.message || '获取K线失败');
    } finally {
      setLoading(false);
    }
  }, [symbol, okxId, interval]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const result = useMemo(() => {
    if (!klines || klines.length < 40) return null;
    return runPaper(klines, cap, lev);
  }, [klines, cap, lev]);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch {}
  };

  const apply = () => {
    const c = parseFloat(inCap), l = parseFloat(inLev);
    if (!(c > 0) || !(l >= 1)) return;
    const cl = Math.min(125, l);
    setCap(c); setLev(cl); setInLev(String(cl));
    setCleared(false); // 重算恢复记录
  };

  const ivLabel = INTERVALS.find((i) => i.value === interval)?.label ?? interval;

  // 派生指标
  const stats = useMemo(() => {
    const r = result;
    if (!r) return null;
    const closed = r.trades.filter((t) => t.act === 'CLOSE');
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closed.length - wins;
    const opens = r.trades.filter((t) => t.act === 'OPEN').length;
    const avgPnl = closed.length ? closed.reduce((x, t) => x + (t.pnl ?? 0), 0) / closed.length : 0;
    const ret = (r.finalEquity / cap - 1) * 100;
    const liq = closed.filter((t) => t.sigType === '强平').length;
    const lastOpen = [...r.trades].reverse().find((t) => t.act === 'OPEN');
    // 最终持仓：最后开未平的仓
    let holding: { dir: 'LONG' | 'SHORT'; price: number; size: number; time: number } | null = null;
    for (const t of r.trades) {
      if (t.act === 'OPEN') holding = { dir: t.dir, price: t.price, size: t.size, time: t.time };
      else if (t.act === 'CLOSE') holding = null;
    }
    return { r, closed, wins, losses, opens, avgPnl, ret, liq, lastOpen, holding };
  }, [result, cap]);

  const priceFixed = (v: number) => v.toFixed(pricePrecision ?? 2);
  const shownTrades = stats && !cleared ? stats.r.trades.slice().reverse() : [];

  return (
    <div className="glass-card overflow-hidden">
      {/* 标题栏（点击折叠） */}
      <button
        onClick={toggleCollapse}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-white/[0.02] transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 text-white text-sm font-bold shadow-lg shadow-blue-900/40">
            分
          </span>
          <div>
            <div className="text-sm font-semibold text-slate-100">预分型模拟盘</div>
            <div className="text-[11px] text-dark-400 leading-tight">
              {symbolLabel} · {ivLabel} · 预底做多 / 预顶做空
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-dark-400">
          {loading ? <span className="animate-pulse">加载中</span> : result ? <span className="text-green-400 inline-flex items-center gap-1"><i className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />实时回放</span> : null}
          <span className="text-dark-300 text-xs transition-transform">{collapsed ? '▸' : '▾'}</span>
        </div>
      </button>

      {!collapsed && (
        <div className="px-5 pb-4 space-y-3">
          {/* 参数设置 */}
          <div className="rounded-xl border border-white/10 bg-black/10 p-3.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-dark-400">交易参数（自定）</span>
              <span className="text-[10px] text-dark-500">本金 {money(cap)} · {lev}x</span>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex-1 flex flex-col gap-1 text-[10px] text-dark-400">
                本金 (USDT)
                <input
                  type="number" min={100} step={100} value={inCap}
                  onChange={(e) => setInCap(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-slate-100 text-sm font-semibold outline-none focus:border-blue-500"
                />
              </label>
              <label className="flex-1 flex flex-col gap-1 text-[10px] text-dark-400">
                杠杆 (倍)
                <input
                  type="number" min={1} max={125} step={1} value={inLev}
                  onChange={(e) => setInLev(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-slate-100 text-sm font-semibold outline-none focus:border-blue-500"
                />
              </label>
              <button onClick={apply} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">
                应用
              </button>
            </div>
            <p className="text-[10px] text-dark-500 mt-2 leading-relaxed">
              满仓：以当前权益作保证金、名义 = 本金 × 杠杆；底分型做多、顶分型做空，反向信号平旧反手；触及 1/杠杆 波动则强平。
            </p>
          </div>

          {error ? (
            <div className="text-center text-dark-300 text-xs py-6">{error}</div>
          ) : !stats ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* 账户主卡 */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-[11px] text-dark-400">虚拟账户权益 (USDT)</div>
                    <div className="text-[32px] font-extrabold tracking-tight text-slate-100 tabular-nums leading-none mt-1">
                      {money(result!.finalEquity)}
                    </div>
                  </div>
                  <div className="text-[11px] text-dark-400 text-right">
                    累计回报 <span className={`font-bold ${clsOf(stats.ret)}`}>{stats.ret >= 0 ? '+' : ''}{stats.ret.toFixed(2)}%</span>
                  </div>
                </div>
                <div className={`mt-2.5 inline-flex items-center gap-1 text-xs font-semibold rounded-full px-2.5 py-0.5 ${stats.ret >= 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                  {stats.ret >= 0 ? '▲ 盈利' : '▼ 亏损'} {Math.abs(stats.ret).toFixed(2)}%
                  <span className="opacity-60 font-normal">vs {money(cap)} 本金 · {lev}x</span>
                </div>
                <div className="mt-3 h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${result!.finalEquity >= cap ? 'bg-gradient-to-r from-green-500 to-emerald-500' : 'bg-gradient-to-r from-red-500 to-rose-500'}`}
                    style={{ width: `${Math.min(100, Math.max(3, (result!.finalEquity / cap - 1) * 100 + 100))}%` }} />
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3">
                  {[
                    { v: String(stats.opens), l: '做单次数' },
                    { v: stats.wins + stats.losses > 0 ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1) + '%' : '-', l: '胜率' },
                    { v: (stats.avgPnl >= 0 ? '+' : '') + '$' + Math.abs(stats.avgPnl).toFixed(2), l: '单笔均收益' },
                  ].map((k, i) => (
                    <div key={i} className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                      <div className={`text-[15px] font-bold tabular-nums ${i === 2 ? clsOf(stats.avgPnl) : 'text-slate-100'}`}>{k.v}</div>
                      <div className="text-[10px] text-dark-400 mt-0.5">{k.l}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 当前持仓 */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <span className="text-dark-400">当前持仓</span>
                  <span className="text-dark-500">{stats.opens} 次做单 · 强平 {stats.liq} 次</span>
                </div>
                {stats.holding ? (
                  <div className="flex items-center gap-3">
                    <span className={`flex-none flex items-center justify-center w-11 h-11 rounded-xl font-extrabold ${stats.holding.dir === 'LONG' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
                      {stats.holding.dir === 'LONG' ? '多' : '空'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between text-sm font-semibold text-slate-100">
                        <span>{stats.holding.dir === 'LONG' ? '持有多单' : '持有空单'} <span className="text-[9px] font-normal border border-amber-400/40 text-amber-300 rounded-full px-1.5 py-px">当前在途</span></span>
                        <span className="text-dark-300">{stats.holding.size.toFixed(4)}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-dark-400 mt-0.5">
                        <span>开仓价 {priceFixed(stats.holding.price)}</span>
                        <span>{stats.holding.dir === 'LONG' ? '▼等待预顶' : '▲等待预底'}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-dark-500 mt-1 border-t border-dashed border-white/10 pt-1">
                        <span>开仓：{fmtT(stats.holding.time)}</span>
                        <span>交易 #{stats.r.trades.indexOf(stats.r.trades.find((t) => t.act === 'OPEN' && t.time === stats.holding!.time)!) + 1}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="flex-none flex items-center justify-center w-11 h-11 rounded-xl bg-dark-800/40 text-dark-400 font-extrabold">空</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-slate-100">当前空仓</div>
                      <div className="text-[11px] text-dark-400 mt-0.5">等待预底分型做多 / 预顶分型做空</div>
                      <div className="flex items-center justify-between text-[10px] text-dark-500 mt-1 border-t border-dashed border-white/10 pt-1">
                        <span>上次做单：{stats.lastOpen ? fmtT(stats.lastOpen.time) : '—'}</span>
                        <span>{stats.lastOpen?.sigType ?? '-'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 最新信号 */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
                <div className="text-[11px] text-dark-400 mb-2">最新信号</div>
                {stats.lastOpen ? (
                  <div className="flex items-center gap-2.5">
                    <span className={`flex-none flex items-center justify-center w-8 h-8 rounded-lg font-extrabold text-sm ${stats.lastOpen.dir === 'LONG' ? 'bg-green-500 text-green-950' : 'bg-red-500 text-white'}`}>
                      {stats.lastOpen.dir === 'LONG' ? '▲' : '▼'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-slate-100">
                        {stats.lastOpen.sigType} · {stats.lastOpen.dir === 'LONG' ? '做多' : '做空'}
                      </div>
                      <div className="text-[11px] text-dark-400 mt-0.5">{fmtT(stats.lastOpen.time)}</div>
                    </div>
                    <div className={`text-xs font-bold tabular-nums ${stats.lastOpen.dir === 'LONG' ? 'text-green-400' : 'text-red-400'}`}>{priceFixed(stats.lastOpen.price)}</div>
                  </div>
                ) : (
                  <div className="text-[11px] text-dark-300">暂无信号，等待预分型预览形成</div>
                )}
              </div>

              {/* 最近交易 */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-slate-100">交易记录</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-dark-400">
                      {cleared ? '已清空' : `${stats.opens} 单 · ${stats.closed.length} 平（盈${stats.wins}/亏${stats.losses}）`}
                    </span>
                    <button
                      onClick={() => setCleared((c) => !c)}
                      className="text-[11px] rounded-md border border-white/15 px-2 py-0.5 text-dark-300 hover:bg-white/10"
                    >
                      {cleared ? '恢复' : '一键清空'}
                    </button>
                  </div>
                </div>
                <div className="max-h-44 overflow-auto">
                  {shownTrades.length > 0 ? (
                    <table className="w-full text-[11px] tabular-nums text-left">
                      <thead className="sticky top-0 bg-dark-950/95 text-dark-400">
                        <tr>
                          <th className="py-1 pr-2 font-medium text-right">#</th>
                          <th className="py-1 pr-2 font-medium">時間</th>
                          <th className="py-1 pr-2 font-medium">方向</th>
                          <th className="py-1 pr-2 font-medium">价格</th>
                          <th className="py-1 pr-2 font-medium">触发</th>
                          <th className="py-1 font-medium">盈亏</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownTrades.map((t, i) => {
                          const b = dirBadge(t.dir, t.act);
                          return (
                            <tr key={i} className="border-b border-white/5">
                              <td className="py-1 pr-2 text-right text-dark-500">{shownTrades.length - i}</td>
                              <td className="py-1 pr-2 text-dark-300">{fmtT(t.time).slice(6)}</td>
                              <td className="py-1 pr-2"><span className={`${b.cls} rounded px-1`}>{b.text}</span></td>
                              <td className="py-1 pr-2">{priceFixed(t.price)}</td>
                              <td className="py-1 pr-2">
                                {t.sigType === '强平'
                                  ? <span className="text-[9px] border border-red-400/40 text-red-400 rounded-full px-1.5 py-px">强平</span>
                                  : <span className="text-dark-300">{t.sigType}</span>}
                              </td>
                              <td className={`py-1 ${t.pnl != null ? clsOf(t.pnl) : 'text-dark-500'}`}>
                                {t.pnl != null ? (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(1) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div className="text-center text-dark-500 text-xs py-5">{cleared ? '交易记录已清空' : '暂无交易记录'}</div>
                  )}
                </div>
              </div>

              <p className="text-center text-[10px] text-dark-500 leading-relaxed">
                示意卡 · 数据为当前币种该周期最近 {BAR_COUNT} 根实时K线 · 预底做多 / 预顶做空，异向反手 · 合约逐仓满仓模型含强平 · 非投资建议
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}