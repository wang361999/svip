/**
 * 锚点价格口径对比：影线极值（现役 high/low）vs K线实体（open/close）
 * 同一组分形下标，只替换锚点价格，比较：
 *  M1 影线外溢：顶/底分形K线的影线长度占整段波段高度的比例（影线把网格撑大了多少）
 *  M2 末端1/8区回踩率：A/B 端最后一格（实体→影线尖之间）未来20根是否被触及
 *     - 影线口径下这格若很少回去 = 网格被插针浪费，最外侧一条线虚悬
 *  M3 现价±2%内九线条数（参考密度）
 *  M4 强度评级顺方向收益区分度
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFractals } from '../../src/shared/lib/indicators';

type K = { time: number; open: number; high: number; low: number; close: number; volume: number };
const HERE = path.dirname(fileURLToPath(import.meta.url));
function load(file: string): K[] {
  return (JSON.parse(fs.readFileSync(path.join(HERE, 'data', file), 'utf8')) as Array<Array<string | number>>).map((r) => ({
    time: r[0] as number, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  }));
}

const files = ['BTCUSDT-4h.json', 'ETHUSDT-4h.json', 'BTCUSDT-1d.json', 'ETHUSDT-1d.json'];

for (const f of files) {
  const kl = load(f);
  const n = kl.length;

  // 复用现役 selectSwing 的选点结果：直接调用 calcAB9Lines 拿到 A/B 时间，再回溯两种价格
  // 为避免循环依赖复杂，这里内联"最近显著分形对"选择（与 indicators.selectSwing 第0步一致）
  const wickTop: number[] = [], bodyTop: number[] = [], wickBot: number[] = [], bodyBot: number[] = [];
  let outerWickWaste = 0, outerChecked = 0;      // M2
  const densW: number[] = [], densB: number[] = []; // M3
  const retW = [[], [], [], []] as number[][], retB = [[], [], [], []] as number[][]; // M4
  let samples = 0;

  for (let i = 300; i < n - 20; i++) {
    const win = kl.slice(0, i + 1);
    const { fractalHighs, fractalLows } = detectFractals(win);
    const sorted = [
      ...fractalHighs.map((x) => ({ ...x, t: 'H' as const })),
      ...fractalLows.map((x) => ({ ...x, t: 'L' as const })),
    ].sort((a, b) => a.idx - b.idx);

    // 找最近一对幅度≥2%的反向分形
    let ai = -1, bi = -1;
    for (let q = sorted.length - 1; q >= 1 && ai < 0; q--) {
      for (let p = q - 1; p >= 0; p--) {
        if (sorted[p].t === sorted[q].t) continue;
        const r = Math.abs(sorted[q].price - sorted[p].price) / Math.min(sorted[q].price, sorted[p].price) * 100;
        if (r >= 2) { ai = sorted[p].idx; bi = sorted[q].idx; }
        break;
      }
    }
    if (ai < 0) continue;
    samples++;

    const ka = win[ai], kb = win[bi];
    const up = ka.low <= kb.high && Math.min(ka.open, ka.close) < Math.min(kb.open, kb.close);
    // 影线口径（现役）
    const Aw = up ? ka.low : ka.high, Bw = up ? kb.high : kb.low;
    // 实体口径
    const Ab = up ? Math.min(ka.open, ka.close) : Math.max(ka.open, ka.close);
    const Bb = up ? Math.max(kb.open, kb.close) : Math.min(kb.open, kb.close);

    // M1：两端影线合计占波段高度比
    const Hw = Math.abs(Bw - Aw);
    const wickA = Math.abs(Aw - Ab), wickB = Math.abs(Bw - Bb);
    const arrW = up ? wickTop : wickBot, arrB = up ? bodyTop : bodyBot;
    arrW.push(wickB / Hw); (up ? wickBot : wickTop).push(wickA / Hw);
    void arrB; void bodyBot;

    // M2：末端1/8格（实体极值→影线尖）未来20根是否回踩
    // 只测 B 端（最新端点），向上波段看 [Bb,Bw] 是否被未来上影/收盘触及
    {
      outerChecked++;
      const future = kl.slice(i + 1, i + 21);
      const touched = up
        ? future.some((x) => x.high >= Bb)          // 影线口径最外格下界=实体顶
        : future.some((x) => x.low <= Bb);
      if (!touched) outerWickWaste++;
    }

    // M3/M4
    const price = win[i].close;
    const linesW = Array.from({ length: 9 }, (_, q) => up ? Aw + Hw * q / 8 : Aw - Hw * q / 8);
    const Hb = Math.abs(Bb - Ab);
    const linesB = Array.from({ length: 9 }, (_, q) => up ? Ab + Hb * q / 8 : Ab - Hb * q / 8);
    densW.push(linesW.filter((p) => Math.abs(p - price) / price <= 0.02).length);
    densB.push(linesB.filter((p) => Math.abs(p - price) / price <= 0.02).length);
    const fwd = (kl[i + 10].close - price) / price;
    const posW = up ? (price - Aw) / Hw : (Aw - price) / Hw;
    const posB = up ? (price - Ab) / Hb : (Ab - price) / Hb;
    const gOf = (p: number) => (p >= 0.625 ? 0 : p >= 0.5 ? 1 : p >= 0.375 ? 2 : 3);
    retW[gOf(posW)].push(up ? fwd : -fwd);
    retB[gOf(posB)].push(up ? fwd : -fwd);
  }

  const avg = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  console.log(`\n========== ${f} （样本${samples}）==========`);
  console.log(`M1 端点影线占波段高度：上端均值 ${(avg(wickTop) * 100).toFixed(1)}% / 下端 ${(avg(wickBot) * 100).toFixed(1)}%；上端>20%的占比 ${(wickTop.filter((x) => x > 0.2).length / wickTop.length * 100).toFixed(1)}%`);
  console.log(`M2 影线撑出的末端格 未来20根不回踩率：${(outerWickWaste / outerChecked * 100).toFixed(1)}%（越高=最外线越虚）`);
  console.log(`M3 现价±2%内线条数：影线 ${avg(densW).toFixed(2)}  实体 ${avg(densB).toFixed(2)}`);
  const labels = ['≥6线强', '5-6一般', '4-5弱', '<4破坏'];
  const show = (name: string, r: number[][]) => {
    const s = r.map((g) => `${labels[r.indexOf(g)]}:${(avg(g) * 100).toFixed(2)}%(n=${g.length})`).join('  ');
    console.log(`M4 ${name} 顺向10根收益 ${s}  强弱差${((avg(r[0]) - avg(r[3])) * 100).toFixed(2)}pp`);
  };
  show('影线', retW);
  show('实体', retB);
}
