import { createHandler } from '@/shared/api/handler';
import { parseQuery, withZod } from '@/shared/api/validate';
import { apiSuccess, apiSuccessPaginated } from '@/shared/api/response';
import { requireAdmin } from '@/shared/api/auth-guard';
import { listUsersQuerySchema, updateMembershipSchema } from '@/features/users/api/users.schema';
import { usersService } from '@/features/users/api/users.service';

export const dynamic = 'force-dynamic';

export const GET = createHandler(async ({ req }) => {
  requireAdmin();
  const query = parseQuery(listUsersQuerySchema, req);
  const { items, total, page, pageSize, totalPages } = await usersService.list(query);
  return apiSuccessPaginated(items, total, page, pageSize);
});

export const PUT = createHandler(async ({ req }) => {
  requireAdmin();
  const input = withZod(updateMembershipSchema, await req.json());
  const user = await usersService.updateMembership(input.userId, input.membership);
  return apiSuccess({ membership: user.membership });
});
