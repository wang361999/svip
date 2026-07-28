import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireAdmin } from '@/shared/api/auth-guard';
import { generateCodesSchema } from '@/features/redeem-codes/api/redeem-codes.schema';
import { redeemCodeService } from '@/features/redeem-codes/api/redeem-codes.service';

export const dynamic = 'force-dynamic';

export const GET = createHandler(async () => {
  requireAdmin();
  const codes = await redeemCodeService.list();
  return apiSuccess({ codes });
});

export const POST = createHandler(async ({ req }) => {
  requireAdmin();
  const input = withZod(generateCodesSchema, await req.json());
  const codes = await redeemCodeService.generate(input.count, input.days);
  return apiSuccess({ message: `成功生成 ${codes.length} 个兑换码`, codes });
});
