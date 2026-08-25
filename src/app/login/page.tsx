'use client';

import LoginForm from '@/components/auth/LoginForm';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';

export default function LoginPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 flex items-center justify-center pt-16 pb-12">
        <div className="w-full max-w-md px-4">
          <div className="glass-card p-8">
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold text-white">登录</h1>
              <p className="text-dark-400 text-sm mt-1">登录以访问完整功能</p>
            </div>
            <LoginForm />
            <div className="mt-5 pt-4 border-t border-dark-700/30 text-center">
              <p className="text-dark-500 text-xs">
                注册即可查看实时K线，<span className="text-amber-400">开通VIP</span>解锁 AI 智能分析与模拟交易
              </p>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}