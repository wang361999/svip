import { useMemo, type ReactNode } from 'react';
import { calcGannAll } from '@/shared/lib/indicators';
import type { KlineData } from '@/shared/lib/market-data';

interface Props {
  klines: KlineData[];
  refreshKey?: number;
  precision?: number;
  symbol?: string;
}

type V = 'bull' | 'bear' | 'osc';
const CHIP = {
  bull: { chip: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400', bar: 'bg-emerald-500', label: '多' },
  bear: { chip: 'bg-red-500/15 border-red-500/40 text-red-400', bar: 'bg-red-500', label: '空' },
  osc: { chip: 'bg-amber-500/15 border-amber-500/40 text-amber-400', bar: 'bg-amber-500', label: '衡' },
};

function Card({ name, verdict, value, note }: { name: string; verdict?: V; value: string; note?: string }) {
  const c = CHIP[verdict ?? 'osc'];
  return (
    <div className="rounded-lg border border-dark-700/50 bg-dark-800/40 p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[11px] text-dark-200 font-medium truncate">{name}</span>
        {verdict ? (
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${c.chip}`}>{c.label}</span>
        ) : null}
      </div>
      <div className="text-[11px] font-mono tabular-nums text-dark-300 leading-tight break-all">{value}</div>
      {note ? <div className="text-[10px] text-dark-400 leading-tight break-words">{note}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-dark-500">{title}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 px-3 pb-3">{children}</div>
    </div>
  );
}

export default function GannPanel({ klines, refreshKey = 0, precision = 2, symbol = '' }: Props) {
  const memo = useMemo(() => {
    void refreshKey;
    const g = calcGannAll(klines);
    const cur = klines.length ? klines[klines.length - 1].close : null;
    const fmt = (v: number | null | undefined) => (v == null ? '--' : v.toFixed(precision));
    return { g, cur, fmt };
  }, [klines, refreshKey, precision]);

  const { g, cur, fmt } = memo;
  const dir: V = g.fan ? (g.fan.direction === 'up' ? 'bull' : 'bear') : 'osc';

  // —— 关键价位收敛：三分位 + 轮中轮支撑/阻力 ——
  const levels: { price: number; tag: string; color: V }[] = [];
  if (g.thirds) {
    for (const t of g.thirds) {
      const mid = g.thirds.length && g.thirds[0].price <= t.price && t.price <= g.thirds[g.thirds.length - 1].price;
      levels.push({ price: t.price, tag: `${t.label}位`, color: 'osc' });
      void mid;
    }
  }
  if (g.squareOfNine) {
    for (const lvl of g.squareOfNine.support.slice(0, 4)) levels.push({ price: lvl.price, tag: `下${lvl.deg}°`, color: 'bull' });
    for (const lvl of g.squareOfNine.resistance.slice(0, 4)) levels.push({ price: lvl.price, tag: `上${lvl.deg}°`, color: 'bear' });
  }
  const below = levels.filter((l) => cur != null && l.price < cur - 1e-12).sort((a, b) => b.price - a.price);
  const above = levels.filter((l) => cur != null && l.price > cur + 1e-12).sort((a, b) => a.price - b.price);
  const supBelow = g.squareOfNine ? g.squareOfNine.support[0] : null;
  const resAbove = g.squareOfNine ? g.squareOfNine.resistance[0] : null;
  const inBox = g.square && cur != null ? cur >= g.square.priceLo && cur <= g.square.priceHi : null;

  if (!g.fan && !g.thirds) {
    return (
      <div className="border-b border-dark-700/50 bg-dark-900/60 px-3 py-3 text-xs text-dark-400">
        江恩工具箱 · 等待K线结构（需≥30根）
      </div>
    );
  }

  let read = '—';
  if (g.squareOfNine && g.fan) {
    const nearSup = below[0] ? fmt(below[0].price) : '--';
    const nearRes = above[0] ? fmt(above[0].price) : '--';
    read = dir === 'bull'
      ? `上升波段，下方支撑 ${nearSup}：守住则沿 1x1 上移，跌破该档或 1/3 位转弱`
      : `下降波段，上方压力 ${nearRes}：站上该档/2/3 位转强，否则延续下行`;
  }

  return (
    <div className="border-b border-dark-700/50 bg-dark-900/60">
      <div className="flex items-center gap-3 flex-wrap px-3 pt-2">
        <span className="text-xs font-semibold text-slate-200">江恩工具箱{symbol ? ` · ${symbol}` : ''}</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${CHIP[dir].chip}`}>
          {g.fan ? (g.fan.direction === 'up' ? '上升波段' : '下降波段') : '波段结构'}{' '}
          {cur != null ? `现价 ${fmt(cur)}` : ''}
        </span>
      </div>

      <Section title="价 × 时 · 核心">
        <Card name="江恩角度线" verdict={dir} value={g.fan ? `1x1 = ${fmt(g.fan.unitPerBar)}·$/根` : '--'} note={g.fan ? `锚 ${fmt(g.fan.anchorPrice)} · ${g.fan.rays.length} 条射线，1x1 为主位` : '需波段结构'} />
        <Card name="时价四方" verdict={inBox == null ? 'osc' : inBox ? 'osc' : dir}
          value={g.square ? `盒 ${fmt(g.square.priceLo)} ~ ${fmt(g.square.priceHi)}` : '--'}
          note={g.square ? `对角线=1x1·45°；现价${inBox ? '在盒内（平衡）' : '在盒外（失衡）'}` : '需波段结构'} />
        <Card name="时间周期" verdict="osc"
          value={g.timeCycles ? `+45/90/144/180/270/360 根` : '--'}
          note={g.timeCycles ? `自波段两端外推变盘窗口，已标于图上` : '--'} />
      </Section>

      <Section title="关键价位 · 三分位 / 轮中轮">
        <Card name="三分位 1/3·2/3" verdict="osc"
          value={g.thirds ? `1/3 ${fmt(g.thirds[0]?.price)} · 2/3 ${fmt(g.thirds[1]?.price)}` : '--'}
          note="回踩 2/3 留意承压，失守 1/3 转弱" />
        <Card name="轮中轮 · 支撑" verdict="bull"
          value={g.squareOfNine && supBelow ? `近档 ${fmt(supBelow.price)} (下${supBelow.deg}°)` : '--'}
          note={g.squareOfNine ? `自波段${g.squareOfNine.seedLabel}√N下行推算` : '--'} />
        <Card name="轮中轮 · 阻力" verdict="bear"
          value={g.squareOfNine && resAbove ? `近档 ${fmt(resAbove.price)} (上${resAbove.deg}°)` : '--'}
          note={g.squareOfNine ? `自波段${g.squareOfNine.seedLabel}√N上行推算` : '--'} />
        <Card name="现价位置" verdict={dir}
          value={cur != null ? `上方 ${fmt(above[0]?.price) ?? '--'} · 下方 ${fmt(below[0]?.price) ?? '--'}` : '--'}
          note={`最近支撑 ${fmt(below[0]?.price) ?? '--'} · 最近阻力 ${fmt(above[0]?.price) ?? '--'}`} />
      </Section>

      <div className="px-3 pb-3 text-[11px] text-dark-300 border-t border-dark-700/40 pt-2">
        <span className="text-purple-400 font-medium">读数：</span>{read}
      </div>
    </div>
  );
}