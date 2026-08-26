'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import useAuthStore from '@/store/authStore';
import { apiGet, apiPost, apiPut } from '@/shared/api/client';

// 平台全部功能列表
const FEATURES = [
  '斐波那契自动画线',
  '分型出场信号',
  '江恩角度线',
  '三合一入场信号',
];

export default function ProfilePage() {
  const router = useRouter();
  const { user, isAuthenticated, setUser, clearUser } = useAuthStore();
  const [checking, setChecking] = useState(true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [showVipNotice, setShowVipNotice] = useState(false);

  // 兑换码激活相关状态
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemLoading, setRedeemLoading] = useState(false);
  const [redeemMessage, setRedeemMessage] = useState('');
  const [redeemError, setRedeemError] = useState('');

  // 画线偏好设置状态
  const [prefAB9, setPrefAB9] = useState(true);
  const [prefAutoFib, setPrefAutoFib] = useState(false);
  const [prefAB9Labels, setPrefAB9Labels] = useState(true);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // VIP 会员或管理员视为已解锁全部功能
  const isVip = user?.membership === 'vip' || user?.role === 'admin';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meData = await apiGet<{ user: any }>('/api/auth/me');
        if (!cancelled) {
          setUser(meData.user);
        }
      } catch {
        if (!cancelled) {
          router.push('/login');
        }
      } finally {
        if (!cancelled) {
          setChecking(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [router, setUser]);

  // VIP用户加载画线偏好设置
  useEffect(() => {
    if (!isVip) return;
    let cancelled = false;
    (async () => {
      try {
        const prefs = await apiGet<{ prefAB9: boolean; prefAutoFib: boolean; prefAB9Labels: boolean }>('/api/user/preferences');
        if (cancelled) return;
        if (prefs.prefAB9 !== undefined) setPrefAB9(prefs.prefAB9);
        if (prefs.prefAutoFib !== undefined) setPrefAutoFib(prefs.prefAutoFib);
        if (prefs.prefAB9Labels !== undefined) setPrefAB9Labels(prefs.prefAB9Labels);
        setPrefsLoaded(true);
      } catch {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isVip]);

  // 切换画线偏好并持久化
  const togglePref = async (key: 'prefAB9' | 'prefAutoFib' | 'prefAB9Labels', value: boolean) => {
    // 本地立即更新
    if (key === 'prefAB9') setPrefAB9(value);
    if (key === 'prefAutoFib') setPrefAutoFib(value);
    if (key === 'prefAB9Labels') setPrefAB9Labels(value);
    // 同步到后端
    try {
      await apiPut('/api/user/preferences', { [key]: value });
    } catch { /* 忽略保存失败，下次加载会恢复 */ }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (newPassword !== confirmPassword) {
      setError('两次新密码输入不一致');
      return;
    }
    if (newPassword.length < 6) {
      setError('新密码长度至少6位');
      return;
    }

    setLoading(true);
    try {
      const result = await apiPut<{ message: string }>('/api/auth/password', { currentPassword, newPassword });
      setSuccess(result.message);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改失败');
    } finally {
      setLoading(false);
    }
  };

  // 激活兑换码
  const handleRedeemCode = async () => {
    setRedeemError('');
    setRedeemMessage('');
    const trimmed = redeemCode.trim();
    if (!trimmed) {
      setRedeemError('请输入兑换码');
      return;
    }
    setRedeemLoading(true);
    try {
      const result = await apiPost<{ message: string }>('/api/redeem-codes/activate', { code: trimmed });
      setRedeemMessage(result.message);
      setRedeemCode('');
      // 激活成功后刷新用户信息
      const meData = await apiGet<{ user: any }>('/api/auth/me');
      setUser(meData.user);
    } catch (err) {
      setRedeemError(err instanceof Error ? err.message : '激活失败');
    } finally {
      setRedeemLoading(false);
    }
  };

  const handleLogout = async () => {
    await apiPost('/api/auth/me');
    clearUser();
    router.push('/login');
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-950">
        <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 flex items-center justify-center pt-16 pb-12">
        <div className="w-full max-w-md px-4">
          <div className="glass-card p-8">
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold text-white">个人中心</h1>
              <p className="text-dark-400 text-sm mt-1">管理你的账户信息</p>
            </div>

            {/* 用户信息 */}
            <div className="bg-dark-800/50 rounded-lg p-4 mb-6 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-dark-400">用户名</span>
                <span className="text-white">{user?.username}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-dark-400">邮箱</span>
                <span className="text-white">{user?.email}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-dark-400">角色</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  user?.role === 'admin'
                    ? 'bg-red-500/10 text-red-400'
                    : 'bg-blue-500/10 text-blue-400'
                }`}>
                  {user?.role === 'admin' ? '管理员' : '用户'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-dark-400">会员状态</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  isVip
                    ? 'bg-yellow-500/10 text-yellow-400'
                    : 'bg-gray-500/10 text-gray-400'
                }`}>
                  {isVip ? 'VIP会员' : '普通用户'}
                </span>
              </div>
            </div>

            {/* 功能列表 */}
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white mb-4">功能列表</h2>
              <div className="bg-dark-800/50 rounded-lg p-4 space-y-3">
                {FEATURES.map((feature) => (
                  <div key={feature} className="flex items-center justify-between text-sm">
                    <span className="text-dark-300">{feature}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      isVip
                        ? 'bg-green-500/10 text-green-400'
                        : 'bg-orange-500/10 text-orange-400'
                    }`}>
                      {isVip ? '已解锁' : '需开通VIP'}
                    </span>
                  </div>
                ))}
              </div>
              {!isVip && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowVipNotice((v) => !v)}
                    className="mt-4 w-full py-2.5 rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 text-dark-900 font-medium text-sm hover:from-yellow-400 hover:to-amber-400 transition-colors"
                  >
                    开通VIP
                  </button>
                  {showVipNotice && (
                    <div className="mt-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 text-sm">
                      如需开通VIP会员，请联系平台管理员获取权限。
                    </div>
                  )}
                </>
              )}

              {/* 兑换码激活 */}
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={redeemCode}
                    onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
                    className="input-dark flex-1"
                    placeholder="输入兑换码（XXXX-XXXX-XXXX）"
                    maxLength={19}
                  />
                  <button
                    type="button"
                    onClick={handleRedeemCode}
                    disabled={redeemLoading || !redeemCode.trim()}
                    className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap text-sm !px-4"
                  >
                    {redeemLoading ? '激活中...' : '激活'}
                  </button>
                </div>
                {redeemMessage && (
                  <div className="mt-2 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
                    {redeemMessage}
                  </div>
                )}
                {redeemError && (
                  <div className="mt-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                    {redeemError}
                  </div>
                )}
              </div>
            </div>

            {/* 画线偏好设置（仅VIP可见） */}
            {isVip && prefsLoaded && (
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-white mb-2">画线偏好设置</h2>
                <p className="text-dark-400 text-xs mb-4">
                  开关状态会自动保存，打开K线图时生效。建议只开启一种画线，避免图表上同时显示两种画线造成干扰。
                </p>
                <div className="bg-dark-800/50 rounded-lg p-4 space-y-4">
                  {/* AB9线开关 */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white font-medium">AB9线</div>
                      <div className="text-xs text-dark-400 mt-0.5">自动绘制AB9九条价格线</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => togglePref('prefAB9', !prefAB9)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        prefAB9 ? 'bg-cyan-500' : 'bg-dark-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          prefAB9 ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  {/* AB9标签开关 */}
                  <div className={`flex items-center justify-between ${!prefAB9 ? 'opacity-40' : ''}`}>
                    <div>
                      <div className="text-sm text-white font-medium">AB9标签</div>
                      <div className="text-xs text-dark-400 mt-0.5">在AB9线上显示序号标签</div>
                    </div>
                    <button
                      type="button"
                      disabled={!prefAB9}
                      onClick={() => togglePref('prefAB9Labels', !prefAB9Labels)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        prefAB9Labels ? 'bg-cyan-500' : 'bg-dark-600'
                      } ${!prefAB9 ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          prefAB9Labels ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  {/* 分隔线 */}
                  <div className="border-t border-dark-700/50 pt-4">
                    {/* 自动斐波那契线开关 */}
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-white font-medium">自动斐波那契线</div>
                        <div className="text-xs text-dark-400 mt-0.5">自动绘制斐波那契回调线</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => togglePref('prefAutoFib', !prefAutoFib)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          prefAutoFib ? 'bg-sky-500' : 'bg-dark-600'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            prefAutoFib ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {/* 同时开启时的提示 */}
                  {prefAB9 && prefAutoFib && (
                    <div className="p-2.5 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-xs">
                      两种画线同时开启，图表上会显示两组画线，建议只保留一种。
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 改密码表单 */}
            <h2 className="text-lg font-semibold text-white mb-4">修改密码</h2>
            <form onSubmit={handleChangePassword} className="space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  {error}
                </div>
              )}
              {success && (
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
                  {success}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-dark-300 mb-1.5">当前密码</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="input-dark"
                  placeholder="请输入当前密码"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-dark-300 mb-1.5">新密码</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="input-dark"
                  placeholder="至少6位"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-dark-300 mb-1.5">确认新密码</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="input-dark"
                  placeholder="再次输入新密码"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? '修改中...' : '修改密码'}
              </button>
            </form>

            <div className="mt-6 pt-4 border-t border-dark-700/50 space-y-2">
              <Link href="/" className="block w-full text-center btn-secondary text-sm !py-2">
                返回主页
              </Link>
              <button
                onClick={handleLogout}
                className="block w-full text-center text-red-400 hover:text-red-300 text-sm py-2 transition-colors"
              >
                退出登录
              </button>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
