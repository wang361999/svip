/**
 * 对拍脚本：真实 K 线 → 规则引擎 → 输出关键数字
 * 验证与手动分析的一致性（腿识别 / 斐波那契 / 预案 / 盈亏比）
 */
import { analyzeStructure } from '../src/shared/lib/structure-analysis';

async function fetchK(symbol: string, interval: string, limit: number) {
  const hosts = ['https://api.binance.com', 'https://data-api.binance.vision'];
  for (const h of hosts) {
    try {
      const r = await fetch(`${h}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!r.ok) continue;
      const d = await r.json();
      if (Array.isArray(d)) return d.map((k: any[]) => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    } catch {}
  }
  throw new Error('全部数据源失败');
}

async function main() {
  const [k4h, k1h, k15m] = await Promise.all([
    fetchK('ETHUSDT', '4h', 300),
    fetchK('ETHUSDT', '1h', 300),
    fetchK('ETHUSDT', '15m', 300),
  ]);
  console.log(`K线: 4h=${k4h.length} 1h=${k1h.length} 15m=${k15m.length}`);

  const a = analyzeStructure({ symbol: 'ETHUSDT', k4h, k1h, k15m });

  console.log('\n===== 三周期趋势 =====');
  (['4h', '1h', '15m'] as const).forEach((tf) => {
    const p = a.periods[tf];
    console.log(`${tf}: ${p.dir} (score ${p.score > 0 ? '+' : ''}${p.score}/3) 均线=${p.maState} MACD=${p.macdState} 结构=${p.structure} EMA20=${p.ema20.toFixed(1)} EMA60=${p.ema60.toFixed(1)}`);
  });
  console.log(`共振: ${a.resonanceText} → 定性: ${a.biasText}`);

  console.log('\n===== 本腿 =====');
  if (a.leg) {
    console.log(`${a.leg.direction === 'up' ? '上涨腿' : '下跌腿'}: ${a.leg.startPrice.toFixed(1)} → ${a.leg.endPrice.toFixed(1)} (${a.leg.rangePct}%), 当前回撤 ${Math.round(a.leg.retracement * 100)}%`);
    console.log('斐波那契回撤:', a.leg.fibRetracements.map((f) => `${f.ratio * 100}%=${f.price.toFixed(1)}`).join(' '));
    console.log('斐波那契扩展:', a.leg.fibExtensions.map((f) => `${f.ratio}=${f.price.toFixed(1)}`).join(' '));
  } else {
    console.log('无显著腿');
  }

  console.log('\n===== 预案 =====');
  for (const p of a.plans) {
    console.log(`[${p.id}] ${p.name} | 入场 ${p.entry} 止损 ${p.stop} (${p.riskPct}%) TP1 ${p.tp1}(${p.rrTp1}) TP2 ${p.tp2}(${p.rrTp2}) 加权${p.rrBlended}`);
    console.log(`     触发: ${p.trigger}`);
  }
  console.log(`\n失效: ${a.invalidation?.note || '无'}`);

  console.log('\n===== 关键位 =====');
  for (const k of a.keyLevels) console.log(`${k.price} ${k.label} (${k.distancePct >= 0 ? '+' : ''}${k.distancePct}%)`);
  console.log(`\n现价: ${a.currentPrice}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
