'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import { apiPost } from '@/shared/api/client';

export default function RegisterForm() {
  const router = useRouter();
  const { setUser } = useAuthStore();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0); // 发送验证码倒计时（秒）
  const [sendingCode, setSendingCode] = useState(false);

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
      setError('请先输入邮箱地址');
      return;
    }

    setSendingCode(true);
    setError('');

    try {
      const result = await apiPost<{ devCode?: string }>('/api/auth/send-code', { email, type: 'register' });

      // 开发模式：后端返回验证码时自动填充
      if (result.devCode) {
        setVerifyCode(result.devCode);
        setError(`开发模式：验证码已自动填充 ${result.devCode}`);
      }

      // 开始60秒倒计时
      setCountdown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setSendingCode(false);
    }
  }, [email]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('两次密码输入不一致');
      return;
    }

    if (password.length < 6) {
      setError('密码长度至少6位');
      return;
    }

    if (!verifyCode) {
      setError('请输入邮箱验证码');
      return;
    }

    setLoading(true);

    try {
      await apiPost<any>('/api/auth/register', { email, username, password, verifyCode });

      // Auto login after register
      try {
        const result = await apiPost<{ user: any }>('/api/auth/login', { email, password, rememberMe: false });
        setUser(result.user);
        router.push('/trading');
      } catch {
        router.push('/login');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-dark-300 mb-1.5">
          用户名
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="input-dark"
          placeholder="你的用户名"
          required
        />
      </div>

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

      {/* 邮箱验证码输入区域 */}
      <div>
        <label className="block text-sm font-medium text-dark-300 mb-1.5">
          邮箱验证码
        </label>
        <div className="flex gap-3">
          <input
            type="text"
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value)}
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
            {countdown > 0 ? `${countdown}秒后重试` : sendingCode ? '发送中...' : '发送验证码'}
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-dark-300 mb-1.5">
          密码
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input-dark"
          placeholder="至少6位密码"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-dark-300 mb-1.5">
          确认密码
        </label>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="input-dark"
          placeholder="再次输入密码"
          required
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? '注册中...' : '创建账号'}
      </button>

      <div className="text-center text-sm text-dark-400">
        已有账号？{' '}
        <Link href="/login" className="text-blue-400 hover:text-blue-300">
          立即登录
        </Link>
      </div>
    </form>
  );
}
