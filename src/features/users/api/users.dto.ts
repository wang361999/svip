import type { User } from '@prisma/client';

export type UserListItem = Pick<User, 'id' | 'email' | 'username' | 'role' | 'membership' | 'membershipExpires' | 'createdAt'>;
