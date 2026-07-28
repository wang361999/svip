'use client';

import AdminSidebar from '@/components/admin/AdminSidebar';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import { apiGet, apiPost } from '@/shared/api/client';

interface TradingSymbol {
  id: string;
  symbol: string;
  okxId: string;
  label: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  qtyPrecision: number;
  minQty: number;
  minNotional: number;
  active: boolean;
  autoTrade: boolean;
  isPopular: boolean;
  sortOrder: number;
  createdAt: string;
}

export default function SymbolsAdminPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const [symbols, setSymbols] = useState<TradingSymbol[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');

  useEffect(() => {
    if (isAuthenticated && user?.role !== 'admin') {
      router.push('/');
      return;
    }
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    loadSymbols();
  }, [isAuthenticated, user?.role, router]);

  const loadSymbols = async () => {
    setLoading(true);
    try {
      const data = await apiGet<TradingSymbol[]>('/api/symbols');
      setSymbols(Array.isArray(data) ? data : []);
    } catch (err: any) {
      showMessage(err?.message || '加载币种失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const showMessage = (text: string, type: 'success' | 'error') => {
    setMessage(text);
    setMessageType(type);
    setTimeout(() => setMessage(''), 4000);
  };

  const handleImport = async () => {
    if (!confirm('将从 Binance 导入前 50 个热门 USDT 币对，是否继续？')) return;
    setImporting(true);
    try {
      const data = await apiPost<{ imported: number; skipped: number; errors?: string[]; warning?: string; source?: string }>(
        '/api/symbols?action=import'
      );
      const sourceText = data.source === 'fallback' ? '内置热门列表' : 'Binance';
      showMessage(`${data.warning ? `${data.warning}；` : ''}${sourceText} 导入成功：新增 ${data.imported} 个，跳过 ${data.skipped} 个`, 'success');
      await loadSymbols();
    } catch (err: any) {
      showMessage(err?.message || '导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const toggleActive = async (symbol: TradingSymbol) => {
    try {
      const nextActive = !symbol.active;
      const payload = nextActive
        ? { id: symbol.id, active: true }
        : { id: symbol.id, active: false, autoTrade: false };
      const res = await fetch('/api/symbols/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSymbols((prev) =>
          prev.map((s) => (s.id === symbol.id ? { ...s, active: nextActive, autoTrade: nextActive ? s.autoTrade : false } : s))
        );
        showMessage(`${symbol.label} 已${nextActive ? '启用' : '禁用'}`, 'success');
      }
    } catch (err: any) {
      showMessage('操作失败', 'error');
    }
  };

  const toggleAutoTrade = async (symbol: TradingSymbol) => {
    try {
      const nextAutoTrade = !symbol.autoTrade;
      const res = await fetch('/api/symbols/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: symbol.id, autoTrade: nextAutoTrade }),
      });
      if (res.ok) {
        setSymbols((prev) =>
          prev.map((s) => (s.id === symbol.id ? { ...s, autoTrade: nextAutoTrade } : s))
        );
        showMessage(`${symbol.label} 已${nextAutoTrade ? '允许' : '禁止'}自动交易`, 'success');
      }
    } catch (err: any) {
      showMessage('操作失败', 'error');
    }
  };

  const filteredSymbols = symbols.filter((s) => {
    if (filter === 'active') return s.active;
    if (filter === 'inactive') return !s.active;
    return true;
  });

  const activeCount = symbols.filter((s) => s.active).length;
  const autoTradeCount = symbols.filter((s) => s.active && s.autoTrade).length;
  const popularCount = symbols.filter((s) => s.isPopular).length;

  if (!isAuthenticated || user?.role !== 'admin') return null;

  return (
    <div className="flex bg-dark-950 min-h-screen">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-6xl">
          {/* 头部 */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold text-white">币种管理</h1>
              <p className="text-dark-400 mt-1">
                共 {symbols.length} 个币种 · 前台显示 {activeCount} 个 · 自动交易 {autoTradeCount} 个 · 热门 {popularCount} 个
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleImport}
                disabled={importing}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2"
              >
                {importing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    导入中...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    从 Binance 导入热门币对
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 消息提示 */}
          {message && (
            <div className={`mb-4 px-4 py-3 rounded-lg text-sm font-medium ${
              messageType === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {message}
            </div>
          )}

          {/* 筛选标签 */}
          <div className="flex items-center gap-2 mb-4">
            {(['all', 'active', 'inactive'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                  filter === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-dark-800 text-dark-400 hover:text-white hover:bg-dark-700'
                }`}
              >
                {f === 'all' ? '全部' : f === 'active' ? '已启用' : '已禁用'}
              </button>
            ))}
          </div>

          {/* 币种列表 */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-dark-700/50 text-dark-400 text-xs">
                      <th className="text-left px-4 py-3 font-medium">币种</th>
                      <th className="text-left px-4 py-3 font-medium">Symbol</th>
                      <th className="text-left px-4 py-3 font-medium">OKX ID</th>
                      <th className="text-left px-4 py-3 font-medium">精度</th>
                      <th className="text-left px-4 py-3 font-medium">最小下单</th>
                      <th className="text-left px-4 py-3 font-medium">状态</th>
                      <th className="text-left px-4 py-3 font-medium">自动交易</th>
                      <th className="text-left px-4 py-3 font-medium">热门</th>
                      <th className="text-right px-4 py-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSymbols.map((s) => (
                      <tr key={s.id} className="border-b border-dark-700/30 hover:bg-dark-800/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-white font-medium">{s.label}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-dark-300 font-mono text-xs">{s.symbol}</td>
                        <td className="px-4 py-3 text-dark-300 font-mono text-xs">{s.okxId}</td>
                        <td className="px-4 py-3 text-dark-400 text-xs">
                          价格 {s.pricePrecision} / 数量 {s.qtyPrecision}
                        </td>
                        <td className="px-4 py-3 text-dark-400 text-xs">
                          {s.minQty > 0 ? s.minQty : '--'} / ${s.minNotional}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            s.active
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-dark-700 text-dark-500'
                          }`}>
                            {s.active ? '已启用' : '已禁用'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => toggleAutoTrade(s)}
                            disabled={!s.active}
                            className={`text-xs px-2 py-0.5 rounded-full font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                              s.autoTrade
                                ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'
                                : 'bg-dark-700 text-dark-500 hover:bg-dark-600 hover:text-dark-300'
                            }`}
                            title={!s.active ? '前台禁用后不能参与自动交易' : undefined}
                          >
                            {s.autoTrade ? '允许' : '禁止'}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          {s.isPopular && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
                              热门
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => toggleActive(s)}
                            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                              s.active
                                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                                : 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                            }`}
                          >
                            {s.active ? '禁用' : '启用'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredSymbols.length === 0 && (
                <div className="text-center py-12">
                  <svg className="w-12 h-12 text-dark-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-dark-400 text-sm">暂无币种数据</p>
                  <p className="text-dark-600 text-xs mt-1">点击上方按钮从 Binance 导入</p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
