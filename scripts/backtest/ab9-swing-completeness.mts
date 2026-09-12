/**
 * 九线锚点"波段完整性"诊断
 * 对每个滑窗，判定当前 A/B 属于哪种状态：
 *  S1 进行中：B 是尾部投影的运行极值（未被右侧3根确认），波段还在延伸
 *  S2 波段已被反向突破：B 已确认、A/B 为最近反向分形对，但现价已越过 A（旧波段失效，新反向分形尚在3根确认中）
 *  S3 噪声过滤：B 之后已出现反向分形，但因幅度<2% 被跳过，仍锚在上一波段
 *  S4 跨波段兜底：A 不是 B 之前最近的反向分形（第0步找不到合格对，落入后续兜底分支）
 *  S0 完整波段·区间内：A/B 为最近反向分形对，B 已确认，现价仍在 A-B 区间内（含正常回调到九线支撑）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcAB9Lines, detectFractals } from '../../src/shared/lib/indicators';

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
  const cnt: Record<string, number> = { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0 };
  const bAge: number[] = []; // 已确认B距窗口末端的根数

  for (let i = 300; i < n - 10; i++) {
    const win = kl.slice(0, i + 1);
    const ab = calcAB9Lines(win);
    if (!ab) continue;
    const { fractalHighs, fractalLows } = detectFractals(win);
    const len = win.length;
    const strength = 3;
    // 投影点：idx >= len - strength（detectFractals 尾部补齐）
    const isProjected = (idx: number) => idx >= len - strength;
    const aIdx = win.findIndex((x) => x.time === ab.timeA);
    const bIdx = win.findIndex((x) => x.time === ab.timeB);

    // A/B 在合并分形序列中是否相邻（中间无其他分形）
    const sorted = [
      ...fractalHighs.map((x) => ({ ...x, t: 'H' as const })),
      ...fractalLows.map((x) => ({ ...x, t: 'L' as const })),
    ].sort((x, y) => x.idx - y.idx);
    const bi = sorted.findIndex((x) => x.idx === bIdx);
    // A 是否为 B 之前最近的反向分形（中间允许有同向点，如双顶/双底）
    let nearestOppIdx = -1;
    for (let q = bi - 1; q >= 0; q--) {
      if (sorted[q].t !== sorted[bi].t) { nearestOppIdx = sorted[q].idx; break; }
    }
    const properPair = nearestOppIdx === aIdx;

    const price = win[len - 1].close;
    const brokeA = ab.direction === 'up' ? price < ab.pointA : price > ab.pointA;

    let state: string;
    if (isProjected(bIdx)) {
      state = 'S1'; // B=运行极值，波段进行中
    } else if (!properPair) {
      state = 'S4'; // 兜底选出的跨波段锚点
    } else {
      bAge.push(len - 1 - bIdx);
      // B 之后是否已有反向确认分形
      const laterOpposite = sorted.slice(bi + 1).some((x) => !isProjected(x.idx));
      if (laterOpposite) state = 'S3';
      else if (brokeA) state = 'S2'; // 整个波段被反向突破，锚点滞后
      else state = 'S0';             // 现价仍在 A-B 区间内
    }
    cnt[state]++;
  }

  const total = Object.values(cnt).reduce((a, b) => a + b, 0);
  const names: Record<string, string> = {
    S0: '完整波段·现价在区间内(含回调)',
    S1: '进行中波段(B=运行极值·未确认)',
    S2: '波段被反向突破·锚点滞后(等确认)',
    S3: '噪声过滤后仍锚旧波段(新波<2%)',
    S4: '跨波段兜底(A非最近反向点)',
  };
  console.log(`\n========== ${f} （${total} 窗）==========`);
  for (const s of ['S0', 'S1', 'S2', 'S3', 'S4']) {
    console.log(`  ${names[s].padEnd(36)} ${String(cnt[s]).padStart(4)}  ${(cnt[s] / total * 100).toFixed(1)}%`);
  }
  console.log(`  → 完整/进行中波段(S0+S1) ${((cnt.S0 + cnt.S1) / total * 100).toFixed(1)}%；锚点滞后(S2+S3) ${((cnt.S2 + cnt.S3) / total * 100).toFixed(1)}%；跨波段兜底(S4) ${(cnt.S4 / total * 100).toFixed(1)}%`);
  if (bAge.length) console.log(`  已确认B点的平均"年龄"：${(bAge.reduce((a, b) => a + b, 0) / bAge.length).toFixed(1)} 根`);
}
