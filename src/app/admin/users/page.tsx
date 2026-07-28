'use client';

import AdminSidebar from '@/components/admin/AdminSidebar';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import { apiGet, apiPut } from '@/shared/api/client';

interface User {
  id: string;
  email: string;
  username: string;
  role: string;
  membership: string;
  createdAt: string;
}

export default function AdminUsersPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (isAuthenticated && user?.role !== 'admin') {
      router.push('/');
      return;
    }

    if (!isAuthenticated) {
      router.push('/login');
      return;
    }

    const loadUsers = async () => {
      try {
        const data = await apiGet<{ items: User[]; total: number; totalPages: number }>(`/api/users?page=${page}&limit=20`);
        setUsers(data.items || []);
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
      } catch {
      } finally {
        setLoading(false);
      }
    };
    loadUsers();
  }, [isAuthenticated, user?.role, page, router]);

  const toggleMembership = async (userId: string, current: string) => {
    const next = current === 'vip' ? 'free' : 'vip';
    try {
      await apiPut('/api/users', { userId, membership: next });
      setUsers(users.map((u) => (u.id === userId ? { ...u, membership: next } : u)));
    } catch {}
  };

  if (!isAuthenticated || user?.role !== 'admin') {
    return null;
  }

  return (
    <div className="flex bg-dark-950 min-h-screen">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-5xl">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white">用户管理</h1>
            <p className="text-dark-400 mt-1">查看用户列表，管理会员权限。共 {total} 位用户</p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="glass-card overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-dark-700/50">
                      <th className="text-left text-dark-400 text-xs font-medium uppercase px-4 py-3">用户名</th>
                      <th className="text-left text-dark-400 text-xs font-medium uppercase px-4 py-3">邮箱</th>
                      <th className="text-left text-dark-400 text-xs font-medium uppercase px-4 py-3">角色</th>
                      <th className="text-left text-dark-400 text-xs font-medium uppercase px-4 py-3">会员</th>
                      <th className="text-left text-dark-400 text-xs font-medium uppercase px-4 py-3">操作</th>
                      <th className="text-left text-dark-400 text-xs font-medium uppercase px-4 py-3">注册时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className="border-b border-dark-800/50 hover:bg-dark-800/30 transition-colors">
                        <td className="px-4 py-3 text-white text-sm">{u.username}</td>
                        <td className="px-4 py-3 text-dark-300 text-sm">{u.email}</td>
                        <td className="px-4 py-3">
                          <span className={`badge ${u.role === 'admin' ? 'badge-admin' : 'badge-user'}`}>
                            {u.role === 'admin' ? '管理员' : '用户'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                            u.membership === 'vip'
                              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                              : u.role === 'admin'
                              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                              : 'bg-dark-700/50 text-dark-400 border border-dark-600/30'
                          }`}>
                            {u.membership === 'vip' ? 'VIP会员' : u.role === 'admin' ? '管理员' : '普通用户'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {u.role !== 'admin' && (
                            <button
                              onClick={() => toggleMembership(u.id, u.membership)}
                              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                                u.membership === 'vip'
                                  ? 'bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20'
                                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20'
                              }`}
                            >
                              {u.membership === 'vip' ? '取消会员' : '设为会员'}
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-dark-400 text-sm">
                          {new Date(u.createdAt).toLocaleDateString('zh-CN')}
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-12 text-center text-dark-500">
                          暂无用户数据
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-4">
                  <button
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page === 1}
                    className="btn-secondary text-sm !py-1.5 !px-3 disabled:opacity-30"
                  >
                    上一页
                  </button>
                  <span className="text-dark-400 text-sm">
                    {page} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage(Math.min(totalPages, page + 1))}
                    disabled={page === totalPages}
                    className="btn-secondary text-sm !py-1.5 !px-3 disabled:opacity-30"
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
