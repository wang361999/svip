import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { resetPasswordSchema } from '@/features/auth/api/auth.schema';
import { authService } from '@/features/auth/api/auth.service';

export const dynamic = 'force-dynamic';

export const POST = createHandler(async ({ req }) => {
  const input = withZod(resetPasswordSchema, await req.json());
  await authService.resetPassword(input);
  return apiSuccess({ message: '密码重置成功' });
});
