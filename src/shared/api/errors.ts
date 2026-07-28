/**
 * 统一错误体系
 * - AppError 为基类，携带 code + status + message
 * - 子类对应不同 HTTP 状态码
 * - createHandler 自动捕获并转为 ApiResponse
 */

/** 应用错误基类 */
export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 400 - 业务逻辑错误 */
export class BusinessError extends AppError {
  constructor(code: string, message: string) {
    super(code, 400, message);
    this.name = 'BusinessError';
  }
}

/** 401 - 未认证 */
export class AuthError extends AppError {
  constructor(code = 'AUTH_UNAUTHORIZED', message = '请先登录') {
    super(code, 401, message);
    this.name = 'AuthError';
  }
}

/** 403 - 无权限 */
export class ForbiddenError extends AppError {
  constructor(code = 'AUTH_FORBIDDEN', message = '无权访问') {
    super(code, 403, message);
    this.name = 'ForbiddenError';
  }
}

/** 404 - 资源不存在 */
export class NotFoundError extends AppError {
  constructor(code = 'NOT_FOUND', message = '资源不存在') {
    super(code, 404, message);
    this.name = 'NotFoundError';
  }
}

/** 409 - 冲突（如邮箱已注册） */
export class ConflictError extends AppError {
  constructor(code = 'CONFLICT', message = '资源冲突') {
    super(code, 409, message);
    this.name = 'ConflictError';
  }
}

/** 422 - 参数校验失败 */
export class ValidationError extends AppError {
  constructor(
    code = 'VALIDATION_FAILED',
    message = '参数校验失败',
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(code, 422, message);
    this.name = 'ValidationError';
  }
}

/** 429 - 请求过于频繁 */
export class RateLimitError extends AppError {
  constructor(code = 'RATE_LIMIT', message = '请求过于频繁，请稍后重试') {
    super(code, 429, message);
    this.name = 'RateLimitError';
  }
}
