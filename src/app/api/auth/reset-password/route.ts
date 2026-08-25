import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { resetPasswordSchema } from '@/features/auth/api/auth.schema';
import { authService } from '@/features/auth/api/auth.service';
import { rateLimit, getClientIp } from '@/shared/lib/rate-limit';
import { RateLimitError } from '@/shared/api/errors';

export const dynamic = 'force-dynamic';

export const POST = createHandler(async ({ req }) => {
  const input = withZod(resetPasswordSchema, await req.json());

  // 防爆破：同一 IP 15 分钟内最多 5 次重置尝试（数据库级，跨实例生效）
  const ip = getClientIp(req);
  const { allowed, retryAfterMs } = await rateLimit(`reset:${ip}`, 5, 15 * 60 * 1000);
  if (!allowed) {
    throw new RateLimitError(
      'AUTH_TOO_MANY_ATTEMPTS',
      `尝试次数过多，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`,
    );
  }

  await authService.resetPassword(input);
  return apiSuccess({ message: '密码重置成功' });
});
