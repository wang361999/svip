/**
 * 端到端测试：K线 → 规则引擎 → DeepSeek 文案 → 数字校验
 */
import { analyzeStructure } from '../src/shared/lib/structure-analysis';
import { generateNarrative } from '../src/shared/lib/analysis-writer';

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
  throw new Error('数据源失败');
}

async function main() {
  const t0 = Date.now();
  const [k4h, k1h, k15m] = await Promise.all([
    fetchK('ETHUSDT', '4h', 300),
    fetchK('ETHUSDT', '1h', 300),
    fetchK('ETHUSDT', '15m', 300),
  ]);
  const analysis = analyzeStructure({ symbol: 'ETHUSDT', k4h, k1h, k15m });
  console.log(`规则引擎耗时 ${Date.now() - t0}ms，现价 ${analysis.currentPrice}`);

  const t1 = Date.now();
  const narrative = await generateNarrative(analysis);
  console.log(`文案生成耗时 ${Date.now() - t1}ms，来源: ${narrative.source}\n`);

  console.log('===== AI 文案 =====');
  console.log(`【${narrative.biasText}】${narrative.headline}\n`);
  for (const p of narrative.paragraphs) console.log(p + '\n');
  console.log(`方案A: ${narrative.planAComment}`);
  console.log(`方案B: ${narrative.planBComment}`);
  console.log(`失效: ${narrative.invalidation}`);
  console.log(`提醒: ${narrative.reminder}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
