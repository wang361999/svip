import { create } from 'zustand';

export interface AuthState {
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
    membership: string;
    membershipExpires?: string | null;
    prefAB9?: boolean | string;
    prefAB9Labels?: boolean | string;
  } | null;
  isAuthenticated: boolean;
  isMember: boolean;
  setUser: (user: AuthState['user']) => void;
  clearUser: () => void;
}

// 检查VIP是否过期
function checkMembershipValid(membership: string, expires?: string | null): boolean {
  if (membership !== 'vip') return false;
  if (!expires) return true; // 没有到期时间，永久有效
  const expiryDate = new Date(expires);
  if (isNaN(expiryDate.getTime())) return true; // 无效日期格式，视为永久
  return expiryDate.getTime() > Date.now();
}

const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isMember: false,
  setUser: (user) => {
    const membership = user?.membership || 'free';
    const isVip = checkMembershipValid(membership, user?.membershipExpires);
    return set({
      user: user ? {
        ...user,
        membership: isVip ? membership : 'free',
        // 将数据库中的字符串 'true'/'false' 转换为布尔值
        prefAB9: user.prefAB9 === true || user.prefAB9 === 'true',
        prefAB9Labels: user.prefAB9Labels === true || user.prefAB9Labels === 'true',
      } : null,
      isAuthenticated: !!user,
      isMember: isVip || user?.role === 'admin',
    });
  },
  clearUser: () => set({ user: null, isAuthenticated: false, isMember: false }),
}));

export default useAuthStore;