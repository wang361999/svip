import { analyzeRapid } from './src/shared/lib/rapid-strategy';

async function main() {
  const symbol = process.argv[2] || 'ETHUSDT';
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=200`);
  const raw = await res.json();
  const klines = raw.map((k) => ({
    time: k[0] / 1000,
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));

  console.log(`\n=== ${symbol} 15m 快速信号测试 ===`);
  console.log(`K线数量: ${klines.length}`);
  console.log(`当前价格: ${klines[klines.length - 1].close.toFixed(2)}`);
  console.log(`最后一根时间: ${new Date(klines[klines.length - 1].time * 1000).toLocaleString('zh-CN')}`);

  const result = analyzeRapid(symbol, klines);

  console.log(`\n--- 综合建议 ---`);
  console.log(`方向: ${result.suggestion.direction}`);
  console.log(`置信度: ${result.suggestion.confidence}/4`);
  console.log(`共振源: ${result.suggestion.sources.join(', ')}`);
  console.log(`原因: ${result.suggestion.reason}`);
  console.log(`入场: ${result.suggestion.entry.toFixed(2)}`);
  console.log(`止损: ${result.suggestion.stop.toFixed(2)}`);
  console.log(`止盈: ${result.suggestion.target.toFixed(2)}`);

  console.log(`\n--- 指标状态 ---`);
  const ind = result.indicatorState;
  console.log(`EMA9/21: ${ind.ema9.toFixed(2)} / ${ind.ema21.toFixed(2)} (${ind.emaCross})`);
  console.log(`RSI: ${ind.rsi.toFixed(1)} (${ind.rsiState})`);
  console.log(`布林带: ${ind.bollingerPosition} (上${ind.bollingerUpper.toFixed(2)} / 中${ind.bollingerMiddle.toFixed(2)} / 下${ind.bollingerLower.toFixed(2)})`);
  console.log(`MACD柱: ${ind.macdHist.toFixed(4)} (${ind.macdHistTrend})`);
  console.log(`ATR: ${ind.atr.toFixed(2)}`);

  console.log(`\n--- 共振统计 ---`);
  console.log(`多头共振源: ${result.confluence.long}`);
  console.log(`空头共振源: ${result.confluence.short}`);

  console.log(`\n--- 最近信号 (最近10个) ---`);
  result.recentSignals.forEach((s, i) => {
    const t = new Date(s.time * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    console.log(`  ${i + 1}. ${s.direction === 'long' ? '多' : '空'} ${s.source} @ ${s.entry.toFixed(2)} (${t}) - ${s.reason}`);
  });

  console.log(`\n--- 当前活跃信号 ---`);
  result.signals.forEach(s => {
    console.log(`  ${s.direction === 'long' ? '多' : '空'} ${s.confluenceSources.join('+')} 置信度${s.confidence}/4`);
  });
}

main().catch(console.error);
