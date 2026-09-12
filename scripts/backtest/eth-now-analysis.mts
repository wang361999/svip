/**
 * ETH 当前走势独立分析（只读，不交易）
 * 口径与 SignalPanel 完全一致：仅用已收盘K线；信号均为回测验证过的子集
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calcAB9Lines, calcBollinger, calcMACD, calcRSIArray, calcEMAArray,
  calcIchimoku, calcATRArray, detectFractals,
} from '../../src/shared/lib/indicators';

type K = { time: number; open: number; high: number; low: number; close: number; volume: number };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f: string): K[] => {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'data', f), 'utf8')) as Array<Array<string | number>>;
  // 剔除最后一根未收盘K线（其 close/volume 仍在变动，用它=前视）
  return raw.slice(0, -1).map((r) => ({ time: r[0] as number, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
};
const pf = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

interface Vote { dir: 'long' | 'short'; w: number; text: string }
function analyze(kl: K[], label: string, btc4h?: K[]): { votes: Vote[]; warns: string[]; notes: string[]; sup: number[]; res: number[] } {
  const votes: Vote[] = []; const warns: string[] = []; const notes: string[] = [];
  const sup: number[] = []; const res: number[] = [];
  const n = kl.length; const last = kl[n - 1]; const price = last.close;
  const barMs = kl[1].time - kl[0].time;
  const is4h = barMs === 4 * 3600e3, is1d = barMs === 86400e3;
  console.log(`\n${'='.repeat(70)}\n【${label}】收盘 ${new Date(last.time).toISOString()}  现价 $${pf(price)}`);
  const chg = (b: number) => (price - kl[n - 1 - b].close) / kl[n - 1 - b].close;
  console.log(`涨跌：近6根${pct(chg(Math.min(6, n - 1)))}  近20根${pct(chg(Math.min(20, n - 1)))}  近60根${pct(chg(Math.min(60, n - 1)))}`);
  const hi20 = Math.max(...kl.slice(n - 20).map((x) => x.high)), lo20 = Math.min(...kl.slice(n - 20).map((x) => x.low));
  console.log(`20根区间：$${pf(lo20)} ~ $${pf(hi20)}（现价处于区间 ${((price - lo20) / (hi20 - lo20) * 100).toFixed(0)}% 位置）`);

  // 均线
  const ema20 = calcEMAArray(kl, 20), ema60 = calcEMAArray(kl, 60);
  console.log(`EMA20 $${pf(ema20[n - 1])}（价${price > ema20[n - 1] ? '在上' : '在下'}）  EMA60 $${pf(ema60[n - 1])}（价${price > ema60[n - 1] ? '在上' : '在下'}）  EMA排列 ${ema20[n - 1] > ema60[n - 1] ? '多头' : '空头'}`);

  // 九线
  const ab9 = calcAB9Lines(kl);
  if (ab9) {
    console.log(`九线：${ab9.direction === 'up' ? '上升' : '下降'}波段 A=$${pf(ab9.pointA)} → B=$${pf(ab9.pointB)}（幅度${(ab9.height / Math.min(ab9.pointA, ab9.pointB) * 100).toFixed(1)}%）｜现价${ab9.betweenLines}｜评级【${ab9.strength}】`);
    ab9.lines.forEach((l) => { if (Math.abs(l.price - price) / price < 0.015) (l.price < price ? sup : res).push(l.price); });
  }

  // 分型
  const frac = detectFractals(kl, 3);
  const cb = n - 1 - 3;
  const cH = frac.fractalHighs.filter((f) => f.idx <= cb), cL = frac.fractalLows.filter((f) => f.idx <= cb);
  const lh = cH[cH.length - 1], ll = cL[cL.length - 1];
  if (lh) res.push(lh.price); if (ll) sup.push(ll.price);
  if (lh && (!ll || lh.idx > ll.idx)) votes.push({ dir: 'short', w: 1.0, text: `顶分型 $${pf(lh.price)}（${n - 1 - lh.idx}根前确认）` });
  if (ll && (!lh || ll.idx > lh.idx)) notes.push(`底分型 $${pf(ll.price)}（${n - 1 - ll.idx}根前确认）— 实测不稳，仅支撑参考`);

  // MACD DIF 顶背离
  const macd = calcMACD(kl, 12, 26, 9);
  if (macd && cH.length >= 2) {
    const a = cH[cH.length - 2], b = cH[cH.length - 1];
    if (kl[b.idx].close > kl[a.idx].close && macd.dif[b.idx] < macd.dif[a.idx] && n - 1 - b.idx <= 20) {
      votes.push({ dir: 'short', w: 2.0, text: `MACD DIF顶背离（${n - 1 - b.idx}根前确认，DIF ${macd.dif[a.idx].toFixed(1)}→${macd.dif[b.idx].toFixed(1)}）` });
    }
  }
  console.log(`MACD：DIF=${macd?.dif[n - 1].toFixed(2)} DEA=${macd?.dea[n - 1].toFixed(2)} 柱=${macd?.hist[n - 1].toFixed(2)}（${(macd?.hist[n - 1] ?? 0) >= 0 ? '零轴上方' : '零轴下方'}）`);

  const rsi = calcRSIArray(kl, 14);
  console.log(`RSI14=${rsi[n - 1]?.toFixed(1)}`);

  if (is4h) {
    // RSI 顶背离
    const i = n - 1, rNow = rsi[i]!;
    if (i >= 70) {
      const s1 = i - 5, s0 = i - 12;
      const h1 = Math.max(...kl.slice(s1, i + 1).map((x) => x.high)), h0 = Math.max(...kl.slice(s0, s1).map((x) => x.high));
      const rh1 = Math.max(...rsi.slice(s1, i + 1).filter((x): x is number => x != null));
      const rh0 = Math.max(...rsi.slice(s0, s1).filter((x): x is number => x != null));
      if (h1 > h0 && rh1 < rh0 - 2 && rNow > 55) votes.push({ dir: 'short', w: 1.8, text: `4h RSI顶背离（RSI ${rh0.toFixed(0)}→${rh1.toFixed(0)}，现价还在涨）` });
      // 缩量止跌
      let vs = 0; for (let j = i - 19; j <= i; j++) vs += kl[j].volume;
      const vma = vs / 20, k0 = kl[i];
      if (k0.close < ema20[i] && k0.volume < 0.6 * vma && k0.low > kl[i - 1].low && k0.close < kl[i - 3].close) {
        votes.push({ dir: 'long', w: 1.3, text: '4h 缩量止跌（量<6成均量且不创新低）' });
      }
    }
    // 收缩假突破警示（只取最近一次，且须发生在3根内，与面板口径一致）
    const bb = calcBollinger(kl, 20);
    if (bb) {
      const bw = kl.map((_, j) => { const u = bb.upperSeries[j - 19]?.value, l = bb.lowerSeries[j - 19]?.value, m = bb.middleSeries[j - 19]?.value; return u != null && l != null && m ? (u - l) / m : NaN; });
      let sq = false, since = -1; let lastBreak: { dir: 'up' | 'down'; ago: number } | null = null;
      for (let j = 60; j < n; j++) {
        if (!isFinite(bw[j])) continue;
        let c = 0, t = 0; for (let q = Math.max(0, j - 59); q <= j; q++) { if (isFinite(bw[q])) { t++; if (bw[q] <= bw[j]) c++; } }
        if (t && c / t <= 0.2) { sq = true; since = j; }
        if (sq && j - since <= 5) {
          const hh = Math.max(...kl.slice(j - 20, j).map((x) => x.high)), ll2 = Math.min(...kl.slice(j - 20, j).map((x) => x.low));
          if (kl[j].close > hh) { lastBreak = { dir: 'up', ago: n - 1 - j }; sq = false; }
          else if (kl[j].close < ll2) { lastBreak = { dir: 'down', ago: n - 1 - j }; sq = false; }
        }
      }
      if (lastBreak && lastBreak.ago <= 3) {
        warns.push(`收缩后${lastBreak.dir === 'up' ? '向上' : '向下'}突破发生在${lastBreak.ago}根前 — 历史多为假突破，勿追`);
      } else if (lastBreak) {
        notes.push(`最近一次收缩突破在${lastBreak.ago}根前（${lastBreak.dir === 'up' ? '向上' : '向下'}），已过警示窗口`);
      }
    }
    // BTC 联动
    if (btc4h) {
      const bf = detectFractals(btc4h, 3); const bcb = btc4h.length - 1 - 3;
      const bh = bf.fractalHighs.filter((f) => f.idx <= bcb).pop();
      if (bh && btc4h.length - 1 - bh.idx <= 3) notes.push(`BTC 4h 刚确认顶分型（弱参考，ETH 联动 lift 仅+4.8pp）`);
    }
  }

  if (is1d) {
    const k0 = kl[n - 1], body = Math.abs(k0.close - k0.open), rng = Math.max(1e-12, k0.high - k0.low);
    const uw = k0.high - Math.max(k0.close, k0.open), lw = Math.min(k0.close, k0.open) - k0.low;
    if (k0.close > kl[n - 4].close && uw >= 2 * body && lw <= 0.25 * rng && body > 0) {
      votes.push({ dir: 'short', w: 1.2, text: '日线流星线（涨后长上影被砸回）' });
    }
  }

  // 云带
  const ichi = calcIchimoku(kl, 9, 26, 52, 26);
  if (ichi?.cloud.length) {
    const cc = [...ichi.cloud].reverse().find((c) => c.time <= last.time) ?? ichi.cloud[0];
    sup.push(cc.bottom); res.push(cc.top);
    if (price < cc.bottom) votes.push({ dir: 'short', w: 1.2, text: `收盘跌破云带下沿 $${pf(cc.bottom)}` });
    if (price > cc.top) warns.push(`价格在云顶 $${pf(cc.top)} 上方 — 历史此处追高平均倒亏，勿追`);
    console.log(`一目云带：$${pf(cc.bottom)} ~ $${pf(cc.top)}（价${price < cc.bottom ? '在云下' : price > cc.top ? '在云上' : '在云中'}）`);
  }

  // 布林
  const bb2 = calcBollinger(kl, 20);
  if (bb2) {
    sup.push(bb2.lower); res.push(bb2.upper);
    console.log(`布林：下$${pf(bb2.lower)} 中$${pf(bb2.middle)} 上$${pf(bb2.upper)}（带宽${((bb2.upper - bb2.lower) / bb2.middle * 100).toFixed(1)}%）`);
    if (price > bb2.upper) warns.push('冲出布林上轨，短线涨过头');
    if (price < bb2.lower) notes.push('跌破布林下轨（不单独抄底，等缩量止跌确认）');
  }

  // ATR
  const atr = calcATRArray(kl, 14);
  console.log(`ATR14=$${pf(atr[n - 1])}（止损参考 1.5×ATR=$${pf(atr[n - 1] * 1.5)}，约${(atr[n - 1] * 1.5 / price * 100).toFixed(1)}%）`);

  return { votes, warns, notes, sup, res };
}

const eth4h = load('ETHUSDT-4h.json');
const eth1d = load('ETHUSDT-1d.json');
const btc4h = load('BTCUSDT-4h.json');

const r4 = analyze(eth4h, 'ETH / 4小时', btc4h);
const r1 = analyze(eth1d, 'ETH / 日线');

// 汇总投票
console.log(`\n${'='.repeat(70)}\n【信号投票汇总】`);
const showV = (name: string, r: { votes: Vote[] }) => {
  if (!r.votes.length) { console.log(`${name}：无方向性信号`); return; }
  const L = r.votes.filter((v) => v.dir === 'long').reduce((a, b) => a + b.w, 0);
  const S = r.votes.filter((v) => v.dir === 'short').reduce((a, b) => a + b.w, 0);
  console.log(`${name}：多票权重 ${L.toFixed(1)} / 空票权重 ${S.toFixed(1)}`);
  r.votes.forEach((v) => console.log(`   ${v.dir === 'long' ? '▲多' : '▼空'} w${v.w}  ${v.text}`));
};
showV('4h', r4); showV('1d', r1);
[...r4.warns.map((x) => `[4h] ${x}`), ...r1.warns.map((x) => `[1d] ${x}`)].forEach((x) => console.log(`   ⚠ ${x}`));
[...r4.notes.map((x) => `[4h] ${x}`), ...r1.notes.map((x) => `[1d] ${x}`)].forEach((x) => console.log(`   · ${x}`));

const price = eth4h[eth4h.length - 1].close;
const near = (arr: number[]) => [...new Set(arr.map((x) => Math.round(x)))]
  .filter((x) => Math.abs(x - price) / price < 0.06).sort((a, b) => a - b);
console.log(`\n现价 $${pf(price)} 上下6%关键位：`);
console.log(`  支撑：${near([...r4.sup, ...r1.sup].filter((x) => x < price)).map(pf).join(' / ') || '无邻近'}`);
console.log(`  阻力：${near([...r4.res, ...r1.res].filter((x) => x > price)).sort((a, b) => b - a).map(pf).join(' / ') || '无邻近'}`);
