import fs from 'node:fs';
import { calcMACD, calcRSIArray, calcKDJ, calcBollinger, calcEMAArray, calcSuperTrend, calcADX } from './svip/src/shared/lib/indicators';

type K = { time: number; open: number; high: number; low: number; close: number; volume: number };
function load(file: string): K[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Array<string | number>>;
  return raw.map((r) => ({ time: r[0] as number, open: parseFloat(String(r[1])), high: parseFloat(String(r[2])), low: parseFloat(String(r[3])), close: parseFloat(String(r[4])), volume: parseFloat(String(r[5])) }));
}

type ScoreLayer = { n: number; win10: number; ret10: number; win20: number };

// 每根K线的全时状态分数 score in [-7,7]
function buildScores(kl: K[]) {
  const n = kl.length;
  const score = new Array<number>(n).fill(0);
  const macd = calcMACD(kl, 12, 26, 9);
  const rsi = calcRSIArray(kl, 14);
  const kdj = calcKDJ(kl, 9, 3, 3);
  const bb = calcBollinger(kl, 20);
  const ema20 = calcEMAArray(kl, 20);
  const st = calcSuperTrend(kl, 10, 3);
  const adx = calcADX(kl, 14);
  for (let i = 26; i < n; i++) {
    let s = 0;
    if (macd && macd.hist[i] != null) s += macd.hist[i]! > 0 ? 1 : -1;
    if (kdj && kdj.k[i] != null) s += kdj.k[i]! >= kdj.d[i]! ? 1 : -1;
    if (rsi[i] != null) s += rsi[i]! >= 50 ? 1 : -1;
    if (ema20[i] != null && ema20[i]! > 0) s += kl[i].close >= ema20[i]! ? 1 : -1;
    if (st.points[i].isUp != null) s += st.points[i].isUp! ? 1 : -1;
    if (bb) { const m = bb.middleSeries.find((x) => x.time === kl[i].time)?.value; if (m != null) s += kl[i].close >= m ? 1 : -1; }
    if (adx && adx.adx[i] != null && adx.pdi[i] != null && adx.mdi[i] != null && adx.adx[i]! >= 22) s += adx.pdi[i]! >= adx.mdi[i]! ? 1 : -1;
    score[i] = s;
  }
  return score;
}

function run(kl: K[]) {
  const score = buildScores(kl);
  const n = kl.length;
  const layers: Record<string, ScoreLayer> = {
    B1: { n: 0, win10: 0, ret10: 0, win20: 0 }, B2: { n: 0, win10: 0, ret10: 0, win20: 0 }, B3: { n: 0, win10: 0, ret10: 0, win20: 0 },
    S1: { n: 0, win10: 0, ret10: 0, win20: 0 }, S2: { n: 0, win10: 0, ret10: 0, win20: 0 }, S3: { n: 0, win10: 0, ret10: 0, win20: 0 },
  };
  const all: ScoreLayer = { n: 0, win10: 0, ret10: 0, win20: 0 };
  for (let i = 30; i < n - 20; i++) {
    const s = score[i];
    const ret10 = (kl[i + 10].close - kl[i].close) / kl[i].close;
    const ret20 = (kl[i + 20].close - kl[i].close) / kl[i].close;
    all.n++; all.win10 += ret10 > 0 ? 1 : 0; all.ret10 += ret10; all.win20 += ret20 > 0 ? 1 : 0;
    for (let ab = 1; ab <= 3; ab++) {
      const L = s >= ab ? `B${ab}` : s <= -ab ? `S${ab}` : null;
      if (!L) continue;
      const l = layers[L];
      l.n++; l.win10 += ret10 > 0 ? 1 : 0; l.ret10 += ret10; l.win20 += ret20 > 0 ? 1 : 0;
    }
  }
  return { layers, all };
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const files = ['data/BTCUSDT-4h.json', 'data/ETHUSDT-4h.json', 'data/BTCUSDT-1d.json', 'data/ETHUSDT-1d.json'];
const G: Record<string, ScoreLayer> = { B1: { n: 0, win10: 0, ret10: 0, win20: 0 }, B2: { n: 0, win10: 0, ret10: 0, win20: 0 }, B3: { n: 0, win10: 0, ret10: 0, win20: 0 }, S1: { n: 0, win10: 0, ret10: 0, win20: 0 }, S2: { n: 0, win10: 0, ret10: 0, win20: 0 }, S3: { n: 0, win10: 0, ret10: 0, win20: 0 } };
const Gall: ScoreLayer = { n: 0, win10: 0, ret10: 0, win20: 0 };

for (const f of files) {
  const kl = load(f);
  const { layers, all } = run(kl);
  console.log(`\n### ${f}`);
  console.log('分层\t\t样本\t赢率10\t赢率20\t均R10');
  for (const key of ['S3', 'S2', 'S1', 'B1', 'B2', 'B3']) {
    const l = layers[key];
    const g = G[key];
    g.n += l.n; g.win10 += l.win10; g.ret10 += l.ret10; g.win20 += l.win20;
    console.log(`${key}\t\t${l.n}\t${l.n ? pct(l.win10 / l.n) : '-'}\t${l.n ? pct(l.win20 / l.n) : '-'}\t${l.n ? (l.ret10 / l.n).toFixed(4) : '-'}`);
  }
  const g2 = Gall; g2.n += all.n; g2.win10 += all.win10; g2.ret10 += all.ret10; g2.win20 += all.win20;
  console.log(`全样本\t\t${all.n}\t${pct(all.win10 / all.n)}\t${pct(all.win20 / all.n)}\t${(all.ret10 / all.n).toFixed(4)}`);
}

console.log(`\n=================== 全局 · 分数分层 vs 全样本 ===================`);
console.log('分层\t\t样本\t赢率10\t赢率20\t均R10\t  -- 与全样本赢率10差值 --');
const baseW = Gall.win10 / (Gall.n || 1);
console.log(`全样本(基线)\t${Gall.n}\t${pct(baseW)}\t${pct(Gall.win20 / Gall.n)}\t${(Gall.ret10 / Gall.n).toFixed(4)}`);
for (const key of ['S3', 'S2', 'S1', 'B1', 'B2', 'B3']) {
  const l = G[key];
  if (!l.n) { console.log(`${key}\t\t0\t--`); continue; }
  const w = l.win10 / l.n;
  const lift = w - baseW;
  console.log(`${key}\t\t${l.n}\t${pct(w)}\t${pct(l.win20 / l.n)}\t${(l.ret10 / l.n).toFixed(4)}\t ${key[0] === 'B' ? '多 ' : '空 '}${key[1]}: ${(lift * 100).toFixed(1)}pp`);
}