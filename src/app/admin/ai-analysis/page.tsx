'use client';

import AdminSidebar from '@/components/admin/AdminSidebar';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import { apiGet } from '@/shared/api/client';

interface AiAnalysisRecord {
  id: string;
  symbol: string;
  direction: string;
  confidence: number;
  summary: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  createdAt: string;
}

interface AiStatItem {
  total: number;
  wins: number;
  winRate: number;
  avgPnl: number;
  sumPnl: number;
  avgWin: number;
  avgLoss: number;
}

interface AiStats {
  sampleSize: number;
  overall: AiStatItem;
  byModel: (AiStatItem & { model: string })[];
  byConfidence: (AiStatItem & { band: string })[];
}

const directionConfig: Record<string, { label: string; color: string; icon: string }> = {
  long: { label: '做多', color: 'text-green-400', icon: '▲' },
  short: { label: '做空', color: 'text-red-400', icon: '▼' },
  neutral: { label: '观望', color: 'text-dark-300', icon: '●' },
};

export default function AdminAiAnalysisPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const [records, setRecords] = useState<AiAnalysisRecord[]>([]);
  const [stats, setStats] = useState<AiStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterSymbol, setFilterSymbol] = useState('');

  useEffect(() => {
    if (isAuthenticated && user?.role !== 'admin') {
      router.push('/');
      return;
    }
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    loadData();
  }, [isAuthenticated, user?.role, router]);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      // 准确率统计与记录列表并行加载
      const statsPromise = apiGet<AiStats>('/api/ai-analysis/stats').catch(() => null);
      // 获取所有币种的最新分析（按 symbol 分组取最新）
      const allRecords: AiAnalysisRecord[] = [];
      // 先获取常见币种
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
      const results = await Promise.allSettled(
        symbols.map((s) => apiGet<{ latest: AiAnalysisRecord | null; history: AiAnalysisRecord[] }>(
          `/api/ai-analysis?symbol=${s}`,
        )),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.latest) allRecords.push(r.value.latest);
          if (r.value.history) allRecords.push(...r.value.history);
        }
      }
      // 按时间倒序
      allRecords.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setRecords(allRecords);
      setStats(await statsPromise);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthenticated || user?.role !== 'admin') return null;

  const filtered = filterSymbol
    ? records.filter((r) => r.symbol.toLowerCase().includes(filterSymbol.toLowerCase()))
    : records;

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const formatPrice = (p: number | null) => {
    if (p == null) return '-';
    return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  return (
    <div className="flex bg-dark-950 min-h-screen">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-6xl">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white">AI 行情分析</h1>
              <p className="text-dark-400 mt-1">查看所有 AI 分析记录</p>
            </div>
            <button
              onClick={loadData}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? '刷新中...' : '刷新'}
            </button>
          </div>

          {error && (
            <div className="p-4 rounded-lg mb-6 bg-red-500/10 border border-red-500/30 text-red-400">
              {error}
            </div>
          )}

          {/* 筛选 */}
          <div className="mb-4">
            <input
              type="text"
              value={filterSymbol}
              onChange={(e) => setFilterSymbol(e.target.value)}
              placeholder="筛选币种..."
              className="input-dark max-w-xs"
            />
          </div>

          {/* AI 准确率统计（AI 自动开仓的已平仓样本） */}
          {stats && stats.sampleSize > 0 ? (
            <div className="mb-8 space-y-4">
              <h2 className="text-sm font-semibold text-dark-300">
                AI 自动开仓准确率（样本 {stats.sampleSize} 笔已平仓）
              </h2>

              {/* 总览卡片 */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-dark-800/40 rounded-lg p-4 border border-dark-700/30">
                  <div className="text-dark-500 text-xs mb-1">胜率</div>
                  <div className={`text-2xl font-bold ${stats.overall.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                    {stats.overall.winRate}%
                  </div>
                  <div className="text-dark-500 text-xs mt-1">{stats.overall.wins}/{stats.overall.total} 笔盈利</div>
                </div>
                <div className="bg-dark-800/40 rounded-lg p-4 border border-dark-700/30">
                  <div className="text-dark-500 text-xs mb-1">累计盈亏</div>
                  <div className={`text-2xl font-bold ${stats.overall.sumPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {stats.overall.sumPnl >= 0 ? '+' : ''}{stats.overall.sumPnl.toFixed(2)}
                  </div>
                  <div className="text-dark-500 text-xs mt-1">USDT</div>
                </div>
                <div className="bg-dark-800/40 rounded-lg p-4 border border-dark-700/30">
                  <div className="text-dark-500 text-xs mb-1">平均盈利</div>
                  <div className="text-2xl font-bold text-green-400">+{stats.overall.avgWin.toFixed(2)}</div>
                  <div className="text-dark-500 text-xs mt-1">单笔盈利均值</div>
                </div>
                <div className="bg-dark-800/40 rounded-lg p-4 border border-dark-700/30">
                  <div className="text-dark-500 text-xs mb-1">平均亏损</div>
                  <div className="text-2xl font-bold text-red-400">{stats.overall.avgLoss.toFixed(2)}</div>
                  <div className="text-dark-500 text-xs mt-1">单笔亏损均值</div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                {/* 按模型统计 */}
                <div className="bg-dark-800/40 rounded-lg p-4 border border-dark-700/30">
                  <div className="text-dark-400 text-xs font-medium mb-2">按模型对比</div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-dark-500 border-b border-dark-700/50">
                        <th className="pb-2 pr-2">模型</th>
                        <th className="pb-2 pr-2">笔数</th>
                        <th className="pb-2 pr-2">胜率</th>
                        <th className="pb-2">累计盈亏</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byModel.map((m) => (
                        <tr key={m.model} className="border-b border-dark-800/50">
                          <td className="py-2 pr-2 text-white truncate max-w-[140px]" title={m.model}>{m.model}</td>
                          <td className="py-2 pr-2 text-dark-300">{m.total}</td>
                          <td className={`py-2 pr-2 font-medium ${m.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>{m.winRate}%</td>
                          <td className={`py-2 ${m.sumPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {m.sumPnl >= 0 ? '+' : ''}{m.sumPnl.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 按置信度分层 */}
                <div className="bg-dark-800/40 rounded-lg p-4 border border-dark-700/30">
                  <div className="text-dark-400 text-xs font-medium mb-2">
                    按置信度分层（验证「高置信度是否更准」）
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-dark-500 border-b border-dark-700/50">
                        <th className="pb-2 pr-2">置信度</th>
                        <th className="pb-2 pr-2">笔数</th>
                        <th className="pb-2 pr-2">胜率</th>
                        <th className="pb-2">平均盈亏</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byConfidence.map((b) => (
                        <tr key={b.band} className="border-b border-dark-800/50">
                          <td className="py-2 pr-2 text-white">{b.band}</td>
                          <td className="py-2 pr-2 text-dark-300">{b.total}</td>
                          <td className={`py-2 pr-2 font-medium ${b.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>{b.winRate}%</td>
                          <td className={`py-2 ${b.avgPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {b.avgPnl >= 0 ? '+' : ''}{b.avgPnl.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-dark-500 text-[11px] mt-2">
                    若各置信度档胜率接近，说明模型置信度不可信，建议关闭置信度联动仓位
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 text-dark-400">
              <p>暂无 AI 分析记录</p>
              <p className="text-xs text-dark-500 mt-1">在交易页面点击「立即分析」或在后台设置中开启自动分析</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-dark-400 text-xs border-b border-dark-800">
                    <th className="pb-3 pr-4">时间</th>
                    <th className="pb-3 pr-4">币种</th>
                    <th className="pb-3 pr-4">方向</th>
                    <th className="pb-3 pr-4">置信度</th>
                    <th className="pb-3 pr-4">入场</th>
                    <th className="pb-3 pr-4">止损</th>
                    <th className="pb-3 pr-4">止盈1</th>
                    <th className="pb-3 pr-4">止盈2</th>
                    <th className="pb-3">总结</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const dir = directionConfig[r.direction] || directionConfig.neutral;
                    return (
                      <tr key={r.id} className="border-b border-dark-800/50 hover:bg-dark-900/30 transition-colors">
                        <td className="py-3 pr-4 text-dark-400 text-xs whitespace-nowrap">{formatTime(r.createdAt)}</td>
                        <td className="py-3 pr-4 text-white text-sm font-medium">{r.symbol}</td>
                        <td className="py-3 pr-4">
                          <span className={`text-sm font-medium ${dir.color}`}>{dir.icon} {dir.label}</span>
                        </td>
                        <td className="py-3 pr-4 text-dark-300 text-sm">{r.confidence}%</td>
                        <td className="py-3 pr-4 text-white text-sm">{formatPrice(r.entryPrice)}</td>
                        <td className="py-3 pr-4 text-red-400 text-sm">{formatPrice(r.stopLoss)}</td>
                        <td className="py-3 pr-4 text-green-400 text-sm">{formatPrice(r.takeProfit1)}</td>
                        <td className="py-3 pr-4 text-green-400 text-sm">{formatPrice(r.takeProfit2)}</td>
                        <td className="py-3 text-dark-300 text-xs max-w-xs truncate">{r.summary}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
