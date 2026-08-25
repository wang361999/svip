/**
 * AI 行情分析核心模块
 *
 * 设计原则：
 * 1. 兼容 OpenAI Chat Completions API 格式（支持 OpenAI / DeepSeek / Qwen / Moonshot 等）
 * 2. 将 K线数据 + 技术指标 转化为结构化 prompt 喂给 AI
 * 3. 要求 AI 返回严格 JSON 格式的分析结果，方便程序解析
 * 4. 支持后台动态切换模型供应商和参数
 *
 * 数据流：
 *   K线（多周期） + 当前价格 + 技术指标 → 构建 prompt → 调用 AI API → 解析 JSON → 结构化分析结果
 */

import { fetchKlines, fetchPrice, type KlineData } from './market-data';
import { fetchMarketContext, buildMarketContextText, fetchBtcSnapshot, buildBtcContextText } from './market-context';
import { evaluatePendingPredictions, getRecentFeedbackText } from './ai-feedback';
import {
  calcMACD,
  calcRSI,
  calcBollinger,
  calcATR,
  calcADX,
  calcSMAArray,
  calcEMAArray,
} from './indicators';

// ==================== 供应商定义 ====================

export interface AiProviderMeta {
  id: string;
  label: string;
  defaultApiUrl: string;
  defaultModel: string;
  models: string[];
  docUrl: string;
  supportsJsonMode: boolean; // 是否支持 response_format: json_object
}

/** 预置 AI 供应商列表（均兼容 OpenAI Chat Completions 格式） */
export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultApiUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    docUrl: 'https://platform.openai.com/docs/models',
    supportsJsonMode: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultApiUrl: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    docUrl: 'https://platform.deepseek.com/docs',
    supportsJsonMode: true,
  },
  {
    id: 'qwen',
    label: '通义千问 (Qwen)',
    defaultApiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    docUrl: 'https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope',
    supportsJsonMode: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    defaultApiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    docUrl: 'https://platform.moonshot.cn/docs',
    supportsJsonMode: true,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA GLM-5.2 (智谱)',
    defaultApiUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    defaultModel: 'z-ai/glm-5.2',
    models: ['z-ai/glm-5.2'],
    docUrl: 'https://build.nvidia.com',
    supportsJsonMode: true,
  },
  {
    id: 'custom',
    label: '自定义 (Custom / Agnes-AI)',
    defaultApiUrl: '',
    defaultModel: '',
    models: [],
    docUrl: '',
    supportsJsonMode: true,
  },
];

/** 根据 provider id 获取供应商元数据 */
export function getProviderMeta(providerId: string): AiProviderMeta | undefined {
  return AI_PROVIDERS.find((p) => p.id === providerId);
}

/**
 * 供应商级别预配置（仅地址与模型，不含密钥）
 * API Key 只存数据库（后台设置），严禁写入源码 — 仓库是公开的
 * 当数据库中的 aiApiUrl / aiModel 为空时回退到这里
 */
const PROVIDER_DEFAULTS: Record<string, { apiUrl: string; model: string }> = {
  custom: {
    apiUrl: 'https://api.agnes-ai.cn/v1/chat/completions',
    model: 'agnes-2.5-flash',
  },
  nvidia: {
    apiUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'z-ai/glm-5.2',
  },
};

// ==================== 类型定义 ====================

export interface AiConfig {
  enabled: boolean;
  provider: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  analysisInterval: number;
  autoTrade: boolean;
  supportsJsonMode: boolean; // 是否支持 response_format: json_object
}

export interface AiAnalysisResult {
  direction: 'long' | 'short' | 'neutral';
  confidence: number; // 0-100
  summary: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  reasoning: string;
  keyLevels: { price: number; type: string; note: string }[] | null;
  riskWarning: string | null;
  provider: string;
  model: string;
  rawResponse: string;
  /** 结构化元数据：市场状态 / A+清单 / 15m ATR / 证据表 / 双计划 / 不做区（供引擎闸门与前端展示） */
  meta: {
    /** AI 判定的市场状态：trending 趋势 / range 区间 / chop 碎波 / event 事件驱动 */
    regime: 'trending' | 'range' | 'chop' | 'event';
    /** A+ 清单：五项全 true 才是最高质量的交易机会 */
    aPlusChecklist: {
      regimeClear: boolean;      // 市场状态明确，有可执行的剧本
      timeframeAligned: boolean; // 多周期方向共振
      fundingNotExtreme: boolean;// 资金费率不极端（无拥挤反转风险）
      volumeConfirmed: boolean;  // 有量能配合
      nearInvalidation: boolean; // 入场贴近无效点（止损近、盈亏比好）
    };
    /** 15m ATR（引擎校验止损距离用） */
    atr15m: number | null;
    /** 多维证据表：每条证据带具体数值与多空倾向（大神分析框架核心） */
    evidence?: { dimension: string; data: string; signal: 'bullish' | 'bearish' | 'neutral'; note: string }[];
    /** 双交易计划：A=推荐主计划（顶层价位字段与其一致），B=激进备选（逆势/小仓） */
    plans?: {
      name: string; style: string; recommended: boolean;
      entry: number | null; stopLoss: number | null;
      takeProfit1: number | null; takeProfit2: number | null;
      rr1: number | null; rr2: number | null; condition: string;
    }[];
    /** 不做区：盈亏比最差、应观望的价格区间 */
    noTradeZone?: { from: number; to: number; reason: string } | null;
  };
}

// ==================== 配置读取 ====================

/** 从 SiteSetting 读取 AI 配置（含供应商级别凭证回退） */
export function parseAiConfig(settings: Record<string, string | null | undefined>): AiConfig {
  const providerId = settings.aiProvider || 'custom';
  const meta = getProviderMeta(providerId);
  const defaults = PROVIDER_DEFAULTS[providerId];

  return {
    enabled: settings.aiEnabled === 'true',
    provider: providerId,
    apiUrl: settings.aiApiUrl || defaults?.apiUrl || meta?.defaultApiUrl || '',
    apiKey: settings.aiApiKey || '', // 密钥只来自数据库，不回落到源码
    model: settings.aiModel || defaults?.model || meta?.defaultModel || '',
    temperature: parseFloat(settings.aiTemperature || '0.3') || 0.3,
    maxTokens: parseInt(settings.aiMaxTokens || '4000', 10) || 4000,
    analysisInterval: parseInt(settings.aiAnalysisInterval || '30', 10) || 30,
    autoTrade: settings.aiAutoTrade === 'true',
    supportsJsonMode: meta?.supportsJsonMode ?? true,
  };
}

// ==================== 技术指标摘要 ====================

interface IndicatorSnapshot {
  rsi: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  bollinger: { upper: number; middle: number; lower: number } | null;
  atr: number | null;
  adx: number | null;
  ma50: number | null;
  ma200: number | null;
  ema20: number | null;
}

/** 计算多周期技术指标摘要 */
function computeIndicatorSnapshot(klines: KlineData[]): IndicatorSnapshot {
  if (klines.length < 30) {
    return {
      rsi: null, macd: null, bollinger: null, atr: null,
      adx: null, ma50: null, ma200: null, ema20: null,
    };
  }

  const last = klines.length - 1;

  const rsi = calcRSI(klines, 14);
  const macdData = calcMACD(klines, 12, 26, 9);
  const boll = calcBollinger(klines, 20);
  const atr = calcATR(klines, 14);
  const adx = calcADX(klines, 14);
  const ma50Arr = calcSMAArray(klines, 50);
  const ma200Arr = calcSMAArray(klines, 200);
  const ema20Arr = calcEMAArray(klines, 20);

  return {
    rsi: rsi,
    macd: macdData ? { macd: macdData.lastDif, signal: macdData.lastDea, histogram: macdData.lastHist } : null,
    bollinger: boll ? { upper: boll.upper, middle: boll.middle, lower: boll.lower } : null,
    atr: atr,
    adx: adx,
    ma50: ma50Arr[last] as number | null,
    ma200: ma200Arr[last] as number | null,
    ema20: ema20Arr[last] ?? null,
  };
}

// ==================== Prompt 构建 ====================

/** 检测摆动高低点（枢轴点：左右各2根K线更低→摆动高点；更高→摆动低点） */
function detectSwings(klines: KlineData[], lookback = 20, radius = 2): { type: 'H' | 'L'; price: number }[] {
  const seg = klines.slice(-lookback);
  const swings: { type: 'H' | 'L'; price: number }[] = [];
  for (let i = radius; i < seg.length - radius; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j === i) continue;
      if (seg[j].high >= seg[i].high) isHigh = false;
      if (seg[j].low <= seg[i].low) isLow = false;
    }
    if (isHigh) swings.push({ type: 'H', price: seg[i].high });
    if (isLow) swings.push({ type: 'L', price: seg[i].low });
  }
  return swings;
}

/** 根据摆动点序列判断市场结构（HH/HL=上升，LH/LL=下降，否则震荡） */
function classifyStructure(swings: { type: 'H' | 'L'; price: number }[]): string {
  const highs = swings.filter((s) => s.type === 'H');
  const lows = swings.filter((s) => s.type === 'L');
  if (highs.length < 2 || lows.length < 2) return '结构不明（摆动点不足）';
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  if (hh && hl) return '上升结构(HH+HL)';
  if (!hh && !hl) return '下降结构(LH+LL)';
  return '震荡结构(高低点方向分歧)';
}

/** 构建 K 线摘要文本（避免传太多数据消耗 token） */
function buildKlineSummary(klines: KlineData[], label: string): string {
  if (klines.length === 0) return `${label}: 无数据`;

  const last = klines[klines.length - 1];
  const prev = klines.length > 1 ? klines[klines.length - 2] : last;
  const recent20 = klines.slice(-20);

  // 最近 20 根 K 线的简化摘要
  const recentCloses = recent20.map((k) => k.close);
  const high20 = Math.max(...recent20.map((k) => k.high));
  const low20 = Math.min(...recent20.map((k) => k.low));
  const avgVol = recent20.reduce((s, k) => s + k.volume, 0) / recent20.length;

  // 计算涨跌幅
  const changePct = prev.close > 0 ? ((last.close - prev.close) / prev.close * 100) : 0;

  // 市场结构：摆动高低点序列 + 趋势形态判断
  const swings = detectSwings(recent20);
  const structure = classifyStructure(swings);
  const swingText = swings.length > 0
    ? swings.slice(-4).map((s) => `${s.type}=${s.price}`).join(' → ')
    : '无';

  // 量能：最新一根相对均量的放大/萎缩（判断突破是否有量能配合）
  const volRatio = avgVol > 0 ? last.volume / avgVol : 0;
  const volStatus = volRatio >= 1.5 ? '显著放量' : volRatio >= 1.1 ? '温和放量' : volRatio <= 0.6 ? '明显缩量' : '量能持平';

  return `${label}:
  最新K线: O=${last.open} H=${last.high} L=${last.low} C=${last.close} V=${last.volume.toFixed(2)}
  涨跌幅: ${changePct.toFixed(2)}%
  近20根最高: ${high20}, 最低: ${low20}
  近20根均价: ${(recentCloses.reduce((s, c) => s + c, 0) / recentCloses.length).toFixed(2)}
  近20根均量: ${avgVol.toFixed(2)}
  市场结构: ${structure} | 摆动点(旧→新): ${swingText}
  量能对比: 最新量为均量的 ${volRatio.toFixed(2)} 倍 (${volStatus})`;
}

/** 构建技术指标摘要 */
function buildIndicatorText(ind: IndicatorSnapshot, currentPrice: number): string {
  const lines: string[] = [];

  if (ind.rsi !== null) {
    const rsiStatus = ind.rsi > 70 ? '超买' : ind.rsi < 30 ? '超卖' : '中性';
    lines.push(`RSI(14): ${ind.rsi.toFixed(2)} (${rsiStatus})`);
  }
  if (ind.macd) {
    const cross = ind.macd.histogram > 0 ? '多头排列' : '空头排列';
    lines.push(`MACD: DIF=${ind.macd.macd.toFixed(4)} DEA=${ind.macd.signal.toFixed(4)} 柱=${ind.macd.histogram.toFixed(4)} (${cross})`);
  }
  if (ind.bollinger) {
    const bollPos = currentPrice > ind.bollinger.upper ? '上轨上方'
      : currentPrice < ind.bollinger.lower ? '下轨下方'
      : '带内';
    lines.push(`布林带(20,2): 上=${ind.bollinger.upper.toFixed(2)} 中=${ind.bollinger.middle.toFixed(2)} 下=${ind.bollinger.lower.toFixed(2)} (${bollPos})`);
  }
  if (ind.atr !== null) {
    lines.push(`ATR(14): ${ind.atr.toFixed(2)} (波动率: ${(ind.atr / currentPrice * 100).toFixed(2)}%)`);
  }
  if (ind.adx !== null) {
    const trend = ind.adx > 25 ? '强趋势' : ind.adx > 20 ? '弱趋势' : '无趋势';
    lines.push(`ADX(14): ${ind.adx.toFixed(2)} (${trend})`);
  }
  if (ind.ma50 !== null) {
    lines.push(`MA50: ${ind.ma50.toFixed(2)} ${currentPrice > ind.ma50 ? '价格在上方(多头)' : '价格在下方(空头)'}`);
  }
  if (ind.ma200 !== null) {
    lines.push(`MA200: ${ind.ma200.toFixed(2)} ${currentPrice > ind.ma200 ? '价格在上方(多头)' : '价格在下方(空头)'}`);
  }
  if (ind.ema20 !== null) {
    lines.push(`EMA20: ${ind.ema20.toFixed(2)} ${currentPrice > ind.ema20 ? '价格在上方(多头)' : '价格在下方(空头)'}`);
  }

  return lines.length > 0 ? lines.join('\n') : '指标数据不足';
}

/** 构建系统 prompt */
const SYSTEM_PROMPT = `你是一位顶级加密货币短线合约交易员，交易风格为短线波段（持仓数十分钟到数小时）。你的盈利哲学：方向预测只是入场券，真正的钱来自「什么时候不做、错了亏多少、对了赚多少」。

分析必须按以下顺序进行：

第一步：判定市场状态（regime）— 最重要的判断，先于方向
- trending 趋势日：ADX >= 20 且均线排列清晰。剧本：只做趋势方向的突破与回踩，绝不逆势抄底摸顶
- range 区间日：高低点在明确区间内反复，ADX 15-25。剧本：只在区间边缘做反转（近支撑做多/近阻力做空），区间中部不开仓
- chop 碎波日：均线纠缠、假突破频繁、ADX < 15 或方向反复。剧本：强制观望，必须给 neutral — 短线最大的亏损来源就是在碎波日反复扫损
- event 事件日：近3小时有重大新闻（黑客/监管/大额清算/宏观数据）且行情剧烈。剧本：等事件影响消化后再进场，方向不明时给 neutral 并在 riskWarning 说明

第二步：BTC 联动校验（分析山寨币时必做）
- BTC 高波动时段（1小时涨跌绝对值 >= 2%），山寨币自身技术信号可靠性大幅下降，置信度应显著下调或直接 neutral
- 与 BTC 趋势同向的山寨信号更可靠；BTC 急跌时的山寨做多信号多为假信号

第三步：无效点思维定止损
- 先回答「价格到哪里，我的逻辑就死了？」止损必须放在该无效点（摆动点/前高低/区间边缘）之外侧
- 止损距离应贴近 15m ATR 的 0.5-1.5 倍（数据会提供 ATR 值）；离无效点太远 = 盈亏比差 = 放弃
- 若找不到近端有效止损位，说明行情不适合短线，给 neutral

第四步：时段与结算意识
- 亚盘流动性差假突破多、美盘波动最剧烈；资金费率结算（UTC 0/8/16 点）前 30 分钟常有异动，追高追低需谨慎
- 数据会提供当前时段与距下次结算的分钟数

第五步：吸收你的历史战绩（真实复盘数据）
- 数据会提供你近期预测的真实结果（触止损/触止盈/方向对错）
- 若近期被扫损比例高：检查止损是否太近、是否把碎波误判成趋势，主动收紧 regime 判定
- 若近期方向错误率高：信号矛盾时优先 neutral，不要强行选边
- 连胜时不放宽标准；这不是让你机械跟随战绩，而是从错误模式中修正判断框架

第六步：证据表 + 双计划 + 不做区（大神输出框架）
- evidence 证据表 6-8 条，每条必须带具体数值（如「RSI 80.4 极端超买」），禁止空泛描述；dimension 覆盖：趋势/动量（多周期 RSI/MACD）、量能（持仓量24h变化/成交量）、情绪（资金费率/多空比/恐贪）、结构（价格与枢轴/布林位置、K线形态）、BTC联动、消息面；signal 标 bullish/bearish/neutral
- 多空矛盾是常态（日线多头 + 15m 动能衰竭 = 回调中继），证据表如实呈现，不要为了统一而扭曲
- plans 双计划：Plan A = 推荐（顺势或高把握，recommended=true，顶层 entryPrice/stopLoss/takeProfit1/takeProfit2 必须与 Plan A 一致）；Plan B = 激进备选（逆势/抢反弹，recommended=false，condition 里注明仓位减半）
- 每个计划给 rr1/rr2（R 倍数，1位小数）；condition 写清进场前提（如「15m出现看涨吞没后进场」「反弹至2490滞涨」）
- noTradeZone：明确标注当前盈亏比最差、应观望的价格区间（通常夹在现价与关键位中间的无人区）及原因；无明确不做区给 null

summary 必须结论先行，格式：短线方向 + 目标区间 + 当前最优动作。
示例："短线看多至 2533，日线趋势多头；最优动作 = 2478 限价多，不追现价"

风控铁律：
1. 单笔风险不超过 2%；止盈第一目标 1.5R-2R，第二目标 3R
2. 震荡/碎波市宁可观望也要给 neutral；不交易也是一种交易
3. 置信度 0-100 反映真实把握：五项 A+ 清单全中才能给 80+；缺任何一项都应下调
4. 衍生品数据是关键领先指标：资金费率极端正=多头拥挤（追多谨慎）；突破伴随持仓量增加=可信，缩量突破=疑似陷阱；重大新闻权重高于技术形态
5. 多空比是反向指标：散户多头账户极度拥挤（>2）时追多大概率被收割，散户空头极度拥挤（<0.5）时追空同理；主动买卖比反映真实资金方向，比账户比更即时

你必须以严格的 JSON 格式返回，不要包含任何其他文字。JSON 格式如下：
{
  "regime": "trending" | "range" | "chop" | "event",
  "direction": "long" | "short" | "neutral",
  "confidence": 数字(0-100),
  "summary": "一句话总结：市场状态 + 核心逻辑 + 方向",
  "entryPrice": 数字或null,
  "stopLoss": 数字或null,
  "takeProfit1": 数字或null,
  "takeProfit2": 数字或null,
  "reasoning": "详细分析：regime判定依据 → 多周期结构 → BTC联动 → 衍生品/量能 → 无效点与盈亏比",
  "keyLevels": [{"price": 数字, "type": "支撑/阻力/前高/前低", "note": "说明"}],
  "evidence": [
    {"dimension": "日线RSI", "data": "80.4 极端超买", "signal": "bearish", "note": "回调压力"},
    {"dimension": "持仓量24h", "data": "-2.2% 价涨仓减", "signal": "bearish", "note": "获利了结迹象"}
  ],
  "plans": [
    {"name": "A", "style": "顺势回调接多", "recommended": true, "entry": 2479, "stopLoss": 2462, "takeProfit1": 2505, "takeProfit2": 2533, "rr1": 1.5, "rr2": 3.2, "condition": "15m出现止跌形态（看涨吞没/长下影）后进场"},
    {"name": "B", "style": "激进逆势短空", "recommended": false, "entry": 2490, "stopLoss": 2512, "takeProfit1": 2478, "takeProfit2": 2464, "rr1": 0.5, "rr2": 1.2, "condition": "反弹至2490-2495滞涨，仓位减半"}
  ],
  "noTradeZone": {"from": 2486, "to": 2505, "reason": "现价与失效区之间的无人区，上下空间不足，盈亏比最差"} 或 null,
  "riskWarning": "当前市场风险提示",
  "checklist": {
    "regimeClear": 布尔,
    "timeframeAligned": 布尔,
    "fundingNotExtreme": 布尔,
    "volumeConfirmed": 布尔,
    "nearInvalidation": 布尔
  }
}

checklist 各项含义（诚实自评，五项全 true 才配得上 80+ 置信度）：
- regimeClear: 市场状态明确且符合可执行剧本（chop 时此项必须 false）
- timeframeAligned: 5m/15m/1h 至少两个周期方向一致
- fundingNotExtreme: 资金费率不在极端区间（|费率| < 0.05%）
- volumeConfirmed: 近期量能支持该方向（放量突破/缩量回调等）
- nearInvalidation: 入场价距止损无效点 <= 1.5 倍 15m ATR（盈亏比好）`;

// ==================== 市场状态客观判定（供 AI 参考 + 引擎闸门） ====================

/**
 * 从 15m K 线客观计算市场状态参考（ADX + 布林带宽 + 波动率）
 * 注意：这是给 AI 的参考基准，最终 regime 由 AI 综合判断后输出
 */
export function computeRegimeHint(k15m: KlineData[]): { regime: string; adx: number | null; bbWidthPct: number | null } {
  if (k15m.length < 50) return { regime: 'unknown', adx: null, bbWidthPct: null };

  const adx = calcADX(k15m, 14);
  const boll = calcBollinger(k15m, 20);
  const bbWidthPct = boll ? ((boll.upper - boll.lower) / boll.middle) * 100 : null;

  let regime = 'unknown';
  if (adx != null) {
    if (adx >= 25) regime = 'trending（趋势明显）';
    else if (adx >= 15) regime = bbWidthPct != null && bbWidthPct < 1.5 ? 'chop（窄幅碎波）' : 'range（区间震荡）';
    else regime = 'chop（无趋势碎波）';
  }
  return { regime, adx, bbWidthPct };
}

/** 时段与资金费率结算感知 */
function buildTimeContext(): string {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  // 交易时段（UTC）：亚盘 00-08 / 欧盘 07-16 / 美盘 13-22（有重叠，标注主时段）
  const sessions: string[] = [];
  if (utcH >= 0 && utcH < 8) sessions.push('亚盘（流动性差，假突破多）');
  if (utcH >= 7 && utcH < 16) sessions.push('欧盘（流动性回升）');
  if (utcH >= 13 && utcH < 22) sessions.push('美盘（波动最剧烈）');
  if (sessions.length === 0) sessions.push('深夜盘（流动性最差）');

  // 距下次资金费率结算（UTC 0/8/16）
  const nextSettle = [0, 8, 16].map((h) => (h * 60 - (utcH * 60 + utcM) + 1440) % 1440);
  const minsToSettle = Math.min(...nextSettle);
  const settleWarn = minsToSettle <= 30 ? '（⚠️ 临近结算，费率异动风险）' : '';

  return `=== 时段与结算 ===
当前 UTC 时间: ${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}
交易时段: ${sessions.join(' + ')}
距下次资金费率结算: ${minsToSettle} 分钟${settleWarn}`;
}

/** 构建用户 prompt（包含行情数据） */
function buildUserPrompt(
  symbol: string,
  label: string,
  currentPrice: number,
  k5m: KlineData[],
  k15m: KlineData[],
  k1h: KlineData[],
  k4h: KlineData[],
  k1d: KlineData[],
  marketContextText: string,
  btcContextText: string,
  atr15m: number | null,
  feedbackText: string,
): string {
  const ind5m = computeIndicatorSnapshot(k5m);
  const ind15m = computeIndicatorSnapshot(k15m);
  const ind1h = computeIndicatorSnapshot(k1h);
  const ind4h = computeIndicatorSnapshot(k4h);
  const ind1d = computeIndicatorSnapshot(k1d);
  const regimeHint = computeRegimeHint(k15m);

  return `请分析以下 ${label} (${symbol}) 的实时行情数据：

当前价格: ${currentPrice}

=== 市场状态参考（客观指标计算，供你 regime 判定参考） ===
15m ADX: ${regimeHint.adx != null ? regimeHint.adx.toFixed(2) : '暂无'} | 布林带宽: ${regimeHint.bbWidthPct != null ? regimeHint.bbWidthPct.toFixed(2) + '%' : '暂无'} | 系统初判: ${regimeHint.regime}
15m ATR(14): ${atr15m != null ? `${atr15m.toFixed(2)}（现价的 ${(atr15m / currentPrice * 100).toFixed(2)}%）；止损距离应控制在 0.5-1.5 倍 ATR = ${(atr15m * 0.5).toFixed(2)} ~ ${(atr15m * 1.5).toFixed(2)}` : '暂无'}

${buildTimeContext()}

${feedbackText}

${marketContextText}
${btcContextText ? `\n${btcContextText}\n` : ''}
=== 5分钟周期（短线入场时机的核心依据） ===
${buildKlineSummary(k5m, '5M K线')}
技术指标:
${buildIndicatorText(ind5m, currentPrice)}

=== 15分钟周期（短线主判定周期） ===
${buildKlineSummary(k15m, '15M K线')}
技术指标:
${buildIndicatorText(ind15m, currentPrice)}

=== 1小时周期（大方向过滤） ===
${buildKlineSummary(k1h, '1H K线')}
技术指标:
${buildIndicatorText(ind1h, currentPrice)}

=== 4小时周期（波段背景，判断中期趋势健康度） ===
技术指标:
${buildIndicatorText(ind4h, currentPrice)}

=== 日线周期（大趋势与超买超卖 — 判断「趋势强但已超买」这类分层信号的关键） ===
技术指标:
${buildIndicatorText(ind1d, currentPrice)}

请综合以上多周期数据和指标，给出你的交易分析建议。记住，只返回 JSON 格式。`;
}

// ==================== AI API 调用 ====================

/** 调用 OpenAI 兼容的 Chat Completions API */
async function callChatCompletions(
  config: AiConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000); // 60s 超时（推理模型分析复杂行情需要更长时间）

  try {
    // 构建请求体 — response_format 仅在供应商支持时发送
    const requestBody: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: config.temperature,
      top_p: 1,
      max_tokens: config.maxTokens,
      stream: false, // 显式关闭流式，确保返回完整 JSON
    };

    // 仅对支持 JSON mode 的供应商发送 response_format
    if (config.supportsJsonMode) {
      requestBody.response_format = { type: 'json_object' };
    }

    const res = await fetch(config.apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`AI API 请求失败 (${res.status}): ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    // 部分推理模型（如 Agnes-AI）可能将内容放在 reasoning_content 而非 content
    const content = data?.choices?.[0]?.message?.content
      || data?.choices?.[0]?.message?.reasoning_content;

    if (!content) {
      throw new Error('AI API 返回内容为空');
    }

    return content;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('AI API 请求超时（60s）');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 结果解析 ====================

/** 从 AI 返回的文本中提取 JSON */
function extractJson(text: string): any {
  // 尝试直接解析
  try {
    return JSON.parse(text);
  } catch {}

  // 尝试提取 ```json ... ``` 块
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock[1]);
    } catch {}
  }

  // 尝试提取第一个 { ... } 块
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  throw new Error('无法从 AI 响应中解析 JSON');
}

/**
 * 将解析的 JSON 转为标准 AiAnalysisResult
 * @param currentPrice 当前价格 — 用于校验 AI 给出的止损/止盈方向是否合理
 */
function normalizeResult(parsed: any, config: AiConfig, rawResponse: string, currentPrice: number): AiAnalysisResult {
  const direction = ['long', 'short', 'neutral'].includes(parsed.direction)
    ? parsed.direction
    : 'neutral';

  // 置信度：兼容 "85"、"85%"、85、0.85 等格式，统一映射到 0-100
  let confidence = 0;
  const rawConf = Number(parsed.confidence);
  if (!Number.isNaN(rawConf)) {
    confidence = rawConf > 0 && rawConf < 1 ? rawConf * 100 : rawConf; // 0.85 → 85
  }
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  // 止损/止盈方向校验：AI 可能幻觉出方向错误的价位
  // long: stopLoss < entry < takeProfit；short: stopLoss > entry > takeProfit
  // 校验基准用当前价（entryPrice 可能为 null 或偏离现价）
  const validatePrice = (v: unknown, side: 'loss' | 'profit'): number | null => {
    const n = v != null ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    if (direction === 'long') {
      return side === 'loss' ? (n < currentPrice ? n : null) : (n > currentPrice ? n : null);
    }
    if (direction === 'short') {
      return side === 'loss' ? (n > currentPrice ? n : null) : (n < currentPrice ? n : null);
    }
    return null; // neutral 不给价位
  };

  const stopLoss = validatePrice(parsed.stopLoss, 'loss');
  const takeProfit1 = validatePrice(parsed.takeProfit1, 'profit');
  const takeProfit2 = validatePrice(parsed.takeProfit2, 'profit');

  // 清洗 keyLevels 数组，确保每项都有合法的 price/type/note 字段（最多保留 8 个）
  let keyLevels: NonNullable<AiAnalysisResult['keyLevels']> | null = null;
  if (Array.isArray(parsed.keyLevels)) {
    const cleaned = parsed.keyLevels
      .filter((lv: any) => lv != null && typeof lv === 'object')
      .slice(0, 8)
      .map((lv: any) => ({
        price: Number(lv.price) || 0,
        type: String(lv.type || '未知'),
        note: String(lv.note || ''),
      }));
    keyLevels = cleaned.length > 0 ? cleaned : null;
  }

  // ===== 结构化元数据：regime + A+ 清单 =====
  // regime 缺省/非法时按 direction 反推中性偏保守值（neutral 方向无法开仓，regime 值影响不大）
  const regime: AiAnalysisResult['meta']['regime'] =
    parsed.regime === 'trending' || parsed.regime === 'range' || parsed.regime === 'chop' || parsed.regime === 'event'
      ? parsed.regime
      : 'chop'; // 无法识别时按最保守的碎波处理（引擎会拦截开仓）

  const cl = parsed.checklist && typeof parsed.checklist === 'object' ? parsed.checklist : {};
  const toBool = (v: unknown): boolean => v === true || v === 'true' || v === 1;

  // ===== 证据表 / 双计划 / 不做区清洗（大神输出框架） =====
  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence
        .filter((e: any) => e != null && typeof e === 'object' && (e.dimension || e.data))
        .slice(0, 8)
        .map((e: any) => ({
          dimension: String(e.dimension || '未命名'),
          data: String(e.data || ''),
          signal: ['bullish', 'bearish', 'neutral'].includes(e.signal) ? e.signal : 'neutral',
          note: String(e.note || ''),
        }))
    : [];

  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const plans = Array.isArray(parsed.plans)
    ? parsed.plans
        .filter((p: any) => p != null && typeof p === 'object')
        .slice(0, 2)
        .map((p: any) => ({
          name: String(p.name || '计划'),
          style: String(p.style || ''),
          recommended: p.recommended === true || p.recommended === 'true',
          entry: num(p.entry),
          stopLoss: num(p.stopLoss),
          takeProfit1: num(p.takeProfit1),
          takeProfit2: num(p.takeProfit2),
          rr1: Number.isFinite(Number(p.rr1)) ? Number(Number(p.rr1).toFixed(1)) : null,
          rr2: Number.isFinite(Number(p.rr2)) ? Number(Number(p.rr2).toFixed(1)) : null,
          condition: String(p.condition || ''),
        }))
    : [];

  let noTradeZone: AiAnalysisResult['meta']['noTradeZone'] = null;
  if (parsed.noTradeZone && typeof parsed.noTradeZone === 'object') {
    const from = num(parsed.noTradeZone.from);
    const to = num(parsed.noTradeZone.to);
    if (from != null && to != null && from > 0 && to > 0) {
      noTradeZone = { from: Math.min(from, to), to: Math.max(from, to), reason: String(parsed.noTradeZone.reason || '') };
    }
  }

  return {
    direction: direction as 'long' | 'short' | 'neutral',
    confidence,
    summary: String(parsed.summary || '无摘要'),
    entryPrice: parsed.entryPrice != null ? Number(parsed.entryPrice) || null : null,
    stopLoss,
    takeProfit1,
    takeProfit2,
    reasoning: String(parsed.reasoning || '无分析'),
    keyLevels,
    riskWarning: parsed.riskWarning ? String(parsed.riskWarning) : null,
    provider: config.provider,
    model: config.model,
    rawResponse,
    meta: {
      regime,
      aPlusChecklist: {
        regimeClear: toBool(cl.regimeClear),
        timeframeAligned: toBool(cl.timeframeAligned),
        fundingNotExtreme: toBool(cl.fundingNotExtreme),
        volumeConfirmed: toBool(cl.volumeConfirmed),
        nearInvalidation: toBool(cl.nearInvalidation),
      },
      atr15m: null, // 由主入口回填（normalizeResult 不重复拉 K 线）
      evidence: evidence.length > 0 ? evidence : undefined,
      plans: plans.length > 0 ? plans : undefined,
      noTradeZone: noTradeZone ?? undefined,
    },
  };
}

// ==================== 主入口 ====================

/**
 * 执行 AI 行情分析
 *
 * @param config  AI 配置
 * @param symbol  交易对（Binance 格式，如 ETHUSDT）
 * @param okxId   OKX 格式（如 ETH-USDT）
 * @param label   显示名称（如 ETH/USDT）
 * @param currentPrice 当前价格（可选，不传则自动获取）
 * @returns 结构化分析结果
 */
export async function analyzeMarketWithAI(
  config: AiConfig,
  symbol: string,
  okxId: string,
  label: string,
  currentPrice?: number,
): Promise<AiAnalysisResult> {
  // 1. 校验配置
  if (!config.enabled) {
    throw new Error('AI 分析功能未启用');
  }
  if (!config.apiUrl) {
    throw new Error('未配置 AI API 地址');
  }
  if (!config.apiKey) {
    throw new Error('未配置 AI API Key');
  }
  if (!config.model) {
    throw new Error('未配置 AI 模型名称');
  }

  // 2. 获取当前价格
  const price = currentPrice && currentPrice > 0
    ? currentPrice
    : await fetchPrice(symbol, okxId);

  if (!price || price <= 0) {
    throw new Error('无法获取当前价格');
  }

  // 3. 获取多周期 K 线数据（短线 5m/15m/1h + 波段背景 4h/1d）
  //    并行抓取衍生品/情绪/要闻上下文 + BTC 快照（带缓存，失败优雅降级）
  const isBtc = symbol.toUpperCase().startsWith('BTC');
  const [k5m, k15m, k1h, k4h, k1d, marketCtx, btcSnap] = await Promise.all([
    fetchKlines(symbol, okxId, '5m', 200).catch(() => []),
    fetchKlines(symbol, okxId, '15m', 200).catch(() => []),
    fetchKlines(symbol, okxId, '1h', 200).catch(() => []),
    fetchKlines(symbol, okxId, '4h', 120).catch(() => []),
    fetchKlines(symbol, okxId, '1d', 60).catch(() => []),
    fetchMarketContext(symbol, okxId).catch(() => null),
    // 分析山寨币时必看 BTC；分析 BTC 自身时跳过（避免冗余）
    isBtc ? Promise.resolve(null) : fetchBtcSnapshot().catch(() => null),
  ]);

  if (k5m.length === 0 && k15m.length === 0 && k1h.length === 0) {
    throw new Error('无法获取 K 线数据');
  }

  // 3.5 计算 15m ATR（无效点/止损距离的客观标尺）
  const atr15m = k15m.length >= 15 ? calcATR(k15m, 14) : null;

  // 3.6 反馈闭环：先评估到期的历史预测（不阻塞主流程），再取近期战绩注入 prompt
  evaluatePendingPredictions().catch(() => {}); // fire-and-forget：评估失败不影响本次分析
  const feedbackText = await getRecentFeedbackText(symbol).catch(
    () => '=== 你的近期预测战绩 === 暂无数据',
  );

  // 4. 构建 prompt
  const userPrompt = buildUserPrompt(
    symbol,
    label,
    price,
    k5m,
    k15m,
    k1h,
    k4h,
    k1d,
    marketCtx ? buildMarketContextText(marketCtx) : '=== 衍生品与市场情绪 === 暂无数据',
    isBtc ? '' : buildBtcContextText(btcSnap),
    atr15m,
    feedbackText,
  );

  // 5. 调用 AI API
  const rawResponse = await callChatCompletions(config, SYSTEM_PROMPT, userPrompt);

  // 6. 解析结果（传入当前价用于校验止损/止盈方向）
  const parsed = extractJson(rawResponse);
  const result = normalizeResult(parsed, config, rawResponse, price);

  // 回填客观计算的 ATR（引擎闸门校验止损距离用）
  result.meta.atr15m = atr15m;

  return result;
}
