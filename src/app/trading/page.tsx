'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import PriceTicker from '@/components/trading/PriceTicker';
import KlineChart from '@/components/trading/KlineChart';
import useAuthStore from '@/store/authStore';
import { apiGet } from '@/shared/api/client';

export default function TradingPage() {
  const router = useRouter();
  const { isAuthenticated, setUser } = useAuthStore();
  const [checking, setChecking] = useState(true);
  const [showPriceCard, setShowPriceCard] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

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

      // 加载显示配置（独立的 try/catch，不阻塞认证流程）
      try {
        const settings = await apiGet<Record<string, string>>('/api/settings');
        if (!cancelled) {
          setShowPriceCard(settings.showPriceCard !== 'false');
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [router, setUser]);

  // 全屏状态监听
  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const enterFullscreen = useCallback(async () => {
    try {
      const el = document.documentElement;
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if ((el as any).webkitRequestFullscreen) {
        await (el as any).webkitRequestFullscreen();
      }
      // 移动端锁定横屏
      if ((screen.orientation as any)?.lock) {
        try { await (screen.orientation as any).lock('landscape'); } catch {}
      }
    } catch {}
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        await (document as any).webkitExitFullscreen();
      }
      // 解除方向锁定
      if ((screen.orientation as any)?.unlock) {
        try { (screen.orientation as any).unlock(); } catch {}
      }
    } catch {}
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }, [enterFullscreen, exitFullscreen]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-950">
        <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className={`min-h-screen flex flex-col ${isFullscreen ? 'bg-dark-950' : ''}`}>
      {!isFullscreen && <Header />}
      <main className={`flex-1 ${isFullscreen ? 'pt-0 pb-0' : 'pt-20 pb-8'}`}>
        <div className={`${isFullscreen ? 'h-screen w-screen' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-3'}`}>
          {/* 实时价格卡片（根据后台配置显示/隐藏） */}
          {!isFullscreen && showPriceCard && <PriceTicker />}

          {/* K线图（含 MACD 副图 + 布林带 + 斐波那契 + MA） */}
          <KlineChart isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />

          {/* 底部声明 */}
          {!isFullscreen && (
            <div className="text-center text-dark-500 text-xs pb-4">
              数据仅供参考，不构成投资建议。数据来源：Binance / OKX
            </div>
          )}
        </div>
      </main>
      {!isFullscreen && <Footer />}
    </div>
  );
}
