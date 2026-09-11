/**
 * 「更早」信号专项回测 v2 —— 无前视口径 + 前后半程稳健性 + 分周期
 *
 * 关键修正：分型中心根 idx 出现时还不能交易，必须等右侧 r 根确认。
 * 入场点统一记为「确认根」idx+r；考核确认后 3/5/10/20 根收益。
 * 这样 1/2/3 确认的对比才反映真实可交易的「早」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcMACD, calcRSIArray, calcBollinger, calcEMAArray, detectFractals } from '../../src/shared/lib/indicators';

type K = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Dir = 'B' | 'S';
type Ev = { name: string; i: number; dir: Dir; group: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = [3, 5, 10, 20] as const;
const MAXH = 20;

function load(file: string): K[] {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'data', file), 'utf8')) as Array<Array<string | number>>;
  return raw.map((r) => ({
    time: r[0] as number, open: parseFloat(String(r[1])), high: parseFloat(String(r[2])),
    low: parseFloat(String(r[3])), close: parseFloat(String(r[4])), volume: parseFloat(String(r[5])),
  }));
}

// 中心根为 r 根窗口极值；返回中心 idx（确认时点 = idx+r）
function swingPoints(kl: K[], r: number) {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = r; i < kl.length - r; i++) {
    let isH = true, isL = true;
    for (let j = i - r; j <= i + r; j++) {
      if (j === i) continue;
      if (kl[j].high >= kl[i].high) isH = false;
      if (kl[j].low <= kl[i].low) isL = false;
    }
    if (isH) highs.push(i);
    if (isL) lows.push(i);
  }
  return { highs, lows };
}

function collectEarly(kl: K[]): Ev[] {
  const n = kl.length;
  const ev: Ev[] = [];
  // 入场点 = 确认根 idx+r
  const add = (name: string, center: number, r: number, dir: Dir, group: string) => {
    const i = center + r;
    if (i >= 60 && i + MAXH < n) ev.push({ name, i, dir, group });
  };

  const macd = calcMACD(kl, 12, 26, 9);
  const rsi = calcRSIArray(kl, 14);
  const bb = calcBollinger(kl, 20);
  const ema20 = calcEMAArray(kl, 20);
  const ema60 = calcEMAArray(kl, 60);

  // E0 现役 MACD DIF 背离：复核确认根(idx+3)口径，旧回测用中心根有前视嫌疑
  {
    const f3 = detectFractals(kl, 3);
    const cl = kl.map((x) => x.close);
    const highsA = [...f3.fractalHighs].sort((a, b) => a.idx - b.idx);
    for (let k = 1; k < highsA.length; k++) {
      const a = highsA[k - 1], b = highsA[k];
      const da = macd?.dif[a.idx], db = macd?.dif[b.idx];
      if (da != null && db != null && cl[b.idx] > cl[a.idx] && db < da) add('E0 DIF顶背离·确认根(复核)', b.idx, 3, 'S', 'E0现役背离复核');
    }
    const lowsA = [...f3.fractalLows].sort((a, b) => a.idx - b.idx);
    for (let k = 1; k < lowsA.length; k++) {
      const a = lowsA[k - 1], b = lowsA[k];
      const da = macd?.dif[a.idx], db = macd?.dif[b.idx];
      if (da != null && db != null && cl[b.idx] < cl[a.idx] && db > da) add('E0 DIF底背离·确认根(复核)', b.idx, 3, 'B', 'E0现役背离复核');
    }
  }

  // E1 分型 1/2 确认 + 现役 3 确认基准（同口径：确认根入场）
  for (const r of [1, 2, 3] as const) {
    const sp = r === 3 ? (() => { const f = detectFractals(kl, 3); return { highs: f.fractalHighs.map((x) => x.idx), lows: f.fractalLows.map((x) => x.idx) }; })() : swingPoints(kl, r);
    const tag = r === 3 ? 'E1 分型顶·3确认(现役基准)' : r === 2 ? 'E1 分型顶·2确认(早1根)' : 'E1 分型顶·1确认(早2根)';
    const tagB = r === 3 ? 'E1 分型底·3确认(现役基准)' : r === 2 ? 'E1 分型底·2确认(早1根)' : 'E1 分型底·1确认(早2根)';
    for (const c of sp.highs) add(tag, c, r, 'S', 'E1分型确认速度');
    for (const c of sp.lows) add(tagB, c, r, 'B', 'E1分型确认速度');
  }

  const volMa: number[] = new Array(n).fill(NaN);
  let vs = 0;
  for (let i = 0; i < n; i++) {
    vs += kl[i].volume;
    if (i >= 20) vs -= kl[i - 20].volume;
    if (i >= 19) volMa[i] = vs / 20;
  }

  const bw: number[] = new Array(n).fill(NaN);
  if (bb) {
    for (let i = 0; i < n; i++) {
      const u = bb.upperSeries[i - 19]?.value;
      const l = bb.lowerSeries[i - 19]?.value;
      const md = bb.middleSeries[i - 19]?.value;
      if (u != null && l != null && md) bw[i] = (u - l) / md;
    }
  }
  const pctRank = (i: number, val: number, len: number) => {
    let cnt = 0, tot = 0;
    for (let j = Math.max(0, i - len + 1); j <= i; j++) {
      if (isFinite(bw[j])) { tot++; if (bw[j] <= val) cnt++; }
    }
    return tot ? cnt / tot : 0.5;
  };

  let squeeze = false;
  let squeezeSince = -1;
  const addI = (name: string, i: number, dir: Dir, group: string) => { if (i >= 60 && i + MAXH < n) ev.push({ name, i, dir, group }); };

  for (let i = 60; i < n; i++) {
    const k = kl[i];
    const body = Math.abs(k.close - k.open);
    const rng = Math.max(1e-12, k.high - k.low);
    const upperW = k.high - Math.max(k.close, k.open);
    const lowerW = Math.min(k.close, k.open) - k.low;
    const down3 = k.close < kl[i - 3].close;
    const up3 = k.close > kl[i - 3].close;

    // E3 RSI 背离（加超买超卖区过滤）
    if (rsi[i] != null && i >= 70) {
      const s1 = i - 5, s0 = i - 12;
      const l1 = Math.min(...kl.slice(s1, i + 1).map((x) => x.low));
      const l0 = Math.min(...kl.slice(s0, s1).map((x) => x.low));
      const r1 = Math.min(...rsi.slice(s1, i + 1).filter((x): x is number => x != null));
      const r0 = Math.min(...rsi.slice(s0, s1).filter((x): x is number => x != null));
      if (isFinite(l0) && isFinite(r0) && l1 < l0 && r1 > r0 + 2 && rsi[i]! < 45) addI('E3 RSI底背离(超卖区)', i, 'B', 'E3RSI背离');
      const h1 = Math.max(...kl.slice(s1, i + 1).map((x) => x.high));
      const h0 = Math.max(...kl.slice(s0, s1).map((x) => x.high));
      const rh1 = Math.max(...rsi.slice(s1, i + 1).filter((x): x is number => x != null));
      const rh0 = Math.max(...rsi.slice(s0, s1).filter((x): x is number => x != null));
      if (isFinite(h0) && isFinite(rh0) && h1 > h0 && rh1 < rh0 - 2 && rsi[i]! > 55) addI('E3 RSI顶背离(超买区)', i, 'S', 'E3RSI背离');
    }

    // E4 流星线（初筛唯一有效的反转K）
    if (up3 && upperW >= 2 * body && lowerW <= 0.25 * rng && body > 0) addI('E4 流星线(涨后长上影)', i, 'S', 'E4流星');

    // E5 缩量止跌
    if (isFinite(volMa[i]) && volMa[i] > 0 && k.close < ema20[i] && k.volume < 0.6 * volMa[i] && k.low > kl[i - 1].low && down3) {
      addI('E5 缩量止跌(抛压枯竭)', i, 'B', 'E5缩量');
    }

    // E6 收缩突破（初筛显示反向，保留做反面教材）
    if (isFinite(bw[i])) {
      const rank = pctRank(i, bw[i], 60);
      if (rank <= 0.2) { squeeze = true; squeezeSince = i; }
      if (squeeze && i - squeezeSince <= 5) {
        const hh20 = Math.max(...kl.slice(i - 20, i).map((x) => x.high));
        const ll20 = Math.min(...kl.slice(i - 20, i).map((x) => x.low));
        if (k.close > hh20) { addI('E6 收缩后向上突破(假突破多)', i, 'B', 'E6收缩(反面)'); squeeze = false; }
        else if (k.close < ll20) { addI('E6 收缩后向下突破(假突破多)', i, 'S', 'E6收缩(反面)'); squeeze = false; }
      }
    }
  }

  return ev;
}

/** BTC 3确认分型 → ETH；入场=BTC确认根对应的 ETH K线 */
function collectCross(btc: K[], eth: K[]): Ev[] {
  const ev: Ev[] = [];
  const t2i = new Map<number, number>();
  eth.forEach((k, idx) => t2i.set(k.time, idx));
  const bf = detectFractals(btc, 3);
  for (const h of bf.fractalHighs) {
    const ei = t2i.get(btc[Math.min(h.idx + 3, btc.length - 1)].time);
    if (ei != null && ei >= 60 && ei + MAXH < eth.length) ev.push({ name: 'X BTC顶分型确认→ETH', i: ei, dir: 'S', group: 'X跨品种BTC→ETH' });
  }
  for (const l of bf.fractalLows) {
    const ei = t2i.get(btc[Math.min(l.idx + 3, btc.length - 1)].time);
    if (ei != null && ei >= 60 && ei + MAXH < eth.length) ev.push({ name: 'X BTC底分型确认→ETH', i: ei, dir: 'B', group: 'X跨品种BTC→ETH' });
  }
  return ev;
}

// ---------------- 统计（带前后半段） ----------------
type St = { n: number; win: Record<number, number>; ret10: number; dir: Dir | ''; half: [{ n: number; w: number }, { n: number; w: number }] };
const newSt = (): St => ({ n: 0, win: {}, ret10: 0, dir: '', half: [{ n: 0, w: 0 }, { n: 0, w: 0 }] });

function ingest(evs: Ev[], kl: K[], agg: Record<string, St>, mid: number) {
  for (const e of evs) {
    const s = (agg[e.name] ??= newSt());
    if (!s.dir) s.dir = e.dir;
    const c0 = kl[e.i].close;
    s.n++;
    for (const h of H) {
      const ret = (kl[e.i + h].close - c0) / c0;
      if (e.dir === 'B' ? ret > 0 : ret < 0) s.win[h] = (s.win[h] ?? 0) + 1;
    }
    const r10 = (kl[e.i + 10].close - c0) / c0;
    s.ret10 += r10;
    const hs = s.half[e.i < mid ? 0 : 1];
    hs.n++;
    if (e.dir === 'B' ? r10 > 0 : r10 < 0) hs.w++;
  }
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';

function runFile(label: string, file: string, agg: Record<string, St>, prior: { n: number; up: number; half: [{ n: number; up: number }, { n: number; up: number }] }, cross?: { btc: K[]; eth: K[] }) {
  const kl = load(file);
  const n = kl.length;
  const mid = Math.floor((n - MAXH) / 2);
  for (let i = 0; i < n - MAXH; i++) {
    const up = (kl[i + 10].close - kl[i].close) / kl[i].close > 0;
    prior.n++; if (up) prior.up++;
    prior.half[i < mid ? 0 : 1].n++; if (up) prior.half[i < mid ? 0 : 1].up++;
  }
  ingest(collectEarly(kl), kl, agg, mid);
  if (cross) ingest(collectCross(cross.btc, cross.eth), cross.eth, agg, mid);
}

function report(title: string, agg: Record<string, St>, priorUp: number) {
  const priorDown = 1 - priorUp;
  console.log(`\n########## ${title} ##########`);
  const groups = [...new Set(Object.values(agg).map(() => '').map(() => ''))];
  void groups;
  const gnames = new Set<string>();
  // 保持插入顺序
  const order: string[] = [];
  for (const s of Object.values(agg)) {
    const g = (s as St & { group?: string }).group ?? '';
    void g;
  }
  // 简单按事件名分组（组名已编码在名称前缀）
  const byGroup: Record<string, [string, St][]> = {};
  for (const [name, s] of Object.entries(agg)) {
    const g = name.startsWith('E0') ? 'E0 现役DIF背离复核（无前视）'
      : name.startsWith('E1') ? 'E1 分型确认速度（核心）'
      : name.startsWith('E3') ? 'E3 RSI背离'
      : name.startsWith('E4') ? 'E4 流星线'
      : name.startsWith('E5') ? 'E5 缩量止跌'
      : name.startsWith('X') ? 'X跨品种BTC→ETH'
      : 'E6 收缩突破（反面教材）';
    (byGroup[g] ??= []).push([name, s]);
  }
  for (const g of ['E0 现役DIF背离复核（无前视）', 'E1 分型确认速度（核心）', 'E3 RSI背离', 'E4 流星线', 'E5 缩量止跌', 'E6 收缩突破（反面教材）', 'X跨品种BTC→ETH']) {
    const rows = byGroup[g];
    if (!rows) continue;
    console.log(`\n---- ${g} ----`);
    console.log('信号\t样本\t赢3\t赢5\t赢10\t赢20\tlift10\t前半lift\t后半lift\t稳定?');
    for (const [name, s] of rows) {
      const pr = s.dir === 'B' ? priorUp : priorDown;
      const w10 = s.win[10] / s.n;
      const lift = w10 - pr;
      const ph = [s.half[0].n ? s.half[0].w / s.half[0].n - pr : NaN, s.half[1].n ? s.half[1].w / s.half[1].n - pr : NaN];
      const stable = isFinite(ph[0]) && isFinite(ph[1]) && Math.sign(ph[0]) === Math.sign(ph[1]) ? '两段同号✓' : '前后反转✗';
      console.log(`${name}\t${s.n}\t${pct(s.win[3] / s.n)}\t${pct(s.win[5] / s.n)}\t${pct(w10)}\t${pct(s.win[20] / s.n)}\t${(lift * 100).toFixed(1)}pp\t${(ph[0] * 100).toFixed(1)}pp\t${(ph[1] * 100).toFixed(1)}pp\t${stable}`);
    }
  }
}

// ===== 全样本 =====
{
  const agg: Record<string, St> = {};
  const prior = { n: 0, up: 0, half: [{ n: 0, up: 0 }, { n: 0, up: 0 }] };
  const btc4 = load('BTCUSDT-4h.json'), eth4 = load('ETHUSDT-4h.json');
  const btc1 = load('BTCUSDT-1d.json'), eth1 = load('ETHUSDT-1d.json');
  runFile('', 'BTCUSDT-4h.json', agg, prior, { btc: btc4, eth: eth4 });
  runFile('', 'ETHUSDT-4h.json', agg, prior);
  runFile('', 'BTCUSDT-1d.json', agg, prior, { btc: btc1, eth: eth1 });
  runFile('', 'ETHUSDT-1d.json', agg, prior);
  console.log(`全样本先验：后10根上涨 ${pct(prior.up / prior.n)}（n=${prior.n}）`);
  report('全样本 BTC/ETH × 4h/1d', agg, prior.up / prior.n);
}

// ===== 分周期 =====
for (const tf of ['4h', '1d'] as const) {
  const agg: Record<string, St> = {};
  const prior = { n: 0, up: 0, half: [{ n: 0, up: 0 }, { n: 0, up: 0 }] };
  const btc = load(`BTCUSDT-${tf}.json`), eth = load(`ETHUSDT-${tf}.json`);
  runFile('', `BTCUSDT-${tf}.json`, agg, prior, { btc, eth });
  runFile('', `ETHUSDT-${tf}.json`, agg, prior);
  report(`${tf} 周期`, agg, prior.up / prior.n);
}
