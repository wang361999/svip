'use client';

import { useEffect, useRef, useState } from 'react';
import usePriceStore from '@/store/priceStore';
import useSymbolStore from '@/store/symbolStore';
import { createMarketWS, fetch24hStats } from '@/shared/lib/market-data';

export default function PriceTicker() {
  const { currentPrice, priceDirection, changePercent24h, setPrice, updatePrice } = usePriceStore();
  const { symbol, okxId, label, pricePrecision } = useSymbolStore();
  const priceRef = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState<string>('none');
  const [lastUpdate, setLastUpdate] = useState<number>(Date.now());
  /** 价格按币种精度显示（DOGE 5位/SHIB 8位 — 写死2位会显示成 0.00） */
  const digits = Math.max(0, Math.min(8, pricePrecision));

  useEffect(() => {
    // 初始化拉取24h统计
    fetch24hStats(symbol, okxId).then((stats) => {
      if (stats) {
        setPrice(stats.price, {
          changePercent24h: stats.changePercent,
          volume24h: stats.volume,
          high24h: stats.high,
          low24h: stats.low,
          change24h: stats.change,
        });
        setLastUpdate(Date.now());
      }
    }).catch(() => {});

    // 启动实时 WebSocket
    const ws = createMarketWS({
      onTrade: (price) => {
        updatePrice(price);
        setLastUpdate(Date.now());
      },
      onConnect: (src) => {
        setSource(src);
      },
      onDisconnect: () => {
        setSource('none');
      },
    }, symbol, okxId);
    ws.connect();

    // 兜底：每 3 秒用 REST 刷新一次 24h 统计
    const statsTimer = setInterval(() => {
      fetch24hStats(symbol, okxId).then((stats) => {
        if (stats) {
          setPrice(stats.price, {
            changePercent24h: stats.changePercent,
            volume24h: stats.volume,
            high24h: stats.high,
            low24h: stats.low,
            change24h: stats.change,
          });
        }
      }).catch(() => {});
    }, 3000);

    return () => {
      ws.disconnect();
      clearInterval(statsTimer);
    };
  }, [symbol, okxId, setPrice, updatePrice]);

  // 价格变动动画
  useEffect(() => {
    if (priceRef.current) {
      priceRef.current.classList.remove('price-up', 'price-down');
      void priceRef.current.offsetWidth;
      if (priceDirection === 'up') priceRef.current.classList.add('price-up');
      else if (priceDirection === 'down') priceRef.current.classList.add('price-down');
    }
  }, [currentPrice, priceDirection]);

  const isPositive = parseFloat(changePercent24h) >= 0;
  const isLive = source === 'binance' || source === 'okx';
  const isRest = source === 'rest';
  const stale = Date.now() - lastUpdate > 5000;

  return (
    <div className="glass-card p-4 flex items-center justify-between overflow-hidden">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              isLive && !stale
                ? 'bg-green-400 animate-pulse'
                : isRest && !stale
                ? 'bg-yellow-400'
                : 'bg-red-400'
            }`}
            title={isLive ? 'WebSocket 实时' : isRest ? 'REST 轮询' : '未连接'}
          />
          <span className="text-dark-400 text-sm font-medium">{label}</span>
          {source !== 'none' && (
            <span className="text-dark-500 text-xs">
              {isLive ? 'WS' : isRest ? 'REST' : ''}
            </span>
          )}
        </div>
        <span ref={priceRef} className="text-2xl sm:text-3xl font-bold font-mono text-white truncate">
          ${currentPrice > 0
            ? currentPrice.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
            : '--'}
        </span>
      </div>
      <div className={`px-3 py-1.5 rounded-lg text-sm font-bold flex-shrink-0 ml-2 ${
        isPositive ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
      }`}>
        {isPositive ? '+' : ''}{changePercent24h}%
      </div>
    </div>
  );
}
