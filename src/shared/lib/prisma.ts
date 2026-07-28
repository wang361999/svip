import { PrismaClient } from '@prisma/client';

/**
 * Prisma 客户端单例
 *
 * 优化点：
 * 1. 全局单例 — 避免热重载时创建多个连接
 * 2. 连接池参数 — 适配 Neon serverless（connection_limit=1, pool_timeout）
 * 3. 带重试的查询包装 — Neon 冷启动时第一次请求可能超时
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** 构建带连接池参数的数据库 URL（适配 Neon serverless） */
function buildDbUrl(): string {
  const baseUrl = process.env.DATABASE_URL || '';
  if (!baseUrl) return baseUrl;
  // 如果 URL 已包含这些参数就不重复添加
  const sep = baseUrl.includes('?') ? '&' : '?';
  const params = [
    'connection_limit=1',    // serverless 每函数实例只建 1 个连接
    'connect_timeout=15',     // 连接超时 15s（Neon 冷启动需要时间）
    'pool_timeout=10',       // 连接池等待超时
  ].filter((p) => !baseUrl.includes(p.split('=')[0]));
  return params.length > 0 ? `${baseUrl}${sep}${params.join('&')}` : baseUrl;
}

/** 带重试的 Prisma 客户端工厂 */
function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: buildDbUrl(),
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * 带重试的数据库查询包装器
 *
 * Neon 冷启动时首次请求可能需要 2-3 秒唤醒，
 * 此函数在连接失败时自动重试，避免偶发性 P1001 错误。
 *
 * @example
 * const user = await withRetry(() => prisma.user.findUnique({ where: { id } }));
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      // 只对连接类错误重试（P1001 = 无法连接, P1002 = 连接超时, P2024 = 连接池超时）
      const isConnectionError =
        error?.code === 'P1001' ||
        error?.code === 'P1002' ||
        error?.code === 'P2024' ||
        error?.message?.includes('Can\'t reach database') ||
        error?.message?.includes('Timed out') ||
        error?.message?.includes('Connection refused');

      if (!isConnectionError || attempt === maxRetries) {
        throw error;
      }

      // 指数退避：1s → 2s → 4s
      const wait = delayMs * Math.pow(2, attempt);
      console.warn(`[Prisma] 连接失败，${wait}ms 后重试 (${attempt + 1}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}
