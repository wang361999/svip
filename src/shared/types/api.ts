/**
 * 统一 API 响应契约
 * 所有 API 端点（成功/失败）都返回此结构
 */

/** 标准 API 响应 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

/** 错误信息 */
export interface ApiError {
  /** 机器可读错误码，如 'AUTH_INVALID_CREDENTIALS' */
  code: string;
  /** 用户可读错误信息 */
  message: string;
  /** 字段级错误（zod 校验失败时） */
  fieldErrors?: Record<string, string[]>;
}
