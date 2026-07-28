import { z } from 'zod';

export const generateCodesSchema = z.object({
  count: z.number().int().min(1).max(100, '生成数量需在1~100之间').default(10),
  days: z.number().int().min(1).max(3650, '有效天数需在1~3650之间').default(30),
});

export const activateCodeSchema = z.object({
  code: z.string().min(1, '请输入兑换码'),
});
