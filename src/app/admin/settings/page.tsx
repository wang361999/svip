'use client';

import AdminSidebar from '@/components/admin/AdminSidebar';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import { apiGet, apiPut } from '@/shared/api/client';

interface SiteSettings {
  siteTitle: string;
  siteSubtitle: string;
  siteLogo: string;
  footerText: string;
  primaryColor: string;
  enableRegistration: string;
  paperTradingEnabled: string;
  // AI 配置
  aiEnabled: string;
  aiProvider: string;
  aiApiUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiTemperature: string;
  aiMaxTokens: string;
  aiAnalysisInterval: string;
  aiAutoTrade: string;
}

interface AiProviderMeta {
  id: string;
  label: string;
  defaultApiUrl: string;
  defaultModel: string;
  models: string[];
  hasPreset: boolean; // 是否有预配置凭证
}

const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultApiUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    hasPreset: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultApiUrl: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hasPreset: false,
  },
  {
    id: 'qwen',
    label: '通义千问 (Qwen)',
    defaultApiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    hasPreset: false,
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    defaultApiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    hasPreset: false,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA GLM-5.2 (智谱) ⚡预配置',
    defaultApiUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    defaultModel: 'z-ai/glm-5.2',
    models: ['z-ai/glm-5.2'],
    hasPreset: true,
  },
  {
    id: 'custom',
    label: 'Agnes-AI (agnes-2.5-flash) ⚡预配置',
    defaultApiUrl: 'https://api.agnes-ai.cn/v1/chat/completions',
    defaultModel: 'agnes-2.5-flash',
    models: ['agnes-2.5-flash', 'agnes-2.5-pro', 'agnes-2.0-flash'],
    hasPreset: true,
  },
];

export default function AdminSettingsPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const [settings, setSettings] = useState<SiteSettings>({
    siteTitle: 'ETH Trading Tool',
    siteSubtitle: 'Real-time Ethereum Trading Platform',
    siteLogo: '/logo.svg',
    footerText: '© 2024 ETH Trading Tool. All rights reserved.',
    primaryColor: '#3b82f6',
    enableRegistration: 'true',
    paperTradingEnabled: 'false',
    aiEnabled: 'true',
    aiProvider: 'custom',
    aiApiUrl: 'https://api.agnes-ai.cn/v1/chat/completions',
    aiApiKey: '',
    aiModel: 'agnes-2.5-flash',
    aiTemperature: '0.3',
    aiMaxTokens: '4000',
    aiAnalysisInterval: '30',
    aiAutoTrade: 'false',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    if (isAuthenticated && user?.role !== 'admin') {
      router.push('/');
      return;
    }
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }

    const loadSettings = async () => {
      try {
        const data = await apiGet<any>('/api/settings');
        setSettings({
          siteTitle: data.siteTitle || '',
          siteSubtitle: data.siteSubtitle || '',
          siteLogo: data.siteLogo || '',
          footerText: data.footerText || '',
          primaryColor: data.primaryColor || '#3b82f6',
          enableRegistration: data.enableRegistration || 'true',
          paperTradingEnabled: data.paperTradingEnabled || 'false',
          aiEnabled: data.aiEnabled || 'true',
          aiProvider: data.aiProvider || 'custom',
          aiApiUrl: data.aiApiUrl || 'https://api.agnes-ai.cn/v1/chat/completions',
          aiApiKey: data.aiApiKey || '',
          aiModel: data.aiModel || 'agnes-2.5-flash',
          aiTemperature: data.aiTemperature || '0.3',
          aiMaxTokens: data.aiMaxTokens || '4000',
          aiAnalysisInterval: data.aiAnalysisInterval || '30',
          aiAutoTrade: data.aiAutoTrade || 'false',
        });
      } catch (err) {
        setMessage(err instanceof Error ? err.message : '获取设置失败');
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
  }, [isAuthenticated, user?.role, router]);

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      await apiPut('/api/settings', settings);
      setMessage('保存成功！');
      document.title = settings.siteTitle;
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleRegistration = () => {
    setSettings((prev) => ({
      ...prev,
      enableRegistration: prev.enableRegistration === 'true' ? 'false' : 'true',
    }));
  };

  const togglePaperTrading = () => {
    setSettings((prev) => ({
      ...prev,
      paperTradingEnabled: prev.paperTradingEnabled === 'true' ? 'false' : 'true',
    }));
  };

  const toggleAi = () => {
    setSettings((prev) => ({
      ...prev,
      aiEnabled: prev.aiEnabled === 'true' ? 'false' : 'true',
    }));
  };

  const toggleAiAutoTrade = () => {
    setSettings((prev) => ({
      ...prev,
      aiAutoTrade: prev.aiAutoTrade === 'true' ? 'false' : 'true',
    }));
  };

  /** 切换供应商时自动填充默认 API URL 和模型 */
  const handleProviderChange = (providerId: string) => {
    const meta = AI_PROVIDERS.find((p) => p.id === providerId);
    setSettings((prev) => ({
      ...prev,
      aiProvider: providerId,
      aiApiUrl: meta?.defaultApiUrl || '',
      aiModel: meta?.defaultModel || '',
      // 预配置供应商的 API Key 留空，后端自动使用 PROVIDER_DEFAULTS
      aiApiKey: meta?.hasPreset ? '' : prev.aiApiKey,
    }));
  };

  if (!isAuthenticated || user?.role !== 'admin') return null;

  const currentProvider = AI_PROVIDERS.find((p) => p.id === settings.aiProvider);

  return (
    <div className="flex bg-dark-950 min-h-screen">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-3xl">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white">网站设置</h1>
            <p className="text-dark-400 mt-1">管理网站基本信息和注册功能。</p>
          </div>

          {message && (
            <div className={`p-4 rounded-lg mb-6 ${
              message.includes('成功')
                ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                : 'bg-red-500/10 border border-red-500/30 text-red-400'
            }`}>
              {message}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-6">
              {/* 基本信息 */}
              <div className="glass-card p-6 space-y-5">
                <h2 className="text-lg font-semibold text-white">基本信息</h2>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">网站标题</label>
                  <input
                    type="text"
                    value={settings.siteTitle}
                    onChange={(e) => setSettings({ ...settings, siteTitle: e.target.value })}
                    className="input-dark"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">网站副标题</label>
                  <input
                    type="text"
                    value={settings.siteSubtitle}
                    onChange={(e) => setSettings({ ...settings, siteSubtitle: e.target.value })}
                    className="input-dark"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">Logo URL</label>
                  <input
                    type="text"
                    value={settings.siteLogo}
                    onChange={(e) => setSettings({ ...settings, siteLogo: e.target.value })}
                    className="input-dark"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">页脚版权文本</label>
                  <textarea
                    value={settings.footerText}
                    onChange={(e) => setSettings({ ...settings, footerText: e.target.value })}
                    className="input-dark" rows={2}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">主题色</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={settings.primaryColor}
                      onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
                      className="w-12 h-10 rounded bg-dark-800 border border-dark-600 cursor-pointer"
                    />
                    <input
                      type="text"
                      value={settings.primaryColor}
                      onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
                      className="input-dark flex-1"
                    />
                  </div>
                </div>
              </div>

              {/* 注册功能开关 */}
              <div className="glass-card p-6">
                <h2 className="text-lg font-semibold text-white mb-4">注册功能</h2>
                <p className="text-dark-400 text-sm mb-4">控制是否允许新用户注册账号</p>
                <div
                  className={`flex items-center justify-between p-4 rounded-lg border transition-all cursor-pointer ${
                    settings.enableRegistration === 'true'
                      ? 'bg-blue-600/10 border-blue-500/30'
                      : 'bg-dark-800/30 border-dark-700/30 hover:border-dark-600'
                  }`}
                  onClick={toggleRegistration}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium">允许注册</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        settings.enableRegistration === 'true' ? 'bg-green-500/20 text-green-400' : 'bg-dark-700 text-dark-400'
                      }`}>
                        {settings.enableRegistration === 'true' ? '开启' : '关闭'}
                      </span>
                    </div>
                    <p className="text-dark-400 text-xs mt-1">
                      {settings.enableRegistration === 'true'
                        ? '新用户可以通过注册页面创建账号'
                        : '注册页面将显示关闭提示，仅管理员可创建账号'}
                    </p>
                  </div>
                  <div className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${
                    settings.enableRegistration === 'true' ? 'bg-blue-600' : 'bg-dark-600'
                  }`}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                      settings.enableRegistration === 'true' ? 'translate-x-6' : 'translate-x-1'
                    }`} />
                  </div>
                </div>
              </div>

              {/* 模拟盘开关 */}
              <div className="glass-card p-6">
                <h2 className="text-lg font-semibold text-white mb-4">模拟盘</h2>
                <p className="text-dark-400 text-sm mb-4">控制交易页面模拟盘面板的显示/隐藏</p>
                <div
                  className={`flex items-center justify-between p-4 rounded-lg border transition-all cursor-pointer ${
                    settings.paperTradingEnabled === 'true'
                      ? 'bg-purple-600/10 border-purple-500/30'
                      : 'bg-dark-800/30 border-dark-700/30 hover:border-dark-600'
                  }`}
                  onClick={togglePaperTrading}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium">模拟盘面板</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        settings.paperTradingEnabled === 'true' ? 'bg-green-500/20 text-green-400' : 'bg-dark-700 text-dark-400'
                      }`}>
                        {settings.paperTradingEnabled === 'true' ? '开启' : '关闭'}
                      </span>
                    </div>
                    <p className="text-dark-400 text-xs mt-1">
                      {settings.paperTradingEnabled === 'true'
                        ? '用户可在交易页面查看模拟盘面板，进行模拟交易和复盘'
                        : '交易页面不显示模拟盘面板，关闭后不影响已有数据'}
                    </p>
                  </div>
                  <div className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${
                    settings.paperTradingEnabled === 'true' ? 'bg-purple-600' : 'bg-dark-600'
                  }`}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                      settings.paperTradingEnabled === 'true' ? 'translate-x-6' : 'translate-x-1'
                    }`} />
                  </div>
                </div>
              </div>

              {/* AI 模型配置 */}
              <div className="glass-card p-6 space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">AI 模型配置</h2>
                    <p className="text-dark-400 text-sm mt-1">接入 AI 模型进行实时行情分析</p>
                  </div>
                  <div
                    className={`flex items-center justify-between p-3 rounded-lg border transition-all cursor-pointer ${
                      settings.aiEnabled === 'true'
                        ? 'bg-emerald-600/10 border-emerald-500/30'
                        : 'bg-dark-800/30 border-dark-700/30 hover:border-dark-600'
                    }`}
                    onClick={toggleAi}
                  >
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium mr-2 ${
                      settings.aiEnabled === 'true' ? 'bg-green-500/20 text-green-400' : 'bg-dark-700 text-dark-400'
                    }`}>
                      {settings.aiEnabled === 'true' ? '已启用' : '未启用'}
                    </span>
                    <div className={`w-11 h-6 rounded-full relative transition-colors ${
                      settings.aiEnabled === 'true' ? 'bg-emerald-600' : 'bg-dark-600'
                    }`}>
                      <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                        settings.aiEnabled === 'true' ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </div>
                  </div>
                </div>

                {/* 供应商选择 */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">模型供应商</label>
                  <select
                    value={settings.aiProvider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="input-dark"
                  >
                    {AI_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  <p className="text-dark-500 text-xs mt-1">
                    ⚡ 标记的供应商已预配置 API 凭证，选择后可直接使用。也可手动填写自定义凭证。
                  </p>
                </div>

                {/* API 地址 */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">API 地址</label>
                  <input
                    type="text"
                    value={settings.aiApiUrl}
                    onChange={(e) => setSettings({ ...settings, aiApiUrl: e.target.value })}
                    placeholder="https://api.openai.com/v1/chat/completions"
                    className="input-dark"
                  />
                  <p className="text-dark-500 text-xs mt-1">兼容 OpenAI Chat Completions 格式的 API 端点</p>
                </div>

                {/* API Key */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">API Key</label>
                  <div className="relative">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={settings.aiApiKey}
                      onChange={(e) => setSettings({ ...settings, aiApiKey: e.target.value })}
                      placeholder="sk-..."
                      className="input-dark pr-20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-dark-400 hover:text-white px-2 py-1"
                    >
                      {showApiKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                  <p className="text-dark-500 text-xs mt-1">
                    {currentProvider?.hasPreset
                      ? '此供应商已预配置凭证，留空则自动使用内置 API Key'
                      : '你的 API 密钥，将安全存储在数据库中'}
                  </p>
                </div>

                {/* 模型名称 */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">模型名称</label>
                  {currentProvider && currentProvider.models.length > 0 ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={settings.aiModel}
                        onChange={(e) => setSettings({ ...settings, aiModel: e.target.value })}
                        placeholder="gpt-4o-mini"
                        className="input-dark"
                      />
                      <div className="flex flex-wrap gap-2">
                        {currentProvider.models.map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setSettings({ ...settings, aiModel: m })}
                            className={`text-xs px-3 py-1 rounded-full border transition-all ${
                              settings.aiModel === m
                                ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
                                : 'bg-dark-800 border-dark-700 text-dark-400 hover:border-dark-600'
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={settings.aiModel}
                      onChange={(e) => setSettings({ ...settings, aiModel: e.target.value })}
                      placeholder="输入模型名称"
                      className="input-dark"
                    />
                  )}
                </div>

                {/* 温度和 Max Tokens */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-dark-300 mb-2">温度 (Temperature)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={settings.aiTemperature}
                      onChange={(e) => setSettings({ ...settings, aiTemperature: e.target.value })}
                      className="input-dark"
                    />
                    <p className="text-dark-500 text-xs mt-1">0=精确, 2=创造性，建议 0.1-0.5</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-dark-300 mb-2">最大 Tokens</label>
                    <input
                      type="number"
                      min="500"
                      max="16384"
                      step="100"
                      value={settings.aiMaxTokens}
                      onChange={(e) => setSettings({ ...settings, aiMaxTokens: e.target.value })}
                      className="input-dark"
                    />
                    <p className="text-dark-500 text-xs mt-1">建议 2000-8000（推理模型建议 4000+）</p>
                  </div>
                </div>

                {/* 自动分析间隔 */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">自动分析间隔（秒）</label>
                  <input
                    type="number"
                    min="0"
                    max="300"
                    value={settings.aiAnalysisInterval}
                    onChange={(e) => setSettings({ ...settings, aiAnalysisInterval: e.target.value })}
                    className="input-dark"
                  />
                  <p className="text-dark-500 text-xs mt-1">
                    每 N 秒自动分析一次「当前选中币种」（0=不自动，30=每30秒，推荐 15-60 秒）。仅前端 AI 面板对正在查看的币种触发，引擎不会批量分析所有币种
                  </p>
                </div>

                {/* AI 自动交易开关 */}
                <div
                  className={`flex items-center justify-between p-4 rounded-lg border transition-all cursor-pointer ${
                    settings.aiAutoTrade === 'true'
                      ? 'bg-amber-600/10 border-amber-500/30'
                      : 'bg-dark-800/30 border-dark-700/30 hover:border-dark-600'
                  }`}
                  onClick={toggleAiAutoTrade}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium">AI 信号自动开仓</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        settings.aiAutoTrade === 'true' ? 'bg-amber-500/20 text-amber-400' : 'bg-dark-700 text-dark-400'
                      }`}>
                        {settings.aiAutoTrade === 'true' ? '开启' : '关闭'}
                      </span>
                    </div>
                    <p className="text-dark-400 text-xs mt-1">
                      {settings.aiAutoTrade === 'true'
                        ? 'AI 分析给出做多/做空建议时，自动在模拟盘开仓（需同时开启模拟盘自动交易）'
                        : 'AI 仅提供分析建议，不会自动开仓'}
                    </p>
                  </div>
                  <div className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${
                    settings.aiAutoTrade === 'true' ? 'bg-amber-600' : 'bg-dark-600'
                  }`}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                      settings.aiAutoTrade === 'true' ? 'translate-x-6' : 'translate-x-1'
                    }`} />
                  </div>
                </div>
              </div>

              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? '保存中...' : '保存设置'}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
