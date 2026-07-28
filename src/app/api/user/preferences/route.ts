import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { updatePreferencesSchema } from '@/features/user/api/user.schema';
import { userService } from '@/features/user/api/user.service';

export const dynamic = 'force-dynamic';

export const GET = createHandler(async () => {
  const payload = requireUser();
  const preferences = await userService.getPreferences(payload.userId);
  return apiSuccess(preferences);
});

export const PUT = createHandler(async ({ req }) => {
  const payload = requireUser();
  const input = withZod(updatePreferencesSchema, await req.json());
  const preferences = await userService.updatePreferences(payload.userId, input);
  return apiSuccess(preferences);
});
