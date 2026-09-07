'use client';

import { useEffect, useState } from 'react';
import { calcHedgeCarry, HedgeCarryView } from '@/shared/lib/carry-signal';
import { FundingPoint } from '@/shared/lib/futures-signal';

const SIGNAL_COLOR: Record<string, string> = {
  '加仓': 'text-emerald-300 border-emerald-500/40 bg-emerald-500/15',
  '持仓': 'text-sky-300 border-sky-500/40 bg-sky-500/15',
  '观望': 'text-amber-300 border-amber-500/40 bg-amber-500/15',
  '减仓': 'text-red-300 border-red-500/40 bg-red-500/15',
};

function fmt(v: number | null | undefined, n = 2): string {
  if (v == null || Number.isNaN(v)) return '--';
  return Number(v).toFixed(n);
}

const venueName = (v: 'binance' | 'okx') => (v === 'binance' ? 'Binance' : 'OKX');

export default function CarryMonitor({ refreshKey }: { refreshKey: number }) {
  const [view, setView] = useState<HedgeCarryView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = async () => {
      try {
        const r = await fetch('/api/futures-data?symbol=ETHUSDT&period=1d&limit=500');
        if (!r.ok) { if (alive) setLoading(false); return; }
        const j = await r.json();
        const b: FundingPoint[] | undefined = j?.funding;
        const o: FundingPoint[] | undefined = j?.fundingOkx;
        const v = calcHedgeCarry(b || null, o || null);
        if (alive) { setView(v); setLoading(false); }
      } catch { if (alive) setLoading(false); }
    };
    void load();
    return () => { alive = false; };
  }, [refreshKey]);

  const badge = (s: string) => (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${SIGNAL_COLOR[s] || ''}`}>{s}</span>
  );

  return (
    <div className="border-b border-dark-700/50 bg-dark-900/60">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-xs font-semibold text-slate-200">ETH 双所永续对冲（纯合约 · 净资金费套利）</span>
        {loading ? <span className="text-[10px] text-dark-500">读取中…</span> : <span className="text-[10px] text-dark-500">实时</span>}
      </div>

      {view ? (
        <div className="px-3 pb-3 pt-2">
          <div className="rounded-lg border border-dark-700/50 bg-dark-800/40 p-2.5 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-slate-100">ETH · 空{venueName(view.shortVenue)} 多{venueName(view.longVenue)}</span>
              {badge(view.signal)}
            </div>

            <div className="grid grid-cols-4 gap-1.5 text-[11px]">
              <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                <span className="text-dark-500 text-[9px]">空腿所资金费</span>
                <span className={`font-mono font-semibold ${view.shortAvg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(view.shortAvg, 2)}%</span>
              </div>
              <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                <span className="text-dark-500 text-[9px]">多腿所资金费</span>
                <span className="font-mono text-slate-200">{fmt(view.longAvg, 2)}%</span>
              </div>
              <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                <span className="text-dark-500 text-[9px]">净价差年化</span>
                <span className={`font-mono font-semibold ${view.grossSpread >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(view.grossSpread, 2)}%</span>
              </div>
              <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                <span className="text-dark-500 text-[9px]">方向稳定度</span>
                <span className="font-mono text-slate-200">{(view.stableRatio * 100).toFixed(0)}%</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                <span className="text-dark-500 text-[9px]">扣费后净收益年化</span>
                <span className={`font-mono font-semibold ${view.netAnnual >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmt(view.netAnnual, 2)}%</span>
              </div>
              <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                <span className="text-dark-500 text-[9px]">当前净价差</span>
                <span className={`font-mono ${view.curSpread >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmt(view.curSpread, 2)}%</span>
              </div>
            </div>

            <div className="text-[10px] text-dark-400 leading-tight break-words">{view.reason}</div>
          </div>
        </div>
      ) : (
        <div className="px-3 pb-3 text-[11px] text-dark-400">
          {loading ? '拉取真实资金费数据…（如长时间无数据，请检查 /api/futures-data）' : '暂无套利数据（需 Binance 与 OKX 双源资金费）'}
        </div>
      )}

      <div className="px-3 pb-2.5 text-[10px] text-dark-500 leading-snug">
        纯合约 Delta中性：多腿开在资金费较低所、空腿开在较高所，每8h收「净资金费=空腿所−多腿所」。两腿同贴指数→净价差通常较薄且会倒挂，需双所账户、两边都押保证金。10u 需拆到两处各约5u，务必先看各所实时 minNotional 能否对开。数字均由真实资金费算出，净收益为估算，不构成投资建议。
      </div>
    </div>
  );
}