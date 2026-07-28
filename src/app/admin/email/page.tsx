'use client';

import AdminSidebar from '@/components/admin/AdminSidebar';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import { apiGet, apiPost, apiPut } from '@/shared/api/client';

interface EmailSettings {
  smtpHost: string;
  smtpPort: string;
  smtpSecure: string;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
}

export default function AdminEmailPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const [settings, setSettings] = useState<EmailSettings>({
    smtpHost: 'smtp.qq.com',
    smtpPort: '465',
    smtpSecure: 'true',
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');

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
          smtpHost: data.smtpHost || 'smtp.qq.com',
          smtpPort: data.smtpPort || '465',
          smtpSecure: data.smtpSecure || 'true',
          smtpUser: data.smtpUser || '',
          smtpPass: data.smtpPass || '',
          smtpFrom: data.smtpFrom || '',
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
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!testEmail) {
      setTestMessage('请输入测试邮箱');
      return;
    }
    setTesting(true);
    setTestMessage('');
    try {
      await apiPost('/api/admin/test-email', { email: testEmail });
      setTestMessage('测试邮件已发送，请查收');
    } catch (err) {
      setTestMessage(err instanceof Error ? err.message : '发送失败');
    } finally {
      setTesting(false);
    }
  };

  if (!isAuthenticated || user?.role !== 'admin') return null;

  return (
    <div className="flex bg-dark-950 min-h-screen">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-3xl">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white">邮箱配置</h1>
            <p className="text-dark-400 mt-1">配置 SMTP 服务器以启用邮箱验证码功能。</p>
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
              {/* SMTP 配置 */}
              <div className="glass-card p-6 space-y-5">
                <h2 className="text-lg font-semibold text-white">SMTP 服务器</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-medium text-dark-300 mb-2">SMTP 服务器地址</label>
                    <input
                      type="text"
                      value={settings.smtpHost}
                      onChange={(e) => setSettings({ ...settings, smtpHost: e.target.value })}
                      className="input-dark"
                      placeholder="smtp.qq.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-dark-300 mb-2">端口</label>
                    <input
                      type="text"
                      value={settings.smtpPort}
                      onChange={(e) => setSettings({ ...settings, smtpPort: e.target.value })}
                      className="input-dark"
                      placeholder="465"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">加密方式</label>
                  <select
                    value={settings.smtpSecure}
                    onChange={(e) => setSettings({ ...settings, smtpSecure: e.target.value })}
                    className="input-dark"
                  >
                    <option value="true">SSL/TLS（端口 465）</option>
                    <option value="false">STARTTLS（端口 587）</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">发件邮箱账号</label>
                  <input
                    type="text"
                    value={settings.smtpUser}
                    onChange={(e) => setSettings({ ...settings, smtpUser: e.target.value })}
                    className="input-dark"
                    placeholder="your_email@qq.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">授权码 / 密码</label>
                  <input
                    type="password"
                    value={settings.smtpPass}
                    onChange={(e) => setSettings({ ...settings, smtpPass: e.target.value })}
                    className="input-dark"
                    placeholder="请输入 SMTP 授权码"
                  />
                  <p className="text-dark-500 text-xs mt-1.5">
                    建议使用邮箱提供的专用授权码，而非登录密码
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">发件人名称（可选）</label>
                  <input
                    type="text"
                    value={settings.smtpFrom}
                    onChange={(e) => setSettings({ ...settings, smtpFrom: e.target.value })}
                    className="input-dark"
                    placeholder="默认与发件账号相同"
                  />
                </div>
              </div>

              {/* 测试邮件 */}
              <div className="glass-card p-6 space-y-4">
                <h2 className="text-lg font-semibold text-white">发送测试</h2>
                <p className="text-dark-400 text-sm">保存配置后，可发送测试邮件验证 SMTP 是否正常工作</p>
                {testMessage && (
                  <div className={`p-3 rounded-lg text-sm ${
                    testMessage.includes('已发送')
                      ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                      : 'bg-red-500/10 border border-red-500/30 text-red-400'
                  }`}>
                    {testMessage}
                  </div>
                )}
                <div className="flex gap-3">
                  <input
                    type="email"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    className="input-dark flex-1"
                    placeholder="输入接收测试邮件的邮箱地址"
                  />
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className="btn-secondary disabled:opacity-50 whitespace-nowrap"
                  >
                    {testing ? '发送中...' : '发送测试邮件'}
                  </button>
                </div>
              </div>

              {/* 常用配置参考 */}
              <div className="glass-card p-6">
                <h2 className="text-lg font-semibold text-white mb-4">常用邮箱配置参考</h2>
                <div className="space-y-3 text-sm">
                  {[
                    { name: 'QQ邮箱', host: 'smtp.qq.com', port: '465', secure: 'SSL' },
                    { name: '163邮箱', host: 'smtp.163.com', port: '465', secure: 'SSL' },
                    { name: 'Gmail', host: 'smtp.gmail.com', port: '465', secure: 'SSL' },
                    { name: 'Outlook', host: 'smtp.office365.com', port: '587', secure: 'STARTTLS' },
                  ].map((item) => (
                    <div key={item.name} className="flex items-center justify-between p-3 rounded-lg bg-dark-800/30 border border-dark-700/30">
                      <span className="text-white font-medium">{item.name}</span>
                      <div className="flex items-center gap-4 text-dark-400">
                        <span>服务器: <span className="text-dark-300 font-mono">{item.host}</span></span>
                        <span>端口: <span className="text-dark-300 font-mono">{item.port}</span></span>
                        <span className="text-xs px-2 py-0.5 rounded bg-dark-700 text-dark-300">{item.secure}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? '保存中...' : '保存邮箱配置'}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
