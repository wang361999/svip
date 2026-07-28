'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/shared/api/client';

export default function ForgotPasswordPage() {
  const router = useRouter();
  // 步骤1：输入邮箱
  // 步骤2：输入验证码 + 新密码
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // 倒计时定时器
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [countdown]);

  /**
   * 发送验证码
   */
  const handleSendCode = useCallback(async () => {
    if (!email) {
      setError('请输入邮箱地址');
      return;
    }

    setSendingCode(true);
    setError('');

    try {
      await apiPost('/api/auth/send-code', { email, type: 'reset' });

      // 进入第二步
      setStep(2);
      setCountdown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setSendingCode(false);
    }
  }, [email]);

  /**
   * 重置密码
   */
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!code) {
      setError('请输入验证码');
      return;
    }

    if (newPassword.length < 6) {
      setError('密码长度至少6位');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('两次密码输入不一致');
      return;
    }

    setLoading(true);

    try {
      await apiPost<{ message: string }>('/api/auth/reset-password', { email, code, newPassword });

      setSuccess('密码重置成功！即将跳转到登录页面...');
      // 3秒后跳转到登录页
      setTimeout(() => {
        router.push('/login');
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重置密码失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* 标题 */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">找回密码</h1>
          <p className="text-dark-400">
            {step === 1 ? '输入您的邮箱地址获取验证码' : '输入验证码并设置新密码'}
          </p>
        </div>

        {/* 表单容器 */}
        <div className="bg-dark-800 rounded-2xl p-8 border border-dark-700 shadow-xl">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm mb-4">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm mb-4">
              {success}
            </div>
          )}

          {/* 步骤1：输入邮箱 */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-1.5">
                  邮箱地址
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input-dark"
                  placeholder="your@email.com"
                  required
                />
              </div>

              <button
                type="button"
                onClick={handleSendCode}
                disabled={sendingCode || !email}
                className="btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sendingCode ? '发送中...' : '发送验证码'}
              </button>
            </div>
          )}

          {/* 步骤2：输入验证码 + 新密码 */}
          {step === 2 && (
            <form onSubmit={handleResetPassword} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-1.5">
                  验证码
                </label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="input-dark flex-1"
                    placeholder="6位验证码"
                    maxLength={6}
                    required
                  />
                  <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={countdown > 0 || sendingCode}
                    className="px-4 py-2 rounded-lg bg-dark-700 border border-dark-500 text-sm font-medium text-dark-200 hover:bg-dark-600 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {countdown > 0 ? `${countdown}秒后重试` : sendingCode ? '发送中...' : '重新发送'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-dark-300 mb-1.5">
                  新密码
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="input-dark"
                  placeholder="至少6位新密码"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-dark-300 mb-1.5">
                  确认新密码
                </label>
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
                {loading ? '重置中...' : '重置密码'}
              </button>
            </form>
          )}

          {/* 返回登录 */}
          <div className="text-center text-sm text-dark-400 mt-6">
            <Link href="/login" className="text-blue-400 hover:text-blue-300">
              返回登录
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
