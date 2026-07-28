'use client';

import { useEffect, useState } from 'react';
import { fetch24hStats } from '@/shared/lib/market-data';
import useSymbolStore from '@/store/symbolStore';

interface Stats {
  price: number;
  changePercent: string;
  change: number;
  high: number;
  low: number;
  volume: number;
}

function formatNum(n: number, digits = 2): string {
  if (!n || n === 0) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatVol(n: number): string {
  if (!n || n === 0) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

export default function StatCards() {
  const [stats, setStats] = useState<Stats | null>(null);
  const { symbol, okxId } = useSymbolStore();

  useEffect(() => {
    let mounted = true;
    const load = () => {
      fetch24hStats(symbol, okxId).then((s) => {
        if (mounted && s) setStats(s);
      }).catch(() => {});
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [symbol, okxId]);

  const isPositive = stats ? parseFloat(stats.changePercent) >= 0 : true;

  const cards = [
    {
      label: '24h 涨跌',
      value: stats ? `${isPositive ? '+' : ''}${stats.changePercent}%` : '--',
      sub: stats ? `${isPositive ? '+' : ''}${formatNum(stats.change)}` : '',
      color: isPositive ? 'text-green-400' : 'text-red-400',
      bg: isPositive ? 'bg-green-500/10' : 'bg-red-500/10',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isPositive ? "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" : "M13 17h8m0 0v-8m0 8l-8-8-4 4-6-6"} />
        </svg>
      ),
    },
    {
      label: '24h 成交量',
      value: stats ? formatVol(stats.volume) : '--',
      sub: 'USDT',
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
    },
    {
      label: '24h 最高',
      value: stats ? formatNum(stats.high) : '--',
      sub: 'USDT',
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
        </svg>
      ),
    },
    {
      label: '24h 最低',
      value: stats ? formatNum(stats.low) : '--',
      sub: 'USDT',
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 13l-5 5m0 0l-5-5m5 5V6" />
        </svg>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div key={card.label} className="glass-card p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-dark-400 text-sm font-medium">{card.label}</span>
            <div className={`w-9 h-9 rounded-lg ${card.bg} flex items-center justify-center ${card.color}`}>
              {card.icon}
            </div>
          </div>
          <div className={`text-2xl font-bold font-mono ${card.color}`}>
            {card.value}
          </div>
          {card.sub && (
            <div className="text-dark-500 text-xs mt-1">{card.sub}</div>
          )}
        </div>
      ))}
    </div>
  );
}
