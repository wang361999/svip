import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { withZod } from '@/shared/api/validate';
import { updateStrategyConfigSchema } from '@/features/user/api/strategy.schema';
import { userService } from '@/features/user/api/user.service';
import { normalizeStrategyConfig } from '@/shared/lib/strategies';

export const dynamic = 'force-dynamic';

/** 获取当前用户的策略配置（已规范化，包含所有策略默认值） */
export const GET = createHandler(async () => {
  const payload = requireUser();
  const raw = await userService.getStrategyConfig(payload.userId);
  const config = normalizeStrategyConfig(raw);
  return apiSuccess(config);
});

/** 更新策略配置（合并后存储） */
export const PUT = createHandler(async ({ req }) => {
  const payload = requireUser();
  const input = withZod(updateStrategyConfigSchema, await req.json());
  const normalized = normalizeStrategyConfig(input);
  await userService.updateStrategyConfig(payload.userId, normalized);
  return apiSuccess(normalized);
});
