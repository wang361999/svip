/**
 * zod 校验工具
 * - withZod: 校验 body，失败抛 ValidationError
 * - parseQuery: 校验 URL query 参数
 * - parseParams: 校验路由参数
 */
import type { ZodSchema } from 'zod';
import { ValidationError } from './errors';

/**
 * 校验请求体，返回强类型数据
 * @example const input = withZod(loginSchema, await req.json());
 */
export function withZod<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = [];
      fieldErrors[key].push(issue.message);
    }
    const firstMessage = result.error.issues[0]?.message ?? '参数错误';
    throw new ValidationError('VALIDATION_FAILED', firstMessage, fieldErrors);
  }
  return result.data;
}

/**
 * 校验 URL 查询参数（req.nextUrl.searchParams 或普通 URL）
 * @example const query = parseQuery(listSchema, req);
 */
export function parseQuery<T>(schema: ZodSchema<T>, req: Request): T {
  const url = new URL(req.url);
  const obj: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    obj[k] = v;
  });
  return withZod(schema, obj);
}

/**
 * 校验路由参数
 * @example const { id } = parseParams(idSchema, ctx.params);
 */
export function parseParams<T>(schema: ZodSchema<T>, params: Record<string, string | string[]>): T {
  return withZod(schema, params);
}
