/**
 * 统一响应工具
 * 所有 API 端点通过 apiSuccess / apiError 返回标准 ApiResponse
 */
import { NextResponse } from 'next/server';
import type { ApiResponse, ApiError } from '@/shared/types/api';
import { AppError } from './errors';

/** 防缓存的响应头 */
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

/** 成功响应 */
export function apiSuccess<T>(data: T, status = 200): NextResponse<ApiResponse<T>> {
  return NextResponse.json<ApiResponse<T>>({ success: true, data }, { status, headers: NO_CACHE_HEADERS });
}

/** 失败响应 */
export function apiError(
  code: string,
  message: string,
  status = 400,
  fieldErrors?: Record<string, string[]>,
): NextResponse<ApiResponse<never>> {
  const error: ApiError = { code, message };
  if (fieldErrors) error.fieldErrors = fieldErrors;
  return NextResponse.json<ApiResponse<never>>({ success: false, error }, { status, headers: NO_CACHE_HEADERS });
}

/** 从 AppError 构建响应 */
export function apiErrorFromApp(err: AppError): NextResponse<ApiResponse<never>> {
  // ValidationError 子类携带 fieldErrors
  const fieldErrors = 'fieldErrors' in err ? (err as { fieldErrors?: Record<string, string[]> }).fieldErrors : undefined;
  return apiError(err.code, err.message, err.status, fieldErrors);
}

/** 分页成功响应 */
export function apiSuccessPaginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): NextResponse<ApiResponse<{ items: T[]; total: number; page: number; pageSize: number; totalPages: number }>> {
  return apiSuccess({
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  });
}
