import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { registerSchema } from '@/features/auth/api/auth.schema';
import { authService } from '@/features/auth/api/auth.service';

export const dynamic = 'force-dynamic';

export const POST = createHandler(async ({ req }) => {
  const input = withZod(registerSchema, await req.json());
  const user = await authService.register(input);
  return apiSuccess({ user });
});
