import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { changePasswordSchema } from '@/features/auth/api/auth.schema';
import { authService } from '@/features/auth/api/auth.service';

export const dynamic = 'force-dynamic';

export const PUT = createHandler(async ({ req }) => {
  const payload = requireUser();
  const input = withZod(changePasswordSchema, await req.json());
  await authService.changePassword(payload.userId, input);
  return apiSuccess({ message: '密码修改成功' });
});
