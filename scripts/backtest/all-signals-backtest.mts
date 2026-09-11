/**
 * 全信号统一回测 —— 覆盖系统中所有"产生多空方向"的工具信号
 *
 * 口径（与 signal-backtest / divergence-backtest 完全一致，无前视偏差）：
 *  - 事件在第 i 根收盘确认，只用 <=i 的数据；评估 i+5 / i+10 / i+20 收益
 *  - 赢率 = 方向命中比例（看涨：未来收益>0；看跌：未来收益<0）
 *  - lift = 信号赢率(10根) − 全样本先验涨/跌率(10根)
 *  - 判定：n>=60 且 lift>+5pp = √优；lift<−5pp = ×劣；其余 ≈平；n<60 = ·样本少
 *
 * 信号分两类：
 *  A. 事件型（向量化，一次算全序列）：常规指标、分型、DIF背离、九转、一目、缠论买卖点
 *  B. 状态翻转型（滑窗重算，方向首次转多/转空）：趋势结构、综合方向决策、预测合成、九线测算
 *
 * 纯画线/几何工具（江恩工具箱、趋势通道、价值区域、ATR目标位、区间箱、关卡触碰）
 * 不产生多空方向，无法做方向回测，在报告末尾单列。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calcMACD, calcRSIArray, calcKDJ, calcBollinger, calcEMAArray,
  calcSuperTrend, calcADX, detectFractals, calcNineTurn, calcChan,
  calcTrendSignal, calcDirectionSignal, calcPredictionSynth, calcAB9Lines,
} from '../../src/shared/lib/indicators';

type K = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Dir = 'B' | 'S';
type Ev = { name: string; i: number; dir: Dir; group: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = [5, 10, 20] as const;
const MAXH = 20;

function load(file: string): K[] {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'data', file), 'utf8')) as Array<Array<string | number>>;
  return raw.map((r) => ({
    time: r[0] as number, open: parseFloat(String(r[1])), high: parseFloat(String(r[2])),
    low: parseFloat(String(r[3])), close: parseFloat(String(r[4])), volume: parseFloat(String(r[5])),
  }));
}

const GROUPS = {
  conv: '常规摆动指标',
  struct: '结构/缠论',
  exo: '特色择时',
  composite: '综合决策',
} as const;

// ---------------- A. 事件型信号 ----------------
function collectEventSignals(kl: K[]): Ev[] {
  const n = kl.length;
  const ev: Ev[] = [];
  const add = (name: string, i: number, dir: Dir, group: string) => { if (i + MAXH < n) ev.push({ name, i, dir, group }); };

  const macd = calcMACD(kl, 12, 26, 9);
  const rsiArr = calcRSIArray(kl, 14);
  const kdj = calcKDJ(kl, 9, 3, 3);
  const bb = calcBollinger(kl, 20);
  const ema9 = calcEMAArray(kl, 9);
  const ema20 = calcEMAArray(kl, 20);
  const st = calcSuperTrend(kl, 10, 3);
  const adx = calcADX(kl, 14);
  const frac = detectFractals(kl);
  const nine = calcNineTurn(kl);
  const chan = calcChan(kl);

  for (let i = 60; i < n; i++) {
    // --- 常规摆动 ---
    if (macd && macd.hist[i - 1] != null && macd.hist[i] != null) {
      if (macd.hist[i - 1]! < 0 && macd.hist[i]! >= 0) add('MACD金叉', i, 'B', GROUPS.conv);
      else if (macd.hist[i - 1]! > 0 && macd.hist[i]! <= 0) add('MACD死叉', i, 'S', GROUPS.conv);
    }
    if (kdj && kdj.k[i - 1] != null && kdj.k[i] != null) {
      if (kdj.k[i - 1]! < kdj.d[i - 1]! && kdj.k[i]! >= kdj.d[i]!) add('KDJ金叉', i, 'B', GROUPS.conv);
      else if (kdj.k[i - 1]! > kdj.d[i - 1]! && kdj.k[i]! <= kdj.d[i]!) add('KDJ死叉', i, 'S', GROUPS.conv);
    }
    if (rsiArr[i - 1] != null && rsiArr[i] != null) {
      if (rsiArr[i - 1]! < 30 && rsiArr[i]! >= 30) add('RSI超卖回升(穿30)', i, 'B', GROUPS.conv);
      else if (rsiArr[i - 1]! > 70 && rsiArr[i]! <= 70) add('RSI超买回落(穿70)', i, 'S', GROUPS.conv);
      if (rsiArr[i - 1]! < 50 && rsiArr[i]! >= 50) add('RSI上穿50', i, 'B', GROUPS.conv);
      else if (rsiArr[i - 1]! > 50 && rsiArr[i]! <= 50) add('RSI下穿50', i, 'S', GROUPS.conv);
    }
    if (bb) {
      const uidx = i - 19;
      if (uidx >= 1 && uidx < bb.upperSeries.length) {
        if (kl[i - 1].close <= bb.upperSeries[uidx - 1].value && kl[i].close > bb.upperSeries[uidx].value) add('BOLL升破上轨', i, 'B', GROUPS.conv);
        if (kl[i - 1].close >= bb.lowerSeries[uidx - 1].value && kl[i].close < bb.lowerSeries[uidx].value) add('BOLL跌破下轨', i, 'S', GROUPS.conv);
      }
    }
    if (ema9[i] > 0 && ema20[i] > 0) {
      if (kl[i].close > ema9[i] && ema9[i] > ema20[i] && (kl[i - 1].close <= ema9[i - 1] || ema9[i - 1] <= ema20[i - 1])) add('EMA多头排列', i, 'B', GROUPS.conv);
      if (kl[i].close < ema9[i] && ema9[i] < ema20[i] && (kl[i - 1].close >= ema9[i - 1] || ema9[i - 1] >= ema20[i - 1])) add('EMA空头排列', i, 'S', GROUPS.conv);
    }
    if (st.points[i - 1].isUp === false && st.points[i].isUp === true) add('SuperTrend翻多', i, 'B', GROUPS.conv);
    else if (st.points[i - 1].isUp === true && st.points[i].isUp === false) add('SuperTrend翻空', i, 'S', GROUPS.conv);
    if (adx && adx.adx[i - 1] != null && adx.adx[i] != null && adx.pdi[i] != null && adx.mdi[i] != null) {
      if (adx.adx[i - 1]! < 23 && adx.adx[i]! >= 25) add('ADX趋势启动', i, adx.pdi[i]! >= adx.mdi[i]! ? 'B' : 'S', GROUPS.conv);
    }

    // --- 神奇九转（+9 底部买入 / -9 顶部卖出）---
    if (nine[i].value === 9) add('神奇九转·底9', i, 'B', GROUPS.exo);
    else if (nine[i].value === -9) add('神奇九转·顶9', i, 'S', GROUPS.exo);
  }

  // --- 分型顶/底 ---
  for (const h of frac.fractalHighs) if (h.idx + MAXH < n && h.idx >= 60) add('缠论分型·顶', h.idx, 'S', GROUPS.struct);
  for (const l of frac.fractalLows) if (l.idx + MAXH < n && l.idx >= 60) add('缠论分型·底', l.idx, 'B', GROUPS.struct);

  // --- MACD DIF 顶/底背离（相邻同向分型）---
  const cl = kl.map((k) => k.close);
  const highs = [...frac.fractalHighs].sort((a, b) => a.idx - b.idx);
  for (let k = 1; k < highs.length; k++) {
    const a = highs[k - 1], b = highs[k];
    if (b.idx + MAXH >= n) break;
    const da = macd!.dif[a.idx], db = macd!.dif[b.idx];
    if (da != null && db != null && cl[b.idx] > cl[a.idx] && db < da) add('MACD/DIF顶背离', b.idx, 'S', GROUPS.struct);
  }
  const lows = [...frac.fractalLows].sort((a, b) => a.idx - b.idx);
  for (let k = 1; k < lows.length; k++) {
    const a = lows[k - 1], b = lows[k];
    if (b.idx + MAXH >= n) break;
    const da = macd!.dif[a.idx], db = macd!.dif[b.idx];
    if (da != null && db != null && cl[b.idx] < cl[a.idx] && db > da) add('MACD/DIF底背离', b.idx, 'B', GROUPS.struct);
  }

  // --- 缠论一/二/三类买卖点（time → index）---
  const t2i = new Map<number, number>();
  kl.forEach((k, idx) => t2i.set(k.time, idx));
  for (const s of chan.signals) {
    const idx = t2i.get(s.time);
    if (idx == null || idx + MAXH >= n) continue;
    const dir: Dir = s.type.endsWith('Buy') ? 'B' : 'S';
    const cls = s.type.startsWith('first') ? '一' : s.type.startsWith('second') ? '二' : '三';
    add(`缠论${cls}类${dir === 'B' ? '买点' : '卖点'}`, idx, dir, GROUPS.struct);
  }

  // --- 一目云图：转换线×基准线 金叉/死叉；收盘上穿/下穿云带 ---
  const Q = 9, B2 = 26, SB = 52;
  const mid = (end: number, len: number) => {
    let h = -Infinity, l = Infinity;
    for (let j = Math.max(0, end - len + 1); j <= end; j++) { if (kl[j].high > h) h = kl[j].high; if (kl[j].low < l) l = kl[j].low; }
    return (h + l) / 2;
  };
  for (let i = Math.max(60, SB); i < n; i++) {
    const tk0 = mid(i - 1, Q), tk1 = mid(i, Q), kj0 = mid(i - 1, B2), kj1 = mid(i, B2);
    if (tk0 <= kj0 && tk1 > kj1) add('一目·转换线上穿基准线', i, 'B', GROUPS.exo);
    else if (tk0 >= kj0 && tk1 < kj1) add('一目·转换线下穿基准线', i, 'S', GROUPS.exo);
    const cTop = Math.max((mid(i, Q) + mid(i, B2)) / 2, mid(i, SB));
    const cBot = Math.min((mid(i, Q) + mid(i, B2)) / 2, mid(i, SB));
    const cTop0 = Math.max((mid(i - 1, Q) + mid(i - 1, B2)) / 2, mid(i - 1, SB));
    const cBot0 = Math.min((mid(i - 1, Q) + mid(i - 1, B2)) / 2, mid(i - 1, SB));
    if (kl[i - 1].close <= cTop0 && kl[i].close > cTop) add('一目·收盘站上云带', i, 'B', GROUPS.exo);
    else if (kl[i - 1].close >= cBot0 && kl[i].close < cBot) add('一目·收盘跌破云带', i, 'S', GROUPS.exo);
  }

  return ev;
}

// ---------------- B. 状态翻转型信号（滑窗重算）----------------
function collectStateSignals(kl: K[]): Ev[] {
  const n = kl.length;
  const ev: Ev[] = [];
  const add = (name: string, i: number, dir: Dir, group: string) => { if (i + MAXH < n) ev.push({ name, i, dir, group }); };

  let prevTrend = '', prevDir = '', prevSynth = '', prevAB9 = '';
  const t0 = Date.now();
  for (let i = 80; i < n; i++) {
    const win = kl.slice(0, i + 1);

    const ts = calcTrendSignal(win);
    const td = ts ? (ts.direction === 'bullish' ? 'L' : ts.direction === 'bearish' ? 'S' : 'N') : 'N';
    if (td === 'L' && prevTrend !== 'L') add('趋势结构·转多(HH+HL)', i, 'B', GROUPS.struct);
    else if (td === 'S' && prevTrend !== 'S') add('趋势结构·转空(LH+LL)', i, 'S', GROUPS.struct);
    prevTrend = td;

    const ds = calcDirectionSignal(win);
    const dd = ds ? ds.decision : 'neutral';
    if (dd === 'long' && prevDir !== 'long') add('综合方向决策·做多', i, 'B', GROUPS.composite);
    else if (dd === 'short' && prevDir !== 'short') add('综合方向决策·做空', i, 'S', GROUPS.composite);
    prevDir = dd;

    const ps = calcPredictionSynth(win);
    const pd = ps ? ps.direction : 'neutral';
    if (pd === 'up' && prevSynth !== 'up') add('预测合成器·转多', i, 'B', GROUPS.composite);
    else if (pd === 'down' && prevSynth !== 'down') add('预测合成器·转空', i, 'S', GROUPS.composite);
    prevSynth = pd;

    const ab = calcAB9Lines(win);
    const ad = ab ? (ab.direction === 'up' ? 'L' : ab.direction === 'down' ? 'S' : 'N') : 'N';
    if (ad === 'L' && prevAB9 !== 'L') add('九线测算·转多', i, 'B', GROUPS.composite);
    else if (ad === 'S' && prevAB9 !== 'S') add('九线测算·转空', i, 'S', GROUPS.composite);
    prevAB9 = ad;
  }
  return ev;
}

// ---------------- 聚合统计 ----------------
type St = { n: number; win: Record<number, number>; ret10: number; group: string; dir: Dir | '' };
const newSt = (group: string): St => ({ n: 0, win: {}, ret10: 0, group, dir: '' });

function ingest(evs: Ev[], kl: K[], agg: Record<string, St>, halfAggs?: [Record<string, St>, Record<string, St>], mid?: number) {
  for (const e of evs) {
    const s = (agg[e.name] ??= newSt(e.group));
    if (!s.dir) s.dir = e.dir;
    const c0 = kl[e.i].close;
    // 半段分桶（稳健性检验）
    if (halfAggs && mid != null) {
      const hs = (halfAggs[e.i < mid ? 0 : 1][e.name] ??= newSt(e.group));
      if (!hs.dir) hs.dir = e.dir;
      hs.n++;
      for (const h of H) {
        const ret2 = (kl[e.i + h].close - c0) / c0;
        hs.win[h] = (hs.win[h] ?? 0) + ((e.dir === 'B' ? ret2 > 0 : ret2 < 0) ? 1 : 0);
      }
      hs.ret10 += (kl[e.i + 10].close - c0) / c0;
    }
    s.n++;
    for (const h of H) {
      const ret = (kl[e.i + h].close - c0) / c0;
      const hit = e.dir === 'B' ? ret > 0 : ret < 0;
      s.win[h] = (s.win[h] ?? 0) + (hit ? 1 : 0);
    }
    s.ret10 += (kl[e.i + 10].close - c0) / c0;
  }
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const files = ['BTCUSDT-4h.json', 'ETHUSDT-4h.json', 'BTCUSDT-1d.json', 'ETHUSDT-1d.json'];
const agg: Record<string, St> = {};
const halfAggs: [Record<string, St>, Record<string, St>] = [{}, {}];
let baseN = 0, baseUp = 0;
const halfBase = [{ n: 0, up: 0 }, { n: 0, up: 0 }];

for (const f of files) {
  const kl = load(f);
  const n = kl.length;
  const mid = Math.floor((n - MAXH) / 2);
  for (let i = 0; i < n - MAXH; i++) {
    baseN++;
    const up = (kl[i + 10].close - kl[i].close) / kl[i].close > 0;
    if (up) baseUp++;
    halfBase[i < mid ? 0 : 1].n++;
    if (up) halfBase[i < mid ? 0 : 1].up++;
  }
  ingest(collectEventSignals(kl), kl, agg, halfAggs, mid);
  const t0 = Date.now();
  ingest(collectStateSignals(kl), kl, agg, halfAggs, mid);
  console.error(`[state] ${f} 状态型滑窗耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const priorUp = baseUp / baseN;       // 先验：任意时点后10根上涨概率
const priorDown = 1 - priorUp;
const halfPrior = [halfBase[0].up / halfBase[0].n, halfBase[1].up / halfBase[1].n] as const;

console.log(`\n数据集：BTC/ETH × 4h/1d，各 1000 根（合并 ${baseN} 个先验观测）`);
console.log(`先验：后10根上涨 ${pct(priorUp)} / 下跌 ${pct(priorDown)}（看涨信号对比前者，看跌对比后者）\n`);

const order = Object.values(GROUPS);
const rows = Object.entries(agg)
  .map(([name, s]) => {
    const isLong = s.dir === 'B';
    const w10 = s.win[10] / s.n;
    const prior = isLong ? priorUp : priorDown;
    const lift = w10 - prior;
    let verdict = '≈平';
    if (s.n < 60) verdict = '·样本少';
    else if (lift > 0.05) verdict = '√优';
    else if (lift < -0.05) verdict = '×劣(反向)';
    return { name, group: s.group, n: s.n, w5: s.win[5] / s.n, w10, w20: s.win[20] / s.n, r10: s.ret10 / s.n, lift, verdict };
  })
  .sort((a, b) => order.indexOf(a.group as never) - order.indexOf(b.group as never) || b.w10 - a.w10);

for (const g of order) {
  const gr = rows.filter((r) => r.group === g);
  if (!gr.length) continue;
  console.log(`================ ${g} ================`);
  console.log('信号\t样本\t赢5\t赢10\t赢20\t均收益10\tlift\t判定');
  for (const r of gr) {
    console.log(`${r.name}\t${r.n}\t${pct(r.w5)}\t${pct(r.w10)}\t${pct(r.w20)}\t${(r.r10 * 100).toFixed(2)}%\t${(r.lift * 100).toFixed(1)}pp\t${r.verdict}`);
  }
  console.log('');
}

console.log('================ 稳健性检验（前半段 vs 后半段 lift，仅列全段 n≥60 的信号） ================');
console.log(`前半先验涨 ${pct(halfPrior[0])} / 后半先验涨 ${pct(halfPrior[1])}；两段同号=跨行情稳定，异号=仅特定行情有效`);
console.log('信号\t前半n\t前lift\t后半n\t后lift\t稳定性');
for (const r of rows) {
  if (r.n < 60) continue;
  const a = halfAggs[0][r.name], b = halfAggs[1][r.name];
  if (!a || !b || a.n < 20 || b.n < 20) continue;
  const pa = a.dir === 'B' ? halfPrior[0] : 1 - halfPrior[0];
  const pb = b.dir === 'B' ? halfPrior[1] : 1 - halfPrior[1];
  const la = a.win[10] / a.n - pa;
  const lb = b.win[10] / b.n - pb;
  const stable = Math.sign(la) === Math.sign(lb) && Math.abs(la) >= 0.03 && Math.abs(lb) >= 0.03 ? '两段同向✓'
    : Math.sign(la) === Math.sign(lb) ? '同向但弱' : '前后反转✗';
  console.log(`${r.name}\t${a.n}\t${(la * 100).toFixed(1)}pp\t${b.n}\t${(lb * 100).toFixed(1)}pp\t${stable}`);
}

console.log('');
console.log('---- 低样本高 lift 信号的分段复核（背离 / 缠论买卖点 / 九转）----');
for (const r of rows) {
  if (r.n >= 60 || Math.abs(r.lift) < 0.05) continue;
  const a = halfAggs[0][r.name], b = halfAggs[1][r.name];
  if (!a || !b) continue;
  const pa = a.dir === 'B' ? halfPrior[0] : 1 - halfPrior[0];
  const pb = b.dir === 'B' ? halfPrior[1] : 1 - halfPrior[1];
  const la = a.n ? a.win[10] / a.n - pa : 0;
  const lb = b.n ? b.win[10] / b.n - pb : 0;
  const tag = a.n && b.n ? (Math.sign(la) === Math.sign(lb) ? '两段同向✓' : '前后反转✗') : '一段无样本';
  console.log(`${r.name}\t全n=${r.n}\t前n=${a.n} ${(la * 100).toFixed(1)}pp\t后n=${b.n} ${(lb * 100).toFixed(1)}pp\t${tag}`);
}
console.log('');
console.log('================ 不参与方向回测的纯画线/几何工具 ================');
console.log('江恩角度线 / 江恩时间周期 / 江恩时价四方 / 江恩轮中轮 / 江恩三分位 / 趋势通道 / 价值区域VA / ATR目标位 / 区间箱 / 关卡触碰');
console.log('（这些工具只产出几何支撑阻力位，不输出多空方向，价值在于手动画线参考，无法统计方向赢率）');
