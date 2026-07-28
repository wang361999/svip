'use client';

import AdminSidebar from '@/components/admin/AdminSidebar';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import { apiGet, apiPost } from '@/shared/api/client';

interface RedeemCode {
  id: number;
  code: string;
  days: number;
  used: boolean;
  usedBy: string | null;
  usedAt: string | null;
  createdAt: string;
}

export default function AdminRedeemCodesPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const [codes, setCodes] = useState<RedeemCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [genCount, setGenCount] = useState(10);
  const [genDays, setGenDays] = useState(30);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');

  const loadCodes = async () => {
    try {
      const data = await apiGet<{ codes: RedeemCode[] }>('/api/redeem-codes');
      setCodes(data.codes || []);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '获取兑换码列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated && user?.role !== 'admin') {
      router.push('/');
      return;
    }
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    loadCodes();
  }, [isAuthenticated, user?.role, router]);

  const handleGenerate = async () => {
    setGenerating(true);
    setMessage('');
    try {
      const data = await apiPost<{ message: string; codes: string[] }>('/api/redeem-codes', { count: genCount, days: genDays });
      setMessage(`成功生成 ${data.codes?.length || 0} 个兑换码`);
      loadCodes();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  if (!isAuthenticated || user?.role !== 'admin') return null;

  return (
    <div className="flex bg-dark-950 min-h-screen">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-5xl">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white">兑换码管理</h1>
            <p className="text-dark-400 mt-1">批量生成兑换码，管理VIP会员激活码。</p>
          </div>

          {message && (
            <div className={`p-4 rounded-lg mb-6 ${
              message.includes('成功')
                ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                : 'bg-red-500/10 border border-red-500/30 text-red-400'
            }`}>
              {message}
            </div>
          )}

          {/* 批量生成 */}
          <div className="glass-card p-6 space-y-4 mb-6">
            <h2 className="text-lg font-semibold text-white">批量生成兑换码</h2>
            <div className="flex items-end gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-dark-300 mb-2">生成数量</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={genCount}
                  onChange={(e) => setGenCount(parseInt(e.target.value) || 10)}
                  className="input-dark"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-dark-300 mb-2">有效天数</label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={genDays}
                  onChange={(e) => setGenDays(parseInt(e.target.value) || 30)}
                  className="input-dark"
                />
              </div>
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {generating ? '生成中...' : '批量生成'}
              </button>
            </div>
          </div>

          {/* 兑换码列表 */}
          <div className="glass-card overflow-hidden">
            <div className="px-6 py-4 border-b border-dark-700/50 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">兑换码列表</h2>
              <span className="text-sm text-dark-400">共 {codes.length} 个</span>
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : codes.length === 0 ? (
              <div className="px-6 py-12 text-center text-dark-500">
                暂无兑换码，请先生成
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-dark-400 border-b border-dark-700/50">
                      <th className="text-left py-3 px-6 font-medium">兑换码</th>
                      <th className="text-left py-3 px-6 font-medium">天数</th>
                      <th className="text-left py-3 px-6 font-medium">状态</th>
                      <th className="text-left py-3 px-6 font-medium">使用者</th>
                      <th className="text-left py-3 px-6 font-medium">使用时间</th>
                      <th className="text-left py-3 px-6 font-medium">创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {codes.map((rc) => (
                      <tr key={rc.id} className="border-b border-dark-800/50 hover:bg-dark-800/30 transition-colors">
                        <td className="py-3 px-6 text-white font-mono">{rc.code}</td>
                        <td className="py-3 px-6 text-dark-300">{rc.days}天</td>
                        <td className="py-3 px-6">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                            rc.used
                              ? 'bg-dark-700 text-dark-400'
                              : 'bg-green-500/10 text-green-400 border border-green-500/20'
                          }`}>
                            {rc.used ? '已使用' : '未使用'}
                          </span>
                        </td>
                        <td className="py-3 px-6 text-dark-400">{rc.usedBy || '-'}</td>
                        <td className="py-3 px-6 text-dark-400">
                          {rc.usedAt ? new Date(rc.usedAt).toLocaleString('zh-CN') : '-'}
                        </td>
                        <td className="py-3 px-6 text-dark-400">
                          {new Date(rc.createdAt).toLocaleString('zh-CN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
