import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { sendCodeSchema } from '@/features/auth/api/auth.schema';
import { authService } from '@/features/auth/api/auth.service';
import { rateLimit, getClientIp } from '@/shared/lib/rate-limit';
import { RateLimitError } from '@/shared/api/errors';

export const dynamic = 'force-dynamic';

export const POST = createHandler(async ({ req }) => {
  const input = withZod(sendCodeSchema, await req.json());

  // 防邮件轰炸：同一 IP 10 分钟内最多 5 次发送（邮箱级 60s 限流在 service 内另有一层）
  const ip = getClientIp(req);
  const { allowed, retryAfterMs } = await rateLimit(`sendcode:${ip}`, 5, 10 * 60 * 1000);
  if (!allowed) {
    throw new RateLimitError(
      'AUTH_TOO_MANY_ATTEMPTS',
      `发送过于频繁，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`,
    );
  }

  const result = await authService.sendCode(input);
  return apiSuccess(result);
});
