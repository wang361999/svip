import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { authService } from '@/features/auth/api/auth.service';

export const dynamic = 'force-dynamic';

/** 获取当前登录用户 */
export const GET = createHandler(async () => {
  const payload = requireUser();
  const user = await authService.getCurrentUser(payload);
  return apiSuccess({ user });
});

/** 退出登录（清除 cookie） */
export const POST = createHandler(async () => {
  const response = apiSuccess({});
  response.cookies.set('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
});

/** 删除账户（退出登录别名） */
export const DELETE = createHandler(async () => {
  const response = apiSuccess({});
  response.cookies.set('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
});
