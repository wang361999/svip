/**
 * createHandler — 统一 API 路由处理器
 * 包裹 try/catch，自动把 AppError 转为对应 HTTP 状态码
 *
 * @example
 * export const POST = createHandler(async ({ req }) => {
 *   const input = withZod(loginSchema, await req.json());
 *   const user = await authService.login(input);
 *   return apiSuccess(user);
 * });
 */
import { NextResponse } from 'next/server';
import type { ApiResponse } from '@/shared/types/api';
import { AppError } from './errors';
import { apiError, apiErrorFromApp } from './response';

/** 路由上下文 */
export interface RouteContext {
  req: Request;
  params: Record<string, string | string[]>;
}

/** 处理器函数类型 */
type HandlerFn = (ctx: RouteContext) => Promise<unknown> | unknown;

/**
 * 创建标准 API 路由处理器
 * 自动捕获错误，统一返回 ApiResponse 格式
 */
export function createHandler(fn: HandlerFn) {
  return async (
    req: Request,
    ctx: { params: Record<string, string | string[]> } = { params: {} },
  ): Promise<Response> => {
    try {
      const result = await fn({ req, params: ctx.params });
      // 如果已经是 NextResponse，直接返回
      if (result instanceof NextResponse) return result;
      if (result instanceof Response) return result;
      // 否则包装为成功响应
      return NextResponse.json<ApiResponse>({ success: true, data: result });
    } catch (err) {
      // 已知的应用错误
      if (err instanceof AppError) {
        return apiErrorFromApp(err);
      }
      // 未知错误
      console.error('[UnhandledError]', err);
      return apiError('INTERNAL', '服务器内部错误', 500);
    }
  };
}
