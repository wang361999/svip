'use client';

import { useEffect } from 'react';

/**
 * 缓存清除组件
 *
 * 工作原理：
 * 1. 构建时 next.config.mjs 注入 NEXT_PUBLIC_BUILD_VERSION（每次部署自动变化的时间戳）
 * 2. 前端读取该版本号，与 localStorage 中存储的版本对比
 * 3. 版本不一致 → 清除所有浏览器缓存（localStorage / sessionStorage / Cache API / Service Worker）
 * 4. 部署后用户首次访问 → 自动清除旧缓存并刷新页面
 *
 * 无需手动改版本号，每次 vercel build 都会自动生成新的。
 */
const CACHE_VERSION = `eth-trading-${process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev'}`;
const VERSION_KEY = 'app_cache_version';

export default function CacheBuster() {
  useEffect(() => {
    const storedVersion = localStorage.getItem(VERSION_KEY);

    // 首次访问（没有任何版本号）或者版本不匹配 → 强制清除缓存
    if (storedVersion !== CACHE_VERSION) {
      console.log(
        '[CacheBuster] 清除本地缓存:',
        storedVersion || '首次部署',
        '→',
        CACHE_VERSION,
      );

      // 清除 localStorage（保留 token 以免重新登录）
      const token = localStorage.getItem('token');
      const keysToRemove = Object.keys(localStorage).filter(
        (key) => key !== VERSION_KEY && key !== 'token',
      );
      keysToRemove.forEach((key) => localStorage.removeItem(key));

      // 清除 sessionStorage
      sessionStorage.clear();

      // 清除 Cache API
      if ('caches' in window) {
        caches.keys().then((names) => {
          names.forEach((name) => caches.delete(name));
        });
      }

      // 注销 Service Worker
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((regs) => {
          regs.forEach((reg) => reg.unregister());
        });
      }

      // 写入新版本
      localStorage.setItem(VERSION_KEY, CACHE_VERSION);

      // 非首次（版本更新时）刷新页面
      // 时序修复：等当前页面（含CSS）完全加载后再刷新 — 慢网络下立即 reload 会
      // 打断仍在下载的样式表，用户看到无样式裸HTML；且load事件至少已一次完整加载
      if (storedVersion !== null) {
        const doReload = () => setTimeout(() => window.location.reload(), 200);
        if (document.readyState === 'complete') doReload();
        else window.addEventListener('load', doReload, { once: true });
      }
    }
  }, []);

  return null;
}
