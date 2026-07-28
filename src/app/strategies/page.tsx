'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import useAuthStore from '@/store/authStore';
import { apiGet, apiPut } from '@/shared/api/client';
import {
  STRATEGIES,
  type StrategyMeta,
  type StrategyConfig,
  type StrategyParamMeta,
} from '@/shared/lib/strategies';

const CATEGORY_COLORS: Record<string, string> = {
  趋势跟随: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  均值回归: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  突破: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  动量: 'bg-red-500/10 text-red-400 border-red-500/30',
  机构订单流: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
  波段: 'bg-green-500/10 text-green-400 border-green-500/30',
  量化统计: 'bg-pink-500/10 text-pink-400 border-pink-500/30',
  经典系统: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
};

const RISK_COLORS: Record<string, string> = {
  保守: 'text-green-400',
  稳健: 'text-amber-400',
  激进: 'text-red-400',
};

export default function StrategiesPage() {
  const router = useRouter();
  const { isAuthenticated, setUser } = useAuthStore();
  const [checking, setChecking] = useState(true);
  const [config, setConfig] = useState<StrategyConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 鉴权
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meData = await apiGet<{ user: any }>('/api/auth/me');
        if (!cancelled) setUser(meData.user);
      } catch {
        if (!cancelled) router.push('/login');
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [router, setUser]);

  // 加载策略配置
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<StrategyConfig>('/api/user/strategy');
        if (!cancelled) setConfig(data);
      } catch (err) {
        console.error('加载策略配置失败', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const handleToggle = useCallback((strategyId: string, enabled: boolean) => {
    setConfig((prev) => ({
      ...prev,
      [strategyId]: {
        enabled,
        params: prev[strategyId]?.params || STRATEGIES.find((s) => s.id === strategyId)?.defaultParams || {},
      },
    }));
  }, []);

  const handleParamChange = useCallback((strategyId: string, paramKey: string, value: number | string) => {
    setConfig((prev) => ({
      ...prev,
      [strategyId]: {
        enabled: prev[strategyId]?.enabled ?? false,
        params: {
          ...(prev[strategyId]?.params || {}),
          [paramKey]: value,
        },
      },
    }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const data = await apiPut<StrategyConfig>('/api/user/strategy', config);
      setConfig(data);
      setMessage({ type: 'success', text: '策略配置已保存，将在交易页面生效' });
      setTimeout(() => setMessage(null), 4000);
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || '保存失败，请重试' });
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handleReset = useCallback(() => {
    const reset: StrategyConfig = {};
    for (const s of STRATEGIES) {
      reset[s.id] = { enabled: false, params: { ...s.defaultParams } };
    }
    setConfig(reset);
    setMessage({ type: 'success', text: '已重置为默认配置（需点击保存生效）' });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-950">
        <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  const enabledCount = Object.values(config).filter((c) => c?.enabled).length;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 pt-20 pb-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* 页头 */}
          <div className="mb-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500/20 to-blue-500/20 border border-amber-500/30 flex items-center justify-center">
                <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">交易策略中心</h1>
                <p className="text-dark-400 text-sm mt-0.5">
                  16 套 BTC/ETH 合约实战策略 · 已启用 <span className="text-amber-400 font-bold">{enabledCount}</span> / {STRATEGIES.length}
                </p>
              </div>
            </div>
          </div>

          {/* 消息提示 */}
          {message && (
            <div className={`p-3.5 rounded-lg mb-5 text-sm ${
              message.type === 'success'
                ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                : 'bg-red-500/10 border border-red-500/30 text-red-400'
            }`}>
              {message.text}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* 操作栏 */}
              <div className="flex items-center justify-between mb-5">
                <div className="text-dark-400 text-xs">
                  点击开关启用策略，展开可调整参数。保存后在<a href="/trading" className="text-blue-400 hover:underline">交易页面</a>查看实时信号。
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleReset}
                    className="px-3 py-1.5 text-xs rounded-lg border border-dark-600 text-dark-300 hover:bg-dark-800 transition-colors"
                  >
                    重置
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-1.5 text-xs rounded-lg bg-blue-500 hover:bg-blue-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                  >
                    {saving && <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />}
                    {saving ? '保存中...' : '保存配置'}
                  </button>
                </div>
              </div>

              {/* 策略卡片列表 */}
              <div className="space-y-3">
                {STRATEGIES.map((strategy) => {
                  const cfg = config[strategy.id] || { enabled: false, params: strategy.defaultParams };
                  const isExpanded = expandedId === strategy.id;
                  const isEnabled = cfg.enabled;
                  return (
                    <StrategyCard
                      key={strategy.id}
                      strategy={strategy}
                      enabled={isEnabled}
                      params={cfg.params}
                      expanded={isExpanded}
                      onToggle={(en) => handleToggle(strategy.id, en)}
                      onParamChange={(k, v) => handleParamChange(strategy.id, k, v)}
                      onExpand={() => setExpandedId(isExpanded ? null : strategy.id)}
                    />
                  );
                })}
              </div>

              {/* 底部说明 */}
              <div className="mt-8 glass-card p-4 border-amber-500/20">
                <div className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="text-xs text-dark-400 leading-relaxed">
                    <p className="text-amber-400 font-medium mb-1">风险提示</p>
                    策略信号基于技术指标计算，仅供参考，不构成投资建议。合约交易具有高杠杆高风险，可能导致本金全部损失。
                    请根据自身风险承受能力谨慎决策，严格执行止损。建议先用小仓位验证策略效果，再逐步加大仓位。
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}

// ==================== 策略卡片组件 ====================

interface StrategyCardProps {
  strategy: StrategyMeta;
  enabled: boolean;
  params: Record<string, number | string>;
  expanded: boolean;
  onToggle: (enabled: boolean) => void;
  onParamChange: (key: string, value: number | string) => void;
  onExpand: () => void;
}

function StrategyCard({ strategy, enabled, params, expanded, onToggle, onParamChange, onExpand }: StrategyCardProps) {
  const catColor = CATEGORY_COLORS[strategy.category] || 'bg-dark-700 text-dark-300';
  const riskColor = RISK_COLORS[strategy.risk] || 'text-dark-300';

  return (
    <div className={`glass-card overflow-hidden transition-all ${
      enabled ? 'border-blue-500/40 shadow-lg shadow-blue-500/5' : ''
    }`}>
      {/* 卡片头部 */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          {/* 左侧：信息 */}
          <button
            onClick={onExpand}
            className="flex-1 text-left min-w-0"
          >
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${catColor}`}>
                {strategy.category}
              </span>
              <span className="text-[10px] text-dark-500">·</span>
              <span className={`text-[10px] font-medium ${riskColor}`}>{strategy.risk}</span>
              <span className="text-[10px] text-dark-500">·</span>
              <span className="text-[10px] text-dark-400">{strategy.timeframe}</span>
              {enabled && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 font-medium">
                  已启用
                </span>
              )}
            </div>
            <h3 className="text-white font-bold text-base mb-1">{strategy.name}</h3>
            <p className="text-dark-400 text-xs">{strategy.tagline}</p>
          </button>

          {/* 右侧：开关 */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggle(!enabled);
              }}
              role="switch"
              aria-checked={enabled}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                enabled ? 'bg-blue-500' : 'bg-dark-600'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                  enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* 展开内容 */}
        {expanded && (
          <div className="mt-4 pt-4 border-t border-dark-700/40 space-y-4">
            {/* 策略说明 */}
            <div>
              <h4 className="text-xs font-semibold text-dark-300 uppercase tracking-wider mb-1.5">策略理念</h4>
              <p className="text-dark-400 text-xs leading-relaxed">{strategy.description}</p>
            </div>

            {/* 入场规则 */}
            <div>
              <h4 className="text-xs font-semibold text-green-400/80 uppercase tracking-wider mb-1.5">入场条件</h4>
              <ul className="space-y-1">
                {strategy.entryRules.map((rule, i) => (
                  <li key={i} className="text-xs text-dark-400 flex items-start gap-2">
                    <span className="text-green-400/60 mt-0.5">▸</span>
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* 出场规则 */}
            <div>
              <h4 className="text-xs font-semibold text-red-400/80 uppercase tracking-wider mb-1.5">出场 / 止损</h4>
              <ul className="space-y-1">
                {strategy.exitRules.map((rule, i) => (
                  <li key={i} className="text-xs text-dark-400 flex items-start gap-2">
                    <span className="text-red-400/60 mt-0.5">▸</span>
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* 参数调整 */}
            {strategy.paramSchema.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-blue-400/80 uppercase tracking-wider mb-2">参数调整</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {strategy.paramSchema.map((param) => (
                    <ParamControl
                      key={param.key}
                      param={param}
                      value={params[param.key] ?? param.default}
                      onChange={(v) => onParamChange(param.key, v)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 展开/收起提示 */}
        <button
          onClick={onExpand}
          className="mt-3 flex items-center gap-1 text-[11px] text-dark-500 hover:text-dark-300 transition-colors"
        >
          {expanded ? '收起' : '查看详情 & 调整参数'}
          <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ==================== 参数控件 ====================

interface ParamControlProps {
  param: StrategyParamMeta;
  value: number | string;
  onChange: (value: number | string) => void;
}

function ParamControl({ param, value, onChange }: ParamControlProps) {
  return (
    <div className="bg-dark-800/40 rounded-lg p-3 border border-dark-700/40">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-dark-300 font-medium">{param.label}</label>
        {param.type === 'number' && (
          <span className="text-xs text-blue-400 font-mono font-bold">{value}</span>
        )}
      </div>
      {param.type === 'number' ? (
        <input
          type="range"
          min={param.min}
          max={param.max}
          step={param.step}
          value={Number(value)}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-dark-600 rounded-full appearance-none cursor-pointer accent-blue-500"
        />
      ) : (
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-dark-700 text-white text-xs rounded-md px-2 py-1.5 border border-dark-600 focus:outline-none focus:border-blue-500"
        >
          {param.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      )}
      {param.desc && (
        <p className="text-[10px] text-dark-500 mt-1">{param.desc}</p>
      )}
      {param.type === 'number' && (
        <div className="flex justify-between text-[9px] text-dark-600 mt-0.5">
          <span>{param.min}</span>
          <span>{param.max}</span>
        </div>
      )}
    </div>
  );
}
