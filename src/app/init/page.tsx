'use client';

import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '@/shared/api/client';

// 安全说明：数据库连接串只允许通过服务端 DATABASE_URL 环境变量提供，
// 页面不再接受、也不再内嵌任何连接串或初始化密钥。

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
  const [initResult, setInitResult] = useState<InitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alreadyInit, setAlreadyInit] = useState(false);

  // 检查数据库初始化状态（连接串完全由服务端环境变量提供）
  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    setStatus('checking');
    setError(null);
    try {
      const data = await apiGet<{
        initialized: boolean;
        userCount: number;
        settingsCount: number;
        message: string;
      }>('/api/init');

      if (data.initialized) {
        setAlreadyInit(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('DB_URL_MISSING')) {
        setError('服务端未配置 DATABASE_URL 环境变量，请在 Vercel 环境变量中配置后重试');
      } else if (msg.includes('DB_CONNECT_FAILED')) {
        setError('数据库连接失败，请检查服务端 DATABASE_URL 配置');
      }
    } finally {
      setStatus('idle');
    }
  };

  const handleInit = async () => {
    setStatus('initializing');
    setError(null);
    setInitResult(null);

    try {
      const data = await apiPost<InitResponse>('/api/init', {});
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
            <p className="text-dark-400 text-sm">数据库初始化向导 — 使用服务端环境变量 DATABASE_URL</p>
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
            disabled={status === 'initializing' || status === 'checking' || alreadyInit}
            className="btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'initializing'
              ? '正在初始化...'
              : status === 'checking'
              ? '检测中...'
              : alreadyInit
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
            <p>初始化会自动创建数据表 + 管理员账户 + 默认网站设置</p>
            <p>管理员初始密码取自 INIT_ADMIN_PASSWORD 环境变量（未配置则随机生成，仅显示一次），登录后请立即修改</p>
          </div>
        </div>
      </div>
    </div>
  );
}
