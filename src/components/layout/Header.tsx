'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import usePriceStore from '@/store/priceStore';
import useAuthStore from '@/store/authStore';
import { apiPost } from '@/shared/api/client';

export default function Header() {
  const { currentPrice, changePercent24h, priceDirection } = usePriceStore();
  const { user, isAuthenticated, clearUser } = useAuthStore();
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleLogout = async () => {
    try {
      await apiPost('/api/auth/me');
    } catch {
      // ignore errors, always clear user and redirect
    }
    clearUser();
    window.location.href = '/login';
  };

  const priceClass = priceDirection === 'up' ? 'price-up' : priceDirection === 'down' ? 'price-down' : '';

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled ? 'glass' : 'bg-dark-900/80'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-700 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">ETH</span>
            </div>
            <span className="text-xl font-bold text-white hidden sm:block">
              ETH Trading
            </span>
          </Link>

          {/* Price Ticker */}
          {currentPrice > 0 && (
            <div className="hidden md:flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <span className="text-dark-400 text-sm">ETH/USDT</span>
                <span className={`font-mono text-lg font-bold ${priceClass}`}>
                  ${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div className={`px-2 py-1 rounded text-xs font-medium ${
                parseFloat(changePercent24h) >= 0
                  ? 'bg-green-500/10 text-green-400'
                  : 'bg-red-500/10 text-red-400'
              }`}>
                {parseFloat(changePercent24h) >= 0 ? '+' : ''}{changePercent24h}%
              </div>
            </div>
          )}

          {/* Navigation */}
          <nav className="hidden md:flex items-center space-x-1">
            <Link href="/" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800 transition-colors">
              首页
            </Link>
            <Link href="/trading" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800 transition-colors">
              交易
            </Link>
            {isAuthenticated && (
              <Link href="/writer" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800 transition-colors">
                消息面
              </Link>
            )}
            {isAuthenticated ? (
              <>
                {user?.role === 'admin' && (
                  <Link href="/admin" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800 transition-colors">
                    管理
                  </Link>
                )}
                <div className="flex items-center space-x-2 ml-2">
                  <span className="text-sm text-dark-400">{user?.username}</span>
                  <button
                    onClick={handleLogout}
                    className="btn-secondary text-sm !py-1.5 !px-3"
                  >
                    退出
                  </button>
                </div>
              </>
            ) : (
              <>
                <Link href="/login" className="btn-secondary text-sm !py-1.5 !px-4">
                  登录
                </Link>
                <Link href="/register" className="btn-primary text-sm !py-1.5 !px-4">
                  注册
                </Link>
              </>
            )}
          </nav>

          {/* Mobile menu button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 text-dark-300 hover:text-white"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden py-4 border-t border-dark-700">
            <nav className="flex flex-col space-y-2">
              <Link href="/" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800">
                首页
              </Link>
              <Link href="/trading" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800">
                交易
              </Link>
              {isAuthenticated && (
                <Link href="/writer" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800">
                  消息面
                </Link>
              )}
              {isAuthenticated ? (
                <>
                  {user?.role === 'admin' && (
                    <Link href="/admin" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800">
                      管理
                    </Link>
                  )}
                  <button onClick={handleLogout} className="px-3 py-2 text-left text-dark-300 hover:text-white rounded-lg hover:bg-dark-800">
                    退出登录
                  </button>
                </>
              ) : (
                <>
                  <Link href="/login" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800">
                    登录
                  </Link>
                  <Link href="/register" className="px-3 py-2 text-dark-300 hover:text-white rounded-lg hover:bg-dark-800">
                    注册
                  </Link>
                </>
              )}
            </nav>
          </div>
        )}
      </div>

      {/* Mobile price ticker */}
      {currentPrice > 0 && (
        <div className="md:hidden px-4 py-2 border-t border-dark-700/50 flex items-center justify-between text-sm">
          <span className="text-dark-400">ETH/USDT</span>
          <span className={`font-mono font-bold ${priceClass}`}>
            ${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
            parseFloat(changePercent24h) >= 0
              ? 'bg-green-500/10 text-green-400'
              : 'bg-red-500/10 text-red-400'
          }`}>
            {parseFloat(changePercent24h) >= 0 ? '+' : ''}{changePercent24h}%
          </span>
        </div>
      )}
    </header>
  );
}