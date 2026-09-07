/**
 * 资金面（外部非价格数据）信号：资金费率的"极端拥挤"逆向提示。
 * 口径与回测验证一致：取最近 90 天的历史资金费率做滚动均值/标准差，
 * 对最新值算 z 分；|z| 越大说明某方向越拥挤，按历史统计其往往在 ~5 日内向反方向回归。
 * 回测（ETH+BTC 日线，2024-2026，无前视）：|z|>=1 时 5 日逆向命中≈67%，|z|>=1.5≈74%。
 */

export interface FundingPoint {
  time: number; // ms
  rate: number; // 单期(8h)资金费率，如 0.0002 = 万分之二
}

export interface FundingCrowding {
  currentRate: number;      // 最新一期资金费率（8h 单期）
  annualizedPct: number;    // 年化资金费率 %
  mean90: number;
  std90: number;
  z: number;                // 相对近90天均值/标准差的 z 分
  level: 'none' | 'mild' | 'strong' | 'extreme'; // none/mild/strong/extreme
  tilt: 'bull' | 'bear' | 'osc'; // 逆向拥挤偏置
  windowN: number;          // 有效样本点数
}

export function calcFundingCrowding(points: FundingPoint[], windowN = 270): FundingCrowding | null {
  if (!points || points.length < 60) return null;
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const latest = sorted[sorted.length - 1].rate;
  // 近 windowN 期（即约 90 天，8h 一期）作为统计窗口，不含最新一期（避免前视）
  const win = sorted.slice(Math.max(0, sorted.length - 1 - windowN), -1);
  if (win.length < 40) return null;
  const mean = win.reduce((s, v) => s + v.rate, 0) / win.length;
  const sd = Math.sqrt(win.reduce((s, v) => s + (v.rate - mean) * (v.rate - mean), 0) / win.length);
  const z = sd < 1e-9 ? 0 : (latest - mean) / sd;
  const az = Math.abs(z);
  let level: FundingCrowding['level'] = 'none';
  if (az >= 1.5) level = 'extreme';
  else if (az >= 1.0) level = 'strong';
  else if (az >= 0.7) level = 'mild';
  // 逆向：z 高 => 做多拥挤 => 偏空；z 低 => 做空拥挤 => 偏多
  const tilt: FundingCrowding['tilt'] = z >= 0.7 ? 'bear' : z <= -0.7 ? 'bull' : 'osc';
  return {
    currentRate: latest,
    annualizedPct: latest * 3 * 365 * 100,
    mean90: mean,
    std90: sd,
    z,
    level,
    tilt,
    windowN: win.length,
  };
}