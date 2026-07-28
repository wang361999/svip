'use client';

import AdminSidebar from '@/components/admin/AdminSidebar';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import { apiGet, apiPut } from '@/shared/api/client';

interface LogItem {
  id: string;
  time: string;
  price: number;
  checked: number;
  opened: number;
  closed: number;
  errors: string[];
}

interface CronStats {
  todayTriggers: number;
  todayChecked: number;
  todayOpened: number;
  todayClosed: number;
  todayErrors: number;
  todaySuccess: number;
  hourTriggers: number;
  lastExecutedAt: string | null;
  lastLoops: number;
  estimatedInterval: number;
}

interface CronConfig {
  cronLoops: string;
  cronInterval: string;
  cronLogTtl: string;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(iso: string | null): string {
  if (!iso) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  return `${Math.floor(diff / 3600000)}小时前`;
}

function isLive(lastAt: string | null) {
  if (!lastAt) return false;
  return Date.now() - new Date(lastAt).getTime() < 120000;
}

export default function CronMonitorPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [stats, setStats] = useState<CronStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 配置
  const [config, setConfig] = useState<CronConfig>({
    cronLoops: '1',
    cronInterval: '0',
    cronLogTtl: '1',
  });

  const loadData = useCallback(async () => {
    try {
      const data = await apiGet<{ items: LogItem[]; stats: CronStats }>('/api/cron/logs?limit=80');
      setLogs(data.items);
      setStats(data.stats);
    } catch (err) {
      console.error('加载日志失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await apiGet<CronConfig>('/api/settings');
      setConfig({
        cronLoops: s.cronLoops ?? '1',
        cronInterval: s.cronInterval ?? '0',
        cronLogTtl: s.cronLogTtl ?? '1',
      });
    } catch {}
  }, []);

  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'admin') {
      router.push('/login');
      return;
    }
    loadData();
    loadSettings();
  }, [isAuthenticated, user?.role, router, loadData, loadSettings]);

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(loadData, 5000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, loadData]);

  const handleSaveConfig = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await apiPut('/api/settings', config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('保存失败:', err);
    } finally {
      setSaving(false);
    }
  };

  if (!isAuthenticated || user?.role !== 'admin') return null;

  const live = isLive(stats?.lastExecutedAt || null);
  const loops = parseInt(config.cronLoops, 10) || 1;
  const interval = parseInt(config.cronInterval, 10) || 0;
  const effectiveInterval = Math.round(60000 / (loops * 60 / (interval / 1000 + 1.5)));

  return (
    <div className="flex bg-dark-950 min-h-screen">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-6xl">
          {/* 头部 */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">Cron 监控</h1>
              <p className="text-dark-400 mt-1">实时查看引擎触发状态和执行日志</p>
            </div>
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
                live
                  ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                  : 'bg-red-500/10 text-red-400 border border-red-500/20'
              }`}>
                <span className={`w-2 h-2 rounded-full ${live ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
                {live ? '运行中' : '离线'}
              </div>
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                  autoRefresh
                    ? 'bg-blue-600/15 text-blue-400 border-blue-500/20'
                    : 'bg-dark-800 text-dark-400 border-dark-700'
                }`}>
                {autoRefresh ? '自动刷新 5s' : '已暂停'}
              </button>
              <button
                onClick={() => { setLoading(true); loadData(); }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-dark-800 text-dark-300 border border-dark-700 hover:bg-dark-700 transition-all">
                刷新
              </button>
            </div>
          </div>

          {loading && !stats ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* 统计卡片 */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
                <StatCard label="今日触发" value={stats?.todayTriggers || 0} sub={`成功率 ${stats?.todayTriggers ? Math.round(((stats?.todaySuccess || 0) / stats.todayTriggers) * 100) : 0}%`} color="blue" />
                <StatCard label="最近触发" value={timeAgo(stats?.lastExecutedAt || null)} sub={stats?.lastExecutedAt ? formatTime(stats.lastExecutedAt) : '--'} color="cyan" isText />
                <StatCard label="1小时触发" value={stats?.hourTriggers || 0} sub={stats?.estimatedInterval ? `约${stats.estimatedInterval}秒/次` : '--'} color="purple" />
                <StatCard label="今日检查持仓" value={stats?.todayChecked || 0} color="amber" />
                <StatCard label="今日自动开仓" value={stats?.todayOpened || 0} color="green" />
                <StatCard label="今日失败" value={stats?.todayErrors || 0} color={stats?.todayErrors ? 'red' : 'slate'} />
              </div>

              {/* 参数配置卡片 */}
              <div className="glass-card p-5 mb-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white">引擎参数配置</h3>
                    <p className="text-[11px] text-dark-500 mt-0.5">修改后下次 Cron 触发立即生效，无需重新部署</p>
                  </div>
                  <button
                    onClick={handleSaveConfig}
                    disabled={saving}
                    className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      saved
                        ? 'bg-green-600/20 text-green-400 border border-green-500/30'
                        : 'bg-blue-600 text-white hover:bg-blue-700'
                    }`}>
                    {saving ? '保存中...' : saved ? '已保存' : '保存配置'}
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  {/* 循环次数 */}
                  <div>
                    <label className="block text-xs text-dark-400 mb-1.5">每次请求循环次数</label>
                    <select
                      value={config.cronLoops}
                      onChange={e => setConfig({ ...config, cronLoops: e.target.value })}
                      className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                    >
                      {[1, 2, 3].map(n => (
                        <option key={n} value={n}>{n} 次{loops === n ? ' (当前)' : ''}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-dark-600 mt-1">1次=最稳，超过安全时间会自动提前停止</p>
                  </div>
                  {/* 循环间隔 */}
                  <div>
                    <label className="block text-xs text-dark-400 mb-1.5">循环间隔（毫秒）</label>
                    <select
                      value={config.cronInterval}
                      onChange={e => setConfig({ ...config, cronInterval: e.target.value })}
                      className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                    >
                      <option value="0">0ms（无间隔，最快）</option>
                      <option value="1000">1000ms（1秒）</option>
                      <option value="2000">2000ms（2秒）</option>
                    </select>
                    <p className="text-[10px] text-dark-600 mt-1">Vercel 环境建议 0ms 或 1000ms</p>
                  </div>
                  {/* 日志保留 */}
                  <div>
                    <label className="block text-xs text-dark-400 mb-1.5">日志保留时间</label>
                    <select
                      value={config.cronLogTtl}
                      onChange={e => setConfig({ ...config, cronLogTtl: e.target.value })}
                      className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                    >
                      <option value="1">1 小时</option>
                      <option value="2">2 小时</option>
                      <option value="6">6 小时</option>
                      <option value="12">12 小时</option>
                      <option value="24">1 天</option>
                      <option value="48">2 天</option>
                      <option value="72">3 天</option>
                    </select>
                    <p className="text-[10px] text-dark-600 mt-1">过期日志每次触发时自动清理</p>
                  </div>
                </div>
                {/* 当前生效预览 */}
                <div className="mt-4 p-3 bg-dark-800/50 rounded-lg flex items-center gap-6 text-xs">
                  <span className="text-dark-500">当前生效：</span>
                  <span className="text-dark-300">cron-job.org 每分钟触发 1 次</span>
                  <span className="text-dark-600">x</span>
                  <span className="text-blue-400 font-medium">循环 {loops} 次</span>
                  <span className="text-dark-600">x</span>
                  <span className="text-dark-300">间隔 {interval / 1000}s</span>
                  <span className="text-dark-600">=</span>
                  <span className="text-green-400 font-medium">约每 {effectiveInterval}s 检查一次</span>
                </div>
              </div>

              {/* 实时心跳条 */}
              <div className="glass-card p-4 mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-dark-400 font-medium">最近 30 分钟触发频率</span>
                  <span className="text-xs text-dark-500">
                    循环 {loops} 次/请求 | 日志保留 {config.cronLogTtl}h
                  </span>
                </div>
                <div className="flex items-end gap-px h-16">
                  {Array.from({ length: 30 }).map((_, i) => {
                    const minAgo = 29 - i;
                    const cutoff = new Date(Date.now() - (minAgo + 1) * 60000);
                    const cutoff2 = new Date(Date.now() - minAgo * 60000);
                    const count = logs.filter(l => {
                      const t = new Date(l.time).getTime();
                      return t >= cutoff.getTime() && t < cutoff2.getTime();
                    }).length;
                    const h = Math.max(2, Math.min(100, count * 20));
                    const isCurrent = i === 29;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1">
                        <div
                          className={`w-full rounded-sm transition-all ${
                            count > 0
                              ? isCurrent ? 'bg-blue-400' : 'bg-blue-500/40'
                              : 'bg-dark-800'
                          }`}
                          style={{ height: `${h}%` }}
                          title={`${29 - minAgo}~${30 - minAgo} 分钟前: ${count} 次`}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-dark-600">30分钟前</span>
                  <span className="text-[10px] text-dark-600">现在</span>
                </div>
              </div>

              {/* 日志列表 */}
              <div className="glass-card overflow-hidden">
                <div className="px-5 py-3 border-b border-dark-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">执行日志</h3>
                  <span className="text-xs text-dark-500">最近 {logs.length} 条 | 保留 {config.cronLogTtl}h</span>
                </div>
                <div className="max-h-[500px] overflow-y-auto">
                  <div className="grid grid-cols-12 gap-2 px-5 py-2 text-[11px] text-dark-500 font-medium border-b border-dark-800/50 sticky top-0 bg-dark-900 z-10">
                    <div className="col-span-3">时间</div>
                    <div className="col-span-2 text-right">ETH 价格</div>
                    <div className="col-span-2 text-center">检查持仓</div>
                    <div className="col-span-1 text-center">开仓</div>
                    <div className="col-span-1 text-center">平仓</div>
                    <div className="col-span-3">状态</div>
                  </div>
                  {logs.length === 0 ? (
                    <div className="py-12 text-center text-dark-500 text-sm">暂无引擎执行记录</div>
                  ) : (
                    logs.map((log, idx) => {
                      const hasError = log.errors.length > 0;
                      const isNew = idx === 0;
                      return (
                        <div
                          key={log.id}
                          className={`grid grid-cols-12 gap-2 px-5 py-2.5 text-sm border-b border-dark-800/30 hover:bg-dark-800/30 transition-colors ${isNew ? 'bg-blue-500/5' : ''}`}
                        >
                          <div className="col-span-3 text-dark-300 font-mono text-xs">
                            {formatTime(log.time)}
                            {isNew && <span className="ml-1.5 text-[10px] text-blue-400 font-medium">NEW</span>}
                          </div>
                          <div className="col-span-2 text-right text-white font-mono text-xs">
                            ${log.price ? log.price.toFixed(2) : '--'}
                          </div>
                          <div className="col-span-2 text-center">
                            <span className="text-xs font-mono text-dark-300">{log.checked}</span>
                          </div>
                          <div className="col-span-1 text-center">
                            {log.opened > 0 ? (
                              <span className="text-xs font-mono text-green-400 font-medium">+{log.opened}</span>
                            ) : (
                              <span className="text-xs font-mono text-dark-600">0</span>
                            )}
                          </div>
                          <div className="col-span-1 text-center">
                            {log.closed > 0 ? (
                              <span className="text-xs font-mono text-amber-400 font-medium">{log.closed}</span>
                            ) : (
                              <span className="text-xs font-mono text-dark-600">0</span>
                            )}
                          </div>
                          <div className="col-span-3">
                            {hasError ? (
                              <div className="text-[11px] text-red-400 truncate" title={log.errors.join('\n')}>
                                {log.errors[0].substring(0, 30)}
                              </div>
                            ) : (
                              <span className="text-[11px] text-green-400/70">正常</span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function StatCard({ label, value, sub, color, isText }: {
  label: string; value: number | string; sub?: string; color: string; isText?: boolean;
}) {
  const colorMap: Record<string, string> = {
    blue: 'text-blue-400', cyan: 'text-cyan-400', purple: 'text-purple-400',
    amber: 'text-amber-400', green: 'text-green-400', red: 'text-red-400', slate: 'text-dark-500',
  };
  return (
    <div className="glass-card p-4">
      <p className="text-xs text-dark-500 mb-1.5">{label}</p>
      <p className={`text-xl font-bold font-mono ${colorMap[color] || 'text-white'} ${isText ? 'text-base' : ''}`}>{value}</p>
      {sub && <p className="text-[10px] text-dark-500 mt-1">{sub}</p>}
    </div>
  );
}
