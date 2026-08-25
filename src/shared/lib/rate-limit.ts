/**
 * 数据库级限流器（跨 Serverless 实例可靠）
 *
 * 原理：每次尝试往 VerificationCode 表插一行（type 专用前缀 + email 存限流键），
 * 统计窗口内行数判断是否放行。Vercel 多实例共享同一数据库，计数天然全局。
 *
 * 相比内存方案：多 ~1 次插入/查询的延迟（Neon 冷启动约 300-1500ms），
 * 但换来真正的防爆破能力，对登录/改密这类低频接口完全可接受。
 */

import { prisma } from '@/shared/lib/prisma';

/** 记录一次尝试并检查是否放行 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const since = new Date(Date.now() - windowMs);

  // 统计窗口内已有尝试次数
  const attempts = await prisma.verificationCode.count({
    where: {
      type: 'rate_limit',
      email: key,
      createdAt: { gte: since },
    },
  });

  if (attempts >= limit) {
    // 找最早一条，计算还需等待多久
    const earliest = await prisma.verificationCode.findFirst({
      where: { type: 'rate_limit', email: key, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const retryAfterMs = earliest
      ? Math.max(1000, windowMs - (Date.now() - earliest.createdAt.getTime()))
      : windowMs;
    return { allowed: false, retryAfterMs };
  }

  // 记录本次尝试（code 字段存时间戳便于排查）
  await prisma.verificationCode.create({
    data: {
      email: key,
      code: String(Date.now()),
      type: 'rate_limit',
      expiry: new Date(Date.now() + windowMs),
    },
  });

  // 机会式清理 1 小时前的旧限流记录（5% 概率触发，避免每次请求都清）
  if (Math.random() < 0.05) {
    prisma.verificationCode
      .deleteMany({
        where: { type: 'rate_limit', createdAt: { lt: new Date(Date.now() - 3600_000) } },
      })
      .catch(() => {});
  }

  return { allowed: true, retryAfterMs: 0 };
}

/**
 * 从请求头提取客户端真实 IP
 *
 * 优先级：x-real-ip（Vercel 边缘设置，客户端不可伪造）
 *       → x-forwarded-for 最后一跳（Vercel 实测会重写整个头，取末位在通用代理链下也最可信）
 *       → 'unknown'
 */
export function getClientIp(req: Request): string {
  const real = req.headers.get('x-real-ip');
  if (real && real.trim()) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return 'unknown';
}
