import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { activateCodeSchema } from '@/features/redeem-codes/api/redeem-codes.schema';
import { redeemCodeService } from '@/features/redeem-codes/api/redeem-codes.service';

export const dynamic = 'force-dynamic';

export const POST = createHandler(async ({ req }) => {
  const payload = requireUser();
  const input = withZod(activateCodeSchema, await req.json());
  const result = await redeemCodeService.activate(payload.userId, input.code);
  return apiSuccess(result);
});
