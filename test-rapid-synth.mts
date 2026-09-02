import { analyzeRapid, type KlineData } from './src/shared/lib/rapid-strategy';

// 生成模拟 K 线：先下跌趋势再上涨趋势，验证双向信号
function generateSyntheticKlines(): KlineData[] {
  const klines: KlineData[] = [];
  let price = 3000;
  const now = Math.floor(Date.now() / 1000);

  // 生成 100 根下跌趋势（制造空头信号）
  for (let i = 0; i < 100; i++) {
    const open = price;
    const change = -Math.random() * 20 - 5; // 下跌趋势
    const close = open + change;
    const high = open + Math.random() * 10;
    const low = close - Math.random() * 10;
    klines.push({
      time: now - (200 - i) * 900, // 15m = 900s
      open, high, low, close,
      volume: Math.random() * 1000,
    });
    price = close;
  }

  // 生成 100 根上涨趋势（制造多头信号）
  for (let i = 0; i < 100; i++) {
    const open = price;
    const change = Math.random() * 20 + 5; // 上涨趋势
    const close = open + change;
    const high = close + Math.random() * 10;
    const low = open - Math.random() * 10;
    klines.push({
      time: now - (100 - i) * 900,
      open, high, low, close,
      volume: Math.random() * 1000,
    });
    price = close;
  }

  return klines;
}

const klines = generateSyntheticKlines();
console.log('合成 K 线数量:', klines.length);
console.log('起始价:', klines[0].close.toFixed(2));
console.log('当前价:', klines[klines.length - 1].close.toFixed(2));
console.log('趋势: 先跌后涨（最后100根上涨）\n');

const result = analyzeRapid('TESTUSDT', klines);

console.log('=== 综合建议 ===');
console.log('方向:', result.suggestion.direction);
console.log('置信度:', result.suggestion.confidence, '/ 4');
console.log('共振源:', result.suggestion.sources.join(', '));
console.log('原因:', result.suggestion.reason);

console.log('\n=== 指标状态 ===');
const ind = result.indicatorState;
console.log('EMA交叉:', ind.emaCross);
console.log('RSI:', ind.rsi.toFixed(1), '-', ind.rsiState);
console.log('布林带:', ind.bollingerPosition);
console.log('MACD趋势:', ind.macdHistTrend);

console.log('\n=== 共振统计 ===');
console.log('多头:', result.confluence.long, '路');
console.log('空头:', result.confluence.short, '路');

console.log('\n=== 最近信号（最后10个）===');
result.recentSignals.forEach((s, i) => {
  const dir = s.direction === 'long' ? '多' : '空';
  console.log(`  ${i + 1}. ${dir} | ${s.source} | ${s.entry.toFixed(2)} | ${s.reason}`);
});

// 统计多空信号数量
const longCount = result.recentSignals.filter(s => s.direction === 'long').length;
const shortCount = result.recentSignals.filter(s => s.direction === 'short').length;
console.log(`\n最近20根内信号统计: 多头${longCount}个 / 空头${shortCount}个`);
console.log('双向都有信号:', longCount > 0 && shortCount > 0 ? '✓ 是' : '✗ 否');
