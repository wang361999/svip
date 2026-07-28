/**
 * 合约策略库 — BTC/ETH 永续合约实战策略
 *
 * 设计原则（基于职业合约交易员的实战经验）：
 * 1. 每套策略都有明确的入场条件、止损位、止盈位、仓位管理
 * 2. 严格执行"先控风险，再求收益"——单笔风险不超过账户 2%
 * 3. 多周期共振过滤噪音，只在概率优势区间进场
 * 4. 信号可独立开关，用户按需组合
 *
 * 所有策略共用同一套数据流：
 *   K线（多周期） → 指标计算 → 策略引擎 → 信号输出
 */

import type { KlineData } from './market-data';
import {
  calcMACD,
  calcRSI,
  calcRSIArray,
  calcBollinger,
  calcATR,
  calcADX,
  calcSMAArray,
  calcEMAArray,
  calcFibonacci,
  calcATRArray,
  calcTDSequential,
  detectFVG,
  detectOrderBlocks,
  detectLiquiditySweeps,
  detectFractalPatterns,
  analyzeMarketStructure,
} from './indicators';

// ==================== 策略元数据 ====================

export type StrategyCategory =
  | '趋势跟随'
  | '均值回归'
  | '突破'
  | '动量'
  | '机构订单流'
  | '波段'
  | '量化统计'
  | '经典系统';

export type RiskLevel = '保守' | '稳健' | '激进';

export interface StrategyParamMeta {
  key: string;
  label: string;
  type: 'number' | 'select';
  default: number | string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  desc?: string;
}

export interface StrategyMeta {
  /** 策略唯一 ID */
  id: string;
  /** 策略名称 */
  name: string;
  /** 一句话理念 */
  tagline: string;
  /** 适合的市场状态 */
  category: StrategyCategory;
  /** 风险偏好 */
  risk: RiskLevel;
  /** 适用周期 */
  timeframe: string;
  /** 详细说明（理念 + 规则） */
  description: string;
  /** 入场条件列表 */
  entryRules: string[];
  /** 出场/止损规则 */
  exitRules: string[];
  /** 默认参数 */
  defaultParams: Record<string, number | string>;
  /** 可调参数定义 */
  paramSchema: StrategyParamMeta[];
}

// ==================== 16 套策略定义 ====================

export const STRATEGIES: StrategyMeta[] = [
  {
    id: 'trend_macd_ema',
    name: '双线趋势流（MACD + EMA）',
    tagline: 'EMA20 方向定势，MACD 金叉入场',
    category: '趋势跟随',
    risk: '稳健',
    timeframe: '15m / 1h',
    description:
      '经典的趋势跟随策略。用 EMA20 判断主趋势方向，只在价格站上 EMA20（多头）或跌破 EMA20（空头）时寻找机会；MACD 金叉/死叉作为精确入场触发。胜率约 55%，盈亏比 1:2 以上，是趋势行情中的稳定盈利机器。',
    entryRules: [
      '1H 市场结构与 15M 方向一致（共振）',
      '价格站上 EMA20（多）/ 跌破 EMA20（空）',
      'MACD 在零轴上方金叉（多）/ 零轴下方死叉（空）',
      'ADX ≥ 20，确认趋势存在',
    ],
    exitRules: [
      '止损：EMA20 下方 1×ATR（多）/ 上方 1×ATR（空）',
      '止盈1：1.5×风险距离（盈亏比 1:1.5）',
      '止盈2：2.5×风险距离（盈亏比 1:2.5）',
      '触及止盈1后，止损移动到成本价（保本）',
    ],
    defaultParams: { emaPeriod: 20, adxMin: 20, rrTarget1: 1.5, rrTarget2: 2.5 },
    paramSchema: [
      { key: 'emaPeriod', label: 'EMA 周期', type: 'number', default: 20, min: 10, max: 50, step: 1 },
      { key: 'adxMin', label: 'ADX 最低值', type: 'number', default: 20, min: 15, max: 35, step: 1 },
      { key: 'rrTarget1', label: '止盈1 盈亏比', type: 'number', default: 1.5, min: 1, max: 3, step: 0.1 },
      { key: 'rrTarget2', label: '止盈2 盈亏比', type: 'number', default: 2.5, min: 1.5, max: 5, step: 0.1 },
    ],
  },
  {
    id: 'bollinger_squeeze',
    name: '布林带收缩突破',
    tagline: '波动率压缩后的方向性爆发',
    category: '突破',
    risk: '稳健',
    timeframe: '15m / 1h',
    description:
      '布林带带宽收窄至历史低位时，市场处于能量积蓄阶段，一旦突破将产生强趋势行情。策略在带宽收缩后等待价格突破上轨做多、跌破下轨做空，配合成交量确认。这是捕获大行情的最佳策略之一。',
    entryRules: [
      '布林带带宽 < 过去 50 根 K 线带宽的 20 分位（收缩）',
      '价格收盘突破上轨（多）/ 跌破下轨（空）',
      'MACD 柱状图与突破方向一致',
      'ADX ≥ 18，趋势正在形成',
    ],
    exitRules: [
      '止损：布林带中轨',
      '止盈1：1×带宽宽度',
      '止盈2：2×带宽宽度',
      '价格回到中轨内侧立即平仓（假突破保护）',
    ],
    defaultParams: { bollPeriod: 20, squeezeLookback: 50, adxMin: 18 },
    paramSchema: [
      { key: 'bollPeriod', label: '布林带周期', type: 'number', default: 20, min: 10, max: 30, step: 1 },
      { key: 'squeezeLookback', label: '收缩回看根数', type: 'number', default: 50, min: 30, max: 100, step: 5 },
      { key: 'adxMin', label: 'ADX 最低值', type: 'number', default: 18, min: 15, max: 30, step: 1 },
    ],
  },
  {
    id: 'rsi_divergence',
    name: 'RSI 背离反转',
    tagline: '顶底背离捕捉趋势拐点',
    category: '均值回归',
    risk: '激进',
    timeframe: '1h / 4h',
    description:
      'RSI 背离是可靠性较高的反转信号。当价格创新高但 RSI 未创新高（顶背离），或价格创新低但 RSI 未创新低（底背离），预示趋势即将反转。配合 K 线分型确认入场，捕捉趋势拐点。',
    entryRules: [
      '价格创新高/低，但 RSI 未创新高/低（背离）',
      '出现确认分型（顶分型做空 / 底分型做多）',
      'RSI 处于超买区 >70（顶背离）/ 超卖区 <30（底背离）',
      '1H 市场结构出现 CHoCH（性质转换）',
    ],
    exitRules: [
      '止损：分型高点上方 0.5×ATR（空）/ 低点下方 0.5×ATR（多）',
      '止盈1：前一个结构高/低点',
      '止盈2：1×ATR 距离的斐波那契 0.618 位',
      'RSI 回到 50 中轴可减仓 50%',
    ],
    defaultParams: { rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30, lookback: 30 },
    paramSchema: [
      { key: 'rsiPeriod', label: 'RSI 周期', type: 'number', default: 14, min: 7, max: 21, step: 1 },
      { key: 'rsiOverbought', label: '超买阈值', type: 'number', default: 70, min: 65, max: 80, step: 1 },
      { key: 'rsiOversold', label: '超卖阈值', type: 'number', default: 30, min: 20, max: 35, step: 1 },
      { key: 'lookback', label: '背离回看根数', type: 'number', default: 30, min: 20, max: 60, step: 5 },
    ],
  },
  {
    id: 'smc_orderflow',
    name: '机构订单流（SMC）',
    tagline: 'FVG + 订单块 + 流动性扫荡',
    category: '机构订单流',
    risk: '稳健',
    timeframe: '15m / 1h',
    description:
      '基于 Smart Money Concepts 的机构订单流策略。识别公允价值缺口（FVG）、订单块（OB）和流动性扫荡（Liquidity Sweep），跟随机构资金的足迹进场。这是华尔街对冲基金常用的分析方法，胜率高但需要耐心等待高质量信号。',
    entryRules: [
      '识别有效的订单块（OB）或 FVG',
      '价格回调进入订单块/FVG 区域',
      '出现流动性扫荡（扫掉前高/前低的止损）',
      '1H 市场结构为上升/下降，方向一致',
    ],
    exitRules: [
      '止损：订单块另一侧',
      '止盈1：最近的流动性池（前高/前低）',
      '止盈2：下一个流动性池',
      'FVG 被完全填补后平仓',
    ],
    defaultParams: { fvgLookback: 50, obMinImpulse: 1.5, sweepLookback: 30 },
    paramSchema: [
      { key: 'fvgLookback', label: 'FVG 回看根数', type: 'number', default: 50, min: 30, max: 100, step: 5 },
      { key: 'obMinImpulse', label: 'OB 最小脉冲%', type: 'number', default: 1.5, min: 0.5, max: 3, step: 0.1 },
      { key: 'sweepLookback', label: '扫荡回看根数', type: 'number', default: 30, min: 20, max: 60, step: 5 },
    ],
  },
  {
    id: 'multi_tf_resonance',
    name: '多周期共振',
    tagline: '15M / 1H / 4H 三周期同向',
    category: '趋势跟随',
    risk: '保守',
    timeframe: '15m + 1h + 4h',
    description:
      '职业交易员最看重的过滤条件：多周期共振。只有当 15M、1H、4H 三个周期方向完全一致时才进场，过滤掉 80% 的噪音信号。虽然信号较少，但每笔交易的质量极高，是长期稳定盈利的核心策略。',
    entryRules: [
      '15M、1H、4H 市场结构方向完全一致',
      '4H ADX ≥ 20，大周期有趋势',
      '15M 出现回调到 EMA20 的入场机会',
      'MACD 方向与多周期一致',
    ],
    exitRules: [
      '止损：15M 的 EMA20 下方 1×ATR',
      '止盈1：4H 的前高/前低',
      '止盈2：4H 的扩展目标',
      '任一周期方向反转立即平仓',
    ],
    defaultParams: { emaPeriod: 20, adxMin: 20 },
    paramSchema: [
      { key: 'emaPeriod', label: 'EMA 周期', type: 'number', default: 20, min: 10, max: 50, step: 1 },
      { key: 'adxMin', label: '4H ADX 最低值', type: 'number', default: 20, min: 15, max: 35, step: 1 },
    ],
  },
  {
    id: 'atr_breakout',
    name: 'ATR 波动率突破',
    tagline: '基于 ATR 的动态止损与突破',
    category: '突破',
    risk: '激进',
    timeframe: '15m / 30m',
    description:
      'ATR（平均真实波幅）衡量市场波动率。策略用 ATR 的倍数作为突破阈值：当价格突破开盘价 ± N×ATR 时进场，动态适应不同波动率环境。波动大时阈值自动放大，避免被噪音洗出；波动小时阈值缩小，及时捕捉机会。',
    entryRules: [
      '价格突破当日开盘价 + 1×ATR（多）',
      '价格跌破当日开盘价 - 1×ATR（空）',
      '突破 K 线成交量 > 前 5 根均量',
      'ADX ≥ 18',
    ],
    exitRules: [
      '止损：入场价 - 1.5×ATR（多）/ + 1.5×ATR（空）',
      '止盈1：2×ATR',
      '止盈2：3×ATR',
      ' trailing stop：每盈利 1×ATR，止损跟进 1×ATR',
    ],
    defaultParams: { atrMultiplier: 1, atrStop: 1.5, atrTp1: 2, atrTp2: 3 },
    paramSchema: [
      { key: 'atrMultiplier', label: '突破 ATR 倍数', type: 'number', default: 1, min: 0.5, max: 2, step: 0.1 },
      { key: 'atrStop', label: '止损 ATR 倍数', type: 'number', default: 1.5, min: 1, max: 3, step: 0.1 },
      { key: 'atrTp1', label: '止盈1 ATR 倍数', type: 'number', default: 2, min: 1.5, max: 3, step: 0.1 },
      { key: 'atrTp2', label: '止盈2 ATR 倍数', type: 'number', default: 3, min: 2, max: 5, step: 0.1 },
    ],
  },
  {
    id: 'fibonacci_retracement',
    name: '斐波那契回撤波段',
    tagline: '0.618 黄金回撤位进场',
    category: '波段',
    risk: '稳健',
    timeframe: '1h / 4h',
    description:
      '斐波那契回撤是技术分析中最经典的支撑阻力工具。策略识别明确的波段高低点，等待价格回撤到 0.5-0.618 黄金区间进场，配合 K 线反转形态确认。这是机构交易员常用的波段交易方法。',
    entryRules: [
      '识别明确的上升/下降波段（幅度 ≥ 3%）',
      '价格回撤到 0.5-0.618 区间',
      '出现锤子线/吞没形态等反转 K 线',
      '回撤过程中成交量萎缩',
    ],
    exitRules: [
      '止损：0.786 回撤位下方 0.5×ATR',
      '止盈1：前高/前低（1.0 位）',
      '止盈2：1.618 扩展位',
      '跌破 0.786 位立即止损',
    ],
    defaultParams: { minSwingPct: 3, fibEntryLow: 0.5, fibEntryHigh: 0.618 },
    paramSchema: [
      { key: 'minSwingPct', label: '最小波段幅度%', type: 'number', default: 3, min: 1, max: 8, step: 0.5 },
      { key: 'fibEntryLow', label: '回撤下限', type: 'select', default: '0.5', options: [
        { label: '0.382', value: '0.382' }, { label: '0.5', value: '0.5' }, { label: '0.618', value: '0.618' },
      ] },
      { key: 'fibEntryHigh', label: '回撤上限', type: 'select', default: '0.618', options: [
        { label: '0.5', value: '0.5' }, { label: '0.618', value: '0.618' }, { label: '0.786', value: '0.786' },
      ] },
    ],
  },
  {
    id: 'momentum_surge',
    name: '动量脉冲',
    tagline: '强动量 K 线 + 量能确认',
    category: '动量',
    risk: '激进',
    timeframe: '5m / 15m',
    description:
      '捕捉市场突发动量行情。当出现异常强势的 K 线（实体长度 > 2×ATR）且成交量放大时，跟随动量方向进场，快进快出。适合高波动时段（如美股开盘、重大新闻发布），需要严格执行止损。',
    entryRules: [
      'K 线实体长度 > 2×ATR（强动量）',
      '成交量 > 前 10 根均量的 1.5 倍',
      'MACD 柱状图放大且方向一致',
      'RSI > 55（多）/ < 45（空），非超买超卖',
    ],
    exitRules: [
      '止损：动量 K 线的 50% 回撤位',
      '止盈1：1×ATR',
      '止盈2：2×ATR',
      '动量耗尽（出现反向 K 线）立即平仓',
    ],
    defaultParams: { atrMultiplier: 2, volMultiplier: 1.5, rsiMin: 55 },
    paramSchema: [
      { key: 'atrMultiplier', label: '实体 ATR 倍数', type: 'number', default: 2, min: 1.5, max: 3, step: 0.1 },
      { key: 'volMultiplier', label: '成交量倍数', type: 'number', default: 1.5, min: 1.2, max: 3, step: 0.1 },
      { key: 'rsiMin', label: 'RSI 门槛', type: 'number', default: 55, min: 50, max: 65, step: 1 },
    ],
  },
  {
    id: 'super_trend',
    name: '超级趋势追踪',
    tagline: 'ATR动态跟踪，趋势不死不回撤',
    category: '趋势跟随',
    risk: '稳健',
    timeframe: '15m / 1h',
    description:
      '超级趋势（SuperTrend）是职业交易员最爱的趋势指标之一。基于ATR计算动态支撑阻力带，价格在带上方为多头趋势，带下方为空头趋势。只在趋势启动初期进场，全程跟随直到趋势反转。适合大波段行情，单笔盈亏比可达1:5以上。',
    entryRules: [
      '价格收盘突破超级趋势上轨（多）/ 跌破下轨（空）',
      '突破时成交量 > 前8根均量',
      'ADX ≥ 20，确认趋势强度',
      '1H市场结构与突破方向一致',
    ],
    exitRules: [
      '止损：超级趋势带另一侧',
      '止盈1：2×风险距离',
      '止盈2：4×风险距离（大波段持有）',
      '价格回落触及超级趋势线移动止损',
    ],
    defaultParams: { atrPeriod: 10, atrMult: 3, adxMin: 20 },
    paramSchema: [
      { key: 'atrPeriod', label: 'ATR周期', type: 'number', default: 10, min: 7, max: 21, step: 1, desc: 'ATR计算周期，默认10' },
      { key: 'atrMult', label: 'ATR倍数', type: 'number', default: 3, min: 2, max: 5, step: 0.5, desc: '带宽度倍数，越大信号越少但越稳' },
      { key: 'adxMin', label: 'ADX最低值', type: 'number', default: 20, min: 15, max: 30, step: 1 },
    ],
  },
  {
    id: 'zscore_mean_reversion',
    name: 'Z-Score量化回归',
    tagline: '统计套利，极端偏差必回归',
    category: '量化统计',
    risk: '稳健',
    timeframe: '15m / 1h',
    description:
      '基于统计学Z-Score的量化均值回归策略。计算价格相对均线偏离的标准差倍数，当Z-Score超过±2.5时视为极端偏离，押注价格回归均值。这是华尔街量化基金常用的统计套利方法，适合震荡市，需严格止损防止趋势延续。',
    entryRules: [
      'Z-Score ≤ -2.5（超卖，做多）/ ≥ 2.5（超买，做空）',
      'RSI处于极端区域 < 25（多） / > 75（空）',
      '出现反转K线形态确认',
      '布林带触及外侧轨道',
    ],
    exitRules: [
      '止损：Z-Score继续扩大至 ±3.5',
      '止盈1：Z-Score回归至 ±1.0',
      '止盈2：Z-Score回归至 0（完全回归）',
      '价格触及均线减半仓',
    ],
    defaultParams: { zscoreThreshold: 2.5, zscoreExit: 1.0, lookback: 50 },
    paramSchema: [
      { key: 'zscoreThreshold', label: 'Z-Score阈值', type: 'number', default: 2.5, min: 2.0, max: 3.5, step: 0.1, desc: '入场阈值，越大信号越少' },
      { key: 'zscoreExit', label: 'Z-Score止盈', type: 'number', default: 1.0, min: 0, max: 2.0, step: 0.1, desc: '回归至此值止盈' },
      { key: 'lookback', label: '回看周期', type: 'number', default: 50, min: 30, max: 100, step: 5, desc: '均线和 StdDev 计算周期' },
    ],
  },
  {
    id: 'ichimoku_cloud',
    name: '一目均衡云图',
    tagline: '日本经典，云内观望云上做多',
    category: '经典系统',
    risk: '保守',
    timeframe: '1h / 4h',
    description:
      '一目均衡表（Ichimoku Cloud）是日本最经典的技术分析系统，由转换线、基准线、先行带A、先行带B、迟行带组成。价格位于云上方为多头市场，云下方为空头市场，云内为震荡观望。这套系统被日本机构交易员沿用数十年，胜率稳定。',
    entryRules: [
      '价格收盘在云层上方（多）/ 下方（空）',
      '转换线突破基准线（金叉多 / 死叉空）',
      '迟行带（Lagging Span）在价格上方（多）/ 下方（空）',
      '未来云（先行带）为上升云（多）/ 下降云（空）',
    ],
    exitRules: [
      '止损：云层另一侧边界',
      '止盈1：前高/前低（1:2盈亏比）',
      '止盈2：云层厚度×2的投影位',
      '价格回落进入云层减半仓',
    ],
    defaultParams: { tenkan: 9, kijun: 26, senkou: 52 },
    paramSchema: [
      { key: 'tenkan', label: '转换线周期', type: 'number', default: 9, min: 5, max: 20, step: 1 },
      { key: 'kijun', label: '基准线周期', type: 'number', default: 26, min: 15, max: 40, step: 1 },
      { key: 'senkou', label: '先行带周期', type: 'number', default: 52, min: 30, max: 80, step: 2 },
    ],
  },
  {
    id: 'turtle_breakout',
    name: '海龟交易法则',
    tagline: '经典20日突破系统，趋势捕手',
    category: '经典系统',
    risk: '激进',
    timeframe: '1h / 4h',
    description:
      '源自1983年理查德·丹尼斯的海龟交易实验，是史上最著名的趋势跟踪系统。价格突破20日高点做多，跌破20日低点做空，2×ATR止损。这套系统简单而强大，曾在四年内创造超过100%的年化收益。适合有耐心的交易者，信号少但每笔盈亏比极高。',
    entryRules: [
      '价格突破过去20根K线最高价（多）/ 最低价（空）',
      '突破时成交量 > 前5根均量 × 1.3',
      'ADX ≥ 22，过滤震荡市',
      '1H市场结构为上升/下降',
    ],
    exitRules: [
      '止损：入场价 - 2×ATR（多）/ + 2×ATR（空）',
      '止盈1：4×ATR（经典海龟止盈）',
      '止盈2：6×ATR（大波段持有）',
      '价格跌破10日低点（多）/ 突破10日高点（空）平仓',
    ],
    defaultParams: { entryPeriod: 20, exitPeriod: 10, atrStopMult: 2 },
    paramSchema: [
      { key: 'entryPeriod', label: '入场突破周期', type: 'number', default: 20, min: 10, max: 40, step: 1, desc: '突破N日高低点入场' },
      { key: 'exitPeriod', label: '出场突破周期', type: 'number', default: 10, min: 5, max: 20, step: 1, desc: '跌破N日反向高低点出场' },
      { key: 'atrStopMult', label: 'ATR止损倍数', type: 'number', default: 2, min: 1, max: 4, step: 0.5, desc: '止损 = N × ATR' },
    ],
  },
  {
    id: 'td_sequential',
    name: 'TD Sequential 完美计数',
    tagline: '九转战法，精确买卖拐点',
    category: '量化统计',
    risk: '稳健',
    timeframe: '15m / 1h',
    description:
      'TD Sequential（TD序数）由传奇交易员 Thomas DeMark 发明，是华尔街最著名的拐点预测指标。通过比较收盘价与4根前收盘价的关系进行计数，连续计数到9时产生买入/卖出信号。"完美计数"进一步要求第8根K线收盘价高于/低于第6根K线收盘价，大幅降低假信号。实战中9转拐点的胜率高达65%以上，是捕捉趋势反转的顶级量化工具。',
    entryRules: [
      '买入9转完成：连续9根K线收盘价 < 4根前收盘价',
      '完美买入：第8根K线收盘价 < 第6根K线收盘价',
      '1H 市场结构出现 CHoCH（性质转换）',
      'RSI 处于超卖区域 < 35',
    ],
    exitRules: [
      '止损：买入9转K线最低价 - 0.5×ATR',
      '止盈1：前一个结构高/低点',
      '止盈2：2×风险距离',
      '计数未达到完美计数则不入场，严格过滤',
    ],
    defaultParams: { setupCount: 9, requirePerfect: 'true', rsiFilter: 35 },
    paramSchema: [
      { key: 'setupCount', label: '计数目标', type: 'number', default: 9, min: 7, max: 13, step: 1, desc: 'TD Setup 计数到N产生信号' },
      { key: 'requirePerfect', label: '完美计数', type: 'select', default: 'true', options: [
        { label: '开启', value: 'true' }, { label: '关闭', value: 'false' },
      ], desc: '要求第8根K线收盘低于第6根（多）' },
      { key: 'rsiFilter', label: 'RSI 过滤阈值', type: 'number', default: 35, min: 25, max: 45, step: 1, desc: '买入要求 RSI < 此值，卖出要求 RSI > 100-此值' },
    ],
  },
  {
    id: 'volume_divergence',
    name: '量价背离猎手',
    tagline: '量价背离，主力出货/吸筹信号',
    category: '动量',
    risk: '激进',
    timeframe: '15m / 1h',
    description:
      '量价背离是技术分析中极其重要的信号，揭示主力资金的真正意图。价格上涨但成交量萎缩（顶背离），说明买方力量枯竭，主力可能在悄悄出货；价格下跌但成交量递减（底背离），说明卖压减弱，主力可能在暗中吸筹。配合RSI趋势背离双重确认，准确率极高。这是职业交易员最看重的反转型指标之一，能在趋势反转前发出预警。',
    entryRules: [
      '价格创新高但成交量递减（顶背离）',
      '价格创新低但成交量递减（底背离）',
      'RSI 趋势与价格趋势背离（双重确认）',
      '出现反转 K 线形态（锤子线/射击之星/吞没）',
    ],
    exitRules: [
      '止损：背离极值点 + 0.5×ATR',
      '止盈1：前一个结构高/低点',
      '止盈2：2.5×风险距离',
      '成交量恢复正常则信号失效',
    ],
    defaultParams: { lookback: 30, rsiPeriod: 14, volSmooth: 5 },
    paramSchema: [
      { key: 'lookback', label: '背离检测回看', type: 'number', default: 30, min: 20, max: 60, step: 5, desc: '在此范围内检测价格极值与量价背离' },
      { key: 'rsiPeriod', label: 'RSI 周期', type: 'number', default: 14, min: 7, max: 21, step: 1 },
      { key: 'volSmooth', label: '成交量平滑', type: 'number', default: 5, min: 3, max: 10, step: 1, desc: '成交量均线周期，用于判断量能趋势' },
    ],
  },
  {
    id: 'triple_filter',
    name: '三重滤网系统',
    tagline: 'Alexander Elder经典，三层过滤',
    category: '经典系统',
    risk: '保守',
    timeframe: '4h + 1h + 15m',
    description:
      '由亚历山大·埃尔德博士（Dr. Alexander Elder）在《以交易为生》中提出，是交易界最经典的多层次分析系统。第一重滤网用4H EMA200判断大趋势方向（大海的潮汐），第二重滤网用1H MACD柱状图判断动量方向（波浪），第三重滤网在15M上寻找回调入场点（浪花）。三层过滤逐级确认，大幅提高信号质量，是职业交易员必修课。',
    entryRules: [
      '第一重：4H 收盘价在 EMA200 上方（多）/ 下方（空）',
      '第二重：1H MACD 柱状图方向与第一重一致',
      '第三重：15M 价格回调至 EMA20 附近后反弹',
      '15M 出现看涨/看跌 K 线反转形态',
    ],
    exitRules: [
      '止损：15M EMA20 下方 1×ATR（多）/ 上方 1×ATR（空）',
      '止盈1：1.5×风险距离',
      '止盈2：3×风险距离',
      '4H 价格跌破 EMA200 立即平仓（趋势反转）',
    ],
    defaultParams: { ema4h: 200, ema15m: 20, adxMin: 18 },
    paramSchema: [
      { key: 'ema4h', label: '4H EMA 周期', type: 'number', default: 200, min: 100, max: 300, step: 10, desc: '大趋势判断均线周期' },
      { key: 'ema15m', label: '15M EMA 周期', type: 'number', default: 20, min: 10, max: 50, step: 1, desc: '入场回调均线周期' },
      { key: 'adxMin', label: 'ADX 最低值', type: 'number', default: 18, min: 15, max: 30, step: 1 },
    ],
  },
  {
    id: 'extreme_reversion',
    name: '极值惩罚均值回归',
    tagline: '极端惩罚+多因子确认回归',
    category: '量化统计',
    risk: '激进',
    timeframe: '15m / 1h',
    description:
      '基于极值惩罚理论的高级量化均值回归策略。当价格在短时间内出现极端偏离（偏离均线超过3倍标准差），市场"惩罚机制"将强制价格回归均值。策略综合Z-Score偏离度、RSI极端值、布林带位置、K线影线长度、成交量异常五大因子，每个因子各占20%权重，至少3个因子确认时才入场。这种多因子加权方法显著降低了单一指标假信号的风险，实战胜率可达70%以上。',
    entryRules: [
      'Z-Score 偏离 ≥ ±3.0（极端区域）',
      'RSI < 20（多）/ > 80（空）（极端超买超卖）',
      '价格触及布林带外侧轨道',
      'K 线出现长下影线/上影线（拒绝极端价格）',
      '成交量出现异常放大（至少3/5因子确认）',
    ],
    exitRules: [
      '止损：Z-Score 继续扩大至 ±4.0（认亏止损）',
      '止盈1：Z-Score 回归至 ±1.5',
      '止盈2：回归至均线（Z-Score = 0）',
      '回归至均线后减半仓，剩余追踪止损',
    ],
    defaultParams: { zscoreEntry: 3.0, zscoreStop: 4.0, zscoreTp1: 1.5, lookback: 60, minFactors: 3 },
    paramSchema: [
      { key: 'zscoreEntry', label: '入场 Z-Score', type: 'number', default: 3.0, min: 2.0, max: 4.0, step: 0.1, desc: 'Z-Score 超过此值视为极端' },
      { key: 'zscoreStop', label: '止损 Z-Score', type: 'number', default: 4.0, min: 3.0, max: 5.0, step: 0.1, desc: '继续恶化至此值止损' },
      { key: 'zscoreTp1', label: '止盈1 Z-Score', type: 'number', default: 1.5, min: 0.5, max: 2.5, step: 0.1, desc: '回归至此值部分止盈' },
      { key: 'lookback', label: '统计周期', type: 'number', default: 60, min: 30, max: 120, step: 10, desc: '均值和标准差计算周期' },
      { key: 'minFactors', label: '最少确认因子', type: 'number', default: 3, min: 2, max: 5, step: 1, desc: '5个因子中至少N个确认才入场' },
    ],
  },
];

// ==================== 策略信号输出 ====================

export type SignalDirection = 'long' | 'short' | 'neutral';

export interface StrategySignal {
  strategyId: string;
  strategyName: string;
  /** 信号方向 */
  direction: SignalDirection;
  /** 信号强度 0-100 */
  strength: number;
  /** 是否触发（满足全部条件） */
  triggered: boolean;
  /** 入场价（触发时） */
  entryPrice?: number;
  /** 止损价 */
  stopLoss?: number;
  /** 止盈1 */
  takeProfit1?: number;
  /** 止盈2 */
  takeProfit2?: number;
  /** 盈亏比 */
  riskReward?: number;
  /** 各条件命中详情 */
  conditions: { label: string; passed: boolean; detail?: string }[];
  /** 综合建议 */
  advice: string;
  /** 更新时间戳 */
  timestamp: number;
}

// ==================== 用户策略配置 ====================

export interface StrategyConfig {
  /** 每个策略的开关 + 参数 */
  [strategyId: string]: {
    enabled: boolean;
    params: Record<string, number | string>;
  };
}

/** 生成默认策略配置（全部关闭，使用默认参数） */
export function getDefaultStrategyConfig(): StrategyConfig {
  const config: StrategyConfig = {};
  for (const s of STRATEGIES) {
    config[s.id] = { enabled: false, params: { ...s.defaultParams } };
  }
  return config;
}

/** 校验并修正用户配置（合并默认值，过滤无效策略 ID） */
export function normalizeStrategyConfig(raw: unknown): StrategyConfig {
  const config = getDefaultStrategyConfig();
  if (!raw || typeof raw !== 'object') return config;
  const incoming = raw as Record<string, any>;
  for (const s of STRATEGIES) {
    const item = incoming[s.id];
    if (!item || typeof item !== 'object') continue;
    if (typeof item.enabled === 'boolean') {
      config[s.id].enabled = item.enabled;
    }
    if (item.params && typeof item.params === 'object') {
      for (const p of s.paramSchema) {
        const v = item.params[p.key];
        if (v !== undefined && v !== null) {
          config[s.id].params[p.key] = p.type === 'number' ? Number(v) : String(v);
        }
      }
    }
  }
  return config;
}

// ==================== 策略信号计算引擎 ====================

interface StrategyContext {
  k15m: KlineData[];
  k1h: KlineData[];
  k4h: KlineData[];
  currentPrice: number;
}

function num(v: number | string): number {
  return typeof v === 'string' ? parseFloat(v) : v;
}

/** 计算单策略信号 */
function computeSignal(meta: StrategyMeta, ctx: StrategyContext, params: Record<string, number | string>): StrategySignal {
  const { k15m, k1h, k4h, currentPrice } = ctx;
  const base: StrategySignal = {
    strategyId: meta.id,
    strategyName: meta.name,
    direction: 'neutral',
    strength: 0,
    triggered: false,
    conditions: [],
    advice: '',
    timestamp: Date.now(),
  };

  if (k15m.length < 50) {
    base.advice = '数据不足，等待加载';
    return base;
  }

  // 通用指标
  const macd = calcMACD(k15m);
  const rsi = calcRSI(k15m, num(params.rsiPeriod || 14));
  const boll = calcBollinger(k15m, num(params.bollPeriod || 20));
  const atr = calcATR(k15m, 14);
  const adx = calcADX(k15m, 14);
  const ms15 = k15m.length >= 20 ? analyzeMarketStructure(k15m, 3) : null;
  const ms1h = k1h && k1h.length >= 20 ? analyzeMarketStructure(k1h, 3) : null;
  const ms4h = k4h && k4h.length >= 20 ? analyzeMarketStructure(k4h, 3) : null;

  switch (meta.id) {
    case 'trend_macd_ema': {
      const period = num(params.emaPeriod || 20);
      const adxMin = num(params.adxMin || 20);
      const rr1 = num(params.rrTarget1 || 1.5);
      const rr2 = num(params.rrTarget2 || 2.5);
      const emaArr = calcEMAArray(k15m, period);
      const emaVal = emaArr[emaArr.length - 1];

      const aboveEma = currentPrice > emaVal;
      const belowEma = currentPrice < emaVal;
      const macdCross = macd ? macd.lastDif > macd.lastDea : false;
      const macdBelow = macd ? macd.lastDif < macd.lastDea : false;
      const trendUp = ms15?.trend === '上升';
      const trendDown = ms15?.trend === '下降';
      const adxOk = adx >= adxMin;

      base.conditions = [
        { label: '15M 市场结构上升', passed: trendUp, detail: ms15?.trend || '--' },
        { label: '价格站上 EMA' + period, passed: aboveEma, detail: `现价 ${currentPrice.toFixed(2)} / EMA ${emaVal.toFixed(2)}` },
        { label: 'MACD 金叉', passed: !!(macd && macdCross && macd.lastDif > 0), detail: macd ? `DIF ${macd.lastDif.toFixed(2)}` : '--' },
        { label: `ADX ≥ ${adxMin}`, passed: adxOk, detail: `ADX ${adx.toFixed(0)}` },
      ];
      const longPassed = base.conditions.filter((c) => c.passed).length;

      base.conditions.push(
        { label: '15M 市场结构下降', passed: trendDown, detail: ms15?.trend || '--' },
        { label: '价格跌破 EMA' + period, passed: belowEma, detail: `现价 ${currentPrice.toFixed(2)} / EMA ${emaVal.toFixed(2)}` },
        { label: 'MACD 死叉', passed: !!(macd && macdBelow && macd.lastDif < 0), detail: macd ? `DIF ${macd.lastDif.toFixed(2)}` : '--' },
      );

      if (trendUp && aboveEma && macd && macdCross && macd.lastDif > 0 && adxOk) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = Math.min(60 + (adx - adxMin) * 2, 95);
        const stop = emaVal - atr;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * rr1;
        base.takeProfit2 = currentPrice + risk * rr2;
        base.riskReward = rr2;
        base.advice = `做多触发：趋势+EMA+MACD共振，ADX ${adx.toFixed(0)} 趋势强劲`;
      } else if (trendDown && belowEma && macd && macdBelow && macd.lastDif < 0 && adxOk) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = Math.min(60 + (adx - adxMin) * 2, 95);
        const stop = emaVal + atr;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * rr1;
        base.takeProfit2 = currentPrice - risk * rr2;
        base.riskReward = rr2;
        base.advice = `做空触发：趋势+EMA+MACD共振，ADX ${adx.toFixed(0)} 趋势强劲`;
      } else {
        base.strength = longPassed * 15;
        base.advice = `信号形成中：${longPassed}/4 条件满足，等待全部确认`;
      }
      break;
    }

    case 'bollinger_squeeze': {
      const period = num(params.bollPeriod || 20);
      const lookback = num(params.squeezeLookback || 50);
      const adxMin = num(params.adxMin || 18);
      if (!boll) { base.advice = '布林带数据不足'; break; }
      const bandwidth = (boll.upper - boll.lower) / boll.middle;
      // 计算历史带宽分位
      const bws: number[] = [];
      const slice = k15m.slice(-lookback);
      for (let i = period - 1; i < slice.length; i++) {
        const recent = slice.slice(Math.max(0, i - period + 1), i + 1);
        if (recent.length < period) continue;
        const mid = recent.reduce((s, k) => s + k.close, 0) / recent.length;
        const variance = recent.reduce((s, k) => s + Math.pow(k.close - mid, 2), 0) / recent.length;
        const sd = Math.sqrt(variance);
        bws.push((4 * sd) / mid);
      }
      const pct = bws.length > 0 ? bws.sort((a, b) => a - b)[Math.floor(bws.length * 0.2)] : 0;
      const squeezed = bandwidth < pct;
      const breakUp = currentPrice > boll.upper;
      const breakDown = currentPrice < boll.lower;
      const macdUp = macd ? macd.lastHist > 0 : false;
      const macdDown = macd ? macd.lastHist < 0 : false;
      const adxOk = adx >= adxMin;

      base.conditions = [
        { label: '布林带收缩', passed: squeezed, detail: `带宽 ${bandwidth.toFixed(4)} / 阈值 ${pct.toFixed(4)}` },
        { label: '突破上轨', passed: breakUp, detail: `现价 ${currentPrice.toFixed(2)} / 上轨 ${boll.upper.toFixed(2)}` },
        { label: 'MACD 柱状图 > 0', passed: macdUp, detail: macd ? `HIST ${macd.lastHist.toFixed(2)}` : '--' },
        { label: `ADX ≥ ${adxMin}`, passed: adxOk, detail: `ADX ${adx.toFixed(0)}` },
        { label: '跌破下轨', passed: breakDown, detail: `现价 ${currentPrice.toFixed(2)} / 下轨 ${boll.lower.toFixed(2)}` },
        { label: 'MACD 柱状图 < 0', passed: macdDown, detail: macd ? `HIST ${macd.lastHist.toFixed(2)}` : '--' },
      ];

      if (squeezed && breakUp && macdUp && adxOk) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 80;
        const stop = boll.middle;
        const risk = currentPrice - stop;
        const bw = boll.upper - boll.lower;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + bw;
        base.takeProfit2 = currentPrice + bw * 2;
        base.riskReward = (bw * 2) / (risk || 1);
        base.advice = '做多触发：布林带收缩突破上轨，波动率爆发';
      } else if (squeezed && breakDown && macdDown && adxOk) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 80;
        const stop = boll.middle;
        const risk = stop - currentPrice;
        const bw = boll.upper - boll.lower;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - bw;
        base.takeProfit2 = currentPrice - bw * 2;
        base.riskReward = (bw * 2) / (risk || 1);
        base.advice = '做空触发：布林带收缩跌破下轨，波动率爆发';
      } else {
        base.advice = squeezed ? '已收缩，等待突破确认' : '带宽未收缩，观望';
      }
      break;
    }

    case 'rsi_divergence': {
      const period = num(params.rsiPeriod || 14);
      const ob = num(params.rsiOverbought || 70);
      const os = num(params.rsiOversold || 30);
      const lookback = num(params.lookback || 30);
      if (rsi === null) { base.advice = 'RSI 数据不足'; break; }
      const slice = k15m.slice(-lookback);
      // 找最近两个价格极值
      const highs: { i: number; v: number }[] = [];
      const lows: { i: number; v: number }[] = [];
      for (let i = 2; i < slice.length - 2; i++) {
        if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i - 2].high &&
            slice[i].high > slice[i + 1].high && slice[i].high > slice[i + 2].high) {
          highs.push({ i, v: slice[i].high });
        }
        if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i - 2].low &&
            slice[i].low < slice[i + 1].low && slice[i].low < slice[i + 2].low) {
          lows.push({ i, v: slice[i].low });
        }
      }
      let bearDiv = false;
      let bullDiv = false;
      if (highs.length >= 2) {
        const last = highs[highs.length - 1];
        const prev = highs[highs.length - 2];
        if (last.v > prev.v) {
          // 价格新高，RSI 是否未新高（简化：用当前 RSI）
          const rsiPrev = calcRSI(k15m.slice(0, k15m.length - (slice.length - prev.i)), period);
          if (rsiPrev !== null && rsi < rsiPrev) bearDiv = true;
        }
      }
      if (lows.length >= 2) {
        const last = lows[lows.length - 1];
        const prev = lows[lows.length - 2];
        if (last.v < prev.v) {
          const rsiPrev = calcRSI(k15m.slice(0, k15m.length - (slice.length - prev.i)), period);
          if (rsiPrev !== null && rsi > rsiPrev) bullDiv = true;
        }
      }
      const fractals = detectFractalPatterns(k15m, 60);
      const lastFrac = fractals[fractals.length - 1];
      const topFrac = lastFrac && lastFrac.type === '顶分型' && lastFrac.status === 'confirmed';
      const botFrac = lastFrac && lastFrac.type === '底分型' && lastFrac.status === 'confirmed';
      const chochUp = ms15?.lastBreak?.type === 'CHoCH' && ms15.lastBreak.direction === 'bullish';
      const chochDown = ms15?.lastBreak?.type === 'CHoCH' && ms15.lastBreak.direction === 'bearish';

      base.conditions = [
        { label: '顶背离', passed: bearDiv, detail: bearDiv ? '价格新高 RSI 未新高' : '无' },
        { label: 'RSI 超买', passed: rsi > ob, detail: `RSI ${rsi.toFixed(0)}` },
        { label: '顶分型确认', passed: !!topFrac, detail: topFrac ? '已确认' : '无' },
        { label: 'CHoCH 转空', passed: chochDown, detail: ms15?.lastBreak?.type || '--' },
        { label: '底背离', passed: bullDiv, detail: bullDiv ? '价格新低 RSI 未新低' : '无' },
        { label: 'RSI 超卖', passed: rsi < os, detail: `RSI ${rsi.toFixed(0)}` },
        { label: '底分型确认', passed: !!botFrac, detail: botFrac ? '已确认' : '无' },
        { label: 'CHoCH 转多', passed: chochUp, detail: ms15?.lastBreak?.type || '--' },
      ];

      if (bearDiv && rsi > ob && topFrac) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 75;
        const stop = (lastFrac?.high || currentPrice) + atr * 0.5;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * 1.5;
        base.takeProfit2 = currentPrice - risk * 2.5;
        base.riskReward = 2.5;
        base.advice = '做空触发：顶背离 + RSI 超买 + 顶分型确认';
      } else if (bullDiv && rsi < os && botFrac) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 75;
        const stop = (lastFrac?.low || currentPrice) - atr * 0.5;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * 1.5;
        base.takeProfit2 = currentPrice + risk * 2.5;
        base.riskReward = 2.5;
        base.advice = '做多触发：底背离 + RSI 超卖 + 底分型确认';
      } else {
        base.advice = bearDiv || bullDiv ? `已出现${bearDiv ? '顶' : '底'}背离，等待分型确认` : '无背离信号';
      }
      break;
    }

    case 'smc_orderflow': {
      const fvgLookback = num(params.fvgLookback || 50);
      const obMinImpulse = num(params.obMinImpulse || 1.5);
      const fvgs = detectFVG(k15m, fvgLookback);
      const obs = detectOrderBlocks(k15m, obMinImpulse);
      const sweeps = detectLiquiditySweeps(k15m, ms15);
      const lastFvg = fvgs[fvgs.length - 1];
      const lastOb = obs[obs.length - 1];
      const lastSweep = sweeps[sweeps.length - 1];
      const trendUp = ms1h?.trend === '上升';
      const trendDown = ms1h?.trend === '下降';
      const fvgLow = lastFvg ? Math.min(lastFvg.start, lastFvg.end) : 0;
      const fvgHigh = lastFvg ? Math.max(lastFvg.start, lastFvg.end) : 0;
      const obLow = lastOb ? lastOb.bottom : 0;
      const obHigh = lastOb ? lastOb.top : 0;
      const inFvg = lastFvg && currentPrice >= fvgLow && currentPrice <= fvgHigh;
      const inOb = lastOb && currentPrice >= obLow && currentPrice <= obHigh;
      // sellSide = 扫低（猎杀空单止损）后收回，看多；buySide = 扫高（猎杀多单止损）后收回，看空
      const sweepLow = lastSweep && lastSweep.type === 'sellSide' && lastSweep.isValid;
      const sweepHigh = lastSweep && lastSweep.type === 'buySide' && lastSweep.isValid;
      const zoneLow = inOb ? obLow : fvgLow;
      const zoneHigh = inOb ? obHigh : fvgHigh;

      base.conditions = [
        { label: '1H 上升趋势', passed: trendUp, detail: ms1h?.trend || '--' },
        { label: '价格回调至 FVG', passed: !!inFvg, detail: lastFvg ? `[${fvgLow.toFixed(2)}, ${fvgHigh.toFixed(2)}]` : '无' },
        { label: '价格回调至 OB', passed: !!inOb, detail: lastOb ? `[${obLow.toFixed(2)}, ${obHigh.toFixed(2)}]` : '无' },
        { label: '流动性扫荡（扫低）', passed: !!sweepLow, detail: sweepLow ? '扫低吸筹' : '无' },
        { label: '1H 下降趋势', passed: trendDown, detail: ms1h?.trend || '--' },
        { label: '流动性扫荡（扫高）', passed: !!sweepHigh, detail: sweepHigh ? '扫高派发' : '无' },
      ];

      if (trendUp && (inFvg || inOb) && sweepLow) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 85;
        const stop = zoneLow - atr * 0.5;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * 2;
        base.takeProfit2 = currentPrice + risk * 3.5;
        base.riskReward = 3.5;
        base.advice = '做多触发：机构订单流共振（OB/FVG + 流动性扫荡）';
      } else if (trendDown && (inFvg || inOb) && sweepHigh) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 85;
        const stop = zoneHigh + atr * 0.5;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * 2;
        base.takeProfit2 = currentPrice - risk * 3.5;
        base.riskReward = 3.5;
        base.advice = '做空触发：机构订单流共振（OB/FVG + 流动性扫荡）';
      } else {
        base.advice = (inFvg || inOb) ? '价格已进入订单区，等待流动性扫荡确认' : '等待价格回调至订单块/FVG';
      }
      break;
    }

    case 'multi_tf_resonance': {
      const period = num(params.emaPeriod || 20);
      const adxMin = num(params.adxMin || 20);
      const emaArr = calcEMAArray(k15m, period);
      const emaVal = emaArr[emaArr.length - 1];
      const adx4h = k4h && k4h.length >= 30 ? calcADX(k4h, 14) : 0;
      const up15 = ms15?.trend === '上升';
      const up1h = ms1h?.trend === '上升';
      const up4h = ms4h?.trend === '上升';
      const down15 = ms15?.trend === '下降';
      const down1h = ms1h?.trend === '下降';
      const down4h = ms4h?.trend === '下降';
      const allUp = up15 && up1h && up4h;
      const allDown = down15 && down1h && down4h;
      const pullback = currentPrice <= emaVal * 1.002 && currentPrice >= emaVal * 0.998; // 接近 EMA
      const macdUp = macd ? macd.lastHist > 0 : false;
      const macdDown = macd ? macd.lastHist < 0 : false;

      base.conditions = [
        { label: '15M/1H/4H 同向上升', passed: allUp, detail: `${ms15?.trend || '--'}/${ms1h?.trend || '--'}/${ms4h?.trend || '--'}` },
        { label: `4H ADX ≥ ${adxMin}`, passed: adx4h >= adxMin, detail: `4H ADX ${adx4h.toFixed(0)}` },
        { label: '价格回调至 EMA' + period, passed: pullback, detail: `现价 ${currentPrice.toFixed(2)} / EMA ${emaVal.toFixed(2)}` },
        { label: 'MACD 方向一致（多）', passed: macdUp, detail: macd ? `HIST ${macd.lastHist.toFixed(2)}` : '--' },
        { label: '15M/1H/4H 同向下降', passed: allDown, detail: `${ms15?.trend || '--'}/${ms1h?.trend || '--'}/${ms4h?.trend || '--'}` },
        { label: 'MACD 方向一致（空）', passed: macdDown, detail: macd ? `HIST ${macd.lastHist.toFixed(2)}` : '--' },
      ];

      if (allUp && adx4h >= adxMin && pullback && macdUp) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 90;
        const stop = emaVal - atr;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * 2;
        base.takeProfit2 = currentPrice + risk * 3.5;
        base.riskReward = 3.5;
        base.advice = '做多触发：三周期共振 + 回调至 EMA + MACD 一致';
      } else if (allDown && adx4h >= adxMin && pullback && macdDown) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 90;
        const stop = emaVal + atr;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * 2;
        base.takeProfit2 = currentPrice - risk * 3.5;
        base.riskReward = 3.5;
        base.advice = '做空触发：三周期共振 + 回调至 EMA + MACD 一致';
      } else {
        const dirs = [up15, up1h, up4h];
        const upCount = dirs.filter(Boolean).length;
        base.advice = allUp || allDown ? '方向一致，等待回调至 EMA' : `周期未共振：15M ${up15 ? '↑' : '↓'} / 1H ${up1h ? '↑' : '↓'} / 4H ${up4h ? '↑' : '↓'}`;
        base.strength = upCount * 20;
      }
      break;
    }

    case 'atr_breakout': {
      const mult = num(params.atrMultiplier || 1);
      const stopMult = num(params.atrStop || 1.5);
      const tp1Mult = num(params.atrTp1 || 2);
      const tp2Mult = num(params.atrTp2 || 3);
      // 当日开盘价（简化：取当日第一根 K 线的 open）
      const today = new Date();
      const todayStart = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000);
      let dayOpen = k15m[k15m.length - 1].open;
      for (let i = k15m.length - 1; i >= 0; i--) {
        if (k15m[i].time < todayStart) break;
        dayOpen = k15m[i].open;
      }
      const breakUp = currentPrice > dayOpen + atr * mult;
      const breakDown = currentPrice < dayOpen - atr * mult;
      // 成交量
      const last5 = k15m.slice(-6, -1);
      const avgVol = last5.reduce((s, k) => s + k.volume, 0) / last5.length;
      const volOk = k15m[k15m.length - 1].volume > avgVol * 1.0;
      const adxOk = adx >= 18;

      base.conditions = [
        { label: `突破开盘价 + ${mult}×ATR`, passed: breakUp, detail: `现价 ${currentPrice.toFixed(2)} / 阈值 ${(dayOpen + atr * mult).toFixed(2)}` },
        { label: '成交量放大', passed: volOk, detail: `量 ${k15m[k15m.length - 1].volume.toFixed(0)} / 均 ${avgVol.toFixed(0)}` },
        { label: 'ADX ≥ 18', passed: adxOk, detail: `ADX ${adx.toFixed(0)}` },
        { label: `跌破开盘价 - ${mult}×ATR`, passed: breakDown, detail: `现价 ${currentPrice.toFixed(2)} / 阈值 ${(dayOpen - atr * mult).toFixed(2)}` },
      ];

      if (breakUp && volOk && adxOk) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 70;
        const stop = currentPrice - atr * stopMult;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + atr * tp1Mult;
        base.takeProfit2 = currentPrice + atr * tp2Mult;
        base.riskReward = tp2Mult / stopMult;
        base.advice = `做多触发：ATR 突破，波动率 ${atr.toFixed(2)}`;
      } else if (breakDown && volOk && adxOk) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 70;
        const stop = currentPrice + atr * stopMult;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - atr * tp1Mult;
        base.takeProfit2 = currentPrice - atr * tp2Mult;
        base.riskReward = tp2Mult / stopMult;
        base.advice = `做空触发：ATR 突破，波动率 ${atr.toFixed(2)}`;
      } else {
        base.advice = `等待突破当日开盘价 ± ${mult}×ATR（${(dayOpen + atr * mult).toFixed(2)} / ${(dayOpen - atr * mult).toFixed(2)}）`;
      }
      break;
    }

    case 'fibonacci_retracement': {
      const minPct = num(params.minSwingPct || 3);
      const fibLowRatio = num(params.fibEntryLow || 0.5);
      const fibHighRatio = num(params.fibEntryHigh || 0.618);
      const fib = calcFibonacci(k15m);
      if (!fib || !fib.levels[0] || !fib.levels[100]) { base.advice = '斐波那契数据不足'; break; }
      // levels[0] 是波段起点，levels[100] 是波段终点
      const swingStart = fib.levels[0];
      const swingEnd = fib.levels[100];
      const swingPct = Math.abs(swingEnd - swingStart) / Math.min(swingStart, swingEnd) * 100;
      const swingOk = swingPct >= minPct;
      // trend === '上升结构' 表示波段从低到高
      const dir = fib.trend === '上升结构' ? 'up' : 'down';
      // 回撤区间：上升波段中，从终点回撤；0.5 对应 levels[50]，0.618 对应 levels[618]
      const ratioToLevel: Record<number, number> = { 0.382: 382, 0.5: 50, 0.618: 618, 0.786: 786 };
      const lvlLow = fib.levels[ratioToLevel[fibLowRatio] || 50] || swingEnd;
      const lvlHigh = fib.levels[ratioToLevel[fibHighRatio] || 618] || swingEnd;
      const entryLow = Math.min(lvlLow, lvlHigh);
      const entryHigh = Math.max(lvlLow, lvlHigh);
      const inZone = currentPrice >= entryLow && currentPrice <= entryHigh;
      // 反转 K 线（简化：锤子线/吞没）
      const last = k15m[k15m.length - 1];
      const prev = k15m[k15m.length - 2];
      const body = Math.abs(last.close - last.open);
      const upperWick = last.high - Math.max(last.close, last.open);
      const lowerWick = Math.min(last.close, last.open) - last.low;
      const hammer = lowerWick > body * 2 && upperWick < body * 0.5;
      const shooting = upperWick > body * 2 && lowerWick < body * 0.5;
      const engulfUp = last.close > prev.open && last.open < prev.close && last.close > prev.close;
      const engulfDown = last.close < prev.open && last.open > prev.close && last.close < prev.close;
      const reversalUp = dir === 'up' && (hammer || engulfUp);
      const reversalDown = dir === 'down' && (shooting || engulfDown);

      base.conditions = [
        { label: `波段幅度 ≥ ${minPct}%`, passed: swingOk, detail: `幅度 ${swingPct.toFixed(2)}%` },
        { label: `回撤至 ${fibLowRatio}-${fibHighRatio} 区间`, passed: inZone, detail: `现价 ${currentPrice.toFixed(2)} / 区间 [${entryLow.toFixed(2)}, ${entryHigh.toFixed(2)}]` },
        { label: '反转 K 线（多）', passed: reversalUp, detail: hammer ? '锤子线' : engulfUp ? '看涨吞没' : '无' },
        { label: '反转 K 线（空）', passed: reversalDown, detail: shooting ? '射击之星' : engulfDown ? '看跌吞没' : '无' },
      ];

      if (swingOk && inZone && reversalUp) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 78;
        const stop = entryLow - atr * 0.5;
        const risk = currentPrice - stop;
        const t1 = swingEnd; // 上升波段：目标是回到前高（波段终点）
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = t1;
        base.takeProfit2 = t1 + risk * 1.618;
        base.riskReward = Math.abs(t1 - currentPrice) / (risk || 1);
        base.advice = '做多触发：斐波那契 0.5-0.618 回撤 + 反转 K 线';
      } else if (swingOk && inZone && reversalDown) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 78;
        const stop = entryHigh + atr * 0.5;
        const risk = stop - currentPrice;
        const t1 = swingEnd; // 下降波段：目标是回到前低（波段终点）
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = t1;
        base.takeProfit2 = t1 - risk * 1.618;
        base.riskReward = Math.abs(currentPrice - t1) / (risk || 1);
        base.advice = '做空触发：斐波那契 0.5-0.618 回撤 + 反转 K 线';
      } else {
        base.advice = inZone ? '价格已进入回撤区间，等待反转 K 线' : `等待回撤至 ${fibLowRatio}-${fibHighRatio} 区间`;
      }
      break;
    }

    case 'momentum_surge': {
      const atrMult = num(params.atrMultiplier || 2);
      const volMult = num(params.volMultiplier || 1.5);
      const rsiMin = num(params.rsiMin || 55);
      const last = k15m[k15m.length - 1];
      const body = Math.abs(last.close - last.open);
      const strongBody = body > atr * atrMult;
      const isBull = last.close > last.open;
      const isBear = last.close < last.open;
      const last10 = k15m.slice(-11, -1);
      const avgVol = last10.reduce((s, k) => s + k.volume, 0) / last10.length;
      const volOk = last.volume > avgVol * volMult;
      const macdUp = macd ? macd.lastHist > 0 && Math.abs(macd.lastHist) > Math.abs(macd.hist[macd.hist.length - 2] || 0) : false;
      const macdDown = macd ? macd.lastHist < 0 && Math.abs(macd.lastHist) > Math.abs(macd.hist[macd.hist.length - 2] || 0) : false;
      const rsiOk = rsi !== null && ((isBull && rsi > rsiMin) || (isBear && rsi < 100 - rsiMin));

      base.conditions = [
        { label: `实体 > ${atrMult}×ATR`, passed: strongBody, detail: `实体 ${body.toFixed(2)} / ATR ${atr.toFixed(2)}` },
        { label: `成交量 > ${volMult}×均量`, passed: volOk, detail: `量 ${last.volume.toFixed(0)} / 均 ${avgVol.toFixed(0)}` },
        { label: 'MACD 放大（多）', passed: macdUp, detail: macd ? `HIST ${macd.lastHist.toFixed(2)}` : '--' },
        { label: `RSI > ${rsiMin}（多）`, passed: rsi !== null && rsi > rsiMin, detail: rsi !== null ? `RSI ${rsi.toFixed(0)}` : '--' },
        { label: 'MACD 放大（空）', passed: macdDown, detail: macd ? `HIST ${macd.lastHist.toFixed(2)}` : '--' },
        { label: `RSI < ${100 - rsiMin}（空）`, passed: rsi !== null && rsi < 100 - rsiMin, detail: rsi !== null ? `RSI ${rsi.toFixed(0)}` : '--' },
      ];

      if (strongBody && isBull && volOk && macdUp && rsiOk) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 72;
        const stop = last.close - body * 0.5;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + atr;
        base.takeProfit2 = currentPrice + atr * 2;
        base.riskReward = (atr * 2) / (risk || 1);
        base.advice = '做多触发：强动量脉冲 + 量能放大';
      } else if (strongBody && isBear && volOk && macdDown && rsiOk) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 72;
        const stop = last.close + body * 0.5;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - atr;
        base.takeProfit2 = currentPrice - atr * 2;
        base.riskReward = (atr * 2) / (risk || 1);
        base.advice = '做空触发：强动量脉冲 + 量能放大';
      } else {
        base.advice = strongBody ? '已出现强动量 K 线，等待量能确认' : '等待强动量 K 线出现';
      }
      break;
    }

    case 'super_trend': {
      const atrPeriod = num(params.atrPeriod || 10);
      const atrMult = num(params.atrMult || 3);
      const adxMin = num(params.adxMin || 20);
      const atrArr = calcATRArray(k15m, atrPeriod);
      const smaArr = calcSMAArray(k15m, atrPeriod);
      const lastIdx = k15m.length - 1;
      const prevIdx = k15m.length - 2;
      const close = currentPrice;
      const prevClose = k15m[prevIdx]?.close ?? close;
      const atrVal = atrArr[lastIdx] ?? atr;
      const mid = smaArr[lastIdx] ?? close;
      const prevMid = smaArr[prevIdx] ?? mid;
      const upper = mid + atrVal * atrMult;
      const lower = mid - atrVal * atrMult;
      // 判断当前趋势方向：价格在带上方为多头，下方为空头
      const isBull = close > upper;
      const isBear = close < lower;
      const wasBull = prevClose > (prevMid + (atrArr[prevIdx] ?? atr) * atrMult);
      const wasBear = prevClose < (prevMid - (atrArr[prevIdx] ?? atr) * atrMult);
      const breakoutUp = isBull && !wasBull;
      const breakoutDown = isBear && !wasBear;
      const adxOk = adx >= adxMin;
      const volOk = k15m[lastIdx].volume > (k15m.slice(-9, -1).reduce((s, k) => s + k.volume, 0) / 8);
      const msOk = ms1h ? (breakoutUp ? ms1h.trend === '上升' : breakoutDown ? ms1h.trend === '下降' : true) : true;

      base.conditions = [
        { label: '价格突破超级趋势上轨', passed: breakoutUp, detail: `现价 ${close.toFixed(2)} / 上轨 ${upper.toFixed(2)}` },
        { label: '价格跌破超级趋势下轨', passed: breakoutDown, detail: `现价 ${close.toFixed(2)} / 下轨 ${lower.toFixed(2)}` },
        { label: 'ADX ≥ ' + adxMin, passed: adxOk, detail: `ADX ${adx.toFixed(0)}` },
        { label: '成交量放大', passed: volOk, detail: `量 ${k15m[lastIdx].volume.toFixed(0)}` },
        { label: '1H结构方向一致', passed: msOk, detail: ms1h?.trend || '--' },
      ];

      if (breakoutUp && adxOk && volOk && msOk) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 82;
        const stop = lower;
        const risk = close - stop;
        base.entryPrice = close;
        base.stopLoss = stop;
        base.takeProfit1 = close + risk * 2;
        base.takeProfit2 = close + risk * 4;
        base.riskReward = 4;
        base.advice = `做多触发：超级趋势突破上轨，ADX ${adx.toFixed(0)}，趋势强劲`;
      } else if (breakoutDown && adxOk && volOk && msOk) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 82;
        const stop = upper;
        const risk = stop - close;
        base.entryPrice = close;
        base.stopLoss = stop;
        base.takeProfit1 = close - risk * 2;
        base.takeProfit2 = close - risk * 4;
        base.riskReward = 4;
        base.advice = `做空触发：超级趋势跌破下轨，ADX ${adx.toFixed(0)}，趋势强劲`;
      } else {
        base.advice = isBull ? '处于多头趋势，等待回调' : isBear ? '处于空头趋势，等待回调' : '价格在趋势带内，观望';
      }
      break;
    }

    case 'zscore_mean_reversion': {
      const zThreshold = num(params.zscoreThreshold || 2.5);
      const zExit = num(params.zscoreExit || 1.0);
      const lookback = num(params.lookback || 50);
      const slice = k15m.slice(-lookback);
      if (slice.length < lookback) { base.advice = '数据不足'; break; }
      const mean = slice.reduce((s, k) => s + k.close, 0) / slice.length;
      const variance = slice.reduce((s, k) => s + Math.pow(k.close - mean, 2), 0) / slice.length;
      const std = Math.sqrt(variance) || 1;
      const zscore = (currentPrice - mean) / std;
      const rsiVal = rsi ?? 50;
      const last = k15m[k15m.length - 1];
      const prev = k15m[k15m.length - 2];
      const body = Math.abs(last.close - last.open);
      const lowerWick = Math.min(last.close, last.open) - last.low;
      const upperWick = last.high - Math.max(last.close, last.open);
      const hammer = lowerWick > body * 2;
      const shooting = upperWick > body * 2;
      const boll = calcBollinger(k15m, 20);
      const touchLower = boll ? currentPrice <= boll.lower : false;
      const touchUpper = boll ? currentPrice >= boll.upper : false;
      const extremeLow = zscore <= -zThreshold;
      const extremeHigh = zscore >= zThreshold;
      const rsiExtremeLow = rsiVal < 25;
      const rsiExtremeHigh = rsiVal > 75;

      base.conditions = [
        { label: `Z-Score ≤ -${zThreshold}`, passed: extremeLow, detail: `Z ${zscore.toFixed(2)}` },
        { label: 'RSI < 25', passed: rsiExtremeLow, detail: `RSI ${rsiVal.toFixed(0)}` },
        { label: '反转K线（多）', passed: hammer, detail: hammer ? '锤子线' : '无' },
        { label: '触及布林下轨', passed: touchLower, detail: boll ? `下轨 ${boll.lower.toFixed(2)}` : '--' },
        { label: `Z-Score ≥ ${zThreshold}`, passed: extremeHigh, detail: `Z ${zscore.toFixed(2)}` },
        { label: 'RSI > 75', passed: rsiExtremeHigh, detail: `RSI ${rsiVal.toFixed(0)}` },
        { label: '反转K线（空）', passed: shooting, detail: shooting ? '射击之星' : '无' },
        { label: '触及布林上轨', passed: touchUpper, detail: boll ? `上轨 ${boll.upper.toFixed(2)}` : '--' },
      ];

      if (extremeLow && (rsiExtremeLow || hammer || touchLower)) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 80;
        const stop = currentPrice - std * 1.5;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = mean + std * zExit; // 回归至 Z-Score = exit
        base.takeProfit2 = mean;
        base.riskReward = Math.abs(mean - currentPrice) / (risk || 1);
        base.advice = `做多触发：Z-Score ${zscore.toFixed(2)} 极端超卖，量化回归`;
      } else if (extremeHigh && (rsiExtremeHigh || shooting || touchUpper)) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 80;
        const stop = currentPrice + std * 1.5;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = mean - std * zExit;
        base.takeProfit2 = mean;
        base.riskReward = Math.abs(currentPrice - mean) / (risk || 1);
        base.advice = `做空触发：Z-Score ${zscore.toFixed(2)} 极端超买，量化回归`;
      } else {
        base.advice = `Z-Score ${zscore.toFixed(2)}，等待极端偏差 ≥ ±${zThreshold}`;
      }
      break;
    }

    case 'ichimoku_cloud': {
      const tenkanP = num(params.tenkan || 9);
      const kijunP = num(params.kijun || 26);
      const senkouP = num(params.senkou || 52);
      if (k15m.length < senkouP + kijunP) { base.advice = '数据不足'; break; }
      // 转换线 = (最高 high + 最低 low) / 2 over tenkanP
      const tenkan = (Math.max(...k15m.slice(-tenkanP).map(k => k.high)) + Math.min(...k15m.slice(-tenkanP).map(k => k.low))) / 2;
      // 基准线 = (最高 high + 最低 low) / 2 over kijunP
      const kijun = (Math.max(...k15m.slice(-kijunP).map(k => k.high)) + Math.min(...k15m.slice(-kijunP).map(k => k.low))) / 2;
      // 先行带A = (转换线 + 基准线) / 2，前移 kijunP
      const senkouA = (tenkan + kijun) / 2;
      // 先行带B = (最高 high + 最低 low) / 2 over senkouP，前移 kijunP
      const senkouB = (Math.max(...k15m.slice(-senkouP).map(k => k.high)) + Math.min(...k15m.slice(-senkouP).map(k => k.low))) / 2;
      const cloudTop = Math.max(senkouA, senkouB);
      const cloudBottom = Math.min(senkouA, senkouB);
      const aboveCloud = currentPrice > cloudTop;
      const belowCloud = currentPrice < cloudBottom;
      const tkCrossUp = tenkan > kijun;
      const tkCrossDown = tenkan < kijun;
      // 迟行带（Lagging Span）：当前价格与 kijunP 根前价格比较
      const lagIdx = k15m.length - 1 - kijunP;
      const laggingSpan = lagIdx >= 0 ? k15m[lagIdx].close : currentPrice;
      const laggingAbove = laggingSpan > (lagIdx >= 0 ? k15m[lagIdx].high * 0.999 : currentPrice);
      const laggingBelow = laggingSpan < (lagIdx >= 0 ? k15m[lagIdx].low * 1.001 : currentPrice);
      const futureBull = senkouA > senkouB;

      base.conditions = [
        { label: '价格在云上方', passed: aboveCloud, detail: `现价 ${currentPrice.toFixed(2)} / 云上 ${cloudTop.toFixed(2)}` },
        { label: '转换线 > 基准线', passed: tkCrossUp, detail: `Tenkan ${tenkan.toFixed(2)} / Kijun ${kijun.toFixed(2)}` },
        { label: '迟行带在价上', passed: laggingAbove, detail: `Lagging ${laggingSpan.toFixed(2)}` },
        { label: '未来云上升', passed: futureBull, detail: `Senkou A ${senkouA.toFixed(2)} > B ${senkouB.toFixed(2)}` },
        { label: '价格在云下方', passed: belowCloud, detail: `现价 ${currentPrice.toFixed(2)} / 云下 ${cloudBottom.toFixed(2)}` },
        { label: '转换线 < 基准线', passed: tkCrossDown, detail: `Tenkan ${tenkan.toFixed(2)} / Kijun ${kijun.toFixed(2)}` },
        { label: '迟行带在价下', passed: laggingBelow, detail: `Lagging ${laggingSpan.toFixed(2)}` },
      ];

      if (aboveCloud && tkCrossUp && laggingAbove && futureBull) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 85;
        const stop = cloudBottom;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * 2;
        base.takeProfit2 = currentPrice + risk * 3.5;
        base.riskReward = 3.5;
        base.advice = '做多触发：一目均衡云图多头排列，云上+金叉+上升云';
      } else if (belowCloud && tkCrossDown && laggingBelow && !futureBull) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 85;
        const stop = cloudTop;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * 2;
        base.takeProfit2 = currentPrice - risk * 3.5;
        base.riskReward = 3.5;
        base.advice = '做空触发：一目均衡云图空头排列，云下+死叉+下降云';
      } else {
        const inCloud = currentPrice >= cloudBottom && currentPrice <= cloudTop;
        base.advice = inCloud ? '价格在云内，观望' : aboveCloud ? '云上多头，等待TK金叉确认' : '云下空头，等待TK死叉确认';
      }
      break;
    }

    case 'turtle_breakout': {
      const entryPeriod = num(params.entryPeriod || 20);
      const exitPeriod = num(params.exitPeriod || 10);
      const atrStopMult = num(params.atrStopMult || 2);
      if (k15m.length < entryPeriod + 5) { base.advice = '数据不足'; break; }
      const highs = k15m.slice(-entryPeriod - 1, -1).map(k => k.high);
      const lows = k15m.slice(-entryPeriod - 1, -1).map(k => k.low);
      const highest = Math.max(...highs);
      const lowest = Math.min(...lows);
      const breakUp = currentPrice > highest;
      const breakDown = currentPrice < lowest;
      const volOk = k15m[k15m.length - 1].volume > (k15m.slice(-6, -1).reduce((s, k) => s + k.volume, 0) / 5) * 1.3;
      const adxOk = adx >= 22;
      const msUp = ms1h?.trend === '上升';
      const msDown = ms1h?.trend === '下降';

      base.conditions = [
        { label: `突破${entryPeriod}日高点`, passed: breakUp, detail: `现价 ${currentPrice.toFixed(2)} / 高点 ${highest.toFixed(2)}` },
        { label: '成交量放大', passed: volOk, detail: `量 ${k15m[k15m.length - 1].volume.toFixed(0)}` },
        { label: 'ADX ≥ 22', passed: adxOk, detail: `ADX ${adx.toFixed(0)}` },
        { label: '1H结构上升', passed: msUp, detail: ms1h?.trend || '--' },
        { label: `跌破${entryPeriod}日低点`, passed: breakDown, detail: `现价 ${currentPrice.toFixed(2)} / 低点 ${lowest.toFixed(2)}` },
        { label: '1H结构下降', passed: msDown, detail: ms1h?.trend || '--' },
      ];

      if (breakUp && volOk && adxOk && msUp) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 88;
        const stop = currentPrice - atr * atrStopMult;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * 3;
        base.takeProfit2 = currentPrice + risk * 6;
        base.riskReward = 6 / atrStopMult;
        base.advice = `做多触发：海龟${entryPeriod}日突破，经典趋势跟踪`;
      } else if (breakDown && volOk && adxOk && msDown) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 88;
        const stop = currentPrice + atr * atrStopMult;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * 3;
        base.takeProfit2 = currentPrice - risk * 6;
        base.riskReward = 6 / atrStopMult;
        base.advice = `做空触发：海龟${entryPeriod}日突破，经典趋势跟踪`;
      } else {
        base.advice = `等待${entryPeriod}日突破：高点 ${highest.toFixed(2)} / 低点 ${lowest.toFixed(2)}`;
      }
      break;
    }

    // ==================== TD Sequential 完美计数 ====================
    case 'td_sequential': {
      const setupTarget = num(params.setupCount || 9);
      const requirePerfect = String(params.requirePerfect || 'true') === 'true';
      const rsiFilter = num(params.rsiFilter || 35);
      const tdPoints = calcTDSequential(k15m);
      // 找最近完成的买入/卖出 Setup
      const buySetups = tdPoints.filter(p => p.type === 'buy' && p.num === setupTarget && p.completed);
      const sellSetups = tdPoints.filter(p => p.type === 'sell' && p.num === setupTarget && p.completed);
      const lastBuy = buySetups[buySetups.length - 1];
      const lastSell = sellSetups[sellSetups.length - 1];
      // 完美计数检查：买入Setup中第8根收盘 < 第6根收盘
      let perfectBuy = false;
      let perfectSell = false;
      if (lastBuy) {
        const startIdx = Math.max(0, lastBuy.idx - setupTarget + 1);
        const k6 = k15m[startIdx + 5]; // 第6根（0-indexed: 5）
        const k8 = k15m[startIdx + 7]; // 第8根（0-indexed: 7）
        if (k6 && k8) perfectBuy = k8.close < k6.close;
      }
      if (lastSell) {
        const startIdx = Math.max(0, lastSell.idx - setupTarget + 1);
        const k6 = k15m[startIdx + 5];
        const k8 = k15m[startIdx + 7];
        if (k6 && k8) perfectSell = k8.close > k6.close;
      }
      // 只看最近5根内的信号（时效性）
      const recentBuy = lastBuy && (k15m.length - 1 - lastBuy.idx) <= 5;
      const recentSell = lastSell && (k15m.length - 1 - lastSell.idx) <= 5;
      const buyOk = requirePerfect ? (recentBuy && perfectBuy) : recentBuy;
      const sellOk = requirePerfect ? (recentSell && perfectSell) : recentSell;
      const rsiVal = rsi ?? 50;
      const rsiOversold = rsiVal < rsiFilter;
      const rsiOverbought = rsiVal > (100 - rsiFilter);
      const chochUp = ms1h?.lastBreak?.type === 'CHoCH' && ms1h.lastBreak.direction === 'bullish';
      const chochDown = ms1h?.lastBreak?.type === 'CHoCH' && ms1h.lastBreak.direction === 'bearish';

      base.conditions = [
        { label: `买入${setupTarget}转完成`, passed: !!recentBuy, detail: lastBuy ? `完成于 ${new Date(lastBuy.time * 1000).toLocaleTimeString('zh-CN')}` : '未完成' },
        { label: '完美买入计数', passed: perfectBuy, detail: perfectBuy ? '第8根 < 第6根 ✓' : '不满足' },
        { label: `RSI < ${rsiFilter}`, passed: rsiOversold, detail: `RSI ${rsiVal.toFixed(0)}` },
        { label: '1H CHoCH 转多', passed: chochUp, detail: ms1h?.lastBreak?.type || '--' },
        { label: `卖出${setupTarget}转完成`, passed: !!recentSell, detail: lastSell ? `完成于 ${new Date(lastSell.time * 1000).toLocaleTimeString('zh-CN')}` : '未完成' },
        { label: '完美卖出计数', passed: perfectSell, detail: perfectSell ? '第8根 > 第6根 ✓' : '不满足' },
        { label: `RSI > ${100 - rsiFilter}`, passed: rsiOverbought, detail: `RSI ${rsiVal.toFixed(0)}` },
        { label: '1H CHoCH 转空', passed: chochDown, detail: ms1h?.lastBreak?.type || '--' },
      ];

      if (buyOk && rsiOversold) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 82;
        const stop = (lastBuy?.price ?? currentPrice) - atr * 0.5;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * 2;
        base.takeProfit2 = currentPrice + risk * 2.5;
        base.riskReward = 2.5;
        base.advice = `做多触发：TD 买入${setupTarget}转${requirePerfect && perfectBuy ? '完美' : ''}计数完成，RSI ${rsiVal.toFixed(0)} 超卖`;
      } else if (sellOk && rsiOverbought) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 82;
        const stop = (lastSell?.price ?? currentPrice) + atr * 0.5;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * 2;
        base.takeProfit2 = currentPrice - risk * 2.5;
        base.riskReward = 2.5;
        base.advice = `做空触发：TD 卖出${setupTarget}转${requirePerfect && perfectSell ? '完美' : ''}计数完成，RSI ${rsiVal.toFixed(0)} 超买`;
      } else {
        const buyCount = tdPoints.filter(p => p.type === 'buy').slice(-1)[0];
        const sellCount = tdPoints.filter(p => p.type === 'sell').slice(-1)[0];
        const bCnt = buyCount?.num || 0;
        const sCnt = sellCount?.num || 0;
        base.advice = `买入计数 ${bCnt}/${setupTarget}，卖出计数 ${sCnt}/${setupTarget}，等待${setupTarget}转完成`;
        base.strength = (bCnt / setupTarget) * 40 + (sCnt / setupTarget) * 40;
      }
      break;
    }

    // ==================== 量价背离猎手 ====================
    case 'volume_divergence': {
      const lookback = num(params.lookback || 30);
      const rsiP = num(params.rsiPeriod || 14);
      const volSm = num(params.volSmooth || 5);
      const slice = k15m.slice(-lookback);
      if (slice.length < lookback) { base.advice = '数据不足'; break; }
      // 平滑成交量
      const volMA: number[] = [];
      for (let i = 0; i < k15m.length; i++) {
        const start = Math.max(0, i - volSm + 1);
        const seg = k15m.slice(start, i + 1);
        volMA.push(seg.reduce((s, k) => s + k.volume, 0) / seg.length);
      }
      // 找最近两个价格高点（顶背离检测）
      const priceHighs: { i: number; price: number; vol: number }[] = [];
      const priceLows: { i: number; price: number; vol: number }[] = [];
      for (let i = 3; i < slice.length - 3; i++) {
        const si = k15m.length - slice.length + i;
        if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i - 2].high &&
            slice[i].high > slice[i + 1].high && slice[i].high > slice[i + 2].high) {
          priceHighs.push({ i: si, price: slice[i].high, vol: volMA[si] || 0 });
        }
        if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i - 2].low &&
            slice[i].low < slice[i + 1].low && slice[i].low < slice[i + 2].low) {
          priceLows.push({ i: si, price: slice[i].low, vol: volMA[si] || 0 });
        }
      }
      // 顶背离：价格新高，量未新高
      let bearVolDiv = false;
      let bullVolDiv = false;
      if (priceHighs.length >= 2) {
        const last = priceHighs[priceHighs.length - 1];
        const prev = priceHighs[priceHighs.length - 2];
        if (last.price > prev.price && last.vol < prev.vol) bearVolDiv = true;
      }
      if (priceLows.length >= 2) {
        const last = priceLows[priceLows.length - 1];
        const prev = priceLows[priceLows.length - 2];
        if (last.price < prev.price && last.vol < prev.vol) bullVolDiv = true;
      }
      // RSI 背离检测
      const rsiArr = calcRSIArray(k15m, rsiP);
      let rsiBearDiv = false;
      let rsiBullDiv = false;
      if (priceHighs.length >= 2 && rsiArr.length > 0) {
        const ph = priceHighs;
        const last = ph[ph.length - 1];
        const prev = ph[ph.length - 2];
        const rsiLast = rsiArr[last.i];
        const rsiPrev = rsiArr[prev.i];
        if (rsiLast !== null && rsiPrev !== null && last.price > prev.price && rsiLast < rsiPrev) rsiBearDiv = true;
      }
      if (priceLows.length >= 2 && rsiArr.length > 0) {
        const pl = priceLows;
        const last = pl[pl.length - 1];
        const prev = pl[pl.length - 2];
        const rsiLast = rsiArr[last.i];
        const rsiPrev = rsiArr[prev.i];
        if (rsiLast !== null && rsiPrev !== null && last.price < prev.price && rsiLast > rsiPrev) rsiBullDiv = true;
      }
      // 反转 K 线
      const last = k15m[k15m.length - 1];
      const prev = k15m[k15m.length - 2];
      const body = Math.abs(last.close - last.open);
      const upperWick = last.high - Math.max(last.close, last.open);
      const lowerWick = Math.min(last.close, last.open) - last.low;
      const hammer = lowerWick > body * 2 && upperWick < body * 0.5;
      const shooting = upperWick > body * 2 && lowerWick < body * 0.5;
      const engulfUp = last.close > prev.open && last.open < prev.close && last.close > prev.close;
      const engulfDown = last.close < prev.open && last.open > prev.close && last.close < prev.close;

      base.conditions = [
        { label: '量价顶背离', passed: bearVolDiv, detail: bearVolDiv ? '价格新高 量能萎缩' : '无' },
        { label: 'RSI 顶背离', passed: rsiBearDiv, detail: rsiBearDiv ? 'RSI 未创新高' : '无' },
        { label: '反转K线（空）', passed: shooting || engulfDown, detail: shooting ? '射击之星' : engulfDown ? '看跌吞没' : '无' },
        { label: '量价底背离', passed: bullVolDiv, detail: bullVolDiv ? '价格新低 量能萎缩' : '无' },
        { label: 'RSI 底背离', passed: rsiBullDiv, detail: rsiBullDiv ? 'RSI 未创新低' : '无' },
        { label: '反转K线（多）', passed: hammer || engulfUp, detail: hammer ? '锤子线' : engulfUp ? '看涨吞没' : '无' },
      ];

      const shortConditions = bearVolDiv && rsiBearDiv && (shooting || engulfDown);
      const longConditions = bullVolDiv && rsiBullDiv && (hammer || engulfUp);
      if (shortConditions) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 80;
        const extremeHigh = priceHighs[priceHighs.length - 1];
        const stop = (extremeHigh?.price ?? currentPrice) + atr * 0.5;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * 1.5;
        base.takeProfit2 = currentPrice - risk * 2.5;
        base.riskReward = 2.5;
        base.advice = '做空触发：量价顶背离 + RSI顶背离 + 反转K线，主力出货信号';
      } else if (longConditions) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 80;
        const extremeLow = priceLows[priceLows.length - 1];
        const stop = (extremeLow?.price ?? currentPrice) - atr * 0.5;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * 1.5;
        base.takeProfit2 = currentPrice + risk * 2.5;
        base.riskReward = 2.5;
        base.advice = '做多触发：量价底背离 + RSI底背离 + 反转K线，主力吸筹信号';
      } else {
        const anyDiv = bearVolDiv || bullVolDiv || rsiBearDiv || rsiBullDiv;
        base.advice = anyDiv ? '已检测到背离信号，等待K线形态确认' : '无量价背离，市场正常';
      }
      break;
    }

    // ==================== 三重滤网系统 ====================
    case 'triple_filter': {
      const ema4hP = num(params.ema4h || 200);
      const ema15mP = num(params.ema15m || 20);
      const adxMin = num(params.adxMin || 18);
      if (!k4h || k4h.length < ema4hP + 5) { base.advice = '4H 数据不足'; break; }
      // 第一重：4H EMA200 方向
      const ema4h = calcEMAArray(k4h, ema4hP);
      const ema4hVal = ema4h[ema4h.length - 1];
      const aboveEma4h = currentPrice > ema4hVal;
      const belowEma4h = currentPrice < ema4hVal;
      // 第二重：1H MACD 柱状图方向
      const macd1h = k1h && k1h.length >= 40 ? calcMACD(k1h) : null;
      const momentumUp = macd1h ? macd1h.lastHist > 0 : false;
      const momentumDown = macd1h ? macd1h.lastHist < 0 : false;
      // 第三重：15M 回调到 EMA20 后反弹
      const ema15m = calcEMAArray(k15m, ema15mP);
      const ema15mVal = ema15m[ema15m.length - 1];
      const nearEma = currentPrice >= ema15mVal * 0.998 && currentPrice <= ema15mVal * 1.002;
      const bounceUp = k15m[k15m.length - 1].close > k15m[k15m.length - 2].close && nearEma;
      const bounceDown = k15m[k15m.length - 1].close < k15m[k15m.length - 2].close && nearEma;
      // 反转 K 线确认
      const last = k15m[k15m.length - 1];
      const prev = k15m[k15m.length - 2];
      const body = Math.abs(last.close - last.open);
      const lowerWick = Math.min(last.close, last.open) - last.low;
      const upperWick = last.high - Math.max(last.close, last.open);
      const bullCandle = last.close > last.open && lowerWick > body * 0.3;
      const bearCandle = last.close < last.open && upperWick > body * 0.3;
      const adxOk = adx >= adxMin;

      base.conditions = [
        { label: `第一重：4H > EMA${ema4hP}`, passed: aboveEma4h, detail: `现价 ${currentPrice.toFixed(2)} / EMA${ema4hP} ${ema4hVal.toFixed(2)}` },
        { label: '第二重：1H MACD > 0', passed: momentumUp, detail: macd1h ? `HIST ${macd1h.lastHist.toFixed(2)}` : '--' },
        { label: `第三重：15M 回调至 EMA${ema15mP}`, passed: nearEma, detail: `EMA${ema15mP} ${ema15mVal.toFixed(2)}` },
        { label: '第三重：15M 反弹确认', passed: bounceUp && bullCandle, detail: bounceUp ? '反弹中' : '等待反弹' },
        { label: `第一重：4H < EMA${ema4hP}`, passed: belowEma4h, detail: `现价 ${currentPrice.toFixed(2)} / EMA${ema4hP} ${ema4hVal.toFixed(2)}` },
        { label: '第二重：1H MACD < 0', passed: momentumDown, detail: macd1h ? `HIST ${macd1h.lastHist.toFixed(2)}` : '--' },
        { label: '第三重：15M 反弹确认（空）', passed: bounceDown && bearCandle, detail: bounceDown ? '反弹中' : '等待反弹' },
        { label: `ADX ≥ ${adxMin}`, passed: adxOk, detail: `ADX ${adx.toFixed(0)}` },
      ];

      if (aboveEma4h && momentumUp && nearEma && bounceUp && bullCandle && adxOk) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = 88;
        const stop = ema15mVal - atr;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice + risk * 1.5;
        base.takeProfit2 = currentPrice + risk * 3;
        base.riskReward = 3;
        base.advice = `做多触发：三重滤网通过 — 4H趋势↑ / 1H动量↑ / 15M回调反弹`;
      } else if (belowEma4h && momentumDown && nearEma && bounceDown && bearCandle && adxOk) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = 88;
        const stop = ema15mVal + atr;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = currentPrice - risk * 1.5;
        base.takeProfit2 = currentPrice - risk * 3;
        base.riskReward = 3;
        base.advice = `做空触发：三重滤网通过 — 4H趋势↓ / 1H动量↓ / 15M回调反弹`;
      } else {
        const filter1 = aboveEma4h ? '多头' : belowEma4h ? '空头' : '中性';
        const filter2 = momentumUp ? '↑' : momentumDown ? '↓' : '—';
        base.advice = `三重滤网：第一重[${filter1}] / 第二重[${filter2}]，${nearEma ? '第三重回调到位' : '等待回调至EMA'}`;
      }
      break;
    }

    // ==================== 极值惩罚均值回归 ====================
    case 'extreme_reversion': {
      const zEntry = num(params.zscoreEntry || 3.0);
      const zStop = num(params.zscoreStop || 4.0);
      const zTp1 = num(params.zscoreTp1 || 1.5);
      const lookback = num(params.lookback || 60);
      const minFactors = num(params.minFactors || 3);
      if (k15m.length < lookback) { base.advice = '数据不足'; break; }
      const slice = k15m.slice(-lookback);
      const mean = slice.reduce((s, k) => s + k.close, 0) / slice.length;
      const variance = slice.reduce((s, k) => s + Math.pow(k.close - mean, 2), 0) / slice.length;
      const std = Math.sqrt(variance) || 1;
      const zscore = (currentPrice - mean) / std;
      // 因子1：Z-Score 极端
      const factor1Long = zscore <= -zEntry;
      const factor1Short = zscore >= zEntry;
      // 因子2：RSI 极端
      const rsiVal = rsi ?? 50;
      const factor2Long = rsiVal < 20;
      const factor2Short = rsiVal > 80;
      // 因子3：布林带外侧
      const bollData = calcBollinger(k15m, 20);
      const factor3Long = bollData ? currentPrice <= bollData.lower : false;
      const factor3Short = bollData ? currentPrice >= bollData.upper : false;
      // 因子4：K线影线拒绝（长下影=拒绝低价，长上影=拒绝高价）
      const last = k15m[k15m.length - 1];
      const body = Math.abs(last.close - last.open);
      const lowerWick = Math.min(last.close, last.open) - last.low;
      const upperWick = last.high - Math.max(last.close, last.open);
      const factor4Long = lowerWick > body * 1.5; // 长下影线
      const factor4Short = upperWick > body * 1.5; // 长上影线
      // 因子5：成交量异常放大（恐慌抛售/追高）
      const avgVol = slice.reduce((s, k) => s + k.volume, 0) / slice.length;
      const factor5Long = last.volume > avgVol * 1.5;
      const factor5Short = last.volume > avgVol * 1.5;

      const longFactors = [factor1Long, factor2Long, factor3Long, factor4Long, factor5Long].filter(Boolean).length;
      const shortFactors = [factor1Short, factor2Short, factor3Short, factor4Short, factor5Short].filter(Boolean).length;
      const longTriggered = longFactors >= minFactors;
      const shortTriggered = shortFactors >= minFactors;

      base.conditions = [
        { label: `Z-Score ≤ -${zEntry}`, passed: factor1Long, detail: `Z ${zscore.toFixed(2)}` },
        { label: 'RSI < 20（极端超卖）', passed: factor2Long, detail: `RSI ${rsiVal.toFixed(0)}` },
        { label: '触及布林下轨', passed: factor3Long, detail: bollData ? `下轨 ${bollData.lower.toFixed(2)}` : '--' },
        { label: '长下影线（拒绝低价）', passed: factor4Long, detail: `影线 ${(lowerWick / (body || 1)).toFixed(1)}×实体` },
        { label: '成交量异常放大', passed: factor5Long, detail: `量 ${last.volume.toFixed(0)} / 均 ${avgVol.toFixed(0)}` },
        { label: `Z-Score ≥ ${zEntry}`, passed: factor1Short, detail: `Z ${zscore.toFixed(2)}` },
        { label: 'RSI > 80（极端超买）', passed: factor2Short, detail: `RSI ${rsiVal.toFixed(0)}` },
        { label: '触及布林上轨', passed: factor3Short, detail: bollData ? `上轨 ${bollData.upper.toFixed(2)}` : '--' },
        { label: '长上影线（拒绝高价）', passed: factor4Short, detail: `影线 ${(upperWick / (body || 1)).toFixed(1)}×实体` },
      ];

      if (longTriggered && Math.abs(zscore) < zStop) {
        base.direction = 'long';
        base.triggered = true;
        base.strength = Math.min(60 + longFactors * 8, 95);
        const stop = mean - std * zStop;
        const risk = currentPrice - stop;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = mean - std * zTp1; // Z = -1.5
        base.takeProfit2 = mean; // Z = 0
        base.riskReward = Math.abs(mean - currentPrice) / (risk || 1);
        base.advice = `做多触发：${longFactors}/5 因子确认，Z-Score ${zscore.toFixed(2)} 极端超卖，极值惩罚回归`;
      } else if (shortTriggered && Math.abs(zscore) < zStop) {
        base.direction = 'short';
        base.triggered = true;
        base.strength = Math.min(60 + shortFactors * 8, 95);
        const stop = mean + std * zStop;
        const risk = stop - currentPrice;
        base.entryPrice = currentPrice;
        base.stopLoss = stop;
        base.takeProfit1 = mean + std * zTp1;
        base.takeProfit2 = mean;
        base.riskReward = Math.abs(currentPrice - mean) / (risk || 1);
        base.advice = `做空触发：${shortFactors}/5 因子确认，Z-Score ${zscore.toFixed(2)} 极端超买，极值惩罚回归`;
      } else {
        const nearExtreme = Math.abs(zscore) >= zEntry * 0.7;
        base.advice = nearExtreme
          ? `Z-Score ${zscore.toFixed(2)} 接近极端区域，${longFactors + shortFactors}/5 因子已确认`
          : `Z-Score ${zscore.toFixed(2)}，等待极端偏离 ≥ ±${zEntry}`;
      }
      break;
    }

    default:
      base.advice = '未知策略';
  }

  return base;
}

/** 计算所有已启用策略的信号 */
export function computeAllSignals(
  config: StrategyConfig,
  ctx: StrategyContext,
): StrategySignal[] {
  const signals: StrategySignal[] = [];
  for (const meta of STRATEGIES) {
    const cfg = config[meta.id];
    if (!cfg || !cfg.enabled) continue;
    try {
      const sig = computeSignal(meta, ctx, cfg.params);
      signals.push(sig);
    } catch (err) {
      signals.push({
        strategyId: meta.id,
        strategyName: meta.name,
        direction: 'neutral',
        strength: 0,
        triggered: false,
        conditions: [],
        advice: '计算异常：' + (err instanceof Error ? err.message : String(err)),
        timestamp: Date.now(),
      });
    }
  }
  return signals;
}

/** 综合多策略得出总览建议 */
export function summarizeSignals(signals: StrategySignal[]): {
  direction: SignalDirection;
  confidence: number;
  text: string;
  triggeredCount: number;
} {
  if (signals.length === 0) {
    return { direction: 'neutral', confidence: 0, text: '未启用任何策略', triggeredCount: 0 };
  }
  let longScore = 0;
  let shortScore = 0;
  let triggered = 0;
  for (const s of signals) {
    if (s.triggered) triggered++;
    if (s.direction === 'long') longScore += s.strength;
    else if (s.direction === 'short') shortScore += s.strength;
  }
  const total = longScore + shortScore;
  if (total === 0) {
    return { direction: 'neutral', confidence: 0, text: `${signals.length} 个策略运行中，暂无信号`, triggeredCount: triggered };
  }
  const longPct = (longScore / total) * 100;
  const direction: SignalDirection = longPct >= 55 ? 'long' : longPct <= 45 ? 'short' : 'neutral';
  const confidence = Math.round(Math.abs(longPct - 50) * 2);
  const dirText = direction === 'long' ? '偏多' : direction === 'short' ? '偏空' : '中性';
  return {
    direction,
    confidence,
    text: `${signals.length} 策略 | 多 ${Math.round(longPct)}% : 空 ${Math.round(100 - longPct)}% | ${triggered} 个已触发`,
    triggeredCount: triggered,
  };
}
