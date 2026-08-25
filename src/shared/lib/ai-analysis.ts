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
    /** 江恩八分位阶梯（服务端客观计算回填 — 价位框架，前端阶梯展示用） */
    gann?: {
      swingHigh: number; swingLow: number; rangePct: number;
      positionPct: number; zoneLabel: string;
      levels: { division: string; index: number; price: number; distPct: number; meaning: string }[];
    } | null;
    /** 顶底分型信号（服务端客观计算回填 — 进场触发器，前端徽章展示用） */
    fractal?: {
      lastTop: { price: number; barsAgo: number; strong: boolean; nearDivision: string } | null;
      lastBottom: { price: number; barsAgo: number; strong: boolean; nearDivision: string } | null;
      topBroken: boolean;
      bottomBroken: boolean;
    } | null;
    /** 多周期结构趋势（服务端客观计算回填 — 方向过滤层，前端周期徽章展示用；d1=日线趋势锚） */
    structure?: {
      m15: StructureTrend;
      h1: StructureTrend;
      h4: StructureTrend;
      d1: StructureTrend;
    } | null;
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

// ==================== Prompt 构建 ====================

/** 构建 K 线摘要文本（避免传太多数据消耗 token） */
// ==================== 江恩八分位（Gann Eighths）客观计算 ====================

/** 江恩八分位：近段摆动区间按 1/8 等分切出的支撑/阻力阶梯 */
export interface GannEighths {
  swingHigh: number;
  swingLow: number;
  /** 区间振幅（%） */
  rangePct: number;
  /** 现价在区间内的位置（0=底部，100=顶部） */
  positionPct: number;
  /** 现价所处分区描述 */
  zoneLabel: string;
  levels: { division: string; index: number; price: number; distPct: number; meaning: string }[];
}

/** 江恩八分位各档的标准含义（严格江恩八分法） */
const GANN_MEANINGS: Record<number, string> = {
  1: '极限支撑 · 最佳买点',
  2: '次级支撑 · 次佳买点',
  3: '下枢轴 · 突破确认位',
  4: '中轴 50% · 多空分水岭',
  5: '上枢轴 · 次强阻力',
  6: '次级阻力 · 次佳空点',
  7: '极限阻力 · 最佳空点',
  8: '区间顶部',
};

/**
 * 计算江恩八分位阶梯：取近 72 根 1h K线（≈3天）的摆动高低点，
 * 将区间 8 等分得到 1/8~8/8 价位。全程客观数值，不依赖 AI 报价。
 */
export function computeGannEighths(k1h: KlineData[], currentPrice: number): GannEighths | null {
  if (k1h.length < 24 || !currentPrice || currentPrice <= 0) return null;

  const win = k1h.slice(-72);
  let hi = -Infinity;
  let lo = Infinity;
  win.forEach((k) => {
    if (k.high > hi) hi = k.high;
    if (k.low < lo) lo = k.low;
  });
  const range = hi - lo;
  if (range <= 0 || !Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  // 最小区间宽度过滤（纯客观过滤器）：窄区间内 1/8 间距过小，止损会被正常波动扫掉 → 不做窄区间单
  // 双重判定：区间 <1.2%（绝对地板），或区间 <5× 平均单根振幅（横盘压缩，自适应各币种波动率）
  if (range / currentPrice < 0.012) return null;
  const avgBarRange = win.reduce((s, k) => s + (k.high - k.low), 0) / win.length;
  if (avgBarRange > 0 && range < avgBarRange * 5) return null;

  const levels = [];
  for (let i = 1; i <= 8; i++) {
    const price = lo + range * (i / 8);
    levels.push({
      division: `${i}/8`,
      index: i,
      price: Number(price.toFixed(price >= 100 ? 2 : 4)),
      distPct: Number((((price - currentPrice) / currentPrice) * 100).toFixed(2)),
      meaning: GANN_MEANINGS[i],
    });
  }

  const positionPct = Number((((currentPrice - lo) / range) * 100).toFixed(1));
  const lower = Math.min(8, Math.max(0, Math.floor(positionPct / 12.5)));
  let zoneLabel = `${lower}/8 – ${Math.min(lower + 1, 8)}/8 分区`;
  if (positionPct <= 12.5) zoneLabel = '0/8–1/8 超卖边缘区';
  else if (positionPct >= 87.5) zoneLabel = '7/8–8/8 超买边缘区';

  return {
    swingHigh: Number(hi.toFixed(hi >= 100 ? 2 : 4)),
    swingLow: Number(lo.toFixed(lo >= 100 ? 2 : 4)),
    rangePct: Number(((range / currentPrice) * 100).toFixed(2)),
    positionPct,
    zoneLabel,
    levels,
  };
}

/** 江恩阶梯文本（注入 prompt — 唯一分析依据） */
function buildGannText(g: GannEighths | null, currentPrice: number): string {
  if (!g) return '=== 江恩八分位 ===\n区间过窄（横盘压缩）或K线不足，八分位间距无意义 → 直接 neutral，不挂单（等待区间扩张）';
  const lines = g.levels.map(
    (l) => `- ${l.division} ${l.price}（${l.distPct > 0 ? '+' : ''}${l.distPct}%）${l.meaning}`,
  );
  return `=== 江恩八分位阶梯（唯一分析依据，全部客观数值） ===
摆动区间（近72小时 1h）：${g.swingLow}（0/8）~ ${g.swingHigh}（8/8），振幅 ${g.rangePct}%
当前价 ${currentPrice}，位于区间 ${g.positionPct}% 处（${g.zoneLabel}）
分位阶梯：
${lines.join('\n')}`;
}

// ==================== 多周期结构趋势（Market Structure） ====================

/** 摆动点序列 → 市场结构分类 */
export type StructureTrend = 'up' | 'down' | 'range' | 'unknown';

export interface StructureInfo {
  trend: StructureTrend;
  /** 近端摆动序列描述（如 "HL 2458 → HH 2510 → HL 2480"） */
  seq: string;
  /** 结构与方向是否对齐的备注 */
  note: string;
}

/**
 * 客观判定市场结构（道氏 HH/HL/LH/LL 框架，纯结构不看指标）
 * 取近端已确认摆动点（顶/底各最多 4 个，[0]=最新），对每对相邻同类型摆动做新旧比较并加权投票：
 * 越新的摆动对权重越高（3/2/1），单一新摆动点只能改变最新一对，无法整体翻转结构标签（降抖动）。
 * - 加权总分 ≥ +60% 满分 → up（HH+HL 主导上升结构）
 * - 加权总分 ≤ -60% 满分 → down（LH+LL 主导下降结构）
 * - 其余（方向分歧、证据不一致）→ range（震荡结构）
 */
export function computeStructureTrend(klines: KlineData[], tfLabel: string): StructureInfo {
  if (klines.length < 30) return { trend: 'unknown', seq: '', note: `${tfLabel} K线不足` };

  const n = klines.length;
  const start = Math.max(2, n - 120); // 近 120 根内找摆动
  const tops: number[] = []; // [0]=最新
  const bottoms: number[] = [];

  for (let i = n - 2; i >= start && (tops.length < 4 || bottoms.length < 4); i--) {
    const k = klines[i];
    if (tops.length < 4 && k.high > klines[i - 1].high && k.high > klines[i + 1].high) tops.push(k.high);
    if (bottoms.length < 4 && k.low < klines[i - 1].low && k.low < klines[i + 1].low) bottoms.push(k.low);
  }

  if (tops.length < 2 || bottoms.length < 2) {
    return { trend: 'unknown', seq: '', note: `${tfLabel} 摆动点不足，结构不明` };
  }

  /** 相邻同类型摆动对加权投票：新>旧=+w（HH/HL），新<旧=-w（LH/LL） */
  const vote = (arr: number[]): { score: number; max: number } => {
    const pairs = Math.min(arr.length - 1, 3);
    const weights = [3, 2, 1].slice(0, pairs);
    let score = 0;
    for (let p = 0; p < pairs; p++) score += arr[p] > arr[p + 1] ? weights[p] : -weights[p];
    return { score, max: weights.reduce((s, w) => s + w, 0) };
  };

  const tv = vote(tops);
  const bv = vote(bottoms);
  const total = tv.score + bv.score;
  const maxTotal = tv.max + bv.max;
  const ratio = maxTotal > 0 ? total / maxTotal : 0; // -1 ~ +1

  // 序列描述（旧→新，最近一对带 HH/HL/LH/LL 标签）
  const topLabel = tops[0] > tops[1] ? 'HH' : 'LH';
  const bottomLabel = bottoms[0] > bottoms[1] ? 'HL' : 'LL';
  const seq = `高点 ${[...tops].reverse().join('→')}（${topLabel}）· 低点 ${[...bottoms].reverse().join('→')}（${bottomLabel}）`;

  if (ratio >= 0.6) return { trend: 'up', seq, note: `${tfLabel} HH+HL 主导上升（加权 ${Math.round(ratio * 100)}%）` };
  if (ratio <= -0.6) return { trend: 'down', seq, note: `${tfLabel} LH+LL 主导下降（加权 ${Math.round(-ratio * 100)}%）` };
  return { trend: 'range', seq, note: `${tfLabel} 摆动方向分歧，震荡（加权 ${Math.round(ratio * 100)}%）` };
}

/** 多周期结构文本（注入 prompt — 方向过滤层，15m/1h/4h/1d 四周期） */
function buildStructureText(s15: StructureInfo, s1h: StructureInfo, s4h: StructureInfo, s1d: StructureInfo): string {
  const label = (s: StructureInfo) =>
    s.trend === 'up' ? '上升（HH+HL）' : s.trend === 'down' ? '下降（LH+LL）' : s.trend === 'range' ? '震荡（矛盾）' : '不明（数据不足）';
  return `=== 多周期结构趋势（道氏 HH/HL/LH/LL，服务端客观计算 — 方向过滤层） ===
15分钟结构：${label(s15)}${s15.seq ? ` | ${s15.seq}` : ''}
1小时结构：${label(s1h)}${s1h.seq ? ` | ${s1h.seq}` : ''}
4小时结构：${label(s4h)}${s4h.seq ? ` | ${s4h.seq}` : ''}
1天结构：${label(s1d)}${s1d.seq ? ` | ${s1d.seq}` : ''}
（1天结构为最高级趋势锚：日线结构明确时，短线信号逆日线 = 逆大势，禁止给该方向信号）`;
}

/**
 * 服务端固定模板摘要（覆盖 AI 自由文本 — 面板展示永远稳定格式，不乱）
 * 有方向：「触发分型@分位 · 挂X 多/空 · 损Y · 看A/B · 结构 升/降/震/升/降/震」
 * 观望：「观望：{客观原因} · 现价 · 位置 · 结构」
 */
export function buildDeterministicSummary(
  direction: 'long' | 'short' | 'neutral',
  entryPrice: number | null,
  stopLoss: number | null,
  takeProfit1: number | null,
  takeProfit2: number | null,
  gann: GannEighths | null,
  fractal: FractalSignal | null,
  s15: StructureInfo,
  s1h: StructureInfo,
  s4h: StructureInfo,
  s1d: StructureInfo,
  currentPrice: number,
): string {
  const tag = (s: StructureInfo) => (s.trend === 'up' ? '升' : s.trend === 'down' ? '降' : s.trend === 'range' ? '震' : '–');
  const structShort = `${tag(s15)}/${tag(s1h)}/${tag(s4h)}/${tag(s1d)}`; // 15m/1h/4h/1d
  const fmt = (p: number | null) =>
    p != null && Number.isFinite(p) ? p.toLocaleString('en-US', { maximumFractionDigits: p >= 100 ? 2 : 4 }) : '–';
  const nearDiv = (p: number, g: GannEighths) => {
    const nearest = g.levels.reduce((a, b) => (Math.abs(b.price - p) < Math.abs(a.price - p) ? b : a));
    return nearest.division;
  };

  // 观望：客观说明原因（可判定顺序：区间 → 分型 → 结构 → 其他）
  if (direction === 'neutral') {
    let why = '未命中进场规则';
    if (!gann) why = '区间过窄（横盘压缩），八分位间距无意义';
    else if (!fractal || (!fractal.lastTop && !fractal.lastBottom)) why = '近端无已确认分型';
    else if (fractal.topBroken) why = '顶分型已被突破，信号失效';
    else if (fractal.bottomBroken) why = '底分型已被跌破，信号失效';
    else if (s4h.trend === 'range' || s1h.trend === 'range') why = '结构震荡，信号不通过过滤';
    return `观望：${why}${gann ? ` · 现价 ${fmt(currentPrice)} 位于 ${gann.zoneLabel}` : ''} · 结构 ${structShort}`;
  }

  // 有方向：固定模板（触发分型 → 挂单价/止损/止盈 → 结构过滤结果）
  const trig =
    direction === 'long'
      ? fractal?.lastBottom
        ? `底分型${fractal.lastBottom.strong ? '(强)' : ''}${fractal.lastBottom.nearDivision ? `·共振${fractal.lastBottom.nearDivision}` : ''}`
        : '底分型'
      : fractal?.lastTop
        ? `顶分型${fractal.lastTop.strong ? '(强)' : ''}${fractal.lastTop.nearDivision ? `·共振${fractal.lastTop.nearDivision}` : ''}`
        : '顶分型';
  const entryDiv = gann && entryPrice ? `@${nearDiv(entryPrice, gann)}` : '';
  const dirText = direction === 'long' ? '多' : '空';
  return `${trig}${entryDiv} · 挂 ${fmt(entryPrice)} ${dirText} · 损 ${fmt(stopLoss)} · 看 ${fmt(takeProfit1)}/${fmt(takeProfit2)} · 结构 ${structShort}`;
}

// ==================== 顶底分型（Fractal）客观计算 ====================

/** 分型点：三根K线中的极值（已确认：右侧K线走完才算） */
export interface FractalPoint {
  type: 'top' | 'bottom';
  price: number;      // 分型极值（顶分型=最高高点，底分型=最低低点）
  barsAgo: number;    // 距最新K线的根数
  strong: boolean;    // 强分型：左右各两根（共5根）内均为极值
  nearDivision: string; // 分型极值贴近的八分位（如 "3/8"），无贴近为空
}

export interface FractalSignal {
  lastTop: FractalPoint | null;
  lastBottom: FractalPoint | null;
  /** 顶分型高点已被最新收盘价突破（信号失效，多头结构强化） */
  topBroken: boolean;
  /** 底分型低点已被最新收盘价跌破（信号失效，空头结构强化） */
  bottomBroken: boolean;
}

/**
 * 客观计算近端顶底分型（1h K线）
 * 顶分型：中间K线高点高于左右两根；底分型：中间低点低于左右两根
 * 只统计已确认分型（i 从 n-2 起，右侧K线存在），从右往左找最近的一组
 */
export function computeFractalSignal(k1h: KlineData[], gann: GannEighths | null): FractalSignal | null {
  if (k1h.length < 20) return null;
  const n = k1h.length;
  const start = Math.max(2, n - 96); // 只看近 96 根（4天）
  let lastTop: FractalPoint | null = null;
  let lastBottom: FractalPoint | null = null;

  /** 分型极值是否贴近某档八分位（0.3% 内） */
  const nearDiv = (p: number): string => {
    if (!gann) return '';
    let best = '';
    let bestDist = Infinity;
    for (const l of gann.levels) {
      const d = Math.abs(l.price - p) / p;
      if (d < bestDist) { bestDist = d; best = l.division; }
    }
    return bestDist <= 0.003 ? best : '';
  };

  for (let i = n - 2; i >= start; i--) {
    const k = k1h[i];
    const l = k1h[i - 1];
    const r = k1h[i + 1];
    const isTop = k.high > l.high && k.high > r.high;
    const isBottom = k.low < l.low && k.low < r.low;
    if (!isTop && !isBottom) continue;

    const barsAgo = n - 1 - i;
    // 强分型：左右各再扩一根（5根内极值）
    const l2 = i >= 2 ? k1h[i - 2] : null;
    const r2 = i + 2 < n ? k1h[i + 2] : null;

    if (isTop && !lastTop) {
      const strong = !!(l2 && r2 && k.high > l2.high && k.high > r2.high);
      lastTop = { type: 'top', price: k.high, barsAgo, strong, nearDivision: nearDiv(k.high) };
    }
    if (isBottom && !lastBottom) {
      const strong = !!(l2 && r2 && k.low < l2.low && k.low < r2.low);
      lastBottom = { type: 'bottom', price: k.low, barsAgo, strong, nearDivision: nearDiv(k.low) };
    }
    if (lastTop && lastBottom) break;
  }

  if (!lastTop && !lastBottom) return null;

  // 失效判定：最新收盘价越过顶分型高点 / 跌破底分型低点
  const lastClose = k1h[n - 1].close;
  return {
    lastTop,
    lastBottom,
    topBroken: !!(lastTop && lastClose > lastTop.price),
    bottomBroken: !!(lastBottom && lastClose < lastBottom.price),
  };
}

/** 分型文本（注入 prompt — 进场触发器） */
function buildFractalText(f: FractalSignal | null, currentPrice: number): string {
  if (!f) return '=== 顶底分型 ===\n近端无已确认分型（此时只能 neutral，等待分型形成）';
  const fmt = (p: FractalPoint | null, broken: boolean) => {
    if (!p) return '近96根内无';
    const status = broken
      ? (p.type === 'top' ? '高点已被收盘突破（信号失效）' : '低点已被收盘跌破（信号失效）')
      : '有效';
    const distRaw = ((p.price - currentPrice) / currentPrice) * 100;
    const distPct = distRaw.toFixed(2);
    return `${p.price}（${p.barsAgo}根前，${p.strong ? '强分型' : '普通分型'}${p.nearDivision ? `，贴近 ${p.nearDivision} 分位（共振）` : ''}，${status}，距现价 ${distRaw > 0 ? '+' : ''}${distPct}%）`;
  };
  return `=== 顶底分型（进场触发器，服务端客观计算） ===
最近顶分型：${fmt(f.lastTop, f.topBroken)}
最近底分型：${fmt(f.lastBottom, f.bottomBroken)}`;
}

function buildKlineSummary(klines: KlineData[], label: string): string {
  if (klines.length === 0) return `${label}: 无数据`;

  const last = klines[klines.length - 1];
  const prev = klines.length > 1 ? klines[klines.length - 2] : last;
  const recent20 = klines.slice(-20);

  const high20 = Math.max(...recent20.map((k) => k.high));
  const low20 = Math.min(...recent20.map((k) => k.low));

  // 计算涨跌幅
  const changePct = prev.close > 0 ? ((last.close - prev.close) / prev.close * 100) : 0;

  // 纯事实摘要：只保留 OHLC 与区间事实。
  // 不注入结构判定（由多周期结构文本统一提供，避免双结构矛盾）、不注入量能（规则明确不看）
  return `${label}:
  最新K线: O=${last.open} H=${last.high} L=${last.low} C=${last.close}
  涨跌幅: ${changePct.toFixed(2)}%
  近20根最高: ${high20}, 最低: ${low20}`;
}

/** 构建系统 prompt */
const SYSTEM_PROMPT = `你是严格执行「江恩八分位 + 顶底分型」的交易分析师。价位框架只用江恩八分位，进场触发只用顶底分型，两者缺一不可。不使用任何其他方法：不看技术指标（RSI/MACD/均线）、不看消息面、不看衍生品数据、不做多周期共振。

【价位框架：江恩八分位】
数据提供近72小时摆动区间的八分位阶梯（1/8~8/8，服务端客观计算）：
- 4/8 中轴（50%）是多空分水岭
- 支撑分位：1/8 极限支撑、2/8 次级支撑、3/8 下枢轴
- 阻力分位：5/8 上枢轴、6/8 次级阻力、7/8 极限阻力

【进场触发：顶底分型】
数据提供近端已确认分型（服务端客观计算）：中间K线高点高于左右两根=顶分型（见顶信号），中间低点低于左右两根=底分型（见底信号）。

进场规则（分型触发 + 分位框架，缺一不给方向）：
1. 底分型有效（低点未被收盘跌破）+ 位于 4/8 下方支撑区（1/8~3/8）→ 反弹做多：entry=分型低点上方就近分位，stopLoss=分型低点，takeProfit1=4/8，takeProfit2=5/8
2. 底分型有效 + 位于 4/8 上方（5/8~7/8）→ 回踩结束顺势做多：entry=分型低点上方就近分位，stopLoss=分型低点，takeProfit1=7/8，takeProfit2=8/8
3. 顶分型有效（高点未被收盘突破）+ 位于 4/8 上方阻力区（5/8~7/8）→ 回落做空：entry=分型高点下方就近分位，stopLoss=分型高点，takeProfit1=4/8，takeProfit2=3/8
4. 顶分型有效 + 位于 4/8 下方（1/8~3/8）→ 反抽结束顺势做空：entry=分型高点下方就近分位，stopLoss=分型高点，takeProfit1=1/8，takeProfit2=2/8
5. 共振加分：分型极值贴近八分位（±0.3%，数据已标注）= 分型分位共振，置信度 80+；强分型再加分
6. 分型失效（顶分型高点被突破 / 底分型低点被跌破）→ 该分型信号作废，等待新分型，否则 neutral
7. 近端无有效分型、或分型与所在分位区矛盾（如下方支撑区出现顶分型）→ neutral，不勉强给方向

【方向过滤：多周期结构对齐（15m/1h/4h/1d 四周期）】
数据提供 15m/1h/4h/1d 四个周期的市场结构（HH+HL=上升、LH+LL=下降、矛盾=震荡，服务端客观计算）。分型信号必须经结构过滤，1d 为最高级趋势锚：
- 日线否决（最优先）：信号方向与 1d 结构相反（如 1d 上升 HH+HL 却想做空）→ 直接 neutral。日线结构明确时禁止逆日线给信号 — 短线回调不改变大势
- 顺势信号：信号方向与 1h、4h 结构一致（或至少不逆 4h）且不逆 1d → 正常置信度；四周期同向共振 → 置信度 85+
- 逆势信号：信号方向与 1h 结构相反（但不逆 1d/4h）→ 置信度上限 55（不自动开仓）；与 4h 结构也相反 → 直接 neutral
- 日线上升 + 1h 下降 = 大级别回调：只允许顺势多（在支撑分位等底分型），禁止抄顶做空
- 结构不明（unknown）：不加仓不重仓，置信度上限 65
- 结构与分位矛盾时以结构为准：如下方支撑区的底分型但 1h 是 LH+LL 下降结构，反弹多只看 4/8 不看 5/8，且置信度降档

【价位铁律】
- entryPrice / takeProfit1 / takeProfit2 必须等于八分位价格；stopLoss = 分型极值（分型极值贴近分位时用该分位价）
- 用户只挂限价单进场，不追市价

你必须以严格的 JSON 格式返回，不要包含任何其他文字。JSON 格式如下：
{
  "direction": "long" | "short" | "neutral",
  "confidence": 数字(0-100，分型分位共振+强分型+近端新鲜=高分，分型失效或无分型=低分),
  "entryPrice": 八分位价格或null（neutral时为null）,
  "stopLoss": 分型极值价格或null,
  "takeProfit1": 八分位价格或null,
  "takeProfit2": 八分位价格或null,
  "reasoning": "一两句：命中进场规则第几条、结构过滤结论。摘要由系统自动生成，无需输出"
}`

/** 构建用户 prompt（江恩八分位框架 + 顶底分型触发 + 多周期结构过滤） */
function buildUserPrompt(
  symbol: string,
  label: string,
  currentPrice: number,
  k1h: KlineData[],
  gannText: string,
  fractalText: string,
  structureText: string,
): string {
  return `请按「江恩八分位 + 顶底分型 + 结构过滤」规则分析 ${label} (${symbol})：

当前价格: ${currentPrice}

${gannText}

${fractalText}

${structureText}

=== 近期价格行为（1小时K线摘要，用于判断分型与分位的突破/回踩状态） ===
${buildKlineSummary(k1h, '1H K线')}

严格按规则返回 JSON，不要包含任何其他文字。`;
}

// ==================== AI API 调用 ====================

/** 调用 OpenAI 兼容的 Chat Completions API（导出供文章生成等模块复用） */
export async function callChatCompletions(
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

/** 从 AI 返回的文本中提取 JSON（导出供文章生成等模块复用） */
export function extractJson(text: string): any {
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

  // regime：纯江恩模式下 AI 不再输出该字段，默认 trending（引擎按最低置信度闸门执行）
  const regime: AiAnalysisResult['meta']['regime'] =
    parsed.regime === 'trending' || parsed.regime === 'range' || parsed.regime === 'chop' || parsed.regime === 'event'
      ? parsed.regime
      : 'trending';

  return {
    direction: direction as 'long' | 'short' | 'neutral',
    confidence,
    summary: String(parsed.summary || '无摘要'),
    entryPrice: parsed.entryPrice != null ? Number(parsed.entryPrice) || null : null,
    stopLoss,
    takeProfit1,
    takeProfit2,
    reasoning: String(parsed.reasoning || '无分析'),
    keyLevels: null,
    riskWarning: parsed.riskWarning ? String(parsed.riskWarning) : null,
    provider: config.provider,
    model: config.model,
    rawResponse,
    meta: { regime },
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

  // 3. 获取 K 线：1h（八分位区间 + 分型触发）+ 15m/4h/1d（结构趋势判定）
  const [k1h, k15m, k4h, k1d] = await Promise.all([
    fetchKlines(symbol, okxId, '1h', 200).catch(() => [] as KlineData[]),
    fetchKlines(symbol, okxId, '15m', 120).catch(() => [] as KlineData[]),
    fetchKlines(symbol, okxId, '4h', 60).catch(() => [] as KlineData[]),
    fetchKlines(symbol, okxId, '1d', 60).catch(() => [] as KlineData[]),
  ]);

  if (k1h.length === 0) {
    throw new Error('无法获取 K 线数据');
  }

  // 3.5 计算江恩八分位阶梯（近72小时摆动区间 8 等分 — 价位框架，注入 prompt + 回填 meta 供前端展示）
  const gann = computeGannEighths(k1h, price);

  // 3.6 计算近端顶底分型（进场触发器 — 注入 prompt + 回填 meta 供前端展示）
  const fractal = computeFractalSignal(k1h, gann);

  // 3.7 计算多周期结构趋势（15m/1h/4h/1d 道氏结构 — 方向过滤层，1d 为最高级趋势锚）
  const struct15 = computeStructureTrend(k15m, '15分钟');
  const struct1h = computeStructureTrend(k1h, '1小时');
  const struct4h = computeStructureTrend(k4h, '4小时');
  const struct1d = computeStructureTrend(k1d, '1天');

  // 4. 构建 prompt（八分位框架 + 分型触发 + 多周期结构过滤）
  const userPrompt = buildUserPrompt(
    symbol,
    label,
    price,
    k1h,
    buildGannText(gann, price),
    buildFractalText(fractal, price),
    buildStructureText(struct15, struct1h, struct4h, struct1d),
  );

  // 5. 调用 AI API
  const rawResponse = await callChatCompletions(config, SYSTEM_PROMPT, userPrompt);

  // 6. 解析结果（传入当前价用于校验止损/止盈方向）
  const parsed = extractJson(rawResponse);
  const result = normalizeResult(parsed, config, rawResponse, price);

  // 6.5 日线一票否决（服务端硬约束 — AI 忽略提示词规则时代码层强制拦截）：
  //     1d 结构明确（up/down）时，信号方向逆 1d → 强制 neutral。
  //     短线回调不改变大势，杜绝"日线强多头里给逆势空单"这类信号与走势背离。
  if (
    (struct1d.trend === 'up' && result.direction === 'short') ||
    (struct1d.trend === 'down' && result.direction === 'long')
  ) {
    result.direction = 'neutral';
    result.confidence = Math.min(result.confidence, 50);
    result.summary = `观望：信号方向与日线结构（${struct1d.trend === 'up' ? '上升 HH+HL' : '下降 LH+LL'}）相反，已否决 · 现价 ${price.toLocaleString('en-US', { maximumFractionDigits: 2 })} · 结构 ${struct1h.trend === 'up' ? '升' : struct1h.trend === 'down' ? '降' : struct1h.trend === 'range' ? '震' : '–'}/日线${struct1d.trend === 'up' ? '升' : '降'}`;
  }

  // 回填江恩八分位（服务端客观计算，前端阶梯图展示；不依赖 AI 复述避免幻觉）
  result.meta.gann = gann;
  // 回填顶底分型（服务端客观计算，前端徽章展示）
  result.meta.fractal = fractal;
  // 回填多周期结构趋势（服务端客观计算，前端周期徽章展示）
  result.meta.structure = { m15: struct15.trend, h1: struct1h.trend, h4: struct4h.trend, d1: struct1d.trend };
  // 摘要改为服务端固定模板（AI 不再自由发挥文案 — 每次分析格式恒定，面板不乱）
  // （若上方日线否决已写 summary 则保留否决理由，不再覆盖）
  const vetoed = result.direction === 'neutral' && result.summary.startsWith('观望：信号方向与日线结构');
  if (!vetoed) {
    result.summary = buildDeterministicSummary(
      result.direction,
      result.entryPrice,
      result.stopLoss,
      result.takeProfit1,
      result.takeProfit2,
      gann,
      fractal,
      struct15,
      struct1h,
      struct4h,
      struct1d,
      price,
    );
  }

  return result;
}
