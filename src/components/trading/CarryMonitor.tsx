'use client';

import { useEffect, useState } from 'react';
import { calcCarryView, CarryView } from '@/shared/lib/carry-signal';
import { FundingPoint } from '@/shared/lib/futures-signal';

const SYMBOLS = ['ETHUSDT', 'BTCUSDT'];
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

export default function CarryMonitor({ refreshKey }: { refreshKey: number }) {
  const [views, setViews] = useState<CarryView[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = async () => {
      const results: CarryView[] = [];
      for (const sym of SYMBOLS) {
        try {
          const r = await fetch(`/api/futures-data?symbol=${sym}&period=1d&limit=500`);
          if (!r.ok) continue;
          const j = await r.json();
          const b: FundingPoint[] | undefined = j?.funding;
          const o: FundingPoint[] | undefined = j?.fundingOkx;
          const v = calcCarryView(sym, b || [], o || null);
          if (v) results.push(v);
        } catch {}
      }
      if (alive) { setViews(results); setLoading(false); }
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
        <span className="text-xs font-semibold text-slate-200">资金费套利监控（Carry · Delta中性 · 仅信号）</span>
        {loading ? <span className="text-[10px] text-dark-500">读取中…</span> : <span className="text-[10px] text-dark-500">实时</span>}
      </div>

      {views && views.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 px-3 pb-3 pt-2">
          {views.map((v) => (
            <div key={v.symbol} className="rounded-lg border border-dark-700/50 bg-dark-800/40 p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-slate-100">{v.symbol}</span>
                {badge(v.signal)}
              </div>

              <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                  <span className="text-dark-500 text-[9px]">当前年化</span>
                  <span className={`font-mono font-semibold ${v.currentAnnual >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(v.currentAnnual, 2)}%</span>
                </div>
                <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                  <span className="text-dark-500 text-[9px]">30日/90日均</span>
                  <span className="font-mono text-slate-200">{fmt(v.avg30Annual, 1)}%<span className="text-dark-500">/{fmt(v.avg90Annual, 1)}%</span></span>
                </div>
                <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                  <span className="text-dark-500 text-[9px]">正资金费占比</span>
                  <span className="font-mono text-slate-200">{(v.positiveRatio * 100).toFixed(0)}%</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                  <span className="text-dark-500 text-[9px]">预估净收益(扣费)</span>
                  <span className={`font-mono font-semibold ${v.netAnnual >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmt(v.netAnnual, 2)}%</span>
                </div>
                <div className="bg-dark-800/50 rounded p-1.5 flex flex-col">
                  <span className="text-dark-500 text-[9px]">拥挤度 z</span>
                  <span className="font-mono text-slate-200">{fmt(v.z, 2)}</span>
                </div>
              </div>

              <div className="text-[10px] text-dark-400 leading-tight break-words">{v.reason}</div>

              {v.okx ? (
                <div className="text-[10px] text-dark-500 leading-tight">
                  双所对照 · 30日本金：Binance {fmt(v.binance.avg30, 2)}% / OKX {fmt(v.okx.avg30, 2)}%
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 pb-3 text-[11px] text-dark-400">
          {loading ? '拉取真实资金费数据…（如长时间无数据，请检查 /api/futures-data）' : '暂无套利数据（数据源不可用）'}
        </div>
      )}

      <div className="px-3 pb-2.5 text-[10px] text-dark-500 leading-snug">
        逻辑：多现货 + 空等额永续（Delta中性），主赚资金费。以上数字均由实时真实资金费算出；"预估净收益"已按一次性开平约0.36%手续费摊薄估算，资金费在约20~27%时段为负（届时变为支出）。本区仅为信号参考，不构成投资建议。
      </div>
    </div>
  );
}