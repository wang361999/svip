'use client';

import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import PriceTicker from '@/components/trading/PriceTicker';
import StatCards from '@/components/trading/StatCards';
import HomeSignalCard from '@/components/trading/HomeSignalCard';

interface HomeClientProps {
  title: string;
  subtitle: string;
}

/** A 级信号：参与方向投票（口径见 scripts/backtest） */
const A_SIGNALS = [
  { name: 'MACD DIF 顶背离', dir: '空', w: '2.0', tf: '4h / 1d', evidence: '确认后10根下跌率62.5%，优势+14.8pp，两段稳定', tone: 'short' },
  { name: 'RSI 顶背离（超买区）', dir: '空', w: '1.8', tf: '仅4h', evidence: '优势+19.8pp，比顶分型早2-3根预警', tone: 'short' },
  { name: '资金费率拥挤', dir: '逆向', w: '1.6', tf: '4h', evidence: '杠杆拥挤盘出清走反向，ETH命中率71%', tone: 'neutral' },
  { name: '缩量止跌', dir: '多', w: '1.3', tf: '仅4h', evidence: '抛压枯竭，优势+15.5pp，唯一提前做多信号', tone: 'long' },
  { name: '收盘跌破一目云带', dir: '空', w: '1.2', tf: '4h / 1d', evidence: '跌破云带下沿后历史走势偏弱', tone: 'short' },
  { name: '日线流星线', dir: '空', w: '1.2', tf: '仅1d', evidence: '涨后长上影被砸回，优势+10.8pp', tone: 'short' },
  { name: '缠论顶分型', dir: '空', w: '1.0', tf: '4h / 1d', evidence: '优势+3.2pp，方向稳定，仅作辅助票', tone: 'short' },
];

const B_WARNS = [
  '多个指标同时喊多 —— 实测常是阶段高点，不跟单追高',
  '九线显示上升波段已走一段 —— 此时追高平均倒亏约6%',
  '价格冲出布林上轨 / 站在云顶上方 —— 历史此处追高倒亏',
  '4h 盘整收缩后的突破 —— 多数是假突破，禁止追单，等回踩',
];

const STEPS = [
  {
    title: '收盘后看卡',
    desc: '4h 在北京 00/04/08/12/16/20 点后、日线在早 8 点后看。K线没走完信号会变，不中途操作。',
  },
  {
    title: '按标签执行',
    desc: '偏多→现价分批；等回踩→挂支撑价不追；偏空→反弹到阻力再进；观望→只记两个触发价。',
  },
  {
    title: '同时挂好止损',
    desc: '下单立刻挂结构位外侧止损和第一目标减半止盈。仓位由系统按单笔2%风险算好，不挪止损。',
  },
  {
    title: '记录与复盘',
    desc: '每条信号对应一笔，记下入场/止损/结果，攒30-50笔统计真实胜率，用数据而不是感觉修正。',
  },
];

const PRINCIPLES = [
  { title: '不自动下单', desc: '系统只给决策，每一笔由你手动执行，风险始终在自己手里' },
  { title: '只用已收盘K线', desc: '不走动中的当前根，信号确认了才算数，杜绝盘中假信号' },
  { title: '固定2%风险', desc: '仓位 = 2% ÷ 止损距离，止损放在结构位外侧0.5个ATR' },
  { title: '打架就空仓', desc: '多空信号权重都不过60%时不给方向，空仓等待不亏钱' },
  { title: '证伪即移除', desc: '底分型、RSI底背离等经回测无效的信号已全部下线，不凑数' },
  { title: '概率不是必然', desc: '每个信号都是历史优势，严格止损就是为判断错的那次准备' },
];

export default function HomeClient({ title, subtitle }: HomeClientProps) {
  return (
    <div className="min-h-screen flex flex-col bg-dark-950">
      <Header />

      <main className="flex-1 pt-16">
        {/* Hero：左侧定位，右侧真实决策卡 */}
        <section className="relative overflow-hidden border-b border-dark-800/70">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_35%),radial-gradient(circle_at_75%_15%,rgba(34,211,238,0.10),transparent_32%),linear-gradient(135deg,#020617_0%,#0f172a_48%,#020617_100%)]" />
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 lg:py-20">
            <div className="grid lg:grid-cols-[0.95fr_1.05fr] gap-10 lg:gap-14 items-center">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-semibold mb-5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  BTC / ETH 手动交易决策系统
                </div>
                <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight leading-tight">
                  每个下单方向，
                  <span className="block text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-cyan-300 to-teal-300">
                    都先经过回测验证
                  </span>
                </h1>
                <p className="text-base sm:text-lg text-dark-300 mt-6 max-w-xl leading-8">
                  {title} 不替你下单，只回答一个问题：<span className="text-slate-100 font-semibold">现在该不该做、往哪个方向做、止损放哪</span>。
                  信号全部在 BTC/ETH 共 3920 根 K 线上回测，经前后半程稳定性检验，无效的一律删除。
                </p>
                <p className="text-sm text-dark-500 mt-2">{subtitle}</p>

                <div className="flex flex-wrap gap-3 mt-7">
                  <Link href="/trading" className="btn-primary text-base px-7 py-3 text-center">
                    进入交易工作台
                  </Link>
                  <a href="#signals" className="btn-secondary text-base px-6 py-3 text-center">
                    查看信号清单
                  </a>
                </div>

                <div className="grid grid-cols-3 gap-3 mt-8 max-w-lg">
                  {[
                    { v: '7 个', l: 'A级实证信号' },
                    { v: '3920 根', l: '回测K线样本' },
                    { v: '2%', l: '单笔风险上限' },
                  ].map((s) => (
                    <div key={s.l} className="rounded-xl bg-dark-900/60 border border-dark-700/50 p-3 text-center">
                      <div className="text-base sm:text-lg font-black text-emerald-300 font-mono">{s.v}</div>
                      <div className="text-[10px] text-dark-500 mt-0.5">{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>

              <HomeSignalCard />
            </div>
          </div>
        </section>

        {/* 实时价格滚动条 + 24h 统计 */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-7 relative z-10">
          <PriceTicker />
        </section>
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-5">
          <StatCards />
        </section>

        {/* 实证信号库 */}
        <section id="signals" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20">
          <div className="mb-9">
            <div className="text-emerald-400 text-sm font-semibold mb-2">实证信号库</div>
            <h2 className="text-3xl sm:text-4xl font-black text-white">
              只有回测有效、且跨行情稳定的信号才配上线
            </h2>
            <p className="text-dark-400 mt-3 max-w-2xl leading-7">
              每个信号都按"确认后才能进场"的无前视口径检验，并拆成前后半段对比：两段同向才保留。下面 7 个 A 级信号参与方向加权投票，权重按证据强度分配。
            </p>
          </div>

          <div className="grid lg:grid-cols-[1.5fr_1fr] gap-5">
            {/* A 级投票信号表 */}
            <div className="glass-card p-5 sm:p-6 overflow-hidden">
              <div className="flex items-center gap-2 mb-4">
                <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold">A 级</span>
                <span className="text-sm text-dark-400">参与方向投票 · 权重 &gt;60% 才给交易方向</span>
              </div>
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-left min-w-[560px]">
                  <thead>
                    <tr className="text-[11px] text-dark-500 border-b border-dark-700/60">
                      <th className="font-medium px-2 pb-2">信号</th>
                      <th className="font-medium px-2 pb-2 w-14">方向</th>
                      <th className="font-medium px-2 pb-2 w-16">权重</th>
                      <th className="font-medium px-2 pb-2 w-20">周期</th>
                      <th className="font-medium px-2 pb-2">回测证据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {A_SIGNALS.map((s) => (
                      <tr key={s.name} className="border-b border-dark-800/50 last:border-0">
                        <td className="px-2 py-2.5 text-[13px] font-semibold text-slate-200">{s.name}</td>
                        <td className="px-2 py-2.5">
                          <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${
                            s.tone === 'short' ? 'bg-red-500/10 text-red-300' :
                            s.tone === 'long' ? 'bg-emerald-500/10 text-emerald-300' :
                            'bg-amber-500/10 text-amber-300'
                          }`}>{s.dir}</span>
                        </td>
                        <td className="px-2 py-2.5 text-[12px] font-mono text-dark-300">{s.w}</td>
                        <td className="px-2 py-2.5 text-[11px] text-dark-400">{s.tf}</td>
                        <td className="px-2 py-2.5 text-[11.5px] text-dark-400 leading-snug">{s.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* B 级风险警告 */}
            <div className="glass-card p-5 sm:p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-bold">B 级</span>
                <span className="text-sm text-dark-400">不投票 · 出现时禁止追单</span>
              </div>
              <ul className="flex flex-col gap-3">
                {B_WARNS.map((w) => (
                  <li key={w} className="flex gap-2.5 text-[12.5px] leading-snug text-amber-200/85">
                    <span className="text-amber-400 shrink-0">⚠</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5 pt-4 border-t border-dark-700/50 text-[11.5px] text-dark-500 leading-relaxed">
                底分型、RSI 底背离、锤子线、看涨吞没等"经典做多信号"经无前视回测前后反转、无稳定优势，已全部移出系统。
              </div>
            </div>
          </div>
        </section>

        {/* 手动下单四步 */}
        <section className="border-y border-dark-800/70 bg-dark-900/30">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20">
            <div className="mb-10 max-w-2xl">
              <div className="text-cyan-400 text-sm font-semibold mb-2">手动执行流程</div>
              <h2 className="text-3xl sm:text-4xl font-black text-white">四步，把决策卡变成一笔受控的交易</h2>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {STEPS.map((step, i) => (
                <div key={step.title} className="relative glass-card p-5">
                  <div className="w-9 h-9 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-center justify-center text-sm font-black mb-4">
                    {i + 1}
                  </div>
                  <h3 className="text-base font-bold text-white mb-2">{step.title}</h3>
                  <p className="text-[12.5px] text-dark-400 leading-6">{step.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 系统原则 */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20">
          <div className="mb-9 text-center">
            <div className="text-emerald-400 text-sm font-semibold mb-2">系统原则</div>
            <h2 className="text-3xl sm:text-4xl font-black text-white">先活下来，再谈赚钱</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="rounded-xl border border-dark-700/50 bg-dark-900/40 p-5">
                <h3 className="text-sm font-bold text-slate-100 mb-1.5 flex items-center gap-2">
                  <span className="w-1 h-4 rounded-full bg-emerald-400/80" />
                  {p.title}
                </h3>
                <p className="text-[12.5px] text-dark-400 leading-6">{p.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
          <div className="relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-r from-emerald-600/12 via-dark-900 to-cyan-600/10 p-8 sm:p-12">
            <div className="absolute right-0 top-0 w-64 h-64 bg-emerald-500/10 blur-3xl rounded-full" />
            <div className="relative flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
              <div>
                <h2 className="text-2xl sm:text-3xl font-black text-white mb-3">
                  现在打开工作台，看当前信号怎么说
                </h2>
                <p className="text-dark-300 max-w-2xl leading-7">
                  实时 K 线、双周期决策卡、九线结构位与出入场价格都已就绪。信号大多数时候是"观望"——有把握的机会本来就少。
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 shrink-0">
                <Link href="/trading" className="btn-primary text-center px-7 py-3">
                  进入工作台
                </Link>
                <Link href="/login" className="btn-secondary text-center px-7 py-3">
                  登录账户
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* 风险提示 */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-10">
          <div className="text-center text-xs text-dark-500 leading-6">
            所有信号均为历史数据回测的概率优势，不构成投资建议。数字资产价格波动剧烈，请严格止损、根据自身风险承受能力谨慎决策。
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
