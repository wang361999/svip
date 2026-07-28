'use client';

import { useEffect, useRef } from 'react';
import usePriceStore from '@/store/priceStore';
import useSymbolStore from '@/store/symbolStore';
import { createMarketWS, fetch24hStats } from '@/shared/lib/market-data';

export default function PriceDisplay() {
  const {
    currentPrice,
    priceDirection,
    changePercent24h,
    volume24h,
    high24h,
    low24h,
    setPrice,
  } = usePriceStore();
  const { symbol, okxId, label } = useSymbolStore();

  const priceRef = useRef<HTMLSpanElement>(null);
  const sourceRef = useRef<string>('none');

  useEffect(() => {
    // 先拉一次 REST 数据初始化
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

    // 启动 WebSocket
    const ws = createMarketWS({
      onTrade: (price) => {
        setPrice(price, {
          changePercent24h,
          volume24h,
          high24h,
          low24h,
          change24h: currentPrice > 0 ? price - currentPrice : 0,
        });
      },
      onConnect: (source) => {
        sourceRef.current = source;
      },
      onDisconnect: () => {
        sourceRef.current = 'none';
      },
    }, symbol, okxId);

    ws.connect();

    return () => {
      ws.disconnect();
    };
  }, [symbol, okxId, setPrice, currentPrice, changePercent24h, volume24h, high24h, low24h]);

  // 价格闪动动画
  useEffect(() => {
    if (priceRef.current) {
      priceRef.current.classList.remove('price-up', 'price-down');
      void priceRef.current.offsetWidth;
      if (priceDirection === 'up') priceRef.current.classList.add('price-up');
      else if (priceDirection === 'down') priceRef.current.classList.add('price-down');
    }
  }, [currentPrice, priceDirection]);

  const isPositive = parseFloat(changePercent24h) >= 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      <div className="glass-card p-4 col-span-2 md:col-span-1">
        <div className="text-dark-400 text-xs mb-1 flex items-center gap-1">
          {label} 价格
          {sourceRef.current !== 'none' && (
            <span className={`w-2 h-2 rounded-full ${
              sourceRef.current.startsWith('ws') || sourceRef.current === 'binance' || sourceRef.current === 'okx'
                ? 'bg-green-400 animate-pulse'
                : 'bg-yellow-400'
            }`} />
          )}
        </div>
        <span ref={priceRef} className="text-2xl font-bold font-mono text-white">
          ${currentPrice > 0
            ? currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : '--'}
        </span>
      </div>

      <div className="glass-card p-4">
        <div className="text-dark-400 text-xs mb-1">24h 涨跌</div>
        <div className={`text-xl font-bold font-mono ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
          {isPositive ? '+' : ''}{changePercent24h}%
        </div>
      </div>

      <div className="glass-card p-4">
        <div className="text-dark-400 text-xs mb-1">24h 成交量</div>
        <div className="text-xl font-bold font-mono text-white">
          {volume24h > 0 ? `$${Math.round(volume24h).toLocaleString()}` : '--'}
        </div>
      </div>

      <div className="glass-card p-4">
        <div className="text-dark-400 text-xs mb-1">24h 最高</div>
        <div className="text-xl font-bold font-mono text-green-400">
          {high24h > 0 ? `$${high24h.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '--'}
        </div>
      </div>

      <div className="glass-card p-4">
        <div className="text-dark-400 text-xs mb-1">24h 最低</div>
        <div className="text-xl font-bold font-mono text-red-400">
          {low24h > 0 ? `$${low24h.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '--'}
        </div>
      </div>
    </div>
  );
}
