'use client';

import AdminSidebar from '@/components/admin/AdminSidebar';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';

interface IndicatorSettings {
  indicatorEMA: string;
  indicatorBOLL: string;
  indicatorMACD: string;
  indicatorRSI: string;
  indicatorATR: string;
  emaPeriod: string;
  bollPeriod: string;
  rsiPeriod: string;
  atrPeriod: string;
  macdFast: string;
  macdSlow: string;
  macdSignal: string;
  showPriceCard: string;
}

const INDICATOR_LIST = [
  { key: 'indicatorEMA' as const, label: 'EMA 指数均线', desc: 'EMA指数移动平均线，天蓝色叠加，比MA更灵敏' },
  { key: 'indicatorBOLL' as const, label: 'BOLL 布林带', desc: '上轨/中轨/下轨，青色+黄色，可配置周期' },
  { key: 'indicatorMACD' as const, label: 'MACD', desc: 'DIF/DEA/柱状图，独立副图显示，可配置快慢周期' },
  { key: 'indicatorRSI' as const, label: 'RSI 相对强弱', desc: '0-100超买超卖指标，独立副图，30/70参考线' },
  { key: 'indicatorATR' as const, label: 'ATR 平均波幅', desc: '平均真实波幅，衡量市场波动率' },
];

const DISPLAY_LIST = [
  { key: 'showPriceCard' as const, label: '实时价格卡片', desc: '交易页顶部 ETH/USDT 实时价格滚动条' },
];

export default function AdminIndicatorsPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const [settings, setSettings] = useState<IndicatorSettings>({
    indicatorEMA: 'false',
    indicatorBOLL: 'true',
    indicatorMACD: 'true',
    indicatorRSI: 'false',
    indicatorATR: 'false',
    emaPeriod: '20',
    bollPeriod: '20',
    rsiPeriod: '14',
    atrPeriod: '14',
    macdFast: '12',
    macdSlow: '26',
    macdSignal: '9',
    showPriceCard: 'true',
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

    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setMessage(data.error);
        } else {
          setSettings({
            indicatorEMA: data.indicatorEMA || 'false',
            indicatorBOLL: data.indicatorBOLL || 'true',
            indicatorMACD: data.indicatorMACD || 'true',
            indicatorRSI: data.indicatorRSI || 'false',
            indicatorATR: data.indicatorATR || 'false',
            emaPeriod: data.emaPeriod || '20',
            bollPeriod: data.bollPeriod || '20',
            rsiPeriod: data.rsiPeriod || '14',
            atrPeriod: data.atrPeriod || '14',
            macdFast: data.macdFast || '12',
            macdSlow: data.macdSlow || '26',
            macdSignal: data.macdSignal || '9',
            showPriceCard: data.showPriceCard || 'true',
          });
        }
      })
      .catch(() => setMessage('获取设置失败'))
      .finally(() => setLoading(false));
  }, [isAuthenticated, user?.role, router]);

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('保存成功！');
        setTimeout(() => setMessage(''), 3000);
      } else {
        setMessage(data.error || '保存失败');
      }
    } catch {
      setMessage('网络错误，请重试');
    } finally {
      setSaving(false);
    }
  };

  const toggleField = (key: keyof IndicatorSettings) => {
    setSettings((prev) => ({
      ...prev,
      [key]: prev[key] === 'true' ? 'false' : 'true',
    }));
  };

  if (!isAuthenticated || user?.role !== 'admin') return null;

  const ToggleItem = ({ item }: { item: typeof INDICATOR_LIST[0] | typeof DISPLAY_LIST[0] }) => {
    const isOn = settings[item.key] === 'true';
    return (
      <div
        className={`flex items-center justify-between p-4 rounded-lg border transition-all cursor-pointer ${
          isOn ? 'bg-blue-600/10 border-blue-500/30' : 'bg-dark-800/30 border-dark-700/30 hover:border-dark-600'
        }`}
        onClick={() => toggleField(item.key)}
      >
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-white font-medium">{item.label}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isOn ? 'bg-green-500/20 text-green-400' : 'bg-dark-700 text-dark-400'}`}>
              {isOn ? '显示' : '隐藏'}
            </span>
          </div>
          <p className="text-dark-400 text-xs mt-1">{item.desc}</p>
        </div>
        <div className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${isOn ? 'bg-blue-600' : 'bg-dark-600'}`}>
          <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${isOn ? 'translate-x-6' : 'translate-x-1'}`} />
        </div>
      </div>
    );
  };

  return (
    <div className="flex bg-dark-950 min-h-screen">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8">
        <div className="max-w-3xl">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white">指标设置</h1>
            <p className="text-dark-400 mt-1">控制交易页K线图显示的技术指标和UI元素。</p>
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
              {/* K线图技术指标 */}
              <div className="glass-card p-6 space-y-3">
                <h2 className="text-lg font-semibold text-white mb-2">K线图技术指标</h2>
                <p className="text-dark-400 text-sm mb-4">控制交易页K线图上显示的技术指标</p>
                {INDICATOR_LIST.map((item) => (
                  <ToggleItem key={item.key} item={item} />
                ))}
              </div>

              {/* 指标周期参数 */}
              <div className="glass-card p-6">
                <h2 className="text-lg font-semibold text-white mb-2">指标周期参数</h2>
                <p className="text-dark-400 text-sm mb-4">自定义各指标的计算周期，生效后所有用户可见</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[
                    { key: 'emaPeriod' as const, label: 'EMA 周期', desc: '指数移动平均线周期', min: 5, max: 200 },
                    { key: 'bollPeriod' as const, label: 'BOLL 周期', desc: '布林带计算周期', min: 5, max: 100 },
                    { key: 'rsiPeriod' as const, label: 'RSI 周期', desc: '相对强弱指标周期', min: 3, max: 50 },
                    { key: 'atrPeriod' as const, label: 'ATR 周期', desc: '平均真实波幅周期', min: 3, max: 50 },
                    { key: 'macdFast' as const, label: 'MACD 快线', desc: '快速EMA周期', min: 3, max: 50 },
                    { key: 'macdSlow' as const, label: 'MACD 慢线', desc: '慢速EMA周期', min: 5, max: 100 },
                    { key: 'macdSignal' as const, label: 'MACD 信号线', desc: 'DEA信号线周期', min: 3, max: 30 },
                  ].map(({ key, label, desc, min, max }) => (
                    <div key={key} className="space-y-2">
                      <label className="block text-sm font-medium text-dark-300">{label}</label>
                      <p className="text-dark-500 text-xs">{desc}</p>
                      <input
                        type="number"
                        min={min}
                        max={max}
                        value={settings[key]}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (!isNaN(v) && v >= min && v <= max) {
                            setSettings({ ...settings, [key]: String(v) });
                          } else if (e.target.value === '') {
                            setSettings({ ...settings, [key]: '' });
                          }
                        }}
                        className="input-dark text-sm"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* 交易页显示 */}
              <div className="glass-card p-6 space-y-3">
                <h2 className="text-lg font-semibold text-white mb-2">交易页显示</h2>
                <p className="text-dark-400 text-sm mb-4">控制交易页各元素的显示与隐藏</p>
                {DISPLAY_LIST.map((item) => (
                  <ToggleItem key={item.key} item={item} />
                ))}
              </div>

              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? '保存中...' : '保存指标设置'}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
