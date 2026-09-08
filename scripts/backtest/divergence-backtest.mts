import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectFractals, calcMACD } from '../../src/shared/lib/indicators';

const HERE = path.dirname(fileURLToPath(import.meta.url));
type K = { time: number; open: number; high: number; low: number; close: number; volume: number };
function load(file: string): K[] {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'data', file), 'utf8')) as Array<Array<string | number>>;
  return raw.map((r) => ({
    time: r[0] as number, open: parseFloat(String(r[1])), high: parseFloat(String(r[2])),
    low: parseFloat(String(r[3])), close: parseFloat(String(r[4])), volume: parseFloat(String(r[5])),
  }));
}

type Dir = 'B' | 'S';
type Sig = { i: number; dir: Dir };
type St = { n: number; win: Record<number, number>; ret10: number };
const FS = [5, 10, 20];
const newS = (): St => ({ n: 0, win: {}, ret10: 0 });

// 分型/背离信号 → 事件（i=触发索引，dir=看涨/看跌方向）
function collect(kl: K[]) {
  const n = kl.length;
  const frac = detectFractals(kl); // {fractalHighs,lows}: {idx,price}[]
  const cl = kl.map((k) => k.close);
  const fxH = [] as Sig[]; // 分型信号
  for (const h of frac.fractalHighs) if (h.idx + FS[2] < n) fxH.push({ i: h.idx, dir: 'S' });
  for (const l of frac.fractalLows) if (l.idx + FS[2] < n) fxH.push({ i: l.idx, dir: 'B' });

  // MACD DIF 值背离（相邻两个同向分型点比较价与DIF)
  const macd = calcMACD(kl, 12, 26, 9);
  const div: Sig[] = [];
  const highList = [...frac.fractalHighs].sort((a, b) => a.idx - b.idx);
  for (let k = 1; k < highList.length; k++) {
    const a = highList[k - 1], b = highList[k];
    if (b.idx + FS[2] >= n) break;
    const da = macd.dif[a.idx], db = macd.dif[b.idx];
    if (da == null || db == null) continue;
    if (cl[b.idx] > cl[a.idx] && db < da) div.push({ i: b.idx, dir: 'S' }); // 价新高·MACD顶降低=顶背离(看跌)
  }
  const lowList = [...frac.fractalLows].sort((a, b) => a.idx - b.idx);
  for (let k = 1; k < lowList.length; k++) {
    const a = lowList[k - 1], b = lowList[k];
    if (b.idx + FS[2] >= n) break;
    const da = macd.dif[a.idx], db = macd.dif[b.idx];
    if (da == null || db == null) continue;
    if (cl[b.idx] < cl[a.idx] && db > da) div.push({ i: b.idx, dir: 'B' }); // 价新低·MACD底抬高=底背离(看涨)
  }
  return { fx: fxH, div };
}

function evalSig(sigs: Sig[], kl: K[], agg: St) {
  for (const s of sigs) {
    const c0 = kl[s.i].close;
    agg.n++;
    for (const F of FS) {
      const ret = (kl[s.i + F].close - c0) / c0;
      const hit = s.dir === 'B' ? ret > 0 : ret < 0;
      agg.win[F] = (agg.win[F] ?? 0) + (hit ? 1 : 0);
    }
    agg.ret10 += (kl[s.i + 10].close - c0) / c0;
  }
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const files = ['BTCUSDT-4h.json', 'ETHUSDT-4h.json', 'BTCUSDT-1d.json', 'ETHUSDT-1d.json'];
const G = {
  baseB: newS(), fxB: newS(), fxS: newS(), fxAll: newS(),
  divB: newS(), divS: newS(), divAll: newS(),
};

for (const f of files) {
  const kl = load(f);
  const n = kl.length;
  const { fx, div } = collect(kl);
  const baseB = newS(); // 全样本先验看涨
  for (let i = 0; i < n - FS[2]; i++) {
    const ret = (kl[i + 10].close - kl[i].close) / kl[i].close;
    baseB.n++; baseB.win[10] = (baseB.win[10] ?? 0) + (ret > 0 ? 1 : 0);
  }
  evalSig(fx, kl, G.fxAll); evalSig(div, kl, G.divAll);
  for (const s of fx) if (s.dir === 'B') evalSig([s], kl, G.fxB); else evalSig([s], kl, G.fxS);
  for (const s of div) if (s.dir === 'B') evalSig([s], kl, G.divB); else evalSig([s], kl, G.divS);
  G.baseB.n += baseB.n; G.baseB.win[10] = (G.baseB.win[10] ?? 0) + (baseB.win[10] ?? 0);
  console.log(`${f}: k=${n} 分型=${fx.length} 背离=${div.length} 先验涨10=${pct(baseB.win[10] / (baseB.n || 1))}`);
}

const base = G.baseB.win[10] / (G.baseB.n || 1);
const baseSell = 1 - base;
console.log(`\n============ 全局（4数据集合并）============`);
console.log('信号\t方向\t样本\t赢率5\t赢率10\t赢率20\t均R10\t vs先验10');
function emit(name: string, isLong: boolean, s: St) {
  const prior10 = isLong ? base : baseSell;
  const lift = s.n ? s.win[10] / s.n - prior10 : 0;
  const verdict = s.n >= 60 ? (lift > 0.05 ? '√优' : lift < -0.05 ? '劣' : '≈平') : '.少';
  console.log(`${name}\t${isLong ? '看涨' : '看跌'}\t${s.n}\t${pct(s.win[5] / s.n)}\t${pct(s.win[10] / s.n)}\t${pct(s.win[20] / s.n)}\t${(s.ret10 / s.n).toFixed(4)}\t${(lift * 100).toFixed(1)}pp ${verdict}`);
}
emit('分型-顶', false, G.fxS);
emit('分型-底', true, G.fxB);
emit('分型-综合', true, G.fxAll);
emit('背离-DIF顶', false, G.divS);
emit('背离-DIF底', true, G.divB);
emit('背离-综合', true, G.divAll);
console.log(`\n基线 先验涨10=${pct(base)} 先验跌10=${pct(baseSell)}`);