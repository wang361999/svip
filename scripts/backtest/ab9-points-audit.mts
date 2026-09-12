/**
 * 九线测算 A/B 高低点选点审计
 * 在真实数据上逐根滑窗调用 calcAB9Lines，检查：
 *  P1 致命：A、B 落在同一根K线（大阳/阴线同时是窗口最高+最低分形 → 时间跨度0的假波段）
 *  P2 锚偏：最新显著端点与更早的大级别反向点本够 2%，却被中间微小反向分形截断（selectSwing 第0步 break 缺陷）
 *  P3 健康度：波段持续根数、锚定方向 vs 后验走势、A/B 是否为真实波段极值
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

const files = ['BTCUSDT-4h.json', 'ETHUSDT-4h.json', 'BTCUSDT-1d.json', 'ETHUSDT-1d.json'];

for (const f of files) {
  const kl = load(f);
  const n = kl.length;
  let p1 = 0;                 // A/B 同根
  const p1Samples: string[] = [];
  let p2 = 0;                 // 微小反向点截断，漏锚更大级别起点
  const p2Samples: string[] = [];
  const durBars: number[] = [];
  let dirMismatch = 0, dirCheck = 0;   // 锚定方向 vs 10根后位置
  let anchorFlip = 0, prevA = -1, prevB = -1, prevDir = '';
  let tinySwing = 0;          // 波段幅度 2~3%（阈值边缘，噪声敏感）
  let nullCnt = 0;

  for (let i = 120; i < n - 10; i++) {
    const win = kl.slice(0, i + 1);
    const ab = calcAB9Lines(win);
    if (!ab) { nullCnt++; continue; }

    // P1：同根K线
    if (ab.timeA === ab.timeB) {
      p1++;
      if (p1Samples.length < 3) {
        const k = win[win.length - 1];
        p1Samples.push(`i=${i} A=B 同根 O=${k.open} H=${k.high} L=${k.low} C=${k.close} 被判方向=${ab.direction}`);
      }
    }
    durBars.push(Math.abs(ab.timeB - ab.timeA) / (kl[1].time - kl[0].time));
    if (ab.height / Math.min(ab.pointA, ab.pointB) * 100 < 3) tinySwing++;

    // 方向连贯性：相邻窗口 A 或 B 突然跳到完全不同的端点（且非尾部创新高/新低）
    if (prevA >= 0 && (ab.timeA !== prevA || ab.timeB !== prevB)) {
      // 端点时间回跳（B 从新端点跳回旧端点）视为抖动
      if (ab.timeB < prevB) anchorFlip++;
    }
    prevA = ab.timeA; prevB = ab.timeB;

    // P2：当前锚点的 A 点之前，是否存在一个反向极值，与 B 组成更大且≥2%的波段，
    // 但 A 与它之间夹着幅度<2%的微小反向分形（说明本可锚更大级别却被截断）
    // 简化检测：若 A 不是"B 之前最近的显著反向极值"，即 A 之前 1~6 根内还有更极端的反向点
    {
      const aIdx = win.findIndex((x) => x.time === ab.timeA);
      const bIdx = win.findIndex((x) => x.time === ab.timeB);
      if (aIdx > 0 && bIdx > aIdx) {
        // 找 A 之前 20 根内同方向更极端的点（上升波段=更早的更低低点；下降=更早的更高高点）
        let better: number | null = null;
        for (let j = aIdx - 1; j >= Math.max(0, aIdx - 20); j--) {
          if (ab.direction === 'up' && kl[j].low < ab.pointA) { better = j; break; }
          if (ab.direction === 'down' && kl[j].high > ab.pointA) { better = j; break; }
        }
        if (better != null) {
          const ext = ab.direction === 'up' ? kl[better].low : kl[better].high;
          const bigRange = Math.abs(ab.pointB - ext) / Math.min(ext, ab.pointB) * 100;
          const smallRange = ab.height / Math.min(ab.pointA, ab.pointB) * 100;
          // A 与更早极值之间的反向波动 <2%（被微小分形截断的特征）
          const gap = Math.abs(ab.pointA - ext) / Math.min(ab.pointA, ext) * 100;
          if (bigRange >= 4 && smallRange < bigRange - 2 && gap < 2) {
            p2++;
            if (p2Samples.length < 3) p2Samples.push(`i=${i} ${ab.direction} 现A=${ab.pointA.toFixed(1)} 更早反向极值=${ext.toFixed(1)}(差${gap.toFixed(2)}%) 现波段${smallRange.toFixed(1)}% 可锚${bigRange.toFixed(1)}%`);
          }
        }
      }
    }

    // 后验：锚定 up 但 10 根后收盘跌破 A（锚错方向的典型表现）
    if (i + 10 < n) {
      dirCheck++;
      const c10 = kl[i + 10].close;
      if (ab.direction === 'up' && c10 < ab.pointA * 0.995) dirMismatch++;
      if (ab.direction === 'down' && c10 > ab.pointA * 1.005) dirMismatch++;
    }
    void prevDir;
  }

  const checked = n - 10 - 120;
  const avgDur = durBars.reduce((a, b) => a + b, 0) / (durBars.length || 1);
  const short01 = durBars.filter((d) => d <= 1).length;
  console.log(`\n========== ${f} ==========`);
  console.log(`滑窗样本 ${checked}`);
  console.log(`P1 A/B同根K线(假波段)      : ${p1} 次 (${(p1 / checked * 100).toFixed(2)}%)  其中跨度<=1根 ${short01}`);
  p1Samples.forEach((s) => console.log(`   ${s}`));
  console.log(`P2 被微小反向分形截断/锚偏 : ${p2} 次 (${(p2 / checked * 100).toFixed(2)}%)`);
  p2Samples.forEach((s) => console.log(`   ${s}`));
  console.log(`波段平均跨度 ${avgDur.toFixed(1)} 根；跨度<=1根占比 ${(short01 / checked * 100).toFixed(1)}%`);
  console.log(`幅度2~3%阈值边缘波段占比 ${(tinySwing / checked * 100).toFixed(1)}%`);
  console.log(`B点时间回跳抖动 ${anchorFlip} 次 (${(anchorFlip / checked * 100).toFixed(2)}%)`);
  console.log(`锚定方向 vs 10根后反向破A : ${dirMismatch}/${dirCheck} (${(dirMismatch / dirCheck * 100).toFixed(1)}%)`);
  console.log(`返回 null ${nullCnt}`);
}
