/**
 * A/B 锚点方案对比：现役分形波段 vs 滚动300根最高最低点
 * 三个维度：
 *  D1 锚点稳定性：每滑一根，A 或 B 的时间发生跳变的比例（画线乱跳=不可用）
 *  D2 强度评级有效性：按现价在九线中的位置分组（≥6线强 / 5-6线 / 4-5线 / <4线破坏），
 *     看未来10根收益是否单调、强/弱两组收益差是否拉开（区分度=九线存在的意义）
 *  D3 参考密度：现价±2% 价格带内有几条九线（大区间锚定时线全飘在远处=没有参考价值）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcAB9Lines } from '../../src/shared/lib/indicators';

type K = { time: number; open: number; high: number; low: number; close: number; volume: number };
const HERE = path.dirname(fileURLToPath(import.meta.url));
function load(file: string): K[] {
  return (JSON.parse(fs.readFileSync(path.join(HERE, 'data', file), 'utf8')) as Array<Array<string | number>>).map((r) => ({
    time: r[0] as number, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  }));
}

const W = 300;
const files = ['BTCUSDT-4h.json', 'ETHUSDT-4h.json', 'BTCUSDT-1d.json', 'ETHUSDT-1d.json'];

/** 方案B：滚动 W 根最高/最低点；低点时间在前=上升，反之下降 */
function windowAB(win: K[]) {
  let h = -Infinity, hIdx = -1, l = Infinity, lIdx = -1;
  for (let i = 0; i < win.length; i++) {
    if (win[i].high > h) { h = win[i].high; hIdx = i; }
    if (win[i].low < l) { l = win[i].low; lIdx = i; }
  }
  if (hIdx === lIdx) return null;
  const up = lIdx < hIdx;
  const A = up ? l : h, B = up ? h : l;
  const H = Math.abs(B - A);
  // 现价在九线中的位置比例 0~1
  const price = win[win.length - 1].close;
  const pos = up ? (price - A) / H : (A - price) / H;
  const lines = Array.from({ length: 9 }, (_, i) => up ? A + H * i / 8 : A - H * i / 8);
  return { timeA: win[up ? lIdx : hIdx].time, timeB: win[up ? hIdx : lIdx].time, A, B, pos, lines, dir: up ? 'up' : 'down' };
}

for (const f of files) {
  const kl = load(f);
  const n = kl.length;

  // 累计器：每个方案 {跳变, 分组收益[4][], 带内线条数和, 样本数, 锚点幅度和}
  const mk = () => ({ flips: 0, prevA: -1, prevB: -1, ret: [[], [], [], []] as number[][], dens: [] as number[], ranges: [] as number[], cnt: 0 });
  const A = mk(), B = mk();

  for (let i = Math.max(W, 120); i < n - 10; i++) {
    const fwd = (kl[i + 10].close - kl[i].close) / kl[i].close;
    const price = kl[i].close;

    // --- 方案A：现役 ---
    const ab = calcAB9Lines(kl.slice(0, i + 1));
    if (ab) {
      A.cnt++;
      if (A.prevA >= 0 && (ab.timeA !== A.prevA || ab.timeB !== A.prevB)) A.flips++;
      A.prevA = ab.timeA; A.prevB = ab.timeB;
      // pos: 现价位置（up 波段 (C-A)/H；down 镜像）
      const pos = ab.direction === 'up'
        ? (price - ab.pointA) / ab.height
        : (ab.pointA - price) / ab.height;
      const g = pos >= 0.625 ? 0 : pos >= 0.5 ? 1 : pos >= 0.375 ? 2 : 3;
      A.ret[g].push(ab.direction === 'up' ? fwd : -fwd);
      A.dens.push(ab.lines.filter((ln) => Math.abs(ln.price - price) / price <= 0.02).length);
      A.ranges.push(ab.height / Math.min(ab.pointA, ab.pointB));
    }

    // --- 方案B：滚动300根极值 ---
    const wb = windowAB(kl.slice(i - W + 1, i + 1));
    if (wb) {
      B.cnt++;
      if (B.prevA >= 0 && (wb.timeA !== B.prevA || wb.timeB !== B.prevB)) B.flips++;
      B.prevA = wb.timeA; B.prevB = wb.timeB;
      const g = wb.pos >= 0.625 ? 0 : wb.pos >= 0.5 ? 1 : wb.pos >= 0.375 ? 2 : 3;
      B.ret[g].push(wb.dir === 'up' ? fwd : -fwd);
      B.dens.push(wb.lines.filter((p) => Math.abs(p - price) / price <= 0.02).length);
      B.ranges.push(Math.abs(wb.B - wb.A) / Math.min(wb.A, wb.B));
    }
  }

  const avg = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  const pct = (x: number) => (x * 100).toFixed(2) + '%';
  const fmt = (s: ReturnType<typeof mk>, name: string) => {
    const labels = ['≥6线(强)', '5-6线(一般)', '4-5线(弱)', '<4线(破坏)'];
    console.log(`  [${name}] 样本${s.cnt} 锚点跳变率${pct(s.flips / s.cnt)} 锚点波段平均幅度${pct(avg(s.ranges))} 现价±2%内平均${avg(s.dens).toFixed(2)}条线`);
    s.ret.forEach((r, gi) =>
      console.log(`      ${labels[gi].padEnd(10)} n=${String(r.length).padStart(4)}  顺方向10根均值 ${isNaN(avg(r)) ? '  —  ' : (avg(r) * 100).toFixed(2) + '%'}`));
    const spread = avg(s.ret[0]) - avg(s.ret[3]);
    console.log(`      强弱组收益差（区分度）: ${isNaN(spread) ? '—' : (spread * 100).toFixed(2) + 'pp'}`);
  };

  console.log(`\n========== ${f} ==========`);
  fmt(A, '现役 分形波段');
  fmt(B, '滚动300根极值');
}
