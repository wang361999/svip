import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { loginSchema } from '@/features/auth/api/auth.schema';
import { authService } from '@/features/auth/api/auth.service';

export const dynamic = 'force-dynamic';

export const POST = createHandler(async ({ req }) => {
  const input = withZod(loginSchema, await req.json());
  const { user, token, maxAge } = await authService.login(input);

  const response = apiSuccess({ user });
  response.cookies.set('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    path: '/',
  });
  return response;
});
