import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireAdmin } from '@/shared/api/auth-guard';
import { updateSettingsSchema } from '@/features/settings/api/settings.schema';
import { settingsService } from '@/features/settings/api/settings.service';

export const dynamic = 'force-dynamic';

export const GET = createHandler(async () => {
  const settings = await settingsService.getSettings();
  return apiSuccess(settings);
});

export const PUT = createHandler(async ({ req }) => {
  requireAdmin();
  const input = withZod(updateSettingsSchema, await req.json());
  const settings = await settingsService.updateSettings(input);
  return apiSuccess(settings);
});
