import type { RedeemCode } from '@prisma/client';

export type RedeemCodeItem = Pick<RedeemCode, 'id' | 'code' | 'days' | 'used' | 'usedBy' | 'usedAt' | 'createdAt'>;
