'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import useSymbolStore, { SymbolOption } from '@/store/symbolStore';
import usePriceStore from '@/store/priceStore';

// ============ 币种图标颜色映射 ============
const COIN_COLORS: Record<string, [string, string]> = {
  BTC: ['#f7931a', '#f5ac48'],
  ETH: ['#627eea', '#8fa4f8'],
  SOL: ['#9945ff', '#c084fc'],
  BNB: ['#f3ba2f', '#f5d76e'],
  XRP: ['#23292f', '#4a5568'],
  ADA: ['#0033ad', '#4c6ef5'],
  DOGE: ['#c2a633', '#e2c96d'],
  TRX: ['#ff060a', '#ff6b6b'],
  AVAX: ['#e84142', '#f08080'],
  LINK: ['#2a5ada', '#6b8cff'],
  DOT: ['#e6007a', '#ff6ec7'],
  MATIC: ['#8247e5', '#b78cf7'],
  SHIB: ['#e42e88', '#f56cb0'],
  UNI: ['#ff007a', '#ff6eb8'],
  LTC: ['#345d9d', '#6b9ae8'],
  BCH: ['#8dc351', '#b8e07a'],
  ETC: ['#34fa99', '#7affc2'],
  ATOM: ['#2e3148', '#5c6280'],
  NEAR: ['#00ec97', '#6bffd0'],
  OP: ['#ff0420', '#ff6b7f'],
  ARB: ['#2d374b', '#5a6b8a'],
  SUI: ['#4da2ff', '#8ec5ff'],
  SEI: ['#9e1f63', '#d45a9a'],
  TIA: ['#6b5b95', '#a89fd3'],
  WLD: ['#1a1a1a', '#4a4a4a'],
  PEPE: ['#4caf50', '#8bc34a'],
  WIF: ['#d4a574', '#e8c9a8'],
  FTM: ['#1969ff', '#6b9fff'],
  GRT: ['#6747ed', '#9d85f5'],
  RNDR: ['#ff4d4d', '#ff8585'],
  APT: ['#00d4aa', '#6bffdb'],
  IMX: ['#e8caff', '#f0e0ff'],
  INJ: ['#00d4aa', '#6bffdb'],
  SAND: ['#00adef', '#6bd4ff'],
  MANA: ['#ff2d55', '#ff6b8a'],
  AXS: ['#0055ff', '#6b9fff'],
  FIL: ['#0090ff', '#6bb8ff'],
  EOS: ['#000000', '#333333'],
  ALGO: ['#000000', '#333333'],
  XLM: ['#000000', '#333333'],
  VET: ['#15bdff', '#6bd4ff'],
  ICP: ['#3b00b9', '#7a4dff'],
  THETA: ['#2ab8e6', '#6bd4ff'],
  XTZ: ['#0d61ff', '#6b9fff'],
  FLOW: ['#00ef8b', '#6bffc7'],
  EGLD: ['#23f7dd', '#6bffe0'],
  HBAR: ['#000000', '#333333'],
  QNT: ['#46dcb5', '#8bf5d8'],
  AAVE: ['#b6509e', '#e08ac9'],
  GALA: ['#002d72', '#4a6ba8'],
  CHZ: ['#cd0124', '#e85a75'],
  ENJ: ['#624dbf', '#9d8cf5'],
  BAT: ['#ff5000', '#ff8a5c'],
  CRV: ['#5175ff', '#8ba3ff'],
  SUSHI: ['#fa52a0', '#ff8ac7'],
  COMP: ['#00d395', '#6bffcb'],
  MKR: ['#1aab9b', '#5cd9c9'],
  YFI: ['#006ae3', '#6b9fff'],
  SNX: ['#00d1ff', '#6be4ff'],
  ZRX: ['#000000', '#333333'],
  KNC: ['#31cb9e', '#6bffd4'],
  REN: ['#001b3a', '#334a6b'],
  BAL: ['#1e1e1e', '#4a4a4a'],
  LRC: ['#2ab6f6', '#6bd4ff'],
  OMG: ['#101010', '#404040'],
  ZEC: ['#ecb244', '#f5d78a'],
  DASH: ['#008de4', '#6bb8ff'],
  XMR: ['#ff6600', '#ff995c'],
  NEO: ['#58bf00', '#8ae84a'],
  QTUM: ['#2e9ad0', '#6bb8ff'],
  IOST: ['#000000', '#333333'],
  ZIL: ['#49c1bf', '#8be0de'],
  ICX: ['#1aaaba', '#5cd4e0'],
  ONT: ['#32a4be', '#6bd4e8'],
  NANO: ['#4a90e2', '#8ab8f0'],
  RVN: ['#384182', '#6b75b8'],
  SC: ['#00cba0', '#6bffd4'],
  DGB: ['#002352', '#334a85'],
  XVG: ['#00cbff', '#6be4ff'],
  STRAX: ['#000000', '#333333'],
  STX: ['#5546ff', '#8a7dff'],
  KSM: ['#000000', '#333333'],
  TFUEL: ['#e3a600', '#f0c85c'],
  CELO: ['#fbcc5c', '#fde08a'],
  ANKR: ['#2e6de6', '#6b9fff'],
  ONE: ['#00aee9', '#6bd4ff'],
  HOT: ['#018e5a', '#4ac494'],
  GLM: ['#001d57', '#334a8a'],
  BNT: ['#000d2b', '#33405e'],
  BAND: ['#516aff', '#8ba3ff'],
  CVC: ['#3ab03e', '#7ad47a'],
  STEEM: ['#171fc9', '#5a62e0'],
  HIVE: ['#e31337', '#f06b7a'],
  JST: ['#000000', '#333333'],
  SUN: ['#f8c500', '#fce06b'],
  SRM: ['#7d00de', '#b34dff'],
  FTT: ['#02a6c2', '#4bcfe0'],
  CEL: ['#5b7fff', '#8ba3ff'],
  TUSD: ['#2b2e7c', '#5c5fad'],
  USDC: ['#2775ca', '#6b9fff'],
  BUSD: ['#f0b90b', '#f5d76e'],
  DAI: ['#f5ac37', '#f8c96b'],
  PAX: ['#ede70f', '#f5f06b'],
  TETHER: ['#26a17b', '#6bffc7'],
};

function getCoinColor(baseAsset?: string): [string, string] {
  if (!baseAsset) return ['#3b82f6', '#60a5fa'];
  const upper = baseAsset.toUpperCase();
  if (COIN_COLORS[upper]) return COIN_COLORS[upper];
  // 基于首字母生成颜色
  const hue = ((upper.charCodeAt(0) * 137) % 360);
  return [`hsl(${hue}, 70%, 45%)`, `hsl(${hue}, 70%, 60%)`];
}

function getCoinIcon(baseAsset?: string): string {
  if (!baseAsset) return '?';
  return baseAsset.slice(0, 2).toUpperCase();
}

/** 中文别名（搜索匹配用 — 用户按中文名找币，如「闪迪」→ SNDKB） */
const CN_ALIASES: Record<string, string> = {
  SNDKBUSDT: '闪迪',
};

// ============ 组件 ============

interface SymbolSelectorProps {
  symbol: string;
  symbolLabel: string;
  symbolList: SymbolOption[];
  onChange: (value: string) => void;
}

export default function SymbolSelector({
  symbol,
  symbolLabel,
  symbolList,
  onChange,
}: SymbolSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'hot'>('hot');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const currentPrice = usePriceStore((s) => s.currentPrice);
  const changePercent24h = usePriceStore((s) => s.changePercent24h);
  const priceDirection = usePriceStore((s) => s.priceDirection);
  /** 当前币种价格精度（下拉当前价按此显示） */
  const priceDigits = Math.max(0, Math.min(8, useSymbolStore((s) => s.pricePrecision)));

  // 热门币种（按市值/交易量排序的常用币种）
  const HOT_SYMBOLS = useMemo(() => new Set([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'SNDKBUSDT', 'ADAUSDT', 'TRXUSDT', 'AVAXUSDT',
    'LINKUSDT', 'DOTUSDT', 'MATICUSDT', 'SHIBUSDT', 'UNIUSDT', 'LTCUSDT',
  ]), []);

  const filteredSymbols = useMemo(() => {
    let list = symbolList;
    if (activeTab === 'hot') {
      list = symbolList.filter((s) => HOT_SYMBOLS.has(s.value));
    }
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    const cn = search.trim();
    return list.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.value.toLowerCase().includes(q) ||
        (s.baseAsset && s.baseAsset.toLowerCase().includes(q)) ||
        (CN_ALIASES[s.value] ?? '').includes(cn)
    );
  }, [symbolList, search, activeTab, HOT_SYMBOLS]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 键盘支持
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // 打开时聚焦搜索框
  useEffect(() => {
    if (open && searchRef.current) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSelect = useCallback(
    (value: string) => {
      onChange(value);
      setOpen(false);
      setSearch('');
    },
    [onChange]
  );

  const currentSymbol = symbolList.find((s) => s.value === symbol);
  const currentBaseAsset = currentSymbol?.baseAsset || symbol.replace('USDT', '');
  const [c1, c2] = getCoinColor(currentBaseAsset);

  const isPositive = parseFloat(changePercent24h) >= 0;

  return (
    <div ref={containerRef} className="relative">
      {/* ===== 触发按钮 ===== */}
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-lg border transition-all duration-200 ${
          open
            ? 'bg-dark-700/80 border-blue-500/50 shadow-lg shadow-blue-500/10'
            : 'bg-dark-800/60 border-dark-700/50 hover:border-dark-600 hover:bg-dark-700/50'
        }`}
      >
        {/* 币种图标 */}
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-inner"
          style={{
            background: `linear-gradient(135deg, ${c1}, ${c2})`,
          }}
        >
          {getCoinIcon(currentBaseAsset)}
        </div>

        {/* 币种信息 */}
        <div className="flex flex-col items-start leading-none">
          <span className="text-white text-xs font-semibold tracking-tight">
            {symbolLabel}
          </span>
          {currentPrice > 0 && (
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[10px] text-dark-300 font-mono">
                {currentPrice.toLocaleString('en-US', {
                  minimumFractionDigits: priceDigits,
                  maximumFractionDigits: priceDigits,
                })}
              </span>
              <span
                className={`text-[9px] font-medium ${
                  isPositive ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {isPositive ? '+' : ''}
                {changePercent24h}%
              </span>
              {priceDirection !== 'none' && (
                <svg
                  className={`w-2.5 h-2.5 ${priceDirection === 'up' ? 'text-green-400' : 'text-red-400'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d={priceDirection === 'up' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'}
                  />
                </svg>
              )}
            </div>
          )}
        </div>

        {/* 下拉箭头 */}
        <svg
          className={`w-3.5 h-3.5 text-dark-400 transition-transform duration-200 ml-1 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* ===== 下拉面板 ===== */}
      {open && (
        <div
          className="absolute top-full left-0 mt-1.5 z-50 w-72 origin-top-left animate-dropdown-in"
        >
          <div className="glass bg-dark-900/95 backdrop-blur-xl rounded-xl border border-dark-600/50 shadow-2xl shadow-black/40 overflow-hidden">
            {/* 搜索框 */}
            <div className="p-2.5 border-b border-dark-700/50">
              <div className="relative">
                <svg
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="搜索币种..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  // 16px：移动端浏览器聚焦小于 16px 的输入框会自动放大页面（双保险，配合 viewport 禁缩放）
                  className="w-full bg-dark-800/60 text-white text-base rounded-lg pl-8 pr-3 py-2 border border-dark-700/50 focus:outline-none focus:border-blue-500/50 placeholder-dark-500 transition-colors"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* 分类标签 */}
            <div className="flex px-2.5 pt-2 gap-1">
              {(['hot', 'all'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1 text-[11px] font-medium rounded-md transition-all ${
                    activeTab === tab
                      ? 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
                      : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800/40'
                  }`}
                >
                  {tab === 'hot' ? '热门' : '全部'}
                </button>
              ))}
            </div>

            {/* 币种列表 */}
            <div className="max-h-72 overflow-y-auto py-1.5 px-1.5">
              {filteredSymbols.length === 0 ? (
                <div className="text-center py-6 text-dark-500 text-xs">
                  未找到匹配的币种
                </div>
              ) : (
                filteredSymbols.map((s) => {
                  const isActive = s.value === symbol;
                  const base = s.baseAsset || s.value.replace('USDT', '');
                  const [color1, color2] = getCoinColor(base);
                  return (
                    <button
                      key={s.value}
                      onClick={() => handleSelect(s.value)}
                      className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg transition-all duration-150 group ${
                        isActive
                          ? 'bg-blue-500/10 border border-blue-500/20'
                          : 'hover:bg-dark-800/60 border border-transparent'
                      }`}
                    >
                      {/* 币种图标 */}
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white shadow-md flex-shrink-0 transition-transform group-hover:scale-105"
                        style={{
                          background: `linear-gradient(135deg, ${color1}, ${color2})`,
                        }}
                      >
                        {getCoinIcon(base)}
                      </div>

                      {/* 币种信息 */}
                      <div className="flex-1 text-left min-w-0">
                        <div className="flex items-center justify-between">
                          <span
                            className={`text-xs font-semibold truncate ${
                              isActive ? 'text-blue-400' : 'text-white group-hover:text-white'
                            }`}
                          >
                            {s.label}
                          </span>
                          {isActive && (
                            <svg
                              className="w-4 h-4 text-blue-400 flex-shrink-0 ml-1"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          )}
                        </div>
                        <span className="text-[10px] text-dark-500 block">
                          {base} / USDT
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* 底部统计 */}
            <div className="px-3 py-2 border-t border-dark-700/50 bg-dark-800/30">
              <span className="text-[10px] text-dark-500">
                共 {symbolList.length} 个交易对
              </span>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
