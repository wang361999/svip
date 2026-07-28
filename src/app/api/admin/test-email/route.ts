import { createHandler } from '@/shared/api/handler';
import { withZod } from '@/shared/api/validate';
import { apiSuccess } from '@/shared/api/response';
import { requireAdmin } from '@/shared/api/auth-guard';
import { z } from 'zod';
import { sendTestEmail } from '@/shared/lib/email';

export const dynamic = 'force-dynamic';

const testEmailSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
});

export const POST = createHandler(async ({ req }) => {
  requireAdmin();
  const { email } = withZod(testEmailSchema, await req.json());
  await sendTestEmail(email);
  return apiSuccess({ message: '测试邮件已发送' });
});
