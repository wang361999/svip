'use client';

import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '@/shared/api/client';

// 首次部署时数据库为空不需要密钥，已初始化后由后端校验

interface StageDetails {
  index?: number;
  label?: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
  message?: string;
  step?: string;
}

interface InitResponse {
  message: string;
  overallOk: boolean;
  urlSource?: string;
  stages?: {
    connectionCheck: { ok: boolean; durationMs: number; error?: string };
    tableCreation: {
      total: number;
      success: number;
      failed: number;
      allOk: boolean;
      details: StageDetails[];
    };
    dataSeed: {
      admin: StageDetails;
      siteSettings: StageDetails;
      allOk: boolean;
    };
  };
  summary?: {
    totalSteps: number;
    successSteps: number;
    failedSteps: number;
  };
}

export default function InitPage() {
  const [status, setStatus] = useState<'idle' | 'checking' | 'initializing' | 'done' | 'error'>('idle');
  const [dbUrl, setDbUrl] = useState('postgresql://neondb_owner:npg_93uJZaQediCT@ep-bitter-sky-av7121gm-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require');
  const [initResult, setInitResult] = useState<InitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alreadyInit, setAlreadyInit] = useState(false);
  const [envDbConfigured, setEnvDbConfigured] = useState(false);

  // 检查是否已通过环境变量配置了 DATABASE_URL
  useEffect(() => {
    checkStatus();
  }, []);

  const INIT_KEY = 'eth-trading-init-2024';

  const checkStatus = async (urlToCheck?: string) => {
    setStatus('checking');
    setError(null);
    try {
      const parts = [urlToCheck ? `databaseUrl=${encodeURIComponent(urlToCheck)}` : '', `key=${INIT_KEY}`].filter(Boolean);
      const params = parts.length ? `?${parts.join('&')}` : '';
      const data = await apiGet<{
        initialized: boolean;
        userCount: number;
        settingsCount: number;
        message: string;
        urlSource?: string;
      }>(`/api/init${params}`);

      if (data.urlSource && data.urlSource !== 'none') {
        setEnvDbConfigured(true);
      }

      if (data.initialized) {
        setAlreadyInit(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('DB_URL_MISSING')) {
        setEnvDbConfigured(false);
      } else if (msg.includes('DB_CONNECT_FAILED')) {
        setError('数据库连接失败，请检查连接串是否正确');
      }
    } finally {
      setStatus('idle');
    }
  };

  const handleInit = async () => {
    if (!dbUrl.trim() && !envDbConfigured) {
      setError('请粘贴 Neon 数据库连接串');
      return;
    }

    setStatus('initializing');
    setError(null);
    setInitResult(null);

    try {
      const body = dbUrl.trim() ? { databaseUrl: dbUrl.trim() } : {};
      const data = await apiPost<InitResponse>(`/api/init?key=${INIT_KEY}`, body);

      setStatus('done');
      setInitResult(data);
      if (data.overallOk) {
        setAlreadyInit(true);
      }
    } catch (err) {
      setStatus('error');
      const msg = err instanceof Error ? err.message : '初始化失败';
      setError(msg);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-950 px-4 py-8">
      <div className="w-full max-w-2xl">
        <div className="glass-card p-8">
          {/* Logo */}
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <span className="text-white font-bold text-2xl">ETH</span>
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">ETH Trading Tool</h1>
            <p className="text-dark-400 text-sm">数据库初始化向导 — 粘贴连接串，一键搞定</p>
          </div>

          {/* 数据库连接串输入框 */}
          <div className="mb-4">
            <label className="block text-sm text-dark-300 mb-2">
              Neon 数据库连接串
              {envDbConfigured && (
                <span className="ml-2 text-green-400 text-xs">(已通过环境变量配置，可不填)</span>
              )}
            </label>
            <textarea
              value={dbUrl}
              onChange={(e) => setDbUrl(e.target.value)}
              placeholder="postgresql://user:password@ep-xxxxx.us-east-2.aws.neon.tech/eth_trading?sslmode=require"
              className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-dark-500 focus:outline-none focus:border-blue-500 resize-none"
              rows={3}
              disabled={status === 'initializing'}
            />
            <p className="text-xs text-dark-500 mt-1.5">
              在 Neon Dashboard → Connection Details → 复制 Connection String 粘贴到这里
            </p>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm mb-4">
              {error}
            </div>
          )}

          {/* 已初始化提示 */}
          {alreadyInit && status === 'idle' && !initResult && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm mb-4 text-center">
              数据库已初始化，可以直接使用！
            </div>
          )}

          {/* 初始化结果 */}
          {initResult && (
            <div className="mb-4 space-y-3">
              {/* 总览 */}
              <div className={`p-4 rounded-lg border ${
                initResult.overallOk
                  ? 'bg-green-500/10 border-green-500/30'
                  : 'bg-yellow-500/10 border-yellow-500/30'
              }`}>
                <div className={`font-bold mb-1 ${initResult.overallOk ? 'text-green-400' : 'text-yellow-400'}`}>
                  {initResult.overallOk ? '初始化成功' : '初始化完成（部分失败）'}
                </div>
                <div className="text-sm text-dark-300">{initResult.message}</div>
                {initResult.summary && (
                  <div className="text-xs text-dark-400 mt-2">
                    总步骤 {initResult.summary.totalSteps} · 成功 {initResult.summary.successSteps} · 失败 {initResult.summary.failedSteps}
                  </div>
                )}
              </div>

              {/* 连接预检 */}
              {initResult.stages?.connectionCheck && (
                <div className="bg-dark-800/50 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-dark-300">① 数据库连接预检</span>
                    <span className={`text-xs ${initResult.stages.connectionCheck.ok ? 'text-green-400' : 'text-red-400'}`}>
                      {initResult.stages.connectionCheck.ok ? `✓ ${initResult.stages.connectionCheck.durationMs}ms` : '✗ 失败'}
                    </span>
                  </div>
                  {initResult.stages.connectionCheck.error && (
                    <div className="text-xs text-red-400 mt-1 break-all">{initResult.stages.connectionCheck.error}</div>
                  )}
                </div>
              )}

              {/* 建表结果 */}
              {initResult.stages?.tableCreation && (
                <div className="bg-dark-800/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-dark-300">② 逐条建表（{initResult.stages.tableCreation.success}/{initResult.stages.tableCreation.total}）</span>
                    <span className={`text-xs ${initResult.stages.tableCreation.allOk ? 'text-green-400' : 'text-yellow-400'}`}>
                      {initResult.stages.tableCreation.allOk ? '✓ 全部成功' : `${initResult.stages.tableCreation.failed} 条失败`}
                    </span>
                  </div>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {initResult.stages.tableCreation.details.map((d, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-dark-400 truncate flex-1 mr-2">
                          <span className={d.ok ? 'text-green-400' : 'text-red-400'}>{d.ok ? '✓' : '✗'}</span>
                          {' '}{d.label}
                        </span>
                        <span className="text-dark-500">{d.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 数据写入结果 */}
              {initResult.stages?.dataSeed && (
                <div className="bg-dark-800/50 rounded-lg p-3 space-y-2">
                  <div className="text-sm text-dark-300 mb-1">③ 逐条写入初始数据</div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-dark-400">
                      <span className={initResult.stages.dataSeed.admin.ok ? 'text-green-400' : 'text-red-400'}>
                        {initResult.stages.dataSeed.admin.ok ? '✓' : '✗'}
                      </span>{' '}管理员账户
                    </span>
                    <span className="text-dark-500">{initResult.stages.dataSeed.admin.message}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-dark-400">
                      <span className={initResult.stages.dataSeed.siteSettings.ok ? 'text-green-400' : 'text-red-400'}>
                        {initResult.stages.dataSeed.siteSettings.ok ? '✓' : '✗'}
                      </span>{' '}网站设置
                    </span>
                    <span className="text-dark-500">{initResult.stages.dataSeed.siteSettings.message}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 初始化按钮 */}
          <button
            onClick={handleInit}
            disabled={status === 'initializing' || (alreadyInit && status === 'idle' && !dbUrl.trim())}
            className="btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'initializing'
              ? '正在初始化...'
              : status === 'checking'
              ? '检测中...'
              : alreadyInit && !dbUrl.trim()
              ? '已初始化完成'
              : '一键初始化数据库'}
          </button>

          {status === 'initializing' && (
            <div className="mt-4 flex items-center justify-center gap-2 text-dark-400 text-sm">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              正在逐条建表和写入数据，请稍候...
            </div>
          )}

          {/* 底部信息 */}
          <div className="mt-6 text-dark-500 text-xs space-y-1 text-center">
            <p>初始化后会自动创建 6 张表 + 管理员账户 + 默认网站设置</p>
            <p>管理员账号: admin@ethtrading.com / admin（登录后请去 /profile 改密码）</p>
          </div>
        </div>
      </div>
    </div>
  );
}
