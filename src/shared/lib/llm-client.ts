/**
 * LLM 客户端（OpenAI 兼容协议）
 *
 * 三个环境变量控制，换厂商只改配置不改代码：
 *   LLM_BASE_URL  默认 https://api.deepseek.com
 *   LLM_API_KEY   必填（DeepSeek / 硅基流动 / 智谱 / OpenRouter 均兼容）
 *   LLM_MODEL     默认 deepseek-chat
 *
 * 设计：失败返回 null（不抛异常），调用方降级到模板文案。
 * 结构分析的数字全部来自规则引擎，LLM 挂了只影响文笔不影响数据。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

const BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';

/** LLM 是否可用（key 未配置时直接走模板，不发起请求） */
export function llmConfigured(): boolean {
  return API_KEY.length > 0;
}

/** 当前模型名（用于前端标注） */
export function llmModelName(): string {
  return MODEL;
}

/**
 * 调用 chat completions
 * @param timeoutMs 超时（默认 30s，Vercel 函数上限内）
 * @returns 失败（未配置/网络/超时/非200/空内容）一律返回 null
 */
export async function llmChat(
  messages: LlmMessage[],
  options: { timeoutMs?: number; temperature?: number; jsonMode?: boolean } = {},
): Promise<LlmResult | null> {
  if (!API_KEY) return null;
  const { timeoutMs = 30_000, temperature = 0.7, jsonMode = false } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_tokens: 2000,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[LLM] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      console.error('[LLM] 空响应');
      return null;
    }
    return {
      text,
      model: data?.model || MODEL,
      promptTokens: data?.usage?.prompt_tokens ?? 0,
      completionTokens: data?.usage?.completion_tokens ?? 0,
    };
  } catch (err: any) {
    console.error(`[LLM] 调用失败: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
