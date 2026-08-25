/**
 * 前端统一 API 客户端
 * 封装 fetch，自动处理 { success, data, error } 响应契约
 *
 * @example
 * // GET
 * const trades = await apiGet<TradeRecord[]>('/api/trades');
 *
 * // POST
 * const result = await apiPost<{ message: string }>('/api/trades', tradeData);
 *
 * // 错误处理
 * try {
 *   const data = await apiGet('/api/...');
 * } catch (err) {
 *   setError(err.message); // err 已是 ApiClientError
 * }
 */

/** API 客户端错误 */
export class ApiClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** 标准响应结构 */
interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
  };
}

/** 内部核心请求函数 */
async function request<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    // 禁用缓存 — 每次部署后都获取最新数据
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });

  let json: ApiResponse<T>;
  try {
    json = await res.json();
  } catch {
    throw new ApiClientError('PARSE_ERROR', '响应解析失败', res.status);
  }

  if (!json.success) {
    const err = json.error;
    throw new ApiClientError(
      err?.code || 'UNKNOWN',
      err?.message || `请求失败 (${res.status})`,
      res.status,
      err?.fieldErrors,
    );
  }

  return json.data as T;
}

/** GET 请求 */
export function apiGet<T = unknown>(url: string, options?: Omit<RequestInit, 'method' | 'body'>): Promise<T> {
  return request<T>(url, { ...options, method: 'GET' });
}

/** POST 请求 */
export function apiPost<T = unknown>(url: string, body?: unknown, options?: Omit<RequestInit, 'method' | 'body'>): Promise<T> {
  return request<T>(url, {
    ...options,
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** PUT 请求 */
export function apiPut<T = unknown>(url: string, body?: unknown, options?: Omit<RequestInit, 'method' | 'body'>): Promise<T> {
  return request<T>(url, {
    ...options,
    method: 'PUT',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
