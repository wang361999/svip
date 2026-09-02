'use client';

import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import PriceTicker from '@/components/trading/PriceTicker';
import MultiTrendCard from '@/components/trading/MultiTrendCard';
import RapidSignalCard from '@/components/trading/RapidSignalCard';
import useAuthStore from '@/store/authStore';
import { apiGet } from '@/shared/api/client';

// 动态导入K线图组件 — lightweight-charts库(~100KB)单独分包，不阻塞首屏渲染
const KlineChart = dynamic(() => import('@/components/trading/KlineChart'), {
  ssr: false,
  loading: () => (
    <div className="glass-card overflow-hidden">
      <div className="flex items-center justify-center" style={{ height: 520 }}>
        <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    </div>
  ),
});

export default function TradingPage() {
  const router = useRouter();
  const { isAuthenticated, setUser } = useAuthStore();
  const [checking, setChecking] = useState(true);
  const [showPriceCard, setShowPriceCard] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 并行发起认证和配置请求 — 不再串行等待
      const [meResult, settingsResult] = await Promise.allSettled([
        apiGet<{ user: any }>('/api/auth/me'),
        apiGet<Record<string, string>>('/api/settings'),
      ]);

      if (cancelled) return;

      // 认证失败 → 跳转登录
      if (meResult.status === 'rejected') {
        router.push('/login');
        return;
      }
      setUser(meResult.value.user);

      // 配置（独立容错，不阻塞认证流程）
      if (settingsResult.status === 'fulfilled') {
        setShowPriceCard(settingsResult.value.showPriceCard !== 'false');
      }

      setChecking(false);
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

          {/* K线图（含 MACD 副图 + 布林带 + EMA） */}
          <KlineChart isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />

          {/* 快速多空信号（4 路独立信号源，15m 周期，15 秒自动刷新） */}
          {!isFullscreen && <RapidSignalCard />}

          {/* 多周期趋势卡片（15m/1h/4h/1d 趋势一览，点击标题栏折叠） */}
          {!isFullscreen && <MultiTrendCard />}

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
