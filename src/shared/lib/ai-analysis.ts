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
 * 供应商级别预配置凭证
 * 当数据库中的 aiApiUrl / aiApiKey / aiModel 为空时，按当前 provider 回退到这里的默认值
 * 这样切换供应商时无需手动输入凭证
 */
const PROVIDER_DEFAULTS: Record<string, { apiUrl: string; apiKey: string; model: string }> = {
  // 模型 1: Agnes-AI (agnes-2.5-flash)
  custom: {
    apiUrl: 'https://api.agnes-ai.cn/v1/chat/completions',
    apiKey: 'sk-cLl30kp5lGb1p8RUmrQRepLg3YcqUYBHbVk1qk4SrL3UKCNh',
    model: 'agnes-2.5-flash',
  },
  // 模型 2: NVIDIA GLM-5.2
  nvidia: {
    apiUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKey: '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',
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
    apiKey: settings.aiApiKey || defaults?.apiKey || '',
    model: settings.aiModel || defaults?.model || meta?.defaultModel || '',
    temperature: parseFloat(settings.aiTemperature || '0.3') || 0.3,
    maxTokens: parseInt(settings.aiMaxTokens || '4000', 10) || 4000,
    analysisInterval: parseInt(settings.aiAnalysisInterval || '0', 10) || 0,
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

  return `${label}:
  最新K线: O=${last.open} H=${last.high} L=${last.low} C=${last.close} V=${last.volume.toFixed(2)}
  涨跌幅: ${changePct.toFixed(2)}%
  近20根最高: ${high20}, 最低: ${low20}
  近20根均价: ${(recentCloses.reduce((s, c) => s + c, 0) / recentCloses.length).toFixed(2)}
  近20根均量: ${avgVol.toFixed(2)}`;
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
const SYSTEM_PROMPT = `你是一位专业的加密货币合约交易分析师，精通技术分析、市场结构和风险管理。

你的任务是分析提供的实时行情数据和技术指标，给出结构化的交易建议。

分析原则：
1. 综合多周期（15分钟、1小时、4小时）信号，寻找共振机会
2. 严格遵守风险控制，止损必须基于技术位，单笔风险不超过2%
3. 止盈设置要符合合理的盈亏比（至少1:1.5）
4. 当市场方向不明确时，明确给出"neutral"（观望）建议
5. 置信度反映你对分析结果的把握程度，0-100

你必须以严格的 JSON 格式返回，不要包含任何其他文字。JSON 格式如下：
{
  "direction": "long" | "short" | "neutral",
  "confidence": 数字(0-100),
  "summary": "一句话总结分析结论",
  "entryPrice": 数字或null,
  "stopLoss": 数字或null,
  "takeProfit1": 数字或null,
  "takeProfit2": 数字或null,
  "reasoning": "详细分析逻辑，包括趋势判断、指标信号、多周期共振等",
  "keyLevels": [{"price": 数字, "type": "支撑/阻力/前高/前低", "note": "说明"}],
  "riskWarning": "当前市场风险提示"
}`;

/** 构建用户 prompt（包含行情数据） */
function buildUserPrompt(
  symbol: string,
  label: string,
  currentPrice: number,
  k15m: KlineData[],
  k1h: KlineData[],
  k4h: KlineData[],
): string {
  const ind15m = computeIndicatorSnapshot(k15m);
  const ind1h = computeIndicatorSnapshot(k1h);
  const ind4h = computeIndicatorSnapshot(k4h);

  return `请分析以下 ${label} (${symbol}) 的实时行情数据：

当前价格: ${currentPrice}

=== 15分钟周期 ===
${buildKlineSummary(k15m, '15M K线')}
技术指标:
${buildIndicatorText(ind15m, currentPrice)}

=== 1小时周期 ===
${buildKlineSummary(k1h, '1H K线')}
技术指标:
${buildIndicatorText(ind1h, currentPrice)}

=== 4小时周期 ===
${buildKlineSummary(k4h, '4H K线')}
技术指标:
${buildIndicatorText(ind4h, currentPrice)}

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
  const timer = setTimeout(() => controller.abort(), 45000); // 45s 超时（推理模型需要更长时间）

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
      throw new Error('AI API 请求超时（45s）');
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

/** 将解析的 JSON 转为标准 AiAnalysisResult */
function normalizeResult(parsed: any, config: AiConfig, rawResponse: string): AiAnalysisResult {
  const direction = ['long', 'short', 'neutral'].includes(parsed.direction)
    ? parsed.direction
    : 'neutral';

  const confidence = Math.max(0, Math.min(100, parseInt(parsed.confidence, 10) || 0));

  return {
    direction: direction as 'long' | 'short' | 'neutral',
    confidence,
    summary: String(parsed.summary || '无摘要'),
    entryPrice: parsed.entryPrice != null ? Number(parsed.entryPrice) || null : null,
    stopLoss: parsed.stopLoss != null ? Number(parsed.stopLoss) || null : null,
    takeProfit1: parsed.takeProfit1 != null ? Number(parsed.takeProfit1) || null : null,
    takeProfit2: parsed.takeProfit2 != null ? Number(parsed.takeProfit2) || null : null,
    reasoning: String(parsed.reasoning || '无分析'),
    keyLevels: Array.isArray(parsed.keyLevels) ? parsed.keyLevels : null,
    riskWarning: parsed.riskWarning ? String(parsed.riskWarning) : null,
    provider: config.provider,
    model: config.model,
    rawResponse,
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

  // 3. 获取多周期 K 线数据
  const [k15m, k1h, k4h] = await Promise.all([
    fetchKlines(symbol, okxId, '15m', 200).catch(() => []),
    fetchKlines(symbol, okxId, '1h', 200).catch(() => []),
    fetchKlines(symbol, okxId, '4h', 200).catch(() => []),
  ]);

  if (k15m.length === 0 && k1h.length === 0 && k4h.length === 0) {
    throw new Error('无法获取 K 线数据');
  }

  // 4. 构建 prompt
  const userPrompt = buildUserPrompt(symbol, label, price, k15m, k1h, k4h);

  // 5. 调用 AI API
  const rawResponse = await callChatCompletions(config, SYSTEM_PROMPT, userPrompt);

  // 6. 解析结果
  const parsed = extractJson(rawResponse);
  const result = normalizeResult(parsed, config, rawResponse);

  return result;
}
