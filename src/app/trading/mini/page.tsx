'use client';

import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import useSymbolStore from '@/store/symbolStore';
import useChartStore from '@/store/chartStore';
import { apiGet } from '@/shared/api/client';

// 动态导入K线图组件 — lightweight-charts库(~100KB)单独分包，不阻塞首屏渲染
const KlineChart = dynamic(() => import('@/components/trading/KlineChart'), {
  ssr: false,
  loading: () => (
    <div className="h-screen flex items-center justify-center bg-dark-950">
      <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  ),
});

/**
 * K线小窗模式：弹出窗口只显示K线主图（无副图/读数卡片/页头页脚）。
 * 币种与周期经 localStorage 自动继承主窗口的当前选择；
 * 并监听 storage 事件 —— 主窗口切换币种/周期时小窗实时跟随。
 */
export default function MiniKlinePage() {
  const router = useRouter();
  const { isAuthenticated, setUser } = useAuthStore();
  const [checking, setChecking] = useState(true);
  const symbolLabel = useSymbolStore((s) => s.label);
  const setSymbol = useSymbolStore((s) => s.setSymbol);
  const fetchSymbols = useSymbolStore((s) => s.fetchSymbols);
  const setIntervalState = useChartStore((s) => s.setInterval);

  // 鉴权：与交易页同口径（未登录跳登录页）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [meResult] = await Promise.allSettled([
        apiGet<{ user: any }>('/api/auth/me'),
      ]);
      if (cancelled) return;
      if (meResult.status === 'rejected') {
        router.push('/login');
        return;
      }
      setUser(meResult.value.user);
      setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [router, setUser]);

  // 拉取数据库交易对列表（symbolStore 初值来自 localStorage 兜底默认表）
  useEffect(() => {
    fetchSymbols().catch(() => {});
  }, [fetchSymbols]);

  // 跨窗口联动：主窗口切换币种/周期（写入 localStorage）时小窗跟随
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'chart-symbol' && e.newValue) setSymbol(e.newValue);
      else if (e.key === 'chart-interval' && e.newValue) setIntervalState(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setSymbol, setIntervalState]);

  // 标题跟随币种：多小窗并排时一眼区分
  useEffect(() => {
    document.title = `${symbolLabel} · K线小窗`;
  }, [symbolLabel]);

  const toggleFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen?.();
      }
    } catch {}
  }, []);

  if (checking) {
    return (
      <div className="h-screen flex items-center justify-center bg-dark-950">
        <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-dark-950">
      <KlineChart isMini onToggleFullscreen={toggleFullscreen} />
    </div>
  );
}
