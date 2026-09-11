import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calcMACD, calcRSIArray, calcKDJ, calcBollinger, calcEMAArray,
  calcSuperTrend, calcADX,
} from '../../src/shared/lib/indicators';

type K = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Dir = 'B' | 'S';

function load(file: string): K[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Array<string | number>>;
  return raw.map((r) => ({
    time: r[0] as number, open: parseFloat(String(r[1])), high: parseFloat(String(r[2])),
    low: parseFloat(String(r[3])), close: parseFloat(String(r[4])), volume: parseFloat(String(r[5])),
  }));
}

const HORIZONS = [5, 10, 20] as const;
const MAXH = 20;
type Stats = { n: number; win: Record<number, number>; ret: Record<number, number> };
const newS = (): Stats => ({ n: 0, win: {}, ret: {} });

// 客观事件信号 → 事件列表（不含未来信息，i+20 越界剔除由调用方处理）
function collectEvents(kl: K[]) {
  const n = kl.length;
  const events: { name: string; i: number; dir: Dir }[] = [];
  const add = (name: string, i: number, dir: Dir) => { if (i + MAXH < n) events.push({ name, i, dir }); };

  const macd = calcMACD(kl, 12, 26, 9);
  const rsiArr = calcRSIArray(kl, 14);
  const kdj = calcKDJ(kl, 9, 3, 3);
  const bb = calcBollinger(kl, 20);
  const ema9 = calcEMAArray(kl, 9);
  const ema20 = calcEMAArray(kl, 20);
  const st = calcSuperTrend(kl, 10, 3);
  const adx = calcADX(kl, 14);

  for (let i = 30; i < n; i++) {
    // MACD 金叉 / 死叉
    if (macd && macd.hist[i - 1] != null && macd.hist[i] != null) {
      if (macd.hist[i - 1]! < 0 && macd.hist[i]! >= 0) add('MACD金叉', i, 'B');
      else if (macd.hist[i - 1]! > 0 && macd.hist[i]! <= 0) add('MACD死叉', i, 'S');
    }
    // KDJ 金叉 / 死叉
    if (kdj && kdj.k[i - 1] != null && kdj.k[i] != null) {
      if (kdj.k[i - 1]! < kdj.d[i - 1]! && kdj.k[i]! >= kdj.d[i]!) add('KDJ金叉', i, 'B');
      else if (kdj.k[i - 1]! > kdj.d[i - 1]! && kdj.k[i]! <= kdj.d[i]!) add('KDJ死叉', i, 'S');
    }
    // RSI 突破
    if (rsiArr[i - 1] != null && rsiArr[i] != null) {
      if (rsiArr[i - 1]! < 30 && rsiArr[i]! >= 30) add('RSI上穿30', i, 'B');
      else if (rsiArr[i - 1]! > 70 && rsiArr[i]! <= 70) add('RSI下穿70', i, 'S');
      if (rsiArr[i - 1]! < 50 && rsiArr[i]! >= 50) add('RSI上穿50', i, 'B');
      else if (rsiArr[i - 1]! > 50 && rsiArr[i]! <= 50) add('RSI下穿50', i, 'S');
    }
    // BOLL 突破（upperSeries 从 index=period-1 起）
    if (bb) {
      const uidx = i - (20 - 1), lidx = i - (20 - 1);
      if (uidx >= 0 && uidx < bb.upperSeries.length && uidx - 1 >= 0) {
        const up0 = bb.upperSeries[uidx - 1].value, up1 = bb.upperSeries[uidx].value;
        if (kl[i - 1].close <= up0 && kl[i].close > up1) add('BOLL升破', i, 'B');
        const lo0 = bb.lowerSeries[lidx - 1].value, lo1 = bb.lowerSeries[lidx].value;
        if (kl[i - 1].close >= lo0 && kl[i].close < lo1) add('BOLL跌破', i, 'S');
      }
    }
    // EMA 排列成立
    const m1 = kl[i].close > ema9[i] && ema9[i] > ema20[i];
    const m0 = kl[i - 1].close <= ema9[i - 1] || ema9[i - 1] <= ema20[i - 1];
    if (m1 && m0 && ema9[i] > 0) add('EMA多头排列', i, 'B');
    const b1 = kl[i].close < ema9[i] && ema9[i] < ema20[i];
    const b0 = kl[i - 1].close >= ema9[i - 1] || ema9[i - 1] >= ema20[i - 1];
    if (b1 && b0 && ema9[i] > 0) add('EMA空头排列', i, 'S');
    // SuperTrend 翻多 / 翻空
    if (st.points[i - 1].isUp === false && st.points[i].isUp === true) add('ST翻多', i, 'B');
    else if (st.points[i - 1].isUp === true && st.points[i].isUp === false) add('ST翻空', i, 'S');
    // ADX 趋势启动（上穿 25，结合方向）
    if (adx && adx.adx[i - 1] != null && adx.adx[i] != null && adx.pdi[i] != null && adx.mdi[i] != null) {
      if (adx.adx[i - 1]! < 23 && adx.adx[i]! >= 25) {
        add(adx.pdi[i]! >= adx.mdi[i]! ? 'ADX启动·多' : 'ADX启动·空', i, adx.pdi[i]! >= adx.mdi[i]! ? 'B' : 'S');
      }
    }
  }
  return events;
}

type Agg = { s: Stats; long: Stats; short: Stats };
function runDataset(kl: K[]) {
  const bySig: Record<string, Agg> = {};
  const base = newS();
  const events = collectEvents(kl);
  for (const e of events) {
    const a = (bySig[e.name] ??= { s: newS(), long: newS(), short: newS() });
    const c0 = kl[e.i].close;
    const st = e.dir === 'B' ? a.s : e.dir === 'S' ? a.s : a.s;
    st.n++;
    const dd = e.dir === 'B' ? a.long : a.short;
    dd.n++;
    for (const h of HORIZONS) {
      const ret = (kl[e.i + h].close - c0) / c0;
      const winF = e.dir === 'B' ? ret > 0 : ret < 0;
      st.win[h] = (st.win[h] ?? 0) + (winF ? 1 : 0);
      st.ret[h] = (st.ret[h] ?? 0) + ret;
      dd.win[h] = (dd.win[h] ?? 0) + (winF ? 1 : 0);
      dd.ret[h] = (dd.ret[h] ?? 0) + ret;
    }
  }
  // 基线：MA5 vs MA20 方向（naive）
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  for (let i = 30; i < kl.length - 10; i++) {
    const m5 = mean(kl.slice(i - 4, i + 1).map((k) => k.close));
    const m20 = mean(kl.slice(i - 19, i + 1).map((k) => k.close));
    const ret = (kl[i + 10].close - kl[i].close) / kl[i].close;
    base.n++;
    const winF = m5 > m20 ? ret > 0 : ret < 0;
    base.win[10] = (base.win[10] ?? 0) + (winF ? 1 : 0);
    base.ret[10] = (base.ret[10] ?? 0) + ret;
  }
  return { bySig, base };
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';
function emit(agg: Agg) {
  const s = agg.s;
  if (s.n < 30) return null;
  const w5 = s.n ? s.win[5] / s.n : 0, w10 = s.n ? s.win[10] / s.n : 0, w20 = s.n ? s.win[20] / s.n : 0;
  const r10 = s.n ? s.ret[10] / s.n : 0;
  return { n: s.n, w5, w10, w20, r10 };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const files = ['BTCUSDT-4h.json', 'ETHUSDT-4h.json', 'BTCUSDT-1d.json', 'ETHUSDT-1d.json'].map((f) => path.join(here, 'data', f));
const globalAgg: Record<string, Agg> = {};
let globalBaseSum = { n: 0, win10: 0, ret10: 0 };

for (const f of files) {
  const kl = load(f);
  const { bySig, base } = runDataset(kl);
  console.log(`\n##### ${f}  基线(MA方向)·赢率10= ${base.n ? pct(base.win[10] / base.n) : '-'} 均R10= ${base.n ? (base.ret[10] / base.n).toFixed(4) : '-'} #####`);
  console.log('信号\t样本\t赢率5\t赢率10\t赢率20\t均R10');
  const rows = Object.entries(bySig).map(([k, a]) => ({ k, r: emit(a) })).filter((x) => x.r);
  rows.sort((a, b) => (b.r?.w10 ?? 0) - (a.r?.w10 ?? 0));
  for (const row of rows) {
    const r = row.r!;
    console.log(`${row.k}\t${r.n}\t${pct(r.w5)}\t${pct(r.w10)}\t${pct(r.w20)}\t${r.r10.toFixed(4)}`);
    const g = (globalAgg[row.k] ??= { s: newS(), long: newS(), short: newS() });
    const src = bySig[row.k].s;
    g.s.n += src.n; for (const h of HORIZONS) { g.s.win[h] = (g.s.win[h] ?? 0) + (src.win[h] ?? 0); g.s.ret[h] = (g.s.ret[h] ?? 0) + (src.ret[h] ?? 0); }
  }
  globalBaseSum.n += base.n; globalBaseSum.win10 += base.win[10] ?? 0; globalBaseSum.ret10 += base.ret[10] ?? 0;
}

console.log(`\n==================== 全局汇总（4 数据集） 基线赢率10= ${pct(globalBaseSum.win10 / (globalBaseSum.n || 1))} 均R10= ${(globalBaseSum.ret10 / (globalBaseSum.n || 1)).toFixed(4)} ====================`);
console.log('信号\t样本\t赢率5\t赢率10\t赢率20\t均R10\t\t判定');
const baseW = globalBaseSum.win10 / (globalBaseSum.n || 1);
const sorted = Object.entries(globalAgg).map(([k, a]) => ({ k, r: emit(a) })).filter((x) => x.r);
sorted.sort((a, b) => (b.r?.w10 ?? 0) - (a.r?.w10 ?? 0));
for (const row of sorted) {
  const r = row.r!;
  const lift = r.w10 - baseW;
  const verdict = r.n >= 100 && lift > 0.08 ? '√可靠' : r.n >= 100 ? '≈持平' : '·样本少';
  console.log(`${row.k}\t${r.n}\t${pct(r.w5)}\t${pct(r.w10)}\t${pct(r.w20)}\t${r.r10.toFixed(4)}\t${verdict} (lift ${(lift * 100).toFixed(1)}pp)`);
}