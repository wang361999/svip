'use client';

import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';

interface HomeClientProps {
  title: string;
  subtitle: string;
}

/* ---------- 图表 mock 数据（纯装饰，非真实行情） ---------- */
// [open, close, high, low] y 坐标（震荡形态，无方向暗示）
const CANDLES: Array<[number, number, number, number]> = [
  [110, 128, 120, 98], [128, 118, 134, 112], [118, 140, 146, 114], [140, 132, 144, 126],
  [132, 152, 158, 128], [152, 146, 156, 140], [146, 124, 150, 118], [124, 108, 130, 100],
  [108, 120, 126, 102], [120, 142, 148, 116], [142, 156, 162, 138], [156, 148, 160, 142],
  [148, 166, 172, 144], [166, 158, 170, 152], [158, 176, 182, 154], [176, 170, 180, 164],
  [170, 152, 174, 146], [152, 138, 156, 132], [138, 150, 156, 134], [150, 134, 154, 128],
  [134, 120, 138, 112], [120, 132, 140, 114], [132, 118, 136, 110], [118, 106, 122, 98],
  [106, 116, 124, 100], [116, 108, 120, 102],
];
const VOLS = [30, 22, 38, 18, 42, 20, 34, 46, 28, 40, 36, 22, 44, 26, 48, 30, 38, 42, 24, 36, 40, 28, 44, 32, 26, 34];
const EMA_PATH = 'M 39,115 C 70,130 90,105 120,125 S 170,150 200,132 S 250,100 280,118 S 330,150 360,132 S 410,105 440,122 S 470,132 492,116';

const STATS = [
  { v: '6 个', l: 'K线周期' },
  { v: '10+', l: '技术指标' },
  { v: '多源', l: '行情容灾' },
  { v: '全参数', l: '自由调整' },
];

const FEATURES = [
  {
    title: '多周期 K 线图表',
    desc: '分钟级到周线多周期切换，缩放平移流畅，成交量、成交明细视图齐备。',
    color: 'blue',
    icon: 'M3 3v18h18M7 15l3-3 3 2 5-7',
  },
  {
    title: '常用技术指标',
    desc: 'MACD、RSI、布林带、EMA、ATR、一目均衡表等指标计算与叠加，参数全部可调。',
    color: 'cyan',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  },
  {
    title: '多周期对照视图',
    desc: '同一品种多个周期的结构并列显示，一眼看到不同时间尺度下的形态差异。',
    color: 'teal',
    icon: 'M8 7h12M8 12h12M8 17h12M3 7h.01M3 12h.01M3 17h.01',
  },
  {
    title: '多行情源容灾',
    desc: '内置多个公开行情数据源的自动切换机制，数据拉取有缓存、有去重，保障连续可用。',
    color: 'indigo',
    icon: 'M5 12a7 7 0 015.7-6.9M19 12a7 7 0 01-5.7 6.9M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5L15 7M9 17l-1.5 1.5m11 0L17 17M7 7L5.5 5.5',
  },
];

const VIEWS = [
  {
    title: '主图 · K线与叠加',
    desc: '蜡烛图为主体，可叠加均线、布林带等主图指标，十字光标配价格读数。',
    art: (
      <svg viewBox="0 0 220 90" className="w-full h-full">
        {[15, 45, 75].map((y) => <line key={y} x1="0" y1={y} x2="220" y2={y} stroke="rgba(148,163,184,0.1)" strokeWidth="1" />)}
        {[[14, 30, 34, 10], [30, 24, 38, 18], [24, 40, 44, 20], [40, 34, 48, 26], [34, 22, 40, 14], [22, 36, 42, 16], [36, 28, 44, 22], [28, 18, 34, 12]].map(([o, c, h, l], i) => {
          const x = 14 + i * 25; const up = c < o;
          const col = up ? '#38bdf8' : '#64748b';
          return (
            <g key={i}>
              <line x1={x + 4} y1={h} x2={x + 4} y2={l} stroke={col} strokeWidth="1.4" />
              <rect x={x} y={Math.min(o, c)} width="8" height={Math.max(3, Math.abs(c - o))} fill={col} rx="1" />
            </g>
          );
        })}
        <path d="M 14,26 C 50,36 70,20 100,30 S 150,44 180,26 S 210,20 220,24" fill="none" stroke="#f59e0b" strokeWidth="1.6" opacity="0.85" />
      </svg>
    ),
  },
  {
    title: '副图 · 指标面板',
    desc: 'MACD 柱状图与快慢线、RSI 摆动区间等副图指标，与主图联动同步。',
    art: (
      <svg viewBox="0 0 220 90" className="w-full h-full">
        <line x1="0" y1="45" x2="220" y2="45" stroke="rgba(148,163,184,0.15)" strokeDasharray="3 3" />
        {[38, 30, 46, 24, 52, 34, 22, 44, 28, 50, 36, 26, 48, 30, 20, 42, 34, 46].map((h, i) => {
          const x = 12 + i * 11; const up = i % 3 !== 0;
          return <rect key={i} x={x} y={up ? 45 - h : 45} width="6" height={h} fill={up ? 'rgba(56,189,248,0.7)' : 'rgba(100,116,139,0.7)'} rx="1" />;
        })}
        <path d="M 12,38 C 60,30 90,52 130,36 S 190,24 218,32" fill="none" stroke="#38bdf8" strokeWidth="1.6" />
        <path d="M 12,44 C 60,40 90,56 130,44 S 190,34 218,40" fill="none" stroke="#f59e0b" strokeWidth="1.4" opacity="0.8" />
      </svg>
    ),
  },
  {
    title: '对照 · 多周期并排',
    desc: '多个周期的走势结构并列成表，跨周期观察同一形态的不同呈现。',
    art: (
      <svg viewBox="0 0 220 90" className="w-full h-full">
        {[
          'M 8,14 C 40,22 60,8 90,14 S 150,24 178,12 S 208,16 214,12',
          'M 8,44 C 40,36 60,52 90,44 S 150,34 178,48 S 208,40 214,46',
          'M 8,74 C 40,80 60,66 90,74 S 150,84 178,70 S 208,76 214,72',
        ].map((d, i) => (
          <g key={i}>
            <line x1="0" y1={30 + i * 30} x2="220" y2={30 + i * 30} stroke="rgba(148,163,184,0.08)" />
            <path d={d} fill="none" stroke={['#38bdf8', '#818cf8', '#64748b'][i]} strokeWidth="1.8" />
          </g>
        ))}
      </svg>
    ),
  },
];

const STEPS = [
  { t: '打开图表', d: '选择交易对与周期，行情自动加载' },
  { t: '叠加指标', d: '按你的观察口径调整指标与参数' },
  { t: '对照周期', d: '多时间尺度并排比较形态差异' },
  { t: '记录观察', d: '沉淀自己的研究笔记与复盘素材' },
];

const DISCLAIMERS = [
  { t: '仅供研究学习', d: '本站仅提供图表绘制与指标计算等技术工具，全部内容仅供个人研究与学习使用。' },
  { t: '不提供投资建议', d: '不提供任何形式的投资建议、行情推荐或资产管理服务，所有内容均不构成投资建议。' },
  { t: '不构成交易服务', d: '不作为任何交易的信息中介或定价服务，不参与、不撮合任何交易行为。' },
  { t: '数据仅供参考', d: '行情数据来自网络公开渠道，可能存在延迟或误差，请以实际数据为准。' },
];

export default function HomeClient({ title, subtitle }: HomeClientProps) {
  return (
    <div className="min-h-screen flex flex-col bg-dark-950">
      <style
        dangerouslySetInnerHTML={{
          __html: `
.hm-grid-bg{
  background-image:linear-gradient(rgba(148,163,184,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.05) 1px,transparent 1px);
  background-size:44px 44px;
  mask-image:radial-gradient(ellipse 80% 70% at 50% 30%,#000 30%,transparent 75%);
  -webkit-mask-image:radial-gradient(ellipse 80% 70% at 50% 30%,#000 30%,transparent 75%);
}
@keyframes hm-drift{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(24px,-16px) scale(1.06)}}
.hm-orb{animation:hm-drift 14s ease-in-out infinite}
.hm-orb-2{animation:hm-drift 18s ease-in-out infinite reverse}
@keyframes hm-draw{from{stroke-dashoffset:900}to{stroke-dashoffset:0}}
.hm-ema{stroke-dasharray:900;animation:hm-draw 2.6s cubic-bezier(.4,0,.2,1) .3s both}
@keyframes hm-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.hm-float{animation:hm-float 6s ease-in-out infinite}
.hm-float-2{animation:hm-float 7s ease-in-out 1.2s infinite}
@keyframes hm-fade-up{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
.hm-fade{opacity:0;animation:hm-fade-up .7s cubic-bezier(.4,0,.2,1) both}
.hm-card{transition:transform .3s ease,border-color .3s ease,box-shadow .3s ease}
.hm-card:hover{transform:translateY(-4px);border-color:rgba(56,189,248,.35);box-shadow:0 12px 40px -12px rgba(56,189,248,.15)}
@keyframes hm-blink{0%,100%{opacity:1}50%{opacity:.35}}
.hm-blink{animation:hm-blink 2s ease-in-out infinite}
`,
        }}
      />
      <Header />

      <main className="flex-1 pt-16">
        {/* ---------- Hero ---------- */}
        <section className="relative overflow-hidden border-b border-dark-800/70">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(59,130,246,0.16),transparent_40%),radial-gradient(circle_at_80%_20%,rgba(34,211,238,0.10),transparent_35%),linear-gradient(160deg,#020617_0%,#0d1526_50%,#020617_100%)]" />
          <div className="absolute inset-0 hm-grid-bg" />
          <div className="hm-orb absolute -left-24 top-10 w-80 h-80 rounded-full bg-blue-600/10 blur-3xl pointer-events-none" />
          <div className="hm-orb-2 absolute right-0 bottom-0 w-96 h-96 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-blue-500/40 to-transparent" />

          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
            <div className="grid lg:grid-cols-[1fr_1.05fr] gap-12 lg:gap-16 items-center">
              {/* 左：文案 */}
              <div>
                <div className="hm-fade inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/25 text-blue-300 text-xs font-semibold mb-6">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 hm-blink" />
                  技术分析研究工具
                </div>
                <h1 className="hm-fade text-4xl sm:text-5xl lg:text-6xl font-black text-white tracking-tight leading-[1.12]" style={{ animationDelay: '.08s' }}>
                  K 线图表与指标计算，
                  <span className="block mt-1 text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-cyan-300 to-indigo-300">
                    把研究做扎实
                  </span>
                </h1>
                <p className="hm-fade text-base sm:text-lg text-dark-300 mt-7 max-w-xl leading-8" style={{ animationDelay: '.16s' }}>
                  {title} 是一套图表绘制与常用技术指标的计算工具：多周期 K 线、指标叠加、多周期对照，帮你把自己的观察做清楚。
                </p>
                <p className="hm-fade text-sm text-dark-500 mt-2.5" style={{ animationDelay: '.2s' }}>{subtitle}</p>

                <div className="hm-fade flex flex-wrap gap-3 mt-9" style={{ animationDelay: '.26s' }}>
                  <Link href="/login" className="btn-primary px-7 py-3 text-base">
                    登录使用
                  </Link>
                  <a href="#features" className="btn-secondary px-6 py-3 text-base">
                    了解工具能力
                  </a>
                </div>

                <div className="hm-fade grid grid-cols-4 gap-3 mt-10 max-w-lg" style={{ animationDelay: '.34s' }}>
                  {STATS.map((s) => (
                    <div key={s.l} className="rounded-xl bg-dark-900/60 border border-dark-700/50 p-3 text-center backdrop-blur">
                      <div className="text-sm sm:text-base font-black text-slate-100 font-mono">{s.v}</div>
                      <div className="text-[10px] text-dark-500 mt-1">{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 右：图表 mockup */}
              <div className="hm-fade relative" style={{ animationDelay: '.2s' }}>
                <div className="absolute -inset-6 bg-blue-500/10 rounded-[2.2rem] blur-3xl pointer-events-none" />
                <div className="hm-card relative rounded-2xl border border-dark-700/60 bg-dark-900/70 backdrop-blur overflow-hidden shadow-2xl">
                  {/* 窗口栏 */}
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-dark-700/50 bg-dark-900/80">
                    <div className="flex gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-500/60" />
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
                    </div>
                    <div className="text-xs text-dark-400 font-mono">图表工作台</div>
                    <div className="ml-auto flex gap-1">
                      {['15m', '1H', '4H', '1D', '1W'].map((tf) => (
                        <span
                          key={tf}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                            tf === '4H' ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'text-dark-500'
                          }`}
                        >
                          {tf}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* 图表主体 */}
                  <div className="p-3">
                    <svg viewBox="0 0 520 280" className="w-full">
                      {/* 网格 */}
                      {[50, 90, 130, 170, 210].map((y) => (
                        <line key={y} x1="24" y1={y} x2="500" y2={y} stroke="rgba(148,163,184,0.08)" />
                      ))}
                      {[120, 220, 320, 420].map((x) => (
                        <line key={x} x1={x} y1="24" x2={x} y2="240" stroke="rgba(148,163,184,0.06)" />
                      ))}
                      {/* 成交量 */}
                      {VOLS.map((v, i) => {
                        const x = 34 + i * 18; const up = CANDLES[i][1] < CANDLES[i][0];
                        return <rect key={`v${i}`} x={x} y={258 - v} width="10" height={v} fill={up ? 'rgba(56,189,248,0.35)' : 'rgba(100,116,139,0.35)'} rx="1" />;
                      })}
                      {/* 蜡烛 */}
                      {CANDLES.map(([o, c, h, l], i) => {
                        const x = 34 + i * 18; const up = c < o;
                        const col = up ? '#38bdf8' : '#64748b';
                        return (
                          <g key={i}>
                            <line x1={x + 5} y1={h} x2={x + 5} y2={l} stroke={col} strokeWidth="1.4" />
                            <rect x={x} y={Math.min(o, c)} width="10" height={Math.max(3, Math.abs(c - o))} fill={col} rx="1.5" />
                          </g>
                        );
                      })}
                      {/* 均线（绘制动画） */}
                      <path d={EMA_PATH} fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" className="hm-ema" />
                      {/* 十字光标 */}
                      <line x1="300" y1="24" x2="300" y2="240" stroke="rgba(148,163,184,0.35)" strokeDasharray="4 4" />
                      <line x1="24" y1="116" x2="500" y2="116" stroke="rgba(148,163,184,0.35)" strokeDasharray="4 4" />
                      <circle cx="300" cy="116" r="3.5" fill="#f59e0b" />
                      {/* 价格标签 */}
                      <rect x="468" y="108" width="44" height="16" rx="3" fill="#f59e0b" />
                      <text x="490" y="120" textAnchor="middle" fontSize="10" fill="#0f172a" fontFamily="monospace" fontWeight="700">2,864</text>
                      {/* 轴刻度 */}
                      {['2,940', '2,860', '2,780'].map((t, i) => (
                        <text key={t} x="506" y={[66, 146, 196][i]} fontSize="9" fill="rgba(148,163,184,0.5)" fontFamily="monospace">{t}</text>
                      ))}
                    </svg>
                  </div>

                  {/* 底部读数条 */}
                  <div className="flex items-center gap-4 px-4 py-2.5 border-t border-dark-700/50 bg-dark-950/60 text-[10px] font-mono text-dark-400 overflow-hidden">
                    <span className="text-amber-400">MA(20)</span>
                    <span className="text-blue-300">MACD(12,26,9)</span>
                    <span className="text-cyan-300">RSI(14)</span>
                    <span className="text-indigo-300">BOLL(20,2)</span>
                    <span className="ml-auto text-dark-500 hidden sm:inline">指标参数可调</span>
                  </div>
                </div>

                {/* 悬浮信息卡 */}
                <div className="hm-float absolute -left-4 sm:-left-8 bottom-16 rounded-xl border border-dark-700/70 bg-dark-900/90 backdrop-blur px-4 py-3 shadow-xl">
                  <div className="text-[10px] text-dark-500 mb-0.5">指标叠加</div>
                  <div className="text-xs font-bold text-slate-200">MACD · RSI · BOLL</div>
                </div>
                <div className="hm-float-2 absolute -right-3 sm:-right-6 top-14 rounded-xl border border-dark-700/70 bg-dark-900/90 backdrop-blur px-4 py-3 shadow-xl">
                  <div className="text-[10px] text-dark-500 mb-0.5">多周期对照</div>
                  <div className="text-xs font-bold text-slate-200">15m · 1h · 4h · 1d</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- 功能特性 ---------- */}
        <section id="features" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5 mb-11">
            <div>
              <div className="text-blue-400 text-sm font-semibold mb-2.5">工具能力</div>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight">
                一个干净稳定的图表工作台
              </h2>
            </div>
            <p className="text-dark-400 max-w-md leading-7 text-sm">
              没有花哨的功能堆叠，专注于把图表绘制与指标计算这两件事做稳定、做清楚。
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {FEATURES.map((f) => (
              <div key={f.title} className="hm-card glass-card p-6 rounded-2xl">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center mb-5 ${
                  f.color === 'blue' ? 'bg-blue-500/10 text-blue-400' :
                  f.color === 'cyan' ? 'bg-cyan-500/10 text-cyan-400' :
                  f.color === 'teal' ? 'bg-teal-500/10 text-teal-400' :
                  'bg-indigo-500/10 text-indigo-300'
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

        {/* ---------- 工作台一览 ---------- */}
        <section className="border-y border-dark-800/70 bg-dark-900/30">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
            <div className="mb-11 max-w-2xl">
              <div className="text-cyan-400 text-sm font-semibold mb-2.5">工作台一览</div>
              <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight">主图、副图、多周期，各就各位</h2>
            </div>
            <div className="grid md:grid-cols-3 gap-5">
              {VIEWS.map((v) => (
                <div key={v.title} className="hm-card rounded-2xl border border-dark-700/50 bg-dark-950/60 overflow-hidden">
                  <div className="h-36 bg-dark-950/80 p-3 border-b border-dark-800/60">{v.art}</div>
                  <div className="p-5">
                    <h3 className="text-base font-bold text-white mb-1.5">{v.title}</h3>
                    <p className="text-[12.5px] text-dark-400 leading-6">{v.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- 使用流程 ---------- */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
          <div className="mb-11 text-center">
            <div className="text-indigo-300 text-sm font-semibold mb-2.5">使用流程</div>
            <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight">四步完成一次观察</h2>
          </div>
          <div className="relative grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {STEPS.map((s, i) => (
              <div key={s.t} className="hm-card relative rounded-2xl border border-dark-700/50 bg-dark-900/40 p-6">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/25 text-blue-300 flex items-center justify-center text-sm font-black mb-4">
                  {String(i + 1).padStart(2, '0')}
                </div>
                <h3 className="text-base font-bold text-white mb-1.5">{s.t}</h3>
                <p className="text-[12.5px] text-dark-400 leading-6">{s.d}</p>
                {i < STEPS.length - 1 && (
                  <div className="hidden lg:block absolute top-1/2 -right-3.5 w-7 h-px border-t border-dashed border-dark-600" />
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ---------- 使用边界 ---------- */}
        <section className="border-t border-dark-800/70 bg-dark-900/30">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 lg:py-20">
            <div className="grid lg:grid-cols-[0.85fr_1.15fr] gap-8">
              <div>
                <div className="text-slate-400 text-sm font-semibold mb-2.5">使用边界</div>
                <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">是工具，不是建议</h2>
                <p className="text-dark-400 text-sm leading-7 mt-4">
                  这是一个技术工具站点。以下是它"是什么"与"不是什么"的完整说明，请在使用前阅读。
                </p>
                <div className="mt-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-6">
                  <h3 className="text-sm font-bold text-amber-200 mb-3 flex items-center gap-2">
                    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    风险提示
                  </h3>
                  <ul className="flex flex-col gap-2 text-[12px] text-amber-100/70 leading-6">
                    <li>· 数字资产价格波动剧烈，可能在短时间内造成重大损失。</li>
                    <li>· 部分国家和地区对虚拟货币相关业务活动有严格监管或明确禁止，请了解并遵守您所在地的法律法规。</li>
                    <li>· 本站所有内容均不构成投资建议或任何形式的交易指导，据此操作，风险自担。</li>
                  </ul>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-4 content-start">
                {DISCLAIMERS.map((d) => (
                  <div key={d.t} className="rounded-2xl border border-dark-700/50 bg-dark-950/50 p-5">
                    <h3 className="text-sm font-bold text-slate-100 mb-1.5 flex items-center gap-2">
                      <span className="w-1 h-4 rounded-full bg-blue-400/70" />
                      {d.t}
                    </h3>
                    <p className="text-[12.5px] text-dark-400 leading-6">{d.d}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ---------- 尾部 ---------- */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="text-center text-xs text-dark-500 leading-6">
            本站为个人技术研究项目，仅供学习与研究用途。数据来源于网络公开行情接口，可能存在延迟或误差。
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
