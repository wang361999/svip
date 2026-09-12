'use client';

import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';

interface HomeClientProps {
  title: string;
  subtitle: string;
}

/** 工具功能描述（仅描述图表能力，不涉及任何方向性内容） */
const FEATURES = [
  {
    title: '多周期 K 线图表',
    desc: '分钟级到日线多周期切换，支持缩放、平移与成交量视图，满足不同颗粒度的行情观察需求。',
    color: 'blue',
    icon: 'M3 3v18h18M7 15l3-3 3 2 5-7',
  },
  {
    title: '常用技术指标',
    desc: 'MACD、RSI、布林带、EMA、ATR、一目均衡表等常用指标的开源计算与叠加展示，参数可调。',
    color: 'cyan',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  },
  {
    title: '多周期对照视图',
    desc: '同一品种多个周期的结构并列显示，便于观察不同时间尺度下的形态差异。',
    color: 'teal',
    icon: 'M8 7h12M8 12h12M8 17h12M3 7h.01M3 12h.01M3 17h.01',
  },
  {
    title: '多行情源适配',
    desc: '内置多个公开行情数据源的自动容灾与切换机制，保障数据连续可用。',
    color: 'slate',
    icon: 'M5 12a7 7 0 015.7-6.9M19 12a7 7 0 01-5.7 6.9M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5L15 7M9 17l-1.5 1.5m11 0L17 17M7 7L5.5 5.5',
  },
];

/** 合规与研究声明 */
const DISCLAIMERS = [
  {
    title: '仅供研究学习',
    desc: '本站仅提供图表绘制与指标计算等技术工具，全部内容仅供个人研究与学习使用。',
  },
  {
    title: '不提供投资建议',
    desc: '本站不提供任何形式的投资建议、行情推荐、代客交易或资产管理服务，所有内容均不构成投资建议。',
  },
  {
    title: '不构成交易服务',
    desc: '本站不作为任何虚拟货币交易的信息中介或定价服务，不参与、不撮合任何交易行为。',
  },
  {
    title: '数据仅供参考',
    desc: '全部行情数据来源于网络公开渠道，可能存在延迟或误差，请以交易所实际数据为准。',
  },
];

export default function HomeClient({ title, subtitle }: HomeClientProps) {
  return (
    <div className="min-h-screen flex flex-col bg-dark-950">
      <Header />

      <main className="flex-1 pt-16">
        {/* Hero：中性工具定位 */}
        <section className="relative overflow-hidden border-b border-dark-800/70">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.16),transparent_35%),radial-gradient(circle_at_75%_15%,rgba(34,211,238,0.10),transparent_32%),linear-gradient(135deg,#020617_0%,#0f172a_48%,#020617_100%)]" />
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-slate-500/40 to-transparent" />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-500/10 border border-slate-500/20 text-slate-300 text-xs font-semibold mb-5">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                技术分析研究工具
              </div>
              <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight leading-tight">
                K 线图表与指标计算，
                <span className="block text-transparent bg-clip-text bg-gradient-to-r from-slate-300 via-slate-200 to-slate-400">
                  只做技术研究本身
                </span>
              </h1>
              <p className="text-base sm:text-lg text-dark-300 mt-6 max-w-2xl leading-8">
                {title} 是一套图表绘制与常用技术指标的计算工具：多周期 K 线、指标叠加、多周期对照，帮助你完成自己的观察与研究。
              </p>
              <p className="text-sm text-dark-500 mt-2">{subtitle}</p>

              <div className="flex flex-wrap gap-3 mt-8">
                <Link href="/login" className="btn-secondary px-6 py-3 text-center">
                  登录使用
                </Link>
              </div>

              <div className="grid grid-cols-3 gap-3 mt-9 max-w-lg">
                {[
                  { v: '6 个', l: 'K线周期' },
                  { v: '10+', l: '技术指标' },
                  { v: '多源', l: '行情适配' },
                ].map((s) => (
                  <div key={s.l} className="rounded-xl bg-dark-900/60 border border-dark-700/50 p-3 text-center">
                    <div className="text-base sm:text-lg font-black text-slate-200 font-mono">{s.v}</div>
                    <div className="text-[10px] text-dark-500 mt-0.5">{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 功能特性 */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20">
          <div className="mb-10 max-w-2xl">
            <div className="text-blue-400 text-sm font-semibold mb-2">工具能力</div>
            <h2 className="text-3xl sm:text-4xl font-black text-white">
              一个干净的图表工作台
            </h2>
            <p className="text-dark-400 mt-3 leading-7">
              没有花哨的功能堆叠，专注于把图表和指标计算这两件事做稳定、做清楚。
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {FEATURES.map((f) => (
              <div key={f.title} className="glass-card p-6">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center mb-5 ${
                  f.color === 'blue' ? 'bg-blue-500/10 text-blue-400' :
                  f.color === 'cyan' ? 'bg-cyan-500/10 text-cyan-400' :
                  f.color === 'teal' ? 'bg-teal-500/10 text-teal-400' :
                  'bg-slate-500/10 text-slate-400'
                }`}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={f.icon} />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-white mb-2">{f.title}</h3>
                <p className="text-dark-400 text-sm leading-6">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 合规与研究声明 */}
        <section className="border-y border-dark-800/70 bg-dark-900/30">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20">
            <div className="mb-10 max-w-2xl">
              <div className="text-slate-400 text-sm font-semibold mb-2">使用边界</div>
              <h2 className="text-3xl sm:text-4xl font-black text-white">明确声明，划清边界</h2>
              <p className="text-dark-400 mt-3 leading-7">
                这是一个技术工具站点，以下是它“是什么”与“不是什么”的完整说明。
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {DISCLAIMERS.map((d) => (
                <div key={d.title} className="rounded-xl border border-dark-700/50 bg-dark-900/40 p-5">
                  <h3 className="text-sm font-bold text-slate-100 mb-1.5 flex items-center gap-2">
                    <span className="w-1 h-4 rounded-full bg-slate-400/80" />
                    {d.title}
                  </h3>
                  <p className="text-[12.5px] text-dark-400 leading-6">{d.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 风险提示 */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-7 sm:p-9">
            <h2 className="text-lg sm:text-xl font-bold text-amber-200 mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              风险提示
            </h2>
            <ul className="flex flex-col gap-2.5 text-[13px] text-amber-100/80 leading-6">
              <li>· 数字资产价格波动剧烈，可能在短时间内造成重大损失，请充分了解相关风险后谨慎决策。</li>
              <li>· 部分国家和地区对虚拟货币相关业务活动有严格监管或明确禁止，请在参与任何相关活动前了解并遵守您所在地的法律法规。</li>
              <li>· 本站所有内容均不构成投资建议、财务建议或任何形式的交易指导；据此操作，风险自担。</li>
              <li>· 本站不面向公众提供商业服务，不构成虚拟货币交易的信息中介或定价服务。</li>
            </ul>
          </div>
        </section>

        {/* 尾部说明 */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
          <div className="text-center text-xs text-dark-500 leading-6">
            本站为个人技术研究项目，仅供学习与研究用途。数据来源于网络公开行情接口，可能存在延迟或误差。
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
