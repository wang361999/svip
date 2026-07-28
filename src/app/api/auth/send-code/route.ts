import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { sendCodeSchema } from '@/features/auth/api/auth.schema';
import { authService } from '@/features/auth/api/auth.service';

export const dynamic = 'force-dynamic';

export const POST = createHandler(async ({ req }) => {
  const input = withZod(sendCodeSchema, await req.json());
  const result = await authService.sendCode(input);
  return apiSuccess(result);
});
