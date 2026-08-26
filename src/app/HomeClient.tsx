'use client';

import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import PriceTicker from '@/components/trading/PriceTicker';
import StatCards from '@/components/trading/StatCards';

interface HomeClientProps {
  title: string;
  subtitle: string;
}

export default function HomeClient({ title, subtitle }: HomeClientProps) {
  const coreFeatures = [
    {
      title: '多币种行情中枢',
      desc: '支持 BTC、ETH、SOL 等主流 USDT 交易对，前台可自由切换图表，行情、K线和指标统一展示。',
      color: 'blue',
      icon: 'M3 3v18h18M7 15l3-3 3 2 5-7',
    },
    {
      title: '自动交易白名单',
      desc: '前台可显示很多币种，但自动开仓只允许后台勾选的币种，避免系统乱扫、乱开仓。',
      color: 'purple',
      icon: 'M9 12l2 2 4-4m5 2a8 8 0 11-16 0 8 8 0 0116 0z',
    },
  ];

  const advantages = [
    { label: '行情来源', value: 'Binance / OKX', sub: '多源行情适配' },
    { label: '风控配置', value: '杠杆 / 止损 / 仓位', sub: '参数可后台调整' },
    { label: '自动范围', value: '白名单控制', sub: '只交易允许币种' },
  ];

  const workflow = [
    '选择关注币种，查看实时K线与指标',
    '后台设置自动交易白名单与风控参数',
  ];

  return (
    <div className="min-h-screen flex flex-col bg-dark-950">
      <Header />

      <main className="flex-1 pt-16">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-dark-800/70">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.24),transparent_35%),radial-gradient(circle_at_75%_15%,rgba(34,211,238,0.12),transparent_32%),linear-gradient(135deg,#020617_0%,#0f172a_48%,#020617_100%)]" />
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-blue-500/40 to-transparent" />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
            <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-10 lg:gap-14 items-center">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs font-semibold mb-5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  多币种实时行情交易系统
                </div>
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white tracking-tight leading-tight">
                  让交易决策先经过
                  <span className="block text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-cyan-300 to-green-300">
                    数据驱动与风控验证
                  </span>
                </h1>
                <p className="text-base sm:text-lg text-dark-300 mt-6 max-w-2xl leading-8">
                  {title} 不只是行情页面，而是一套面向数字货币交易者的专业工具：实时行情、技术指标和自动交易白名单集中在一个工作台。
                </p>
                <p className="text-sm text-dark-500 mt-2">
                  {subtitle}
                </p>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mt-8">
                  <Link href="/trading" className="btn-primary text-base px-7 py-3 text-center">
                    进入交易工作台
                  </Link>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-8">
                  {advantages.map((item) => (
                    <div key={item.label} className="rounded-xl bg-dark-900/60 border border-dark-700/50 p-3">
                      <div className="text-[10px] text-dark-500 mb-1">{item.label}</div>
                      <div className="text-sm font-bold text-white">{item.value}</div>
                      <div className="text-[10px] text-dark-500 mt-1">{item.sub}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="relative">
                <div className="absolute -inset-4 bg-blue-500/10 rounded-[2rem] blur-2xl" />
                <div className="relative glass-card p-4 sm:p-5 overflow-hidden">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <div className="text-xs text-dark-500">交易工作台预览</div>
                      <div className="text-lg font-bold text-white">Market Intelligence</div>
                    </div>
                    <div className="px-2.5 py-1 rounded-full bg-green-500/10 text-green-400 text-xs border border-green-500/20">
                      实时
                    </div>
                  </div>

                  <div className="rounded-xl bg-dark-950/70 border border-dark-700/60 p-4 mb-3">
                    <div className="flex items-end justify-between mb-4">
                      <div>
                        <div className="text-xs text-dark-500">ETH/USDT</div>
                        <div className="text-2xl font-black text-white font-mono">$6,519.32</div>
                      </div>
                      <div className="text-green-400 text-sm font-semibold">+2.48%</div>
                    </div>
                    <div className="h-36 flex items-end gap-1">
                      {[38, 48, 36, 62, 56, 74, 52, 82, 69, 88, 76, 93, 84, 100, 91, 108, 96, 118].map((h, i) => (
                        <div
                          key={i}
                          className={`flex-1 rounded-t ${i % 3 === 0 ? 'bg-red-400/70' : 'bg-green-400/70'}`}
                          style={{ height: `${h}px` }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-dark-800/50 border border-dark-700/50 p-3">
                      <div className="text-[10px] text-dark-500">行情监控</div>
                      <div className="text-sm font-bold text-cyan-300 mt-1">实时K线与指标</div>
                      <div className="text-[10px] text-dark-500 mt-1">多周期图表</div>
                    </div>
                    <div className="rounded-xl bg-dark-800/50 border border-dark-700/50 p-3">
                      <div className="text-[10px] text-dark-500">自动交易</div>
                      <div className="text-sm font-bold text-blue-300 mt-1">白名单控制</div>
                      <div className="text-[10px] text-dark-500 mt-1">BTC / ETH / SOL</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 实时价格滚动条 */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-8 relative z-10">
          <PriceTicker />
        </section>

        {/* 24h 统计卡片 */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-6">
          <StatCards />
        </section>

        {/* Features */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-18 lg:py-20">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 mb-10">
            <div>
              <div className="text-blue-400 text-sm font-semibold mb-2">核心能力</div>
              <h2 className="text-3xl sm:text-4xl font-black text-white">
                不只是看行情，而是完整的交易决策流程
              </h2>
            </div>
            <p className="text-dark-400 max-w-xl leading-7">
              从行情监控到风控验证，从手动观察到自动执行范围控制，每一步都围绕“减少随意交易、强化风控”设计。
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {coreFeatures.map((feature) => (
              <div key={feature.title} className="glass-card p-6">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center mb-5 ${
                  feature.color === 'blue' ? 'bg-blue-500/10 text-blue-400' :
                  feature.color === 'cyan' ? 'bg-cyan-500/10 text-cyan-400' :
                  feature.color === 'green' ? 'bg-green-500/10 text-green-400' :
                  'bg-purple-500/10 text-purple-400'
                }`}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={feature.icon} />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-white mb-2">{feature.title}</h3>
                <p className="text-dark-400 text-sm leading-6">{feature.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Workflow */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
          <div className="grid lg:grid-cols-[0.9fr_1.1fr] gap-8 items-stretch">
            <div className="glass-card p-7">
              <div className="text-green-400 text-sm font-semibold mb-2">使用路径</div>
              <h2 className="text-2xl sm:text-3xl font-black text-white mb-4">
                把交易从“感觉”变成可复盘的流程
              </h2>
              <p className="text-dark-400 text-sm leading-7 mb-6">
                好的工具不应该替你盲目下单，而应该帮你过滤机会、记录决策、验证想法，并把自动交易控制在明确范围内。
              </p>
              <Link href="/trading" className="btn-primary inline-block">
                打开工作台
              </Link>
            </div>
            <div className="glass-card p-7">
              <div className="space-y-4">
                {workflow.map((item, index) => (
                  <div key={item} className="flex gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
                      {index + 1}
                    </div>
                    <div className="pt-1">
                      <div className="text-white font-semibold">{item}</div>
                      {index < workflow.length - 1 && <div className="w-px h-6 bg-dark-700/70 ml-4 mt-4" />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
          <div className="relative overflow-hidden rounded-2xl border border-blue-500/20 bg-gradient-to-r from-blue-600/15 via-dark-900 to-cyan-600/10 p-8 sm:p-12">
            <div className="absolute right-0 top-0 w-64 h-64 bg-blue-500/10 blur-3xl rounded-full" />
            <div className="relative flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
              <div>
                <h2 className="text-2xl sm:text-3xl font-black text-white mb-3">
                  数据驱动决策，风控先行
                </h2>
                <p className="text-dark-300 max-w-2xl leading-7">
                  所有行情数据仅用于辅助分析，不构成投资建议。专业交易的第一步，是把风险控制在你能理解和接受的范围内。
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <Link href="/register" className="btn-primary text-center px-7 py-3">
                  免费注册
                </Link>
                <Link href="/login" className="btn-secondary text-center px-7 py-3">
                  登录账户
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Risk note */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-10">
          <div className="text-center text-xs text-dark-500 leading-6">
            数据仅供参考，不构成投资建议。数字资产价格波动较大，请根据自身风险承受能力谨慎决策。
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
