'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RegisterForm from '@/components/auth/RegisterForm';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import { apiGet } from '@/shared/api/client';

export default function RegisterPage() {
  // null = 加载中, true = 允许注册, false = 注册已关闭
  const [enableRegistration, setEnableRegistration] = useState<boolean | null>(null);

  useEffect(() => {
    apiGet<{ enableRegistration?: string }>('/api/settings')
      .then((data) => {
        // 严格判断：仅当值为字符串 'false' 时关闭；未设置或其它值均视为开启
        setEnableRegistration(data.enableRegistration !== 'false');
      })
      .catch(() => {
        // 获取失败时默认允许注册，避免误锁
        setEnableRegistration(true);
      });
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 flex items-center justify-center pt-16 pb-12">
        <div className="w-full max-w-md px-4">
          <div className="glass-card p-8">
            {enableRegistration === null ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : enableRegistration ? (
              <>
                <div className="text-center mb-6">
                  <h1 className="text-2xl font-bold text-white">创建账号</h1>
                  <p className="text-dark-400 text-sm mt-1">注册以开始使用交易工具</p>
                </div>
                <RegisterForm />
              </>
            ) : (
              <div className="text-center py-8">
                <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
                  <svg
                    className="w-7 h-7 text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                    />
                  </svg>
                </div>
                <h1 className="text-2xl font-bold text-white mb-2">注册已关闭</h1>
                <p className="text-dark-400 text-sm mb-6">
                  当前平台已关闭新用户注册，如需账号请联系管理员。
                </p>
                <Link
                  href="/login"
                  className="inline-block btn-primary !py-2 px-6 text-sm"
                >
                  前往登录
                </Link>
              </div>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
