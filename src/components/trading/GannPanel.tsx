import { useMemo } from 'react';
import { calcAB9Lines, calcGannAll } from '@/shared/lib/indicators';
import type { KlineData } from '@/shared/lib/market-data';

/**
 * 江恩价位卡
 * 图上的「江恩工具箱」画线保留；这里只把能挂单用的数字挑出来：
 * 波段方向、回调深度、最近支撑/阻力（轮中轮 + 三分位/九线回调档）。
 * 角度线单位、时价四方盒、时间周期这些看不懂又没法直接执行的，已删。
 * 注意：江恩价位是几何测算，未经回测验证，只作挂单/止盈止损的参考位。
 */

interface Props {
  klines: KlineData[];
  refreshKey?: number;
  precision?: number;
  symbol?: string;
}

function Cell({ name, value, note, tone }: { name: string; value: string; note: string; tone?: 'sup' | 'res' | 'flat' }) {
  const valColor = tone === 'sup' ? 'text-emerald-300' : tone === 'res' ? 'text-red-300' : 'text-slate-200';
  return (
    <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 px-2.5 py-2 flex flex-col gap-0.5">
      <span className="text-[10px] text-dark-400">{name}</span>
      <span className={`text-[13px] font-mono font-semibold tabular-nums leading-tight ${valColor}`}>{value}</span>
      <span className="text-[10px] text-dark-400 leading-tight">{note}</span>
    </div>
  );
}

export default function GannPanel({ klines, refreshKey = 0, precision = 2, symbol = '' }: Props) {
  const m = useMemo(() => {
    void refreshKey;
    const g = calcGannAll(klines);
    const ab9 = calcAB9Lines(klines);
    const cur = klines.length ? klines[klines.length - 1].close : null;
    const fmt = (v: number | null | undefined) => (v == null || !isFinite(v) ? '--' : v.toFixed(precision));

    // 回调档位：九线 4/5/6 线 + 江恩三分位
    let cl: { label: string; price: number }[] = [];
    if (ab9) for (const ln of ab9.lines) if (ln.lineNo === 4 || ln.lineNo === 5 || ln.lineNo === 6) cl.push({ label: ln.label, price: ln.price });
    if (g.thirds) for (const t of g.thirds) cl.push({ label: t.label, price: t.price });
    cl = cl.sort((a, b) => a.price - b.price);

    const height = ab9 ? ab9.height : 0;
    const lo = ab9 ? Math.min(ab9.pointA, ab9.pointB) : null;
    const hi = ab9 ? Math.max(ab9.pointA, ab9.pointB) : null;
    const ab9Dir = ab9?.direction ?? g.fan?.direction ?? null;
    let depthPct: number | null = null;
    if (cur != null && hi != null && lo != null && height > 0) {
      const d = ab9Dir === 'down' ? (cur - lo) / height : (hi - cur) / height;
      depthPct = Math.round(Math.max(0, Math.min(1, d)) * 100);
    }

    const nearBelow = cur == null ? undefined : [...cl].reverse().find((l) => l.price <= cur + 1e-9);
    const nearAbove = cur == null ? undefined : cl.find((l) => l.price >= cur - 1e-9);

    // 轮中轮近档（按离现价最近取，不按离种子取）
    const supBelow = g.squareOfNine && cur != null
      ? g.squareOfNine.support.filter((l) => l.price <= cur + 1e-9).sort((a, b) => b.price - a.price)[0] ?? null
      : null;
    const resAbove = g.squareOfNine && cur != null
      ? g.squareOfNine.resistance.filter((l) => l.price >= cur - 1e-9).sort((a, b) => a.price - b.price)[0] ?? null
      : null;

    return { g, ab9, cur, fmt, depthPct, nearBelow, nearAbove, supBelow, resAbove, ab9Dir };
  }, [klines, refreshKey, precision]);

  const { g, cur, fmt, depthPct, nearBelow, nearAbove, supBelow, resAbove, ab9Dir } = m;

  if (!g.fan && !g.thirds) {
    return (
      <div className="rounded-xl border border-purple-500/20 bg-dark-800/30 px-4 py-3 text-xs text-dark-400">
        江恩价位 · 等待K线结构（需≥30根）
      </div>
    );
  }

  const dirUp = g.fan ? g.fan.direction === 'up' : ab9Dir !== 'down';
  const depthText = depthPct == null
    ? '--'
    : depthPct <= 33
      ? dirUp ? '回撤浅，走势强' : '反弹弱'
      : depthPct >= 66
        ? dirUp ? '回撤深，走势弱' : '反弹深，走势强'
        : '回调一半，强弱一般';

  // 一句话读数
  let read: string;
  if (dirUp) {
    read = `上升波段中，${depthText}；价格守住下方 ${supBelow ? fmt(supBelow.price) : (nearBelow ? fmt(nearBelow.price) : '--')} 就还沿趋势走，跌破要小心转弱`;
  } else {
    read = `下降波段中，${depthText}；价格站不上方 ${resAbove ? fmt(resAbove.price) : (nearAbove ? fmt(nearAbove.price) : '--')} 就继续偏弱，放量站上才转强`;
  }

  return (
    <div className="rounded-xl border border-purple-500/20 bg-dark-800/30 overflow-hidden flex flex-col">
      <div className="px-3 pt-2.5 pb-1.5 border-b border-dark-700/40 flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-slate-200">江恩价位{symbol ? ` · ${symbol}` : ''}</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${dirUp ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-red-500/15 border-red-500/40 text-red-300'}`}>
          {dirUp ? '上升波段' : '下降波段'} · 现价 {fmt(cur)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 p-3">
        <Cell name="回调深度（0浅100深）" value={depthPct != null ? `${depthPct}%` : '--'} note={depthText} />
        <Cell name="江恩支撑 · 轮中轮近档" value={supBelow ? fmt(supBelow.price) : '--'}
          note={supBelow ? `下${supBelow.deg}°档，挂多单/止损可参考` : '下方暂无档位'} tone="sup" />
        <Cell name="江恩阻力 · 轮中轮近档" value={resAbove ? fmt(resAbove.price) : '--'}
          note={resAbove ? `上${resAbove.deg}°档，挂空单/止盈可参考` : '上方暂无档位'} tone="res" />
        <Cell name="最近回调档 · 下方" value={nearBelow ? `${fmt(nearBelow.price)}` : '--'}
          note={nearBelow ? `${nearBelow.label} · 回踩位` : '--'} tone="sup" />
        <Cell name="最近回调档 · 上方" value={nearAbove ? `${fmt(nearAbove.price)}` : '--'}
          note={nearAbove ? `${nearAbove.label} · 反弹位` : '--'} tone="res" />
      </div>

      <div className="mx-3 mb-3 rounded-lg bg-dark-900/40 border border-dark-700/50 px-2.5 py-2 text-[11px] text-dark-300 leading-snug">
        <span className="text-purple-300 font-medium">读数：</span>{read}
      </div>
      <div className="mt-auto px-3 py-1.5 border-t border-dark-700/40 text-[9.5px] text-dark-500 leading-tight">
        江恩价位为几何测算，未经回测验证，只作挂单参考；方向和仓位以决策卡为准（图上角度线在「图层 → 江恩工具箱」开关）
      </div>
    </div>
  );
}
