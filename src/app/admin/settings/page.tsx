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
}

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
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

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

  if (!isAuthenticated || user?.role !== 'admin') return null;

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
