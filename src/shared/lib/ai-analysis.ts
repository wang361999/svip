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
    /** 江恩八分位阶梯（服务端客观计算回填 — 唯一分析依据，前端阶梯展示用） */
    gann?: {
      swingHigh: number; swingLow: number; rangePct: number;
      positionPct: number; zoneLabel: string;
      levels: { division: string; index: number; price: number; distPct: number; meaning: string }[];
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
  if (range / currentPrice < 0.004) return null; // 区间过窄（<0.4%）无分析意义

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
  if (!g) return '=== 江恩八分位 ===\nK线数据不足，无法计算八分位（此时直接 neutral）';
  const lines = g.levels.map(
    (l) => `- ${l.division} ${l.price}（${l.distPct > 0 ? '+' : ''}${l.distPct}%）${l.meaning}`,
  );
  return `=== 江恩八分位阶梯（唯一分析依据，全部客观数值） ===
摆动区间（近72小时 1h）：${g.swingLow}（0/8）~ ${g.swingHigh}（8/8），振幅 ${g.rangePct}%
当前价 ${currentPrice}，位于区间 ${g.positionPct}% 处（${g.zoneLabel}）
分位阶梯：
${lines.join('\n')}`;
}

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

/** 构建系统 prompt */
const SYSTEM_PROMPT = `你是严格执行「江恩八分法」的交易分析师。你只使用江恩八分位规则，不使用任何其他方法：不看技术指标（RSI/MACD/均线）、不看消息面、不看衍生品数据、不做多周期共振。

【江恩八分法规则 — 唯一分析依据】
数据提供近72小时摆动区间的八分位阶梯（1/8~8/8，服务端客观计算）。所有判断严格按以下规则执行：

1. 4/8 中轴（50%）是多空分水岭：价格站稳 4/8 之上只做多，之下只做空
2. 买入分位：1/8 极限支撑（最佳买点）、2/8 次佳买点、3/8 突破确认位（有效突破后上看 4/8）
3. 卖出分位：7/8 极限阻力（最佳空点）、6/8 次佳空点、5/8 次强阻力
4. 回调做多：价格在 4/8 上方运行且回踩 3/8 或 4/8 → 挂多单，止盈看 5/8、6/8
5. 反弹做空：价格在 4/8 下方运行且反弹 5/8 或 4/8 → 挂空单，止盈看 3/8、2/8
6. 边缘反转：价格触及 7/8~8/8 → 只做向 4/8 回归的空单或观望；触及 0~1/8 → 只做向 4/8 回归的多单或观望
7. 止损：入场分位相邻的外侧分位（挂 3/8 多单止损放 2/8，空单镜像）
8. 止盈：入场方向的下一档分位（止盈1）、再下一档（止盈2）
9. 突破顺延：某分位被有效突破（1小时收盘越过）后，该分位角色反转，目标顺延一档
10. 价格悬停在两个分位中间、无分位依托 → neutral，不勉强给方向

【价位铁律】
- entryPrice / stopLoss / takeProfit1 / takeProfit2 必须精确等于八分位价格，禁止自创价位
- 用户只挂限价单进场，不追市价

你必须以严格的 JSON 格式返回，不要包含任何其他文字。JSON 格式如下：
{
  "direction": "long" | "short" | "neutral",
  "confidence": 数字(0-100，分位依托清晰度：价格贴近强分位且规则情形明确=高分；分位间悬空=低分),
  "entryPrice": 八分位价格或null（neutral时为null）,
  "stopLoss": 相邻外侧分位价格或null,
  "takeProfit1": 下一档分位价格或null,
  "takeProfit2": 再下一档分位价格或null,
  "summary": "一句话：现价位于X/8~Y/8之间 + 挂单动作（如：位于4/8~5/8，挂3/8限价多）",
  "reasoning": "两三句：命中规则第几条的哪种情形、依托哪个分位"
}`

/** 构建用户 prompt（纯江恩八分法：阶梯 + 1h 近期价格行为，无其他数据） */
function buildUserPrompt(
  symbol: string,
  label: string,
  currentPrice: number,
  k1h: KlineData[],
  gannText: string,
): string {
  return `请按江恩八分法规则分析 ${label} (${symbol})：

${gannText}

=== 近期价格行为（1小时K线摘要，用于判断分位的突破/回踩状态） ===
${buildKlineSummary(k1h, '1H K线')}

严格按八分位规则返回 JSON，不要包含任何其他文字。`;
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

  // 3. 获取 1h K线（江恩八分位区间的计算源 + 判断分位突破/回踩的近期价格行为）
  const k1h = await fetchKlines(symbol, okxId, '1h', 200).catch(() => [] as KlineData[]);

  if (k1h.length === 0) {
    throw new Error('无法获取 K 线数据');
  }

  // 3.5 计算江恩八分位阶梯（近72小时摆动区间 8 等分 — 唯一分析依据，注入 prompt + 回填 meta 供前端展示）
  const gann = computeGannEighths(k1h, price);

  // 4. 构建 prompt（纯江恩：阶梯 + 1h 价格行为，无其他数据）
  const userPrompt = buildUserPrompt(symbol, label, price, k1h, buildGannText(gann, price));

  // 5. 调用 AI API
  const rawResponse = await callChatCompletions(config, SYSTEM_PROMPT, userPrompt);

  // 6. 解析结果（传入当前价用于校验止损/止盈方向）
  const parsed = extractJson(rawResponse);
  const result = normalizeResult(parsed, config, rawResponse, price);

  // 回填江恩八分位（服务端客观计算，前端阶梯图展示；不依赖 AI 复述避免幻觉）
  result.meta.gann = gann;

  return result;
}
