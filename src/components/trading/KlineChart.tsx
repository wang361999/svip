'use client';

import {
  calcBollinger,
  calcMACD,
  calcEMAArray,
  calcSMAArray,
  calcRSIArray,
  calcAB9Lines,
  calcGannAll,
  calcVWAPArray,
  calcKDJ,
  calcATRArray,
  calcNineTurn,
  calcChan,
  calcTrendChannel,
  calcValueArea,
  calcIchimoku,
  calcPredictionSynth,
  calcRangeBox,
  detectFractals,
  calcSuperTrend,
  type ChanResult,
  type TrendChannel,
  type ValueArea,
  type IchimokuData,
  type PredictionSynth,
} from '@/shared/lib/indicators';


import { useEffect, useRef, useState, useCallback } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  LineData,
  Time,
  CrosshairMode,
  LineStyle,
  type SeriesMarker,
} from 'lightweight-charts';
import {
  INTERVALS,
  fetchKlines as fetchKlinesApi,
  createMarketWS,
  KlineData,
} from '@/shared/lib/market-data';
import useSymbolStore from '@/store/symbolStore';
import usePriceStore from '@/store/priceStore';
import useAuthStore from '@/store/authStore';
import useChartStore from '@/store/chartStore';
import { apiGet, apiPut } from '@/shared/api/client';
import SymbolSelector from './SymbolSelector';
import SignalPanel from './SignalPanel';
import GannPanel from './GannPanel';
import IndicatorPanel from './IndicatorPanel';

// AB9线固定彩色（9种不同颜色）
const AB9_COLORS: Record<number, string> = {
  1: 'rgba(239, 68, 68, 0.85)',
  2: 'rgba(249, 115, 22, 0.85)',
  3: 'rgba(245, 158, 11, 0.85)',
  4: 'rgba(234, 179, 8, 0.85)',
  5: 'rgba(34, 197, 94, 0.85)',
  6: 'rgba(20, 184, 166, 0.85)',
  7: 'rgba(6, 182, 212, 0.85)',
  8: 'rgba(59, 130, 246, 0.85)',
  9: 'rgba(168, 85, 247, 0.85)',
};

// 周期 → 毫秒（R4 跨周期投射用）
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};
const FOUR_H_MS = 14_400_000;

// ===== 图表视觉主题（全局统一：Binance 色系 + 点状淡网格 + 统一字体） =====
const CHART_FONT = '-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif';
const CANDLE_UP = '#0ecb81';    // 涨·Binance 绿
const CANDLE_DOWN = '#f6465d';  // 跌·Binance 红
const GRID_COLOR = 'rgba(132, 142, 156, 0.10)';
const GRID_COLOR_FAINT = 'rgba(132, 142, 156, 0.06)';
const AXIS_BORDER = 'rgba(132, 142, 156, 0.18)';
const CROSSHAIR_COLOR = '#586ea0';
const CROSSHAIR_LABEL_BG = '#3d4451';

interface KlineChartProps {
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

// ========== 指标显示开关：前台徽章直接管控 ==========
// 开关状态仅存于浏览器本地（localStorage），后台/数据库不再有任何指标开关，
// 徽章点击即生效并持久化，刷新/换币种/换周期后保持用户的选择。
// 版本号：默认值变更时递增，旧 localStorage 自动失效
  const INDICATOR_PREFS_KEY = 'kline-indicator-prefs-v2';
const DEFAULT_INDICATORS = { EMA: false, MA120: true, BOLL: false, MACD: false, RSI: false, VWAP: false, KDJ: false, ATR: false, NINE: false, CHAN: false };

function loadIndicatorPrefs(): typeof DEFAULT_INDICATORS {
  if (typeof window === 'undefined') return { ...DEFAULT_INDICATORS };
  try {
    const raw = window.localStorage.getItem(INDICATOR_PREFS_KEY);
    if (!raw) return { ...DEFAULT_INDICATORS };
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_INDICATORS>;
    return {
      EMA: !!parsed.EMA,
      MA120: parsed.MA120 !== undefined ? !!parsed.MA120 : DEFAULT_INDICATORS.MA120,
      BOLL: !!parsed.BOLL,
      MACD: !!parsed.MACD,
      RSI: !!parsed.RSI,
      VWAP: parsed.VWAP !== undefined ? !!parsed.VWAP : DEFAULT_INDICATORS.VWAP,
      KDJ: parsed.KDJ !== undefined ? !!parsed.KDJ : DEFAULT_INDICATORS.KDJ,
      ATR: parsed.ATR !== undefined ? !!parsed.ATR : DEFAULT_INDICATORS.ATR,
      NINE: parsed.NINE !== undefined ? !!parsed.NINE : DEFAULT_INDICATORS.NINE,
      CHAN: parsed.CHAN !== undefined ? !!parsed.CHAN : DEFAULT_INDICATORS.CHAN,
    };
  } catch {
    return { ...DEFAULT_INDICATORS };
  }
}

function saveIndicatorPrefs(next: typeof DEFAULT_INDICATORS) {
  try {
    window.localStorage.setItem(INDICATOR_PREFS_KEY, JSON.stringify(next));
  } catch {}
}

// ========== 画线开关持久化（AB9 等） ==========
// 同样存于浏览器本地，刷新/换币种/换周期后保持用户的选择
// 会员用户额外同步到后端（跨设备），非会员仅本地
// 版本号：默认值变更时递增，旧 localStorage 自动失效
  const OVERLAY_PREFS_KEY = 'kline-overlay-prefs-v7';
// 分型 + 背离为默认可见的核心信号（默认开启），版本号递增使旧缓存失效，避免已保存的关闭状态覆盖新默认
const DEFAULT_OVERLAY = { AB9: false, CHANNEL: false, VALUEAREA: false, ICHIMOKU: false, SYNTH: false, GANN: false, SUPER: false, FRACTAL: true, DIVERG: true };

function loadOverlayPrefs() {
  if (typeof window === 'undefined') return { ...DEFAULT_OVERLAY };
  try {
    const raw = window.localStorage.getItem(OVERLAY_PREFS_KEY);
    if (!raw) return { ...DEFAULT_OVERLAY };
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_OVERLAY>;
    return {
      AB9: parsed.AB9 !== undefined ? !!parsed.AB9 : DEFAULT_OVERLAY.AB9,
      CHANNEL: parsed.CHANNEL !== undefined ? !!parsed.CHANNEL : DEFAULT_OVERLAY.CHANNEL,
      VALUEAREA: parsed.VALUEAREA !== undefined ? !!parsed.VALUEAREA : DEFAULT_OVERLAY.VALUEAREA,
      ICHIMOKU: parsed.ICHIMOKU !== undefined ? !!parsed.ICHIMOKU : DEFAULT_OVERLAY.ICHIMOKU,
      SYNTH: parsed.SYNTH !== undefined ? !!parsed.SYNTH : DEFAULT_OVERLAY.SYNTH,
      GANN: parsed.GANN !== undefined ? !!parsed.GANN : DEFAULT_OVERLAY.GANN,
      SUPER: parsed.SUPER !== undefined ? !!parsed.SUPER : DEFAULT_OVERLAY.SUPER,
      FRACTAL: parsed.FRACTAL !== undefined ? !!parsed.FRACTAL : DEFAULT_OVERLAY.FRACTAL,
      DIVERG: parsed.DIVERG !== undefined ? !!parsed.DIVERG : DEFAULT_OVERLAY.DIVERG,
    };
  } catch {
    return { ...DEFAULT_OVERLAY };
  }
}

function saveOverlayPrefs(next: typeof DEFAULT_OVERLAY) {
  try {
    window.localStorage.setItem(OVERLAY_PREFS_KEY, JSON.stringify(next));
  } catch {}
}

// ========== 江恩工具箱绘制（canvas 叠层，跟随滚动/缩放重绘） ==========
// xOf: 时间→x（已支持未来时间外推）；yOf: 价格→y；width/height: 画布 CSS 尺寸
function drawGannSuite(
  ctx: CanvasRenderingContext2D,
  xOf: (t: number) => number | null,
  yOf: (p: number) => number | null,
  width: number,
  height: number,
  g: ReturnType<typeof calcGannAll>,
): void {
  if (!g) return;
  const dash = (arr: number[]) => { ctx.setLineDash(arr); };

  // —— 江恩角度线（从波段锚点向未来发散，1x1 高亮） ——
  if (g.fan) {
    const f = g.fan;
    const ax = xOf(f.anchorTime);
    const ay = yOf(f.anchorPrice);
    const interval = f.interval > 0 ? f.interval : 1;
    const off = 1600; // 足够长的未来外推，保证射线穿越可视区
    const ex = xOf(f.anchorTime + off * interval);
    if (ax !== null && ay !== null && ex !== null) {
      for (const ray of f.rays) {
        const sign = f.direction === 'up' ? 1 : -1;
        const ey = yOf(f.anchorPrice + sign * ray.ratio * f.unitPerBar * off);
        if (ey === null) continue;
        const is1x1 = ray.label === '1x1';
        ctx.strokeStyle = is1x1 ? 'rgba(251, 191, 36, 0.85)' : 'rgba(148, 163, 184, 0.4)';
        ctx.lineWidth = is1x1 ? 1.6 : 1;
        dash(is1x1 ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        dash([]);
      }
    }
  }

  // —— 江恩时价四方（矩形 + 1x1 对角线） ——
  if (g.square) {
    const sq = g.square;
    const startT = sq.endTime - sq.bars * sq.interval;
    const x0 = xOf(startT);
    const x1 = xOf(sq.endTime);
    const y0 = yOf(sq.priceLo);
    const y1 = yOf(sq.priceHi);
    if (x0 !== null && x1 !== null && y0 !== null && y1 !== null) {
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.55)';
      ctx.lineWidth = 1;
      dash([5, 4]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      dash([]);
    }
  }

  // —— 江恩时间周期（竖线转折窗口） ——
  if (g.timeCycles) {
    for (const m of g.timeCycles.markers) {
      const x = xOf(m.time);
      if (x === null) continue;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
      ctx.lineWidth = 1;
      dash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, height - 4);
      ctx.stroke();
      dash([]);
      ctx.fillStyle = 'rgba(226, 232, 240, 0.55)';
      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`+${m.bars}`, x, 2);
    }
  }

  // —— 江恩三分位 + 轮中轮档位（水平价线） ——
  const drawHoriz = (price: number, label: string, color: string, strong: boolean) => {
    const y = yOf(price);
    if (y === null) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = strong ? 1.4 : 1;
    dash(strong ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    dash([]);
    ctx.fillStyle = color;
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(label), 4, y);
  };
  if (g.thirds) {
    for (const t of g.thirds) drawHoriz(t.price, t.label, 'rgba(168, 85, 247, 0.7)', true);
  }
  if (g.squareOfNine) {
    for (const lvl of g.squareOfNine.resistance) drawHoriz(lvl.price, `${lvl.deg}°`, 'rgba(246, 70, 93, 0.5)', false);
    for (const lvl of g.squareOfNine.support) drawHoriz(lvl.price, `${lvl.deg}°`, 'rgba(16, 185, 129, 0.5)', false);
  }
}

export default function KlineChart({ isFullscreen = false, onToggleFullscreen }: KlineChartProps) {
  const mainChartRef = useRef<HTMLDivElement>(null);
  const macdChartRef = useRef<HTMLDivElement>(null);
  const rsiChartRef = useRef<HTMLDivElement>(null);
  const mainChart = useRef<IChartApi | null>(null);
  const macdChart = useRef<IChartApi | null>(null);
  const rsiChart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const emaSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const ma120Series = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpper = useRef<ISeriesApi<'Line'> | null>(null);
  const bbMiddle = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLower = useRef<ISeriesApi<'Line'> | null>(null);
  const macdHist = useRef<ISeriesApi<'Histogram'> | null>(null);
  const macdDif = useRef<ISeriesApi<'Line'> | null>(null);
  const macdDea = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiLine = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiOverbought = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiOversold = useRef<ISeriesApi<'Line'> | null>(null);

  // KDJ 副图
  const kdjChartRef = useRef<HTMLDivElement>(null);
  const kdjChart = useRef<IChartApi | null>(null);
  const kdjKLine = useRef<ISeriesApi<'Line'> | null>(null);
  const kdjDLine = useRef<ISeriesApi<'Line'> | null>(null);
  const kdjJLine = useRef<ISeriesApi<'Line'> | null>(null);
  const kdjOverbought = useRef<ISeriesApi<'Line'> | null>(null);
  const kdjOversold = useRef<ISeriesApi<'Line'> | null>(null);

  // ATR 副图
  const atrChartRef = useRef<HTMLDivElement>(null);
  const atrChart = useRef<IChartApi | null>(null);
  const atrLine = useRef<ISeriesApi<'Line'> | null>(null);

  // VWAP（主图线）
  const vwapSeries = useRef<ISeriesApi<'Line'> | null>(null);

  // 神奇九转（主图标注）
  const nineTurnCanvasRef = useRef<HTMLCanvasElement>(null);
  const nineTurnDataRef = useRef<{ value: number }[]>([]);
  const drawNineTurnRef = useRef<() => void>(() => {});

  // 缠论（主图标注）
  const chanCanvasRef = useRef<HTMLCanvasElement>(null);
  const chanDataRef = useRef<ChanResult | null>(null);
  const trendChannelRef = useRef<TrendChannel | null>(null);
  const valueAreaRef = useRef<ValueArea | null>(null);
  const ichimokuRef = useRef<IchimokuData | null>(null);
  const synthRef = useRef<PredictionSynth | null>(null);
  const drawChanRef = useRef<() => void>(() => {});

  const srLinesRef = useRef<any[]>([]);

  const allKlinesRef = useRef<KlineData[]>([]);
  // 4h 级别K线缓存（R4 跨周期分型投射用）：独立于当前显示周期拉取，fetchKlines TTL 缓存 5 分钟
  const k4hRef = useRef<KlineData[]>([]);
  const pendingTickRef = useRef<number | null>(null);
  const pendingTickTsRef = useRef<number | null>(null);
  // 最近一次已应用 tick 的成交时间戳：用于过滤过期/乱序 tick（重连回放）
  const lastTradeTsRef = useRef<number>(0);
  const rAFRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number>(0);
  // 最近一次已“收盘”的K线时间：用于在丢失 isFinal 消息时也能驱动缠论/九转刷新
  const lastBarTimeRef = useRef<number>(0);
  // 最近一次分型/背离标记实时刷新时间（flushTick 内 300ms 节流，驱动未确认分型预览）
  const lastMarkerDrawAtRef = useRef<number>(0);
  // 数据串扰守卫（切换周期/币种时避免新tick/kline写进旧数组造成混图闪跳）：
  //  loadedDataKey = allKlinesRef 当前真实装载的内存×周期签名；
  //  dataKeyRef    = 当前期望的内存×周期（镜像）；两者不一致时丢弃提前到达的实时消息。
  const loadedDataKeyRef = useRef<string>('');
  const dataKeyRef = useRef<string>('');

  // AB9线 + 趋势通道 + 安德鲁音叉：从 localStorage 初始化（需惰性执行，避免每次渲染读 localStorage）
  const [overlayPrefsInit] = useState(loadOverlayPrefs);
  const [showAutoAB9, setShowAutoAB9] = useState(overlayPrefsInit.AB9);
  const [showTrendChannel, setShowTrendChannel] = useState(overlayPrefsInit.CHANNEL);
  const [showValueArea, setShowValueArea] = useState(overlayPrefsInit.VALUEAREA ?? false);
  const [showIchimoku, setShowIchimoku] = useState(overlayPrefsInit.ICHIMOKU ?? false);
  const [showSynth, setShowSynth] = useState(overlayPrefsInit.SYNTH ?? false);
  const [showGann, setShowGann] = useState(overlayPrefsInit.GANN ?? false);
  const [showSuperTrend, setShowSuperTrend] = useState(overlayPrefsInit.SUPER ?? false);
  const [showFractal, setShowFractal] = useState(overlayPrefsInit.FRACTAL ?? false);
  const [showDiverg, setShowDiverg] = useState(overlayPrefsInit.DIVERG ?? false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // 信号面板：聚合所有指标/画线工具的多空震荡判定
  const [showSignalsPanel, setShowSignalsPanel] = useState(false);
  const [showGannPanel, setShowGannPanel] = useState(false);
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
  const [panelTick, setPanelTick] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // 面板独立节流刷新：直接读 ref 最新数据，不影响主图重绘频率
  useEffect(() => {
    if (!showSignalsPanel && !showGannPanel && !showIndicatorPanel) return;
    const t = setInterval(() => setPanelTick((v) => v + 1), 1500);
    return () => clearInterval(t);
  }, [showSignalsPanel, showGannPanel, showIndicatorPanel]);
  // ref 镜像：updateIndicators 的 useCallback 依赖里没有这两个开关，
  // 切换币种/周期重载数据时闭包里是旧值，会出现"关了又冒出来/开了不出来"的状态错乱
  const showTrendChannelRef = useRef(showTrendChannel);
  showTrendChannelRef.current = showTrendChannel;
  const showValueAreaRef = useRef(showValueArea);
  showValueAreaRef.current = showValueArea;
  const showIchimokuRef = useRef(showIchimoku);
  showIchimokuRef.current = showIchimoku;
  const showSynthRef = useRef(showSynth);
  showSynthRef.current = showSynth;
  const showGannRef = useRef(showGann);
  showGannRef.current = showGann;
  const showSuperTrendRef = useRef(showSuperTrend);
  showSuperTrendRef.current = showSuperTrend;
  // SuperTrend 叠加段 series 引用（重算/关闭时清理）
  const superTrendSegsRef = useRef<ISeriesApi<'Line'>[]>([]);
  // 江恩工具箱结果缓存（按 K 线签名懒重算）
  const gannRef = useRef<ReturnType<typeof calcGannAll> | null>(null);
  const gannSigRef = useRef<string>('');
  // AB9线 ref（原生满宽价格线）
  const autoPriceLinesRef = useRef<any[]>([]);
  // 左上角 OHLC 图例：随十字线联动（悬停读历史K线，离开回落到最新一根，tick 实时刷新）
  interface LegendInfo { o: number; h: number; l: number; c: number; pct: number }
  const [legend, setLegend] = useState<LegendInfo | null>(null);
  const legendOf = useCallback((o: number, h: number, l: number, c: number): LegendInfo => ({
    o, h, l, c, pct: o > 0 ? ((c - o) / o) * 100 : 0,
  }), []);
  // 趋势通道 LineSeries refs（上轨/下轨/中轨 + 预测延伸线）
  const tcSeriesRef = useRef<{
    upper?: ISeriesApi<'Line'>; lower?: ISeriesApi<'Line'>; mid?: ISeriesApi<'Line'>;
    upperProj?: ISeriesApi<'Line'>; lowerProj?: ISeriesApi<'Line'>;
  }>({});

  // 指标显示开关：前台徽章直接管控（localStorage 持久化，后台不再干预）
  const [indicators, setIndicators] = useState(loadIndicatorPrefs);
  // 指标周期参数（从后台加载）
  const [periods, setPeriods] = useState({
    emaPeriod: 20,
    bollPeriod: 20,
    rsiPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    kdjN: 9,
    kdjK: 3,
    kdjD: 3,
    atrPeriod: 14,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState('连接中');
  const isMember = useAuthStore((s) => s.isMember);
  const isMemberRef = useRef(isMember);
  isMemberRef.current = isMember;
  const showAutoAB9Ref = useRef(showAutoAB9);
  showAutoAB9Ref.current = showAutoAB9;
  const showFractalRef = useRef(showFractal);
  showFractalRef.current = showFractal;
  const showDivergRef = useRef(showDiverg);
  showDivergRef.current = showDiverg;
  const interval = useChartStore((s) => s.interval);
  // 当前周期镜像 ref：drawFractalDivergMarkers（空依赖 useCallback）内读取，判断 R4 投射方式
  const intervalRef = useRef(interval);
  intervalRef.current = interval;
  const setIntervalState = useChartStore((s) => s.setInterval);
  const symbol = useSymbolStore((s) => s.symbol);
  const okxId = useSymbolStore((s) => s.okxId);
  const symbolLabel = useSymbolStore((s) => s.label);
  const setSymbol = useSymbolStore((s) => s.setSymbol);
  const symbolList = useSymbolStore((s) => s.symbols);
  const fetchSymbols = useSymbolStore((s) => s.fetchSymbols);
  /** 当前币种价格精度（K线价格轴/十字线按此格式化 — 低价币不再显示成 0.00） */
  const pricePrecision = useSymbolStore((s) => s.pricePrecision);
  // 期望加载的数据签名（镜像）：切换周期/币种时渲染即更新，供 tick/kline 守卫比对
  dataKeyRef.current = `${symbol}|${interval}`;

  // 切换币种时更新价格轴精度（K线主图 + MACD 快慢线，值随币价量级变化）
  useEffect(() => {
    const precision = Math.max(0, Math.min(8, pricePrecision));
    const minMove = Math.pow(10, -precision);
    candleSeries.current?.applyOptions({
      priceFormat: { type: 'price', precision, minMove },
    });
    macdDif.current?.applyOptions({
      priceFormat: { type: 'price', precision, minMove },
    });
    macdDea.current?.applyOptions({
      priceFormat: { type: 'price', precision, minMove },
    });
  }, [pricePrecision]);

  // 加载币种列表
  useEffect(() => {
    fetchSymbols();
  }, [fetchSymbols]);

  // 从后台 API 加载指标周期参数 + 用户画线偏好（并行请求，不阻塞K线加载）
  // 注意：指标显示开关（EMA/BOLL/MACD/RSI）不再从后台加载 —— 前台徽章直接管控
  useEffect(() => {
    let cancelled = false;
    // 同时发起 settings 请求，不串行等待
    const settingsPromise = apiGet<Record<string, string>>('/api/settings');

    settingsPromise
      .then((data) => {
        if (cancelled) return;
        setPeriods({
          emaPeriod: parseInt(data.emaPeriod || '20', 10) || 20,
          bollPeriod: parseInt(data.bollPeriod || '20', 10) || 20,
          rsiPeriod: parseInt(data.rsiPeriod || '14', 10) || 14,
          macdFast: parseInt(data.macdFast || '12', 10) || 12,
          macdSlow: parseInt(data.macdSlow || '26', 10) || 26,
          macdSignal: parseInt(data.macdSignal || '9', 10) || 9,
          kdjN: parseInt(data.kdjN || '9', 10) || 9,
          kdjK: parseInt(data.kdjK || '3', 10) || 3,
          kdjD: parseInt(data.kdjD || '3', 10) || 3,
          atrPeriod: parseInt(data.atrPeriod || '14', 10) || 14,
        });
        // AB9/FIB 不再从后台读取，localStorage 是唯一数据源
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 持久化画线开关偏好到后端
  const saveUserPref = useCallback((key: string, value: boolean) => {
    apiPut('/api/user/preferences', { [key]: value }).catch(() => {});
  }, []);

  // 更新所有指标线
  const updateIndicators = useCallback(() => {
    const klines = allKlinesRef.current;
    if (!klines.length || !mainChart.current) return;

    // 清除旧的布林带
    [bbUpper.current, bbMiddle.current, bbLower.current, emaSeries.current, ma120Series.current].forEach((s) => {
      if (s) { try { mainChart.current?.removeSeries(s); } catch {} }
    });
    bbUpper.current = bbMiddle.current = bbLower.current = emaSeries.current = ma120Series.current = null;

    // EMA 均线
    if (indicators.EMA) {
      emaSeries.current = mainChart.current.addLineSeries({
        color: 'rgba(56, 189, 248, 0.85)',
        lineWidth: 1,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const ema = calcEMAArray(klines, periods.emaPeriod);
      const emaData: LineData[] = [];
      ema.forEach((v, i) => {
        if (v !== null && !isNaN(v)) emaData.push({ time: klines[i].time as Time, value: v });
      });
      emaSeries.current.setData(emaData);
    }

    // MA120 长期均线（金色，固定 120 周期）
    if (indicators.MA120) {
      ma120Series.current = mainChart.current.addLineSeries({
        color: 'rgba(230, 180, 80, 0.95)',
        lineWidth: 2,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'MA120',
      });
      const ma = calcSMAArray(klines, 120);
      const maData: LineData[] = [];
      ma.forEach((v, i) => {
        if (v !== null && !isNaN(v)) maData.push({ time: klines[i].time as Time, value: v });
      });
      ma120Series.current.setData(maData);
    }

    // 布林带
    if (indicators.BOLL) {
      const bb = calcBollinger(klines, periods.bollPeriod);
      if (bb) {
        bbUpper.current = mainChart.current.addLineSeries({
          color: 'rgba(34, 211, 238, 0.62)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        });
        bbMiddle.current = mainChart.current.addLineSeries({
          color: 'rgba(251, 191, 36, 0.68)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        });
        bbLower.current = mainChart.current.addLineSeries({
          color: 'rgba(34, 211, 238, 0.62)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        });
        bbUpper.current.setData(bb.upperSeries.map((d) => ({ time: d.time as Time, value: d.value })));
        bbMiddle.current.setData(bb.middleSeries.map((d) => ({ time: d.time as Time, value: d.value })));
        bbLower.current.setData(bb.lowerSeries.map((d) => ({ time: d.time as Time, value: d.value })));
      }
    }

    // SuperTrend 叠加（上趋势绿轨 / 下趋势红轨，按连续段分段）
    superTrendSegsRef.current.forEach((s) => { try { mainChart.current?.removeSeries(s); } catch {} });
    superTrendSegsRef.current = [];
    if (showSuperTrendRef.current) {
      const st = calcSuperTrend(klines, 10, 3);
      const runs: { up: boolean; data: LineData[] }[] = [];
      let seg: LineData[] | null = null;
      let segUp: boolean | null = null;
      for (let i = 0; i < st.points.length; i++) {
        const p = st.points[i];
        if (p.value == null || p.isUp == null) continue;
        if (!seg || segUp !== p.isUp) { if (seg) runs.push({ up: !!segUp, data: seg }); seg = []; segUp = p.isUp; }
        seg.push({ time: klines[i].time as Time, value: p.value });
      }
      if (seg) runs.push({ up: !!segUp, data: seg });
      runs.forEach((r) => {
        if (r.data.length < 2) return;
        const s = mainChart.current?.addLineSeries({
          color: r.up ? 'rgba(16, 185, 129, 0.9)' : 'rgba(244, 63, 94, 0.9)',
          lineWidth: 2,
          lineStyle: 0,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        if (s) { s.setData(r.data); superTrendSegsRef.current.push(s); }
      });
    }

    // MACD 副图
    if (indicators.MACD && macdChart.current) {
      const macdData = calcMACD(klines, periods.macdFast, periods.macdSlow, periods.macdSignal);
      if (macdData && macdHist.current && macdDif.current && macdDea.current) {
        const histData: HistogramData[] = [];
        const difData: LineData[] = [];
        const deaData: LineData[] = [];
        for (let i = 0; i < klines.length; i++) {
          const t = klines[i].time as Time;
          const hv = macdData.hist[i];
          histData.push({
            time: t,
            value: hv as number,
            color: (hv as number) >= 0 ? 'rgba(14, 203, 129, 0.75)' : 'rgba(246, 70, 93, 0.75)',
          });
          difData.push({ time: t, value: macdData.dif[i] as number });
          deaData.push({ time: t, value: macdData.dea[i] as number });
        }
        macdHist.current.setData(histData);
        macdDif.current.setData(difData);
        macdDea.current.setData(deaData);
      }
      // 显示 MACD 副图
      if (macdChartRef.current?.parentElement) {
        macdChartRef.current.parentElement.classList.remove('hidden');
      }
    } else {
      // 关闭 MACD：清空数据并隐藏副图面板
      if (macdHist.current) macdHist.current.setData([]);
      if (macdDif.current) macdDif.current.setData([]);
      if (macdDea.current) macdDea.current.setData([]);
      if (macdChartRef.current?.parentElement) {
        macdChartRef.current.parentElement.classList.add('hidden');
      }
    }

    // RSI 副图
    if (indicators.RSI && rsiChart.current && rsiLine.current) {
      const rsiData = calcRSIArray(klines, periods.rsiPeriod);
      const lineData: LineData[] = [];
      const overboughtData: LineData[] = [];
      const oversoldData: LineData[] = [];
      for (let i = 0; i < klines.length; i++) {
        const t = klines[i].time as Time;
        const v = rsiData[i];
        lineData.push({ time: t, value: v as number });
        overboughtData.push({ time: t, value: 70 });
        oversoldData.push({ time: t, value: 30 });
      }
      rsiLine.current.setData(lineData);
      if (rsiOverbought.current) rsiOverbought.current.setData(overboughtData);
      if (rsiOversold.current) rsiOversold.current.setData(oversoldData);
      // 显示 RSI 副图
      if (rsiChartRef.current?.parentElement) {
        rsiChartRef.current.parentElement.classList.remove('hidden');
      }
    } else {
      // 关闭 RSI：清空数据并隐藏副图面板
      if (rsiLine.current) rsiLine.current.setData([]);
      if (rsiOverbought.current) rsiOverbought.current.setData([]);
      if (rsiOversold.current) rsiOversold.current.setData([]);
      if (rsiChartRef.current?.parentElement) {
        rsiChartRef.current.parentElement.classList.add('hidden');
      }
    }

    // VWAP（主图线）
    if (vwapSeries.current) {
      try { mainChart.current?.removeSeries(vwapSeries.current); } catch {}
      vwapSeries.current = null;
    }
    if (indicators.VWAP) {
      vwapSeries.current = mainChart.current.addLineSeries({
        color: 'rgba(168, 85, 247, 0.85)',
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const vwap = calcVWAPArray(klines);
      const vwapData: LineData[] = [];
      vwap.forEach((v, i) => {
        if (v !== null && !isNaN(v)) vwapData.push({ time: klines[i].time as Time, value: v });
      });
      vwapSeries.current.setData(vwapData);
    }

    // 神奇九转：计算数据并绘制到覆盖层 canvas
    if (indicators.NINE) {
      nineTurnDataRef.current = calcNineTurn(klines);
    } else {
      nineTurnDataRef.current = [];
    }
    // 延迟一帧重绘九转（等图表布局完成）
    requestAnimationFrame(() => {
      try { drawNineTurnRef.current(); } catch (e) { console.warn('[NineTurn] raf error:', e); }
    });

    // 缠论：计算数据并绘制到覆盖层 canvas
    if (indicators.CHAN) {
      chanDataRef.current = calcChan(klines);
    } else {
      chanDataRef.current = null;
    }

    // 趋势通道（读 ref 镜像，避免闭包过期）
    if (showTrendChannelRef.current) {
      trendChannelRef.current = calcTrendChannel(klines, 60);
    } else {
      trendChannelRef.current = null;
    }

    // 价值区域（VAH/VAL/POC）
    if (showValueAreaRef.current) {
      valueAreaRef.current = calcValueArea(klines, 80);
    } else {
      valueAreaRef.current = null;
    }

    // 一目均衡表云图
    if (showIchimokuRef.current) {
      ichimokuRef.current = calcIchimoku(klines, 9, 26, 52, 26);
    } else {
      ichimokuRef.current = null;
    }

    // 预测信号合成器
    if (showSynthRef.current) {
      synthRef.current = calcPredictionSynth(klines);
    } else {
      synthRef.current = null;
    }

    requestAnimationFrame(() => {
      try { drawChanRef.current(); } catch (e) { console.warn('[Chan] raf error:', e); }
    });

    // KDJ 副图
    if (indicators.KDJ && kdjChart.current && kdjKLine.current && kdjDLine.current && kdjJLine.current) {
      const kdjData = calcKDJ(klines, periods.kdjN, periods.kdjK, periods.kdjD);
      if (kdjData) {
        const kData: LineData[] = [];
        const dData: LineData[] = [];
        const jData: LineData[] = [];
        const overboughtData: LineData[] = [];
        const oversoldData: LineData[] = [];
        for (let i = 0; i < klines.length; i++) {
          const t = klines[i].time as Time;
          kData.push({ time: t, value: kdjData.k[i] as number });
          dData.push({ time: t, value: kdjData.d[i] as number });
          jData.push({ time: t, value: kdjData.j[i] as number });
          overboughtData.push({ time: t, value: 80 });
          oversoldData.push({ time: t, value: 20 });
        }
        kdjKLine.current.setData(kData);
        kdjDLine.current.setData(dData);
        kdjJLine.current.setData(jData);
        if (kdjOverbought.current) kdjOverbought.current.setData(overboughtData);
        if (kdjOversold.current) kdjOversold.current.setData(oversoldData);
      }
      // 显示 KDJ 副图
      if (kdjChartRef.current?.parentElement) {
        kdjChartRef.current.parentElement.classList.remove('hidden');
      }
    } else {
      // 关闭 KDJ：清空数据并隐藏副图面板
      if (kdjKLine.current) kdjKLine.current.setData([]);
      if (kdjDLine.current) kdjDLine.current.setData([]);
      if (kdjJLine.current) kdjJLine.current.setData([]);
      if (kdjOverbought.current) kdjOverbought.current.setData([]);
      if (kdjOversold.current) kdjOversold.current.setData([]);
      if (kdjChartRef.current?.parentElement) {
        kdjChartRef.current.parentElement.classList.add('hidden');
      }
    }

    // ATR 副图
    if (indicators.ATR && atrChart.current && atrLine.current) {
      const atrData = calcATRArray(klines, periods.atrPeriod);
      const lineData: LineData[] = [];
      for (let i = 0; i < klines.length; i++) {
        lineData.push({ time: klines[i].time as Time, value: atrData[i] as number });
      }
      atrLine.current.setData(lineData);
      // 显示 ATR 副图
      if (atrChartRef.current?.parentElement) {
        atrChartRef.current.parentElement.classList.remove('hidden');
      }
    } else {
      // 关闭 ATR：清空数据并隐藏副图面板
      if (atrLine.current) atrLine.current.setData([]);
      if (atrChartRef.current?.parentElement) {
        atrChartRef.current.parentElement.classList.add('hidden');
      }
    }
  }, [indicators, periods]);

  // 徽章切换指标时立即重绘
  // 修复：此前徽章只改 state 不触发重绘，必须等K线收盘或刷新页面才生效
  useEffect(() => {
    if (allKlinesRef.current.length > 0 && mainChart.current) {
      updateIndicators();
    }
  }, [indicators, updateIndicators]);

  // 趋势通道/音叉/Fourier 开关切换时立即重算
  // （showGann 叠加绘制在 canvas 层，开关切换只需触发一次 drawChan 重绘）
  useEffect(() => {
    if (allKlinesRef.current.length > 0 && mainChart.current) {
      const klines = allKlinesRef.current;
      // 趋势通道
      if (showTrendChannel) {
        trendChannelRef.current = calcTrendChannel(klines, 60);
      } else {
        trendChannelRef.current = null;
      }
      // 价值区域
      if (showValueArea) {
        valueAreaRef.current = calcValueArea(klines, 80);
      } else {
        valueAreaRef.current = null;
      }
      // 一目均衡表
      if (showIchimoku) {
        ichimokuRef.current = calcIchimoku(klines, 9, 26, 52, 26);
      } else {
        ichimokuRef.current = null;
      }
      // 预测合成
      if (showSynth) {
        synthRef.current = calcPredictionSynth(klines);
      } else {
        synthRef.current = null;
      }
      requestAnimationFrame(() => {
        try { drawChanRef.current(); } catch (e) { console.warn('[Overlay] raf error:', e); }
      });
    }
  }, [showTrendChannel, showValueArea, showIchimoku, showSynth, showGann, showAutoAB9, isMember]);

  // === AB9线 + 支撑/阻力线重绘 ===
  // 数据加载、开关切换、K线收盘（isFinal）时调用，统一走这一个入口
  const redrawOverlayLines = useCallback(() => {
    const klines = allKlinesRef.current;
    const series = candleSeries.current;
    if (!mainChart.current || !series || klines.length === 0) return;

    // 先清除所有旧画线
    for (const pl of autoPriceLinesRef.current) {
      try { series.removePriceLine(pl); } catch {}
    }
    autoPriceLinesRef.current = [];

    // —— 支撑/阻力（箱体区间或近端；恢复快信号版本的原画法，独立于策略引擎） ——
    for (const pl of srLinesRef.current) {
      try { series.removePriceLine(pl); } catch {}
    }
    srLinesRef.current = [];
    if (isMember && klines.length >= 8) {
      const sr = calcRangeBox(klines);
      if (sr) {
        const solid = sr.isRange; // 箱体:实(0.8) | 近端:淡(0.5)
        try {
          srLinesRef.current.push(series.createPriceLine({
            price: sr.support,
            color: solid ? 'rgba(34, 197, 94, 0.8)' : 'rgba(34, 197, 94, 0.5)',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: solid ? ' 支撑' : ' 近端支撑',
          }));
          srLinesRef.current.push(series.createPriceLine({
            price: sr.resistance,
            color: solid ? 'rgba(246, 70, 93, 0.8)' : 'rgba(246, 70, 93, 0.5)',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: solid ? ' 阻力' : ' 近端阻力',
          }));
        } catch {}
      }
    }

    // —— AB9线（原生满宽价格线，价格轴可读数） ——
    if (showAutoAB9 && isMember) {
      const ab9 = calcAB9Lines(klines);
      if (ab9) {
        for (const line of ab9.lines) {
          const color = AB9_COLORS[line.lineNo];
          if (!color) continue;
          try {
            const pl = series.createPriceLine({
              price: line.price,
              color: color.replace(/[\d.]+\)$/, '0.85)'),
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: ` ${line.lineNo}线`,
            });
            autoPriceLinesRef.current.push(pl);
          } catch {}
        }
      }
    }

    }, [showAutoAB9, isMember, symbol]);

  // ====== 趋势通道 + 预测延伸线 + 音叉 ====== 画线 ======
  // 在 redrawOverlayLines 之后独立执行，依赖 showTrendChannel
  const drawTrendOverlays = useCallback(() => {
    const klines = allKlinesRef.current;
    if (!mainChart.current || klines.length < 2) return;

    // ---- 清除旧的 LineSeries ----
    const removeTcSeries = () => {
      const r = tcSeriesRef.current;
      for (const key of ['upper', 'lower', 'mid', 'upperProj', 'lowerProj'] as const) {
        if (r[key]) { try { mainChart.current?.removeSeries(r[key]!); } catch {} r[key] = undefined; }
      }
    };
    // ---- 趋势通道 ----
    // 趋势通道通过 Canvas 叠层绘制（drawChan 内），不使用 LineSeries。
    // Canvas 绘制附带通道填充、方向感知配色和触点标签，功能更完整。
    if (showTrendChannelRef.current && isMember) {
      if (!trendChannelRef.current) {
        trendChannelRef.current = calcTrendChannel(klines, 60);
      }
    } else {
      trendChannelRef.current = null;
    }
    // 清理可能残留的旧 LineSeries
    removeTcSeries();

    }, [isMember, symbol]);

  // 重算并绘制顶/底分型 + 顶/底背离标记。
  // 复用自 updateChart 原逻辑，抽成独立函数以便实时 tick（flushTick / updateLastKline）也能动态刷新。
  // 分型/背离标记覆盖整段已加载K线（不做近端90根窗口裁剪），滑动查看历史同样可见。
  // 分型确认需右侧 3 根收盘（固有滞后）；尾部另叠加半透明“未确认分型”预览（见下），
  // 价格回落即现、确认后转实心、形态破坏自动消失，缓解确认滞后导致的“标记出现太晚”。
  const drawFractalDivergMarkers = useCallback((klines: KlineData[]) => {
    if (!candleSeries.current) return;
    candleSeries.current.setMarkers([]);
    if (!isMemberRef.current) return;

    const fs = detectFractals(klines);
    const mk: SeriesMarker<Time>[] = [];
    // 4h 周期图上的分型箭头本身就是 4h 级别信号（回测中唯一「每笔毛优势>费用」的周期），
    // 直接在箭头上方/下方标注 R4；其余周期的箭头保持无文本，R4 由下方跨周期投射逻辑单独绘制。
    const r4 = intervalRef.current === '4h' ? 'R4' : undefined;
    if (showFractalRef.current) {
      for (const h of fs.fractalHighs) {
        if (h.idx < 0 || h.idx >= klines.length) continue;
        mk.push({ time: klines[h.idx].time as Time, position: 'aboveBar', color: '#f87171', shape: 'arrowDown', size: 1, text: r4 });
      }
      for (const l of fs.fractalLows) {
        if (l.idx < 0 || l.idx >= klines.length) continue;
        mk.push({ time: klines[l.idx].time as Time, position: 'belowBar', color: '#34d399', shape: 'arrowUp', size: 1, text: r4 });
      }
    }
    const macd = showDivergRef.current ? calcMACD(klines, 12, 26, 9) : null;
    if (macd && showDivergRef.current) {
      const cl = klines.map((k) => k.close);
      const highs = [...fs.fractalHighs].sort((a, b) => a.idx - b.idx);
      for (let k = 1; k < highs.length; k++) {
        const a = highs[k - 1], b = highs[k];
        if (b.idx + 1 >= klines.length) break;
        const da = macd.dif[a.idx], db = macd.dif[b.idx];
        if (da == null || db == null) continue;
        if (cl[b.idx] > cl[a.idx] && db < da) mk.push({ time: klines[b.idx].time as Time, position: 'aboveBar', color: '#f97316', shape: 'circle', size: 2 });
      }
      const lows = [...fs.fractalLows].sort((a, b) => a.idx - b.idx);
      for (let k = 1; k < lows.length; k++) {
        const a = lows[k - 1], b = lows[k];
        if (b.idx + 1 >= klines.length) break;
        const da = macd.dif[a.idx], db = macd.dif[b.idx];
        if (da == null || db == null) continue;
        if (cl[b.idx] < cl[a.idx] && db > da) mk.push({ time: klines[b.idx].time as Time, position: 'belowBar', color: '#06b6d4', shape: 'circle', size: 2 });
      }
    }
    // —— 尾部未确认分型预览（半透明）——
    // 确认分型需右侧 3 根收盘，固有滞后最多 3 根；此处对“右确认不足但形态已成”的尾部
    // 局部极值打半透明预览箭头：已回落的倒数第二、三根在回落瞬间即现；最新根（n-1）无右侧，
    // 仅按左侧极值判定为“进行中”潜在分型预警（更淡），创新高/新低当下就给出最早信号，
    // 右侧价格反向时形态破坏自动消失。配合 flushTick 的 300ms 节流刷新随实时价更新。
    const used = new Set(mk.map((m) => m.time as number));
    const PROV = 3;
    const provStart = klines.length - PROV;
    if (provStart > PROV && showFractalRef.current) {
      // 循环覆盖到最新根 n-1，让“可能形成未确认分型”的信号最早呈现
      for (let i = provStart; i <= klines.length - 1; i++) {
        const inProgress = i === klines.length - 1;
        let topOk = true, botOk = true;
        for (let j = 1; j <= PROV; j++) {
          const li = i - j, ri = i + j;
          if (li >= 0) {
            if (klines[i].high < klines[li].high) topOk = false;
            if (klines[i].low > klines[li].low) botOk = false;
          }
          if (ri < klines.length) {
            if (klines[i].high <= klines[ri].high) topOk = false;
            if (klines[i].low >= klines[ri].low) botOk = false;
          }
        }
        const alpha = inProgress ? 0.30 : 0.45;
        const t = klines[i].time as number;
        if (topOk && !used.has(t)) mk.push({ time: t as Time, position: 'aboveBar', color: `rgba(248,113,113,${alpha})`, shape: 'arrowDown', size: 1, text: r4 });
        if (botOk && !used.has(t)) mk.push({ time: t as Time, position: 'belowBar', color: `rgba(52,211,153,${alpha})`, shape: 'arrowUp', size: 1, text: r4 });
      }
    }

    // —— R4：4h 级别分型信号跨周期投射（非 4h 周期图上）——
    // 在 15m/1h 等低周期图上也能一眼看到 4h 级别的顶/底分型（含未确认预览），
    // 标注 R4 与当前周期自己的箭头区分。数据源为独立拉取的 4h K线（k4hRef）。
    if (showFractalRef.current && intervalRef.current !== '4h') {
      const base4 = k4hRef.current;
      if (base4.length > 10) {
        // 实时合并：当前周期 < 4h 时，把当前图表实时K线（含 tick）并入最后一个 4h 根，
        // 让 4h 预览分型随实时价即时演化（high/low 取极值、close 取最新；1d 周期跨度大于
        // 4h 窗口，合并会引入窗口外价格，故不合并，直接用 4h 缓存数据）。
        let k4 = base4;
        const curMs = INTERVAL_MS[intervalRef.current ?? ''] ?? FOUR_H_MS;
        if (curMs < FOUR_H_MS) {
          const last = base4[base4.length - 1];
          let hi = last.high, lo = last.low, cl = last.close;
          for (let i = klines.length - 1; i >= 0; i--) {
            const tk = klines[i].time;
            if (tk < last.time || tk >= last.time + FOUR_H_MS) break;
            hi = Math.max(hi, klines[i].high);
            lo = Math.min(lo, klines[i].low);
            cl = klines[i].close;
          }
          k4 = base4.slice(0, -1).concat([{ ...last, high: hi, low: lo, close: cl }]);
        }
        // 定位：4h 根时间 → 当前图表「最后一个 time ≤ t」的K线（即包含该 4h 窗口的根；
        // 4h 边界时刻与 1m/5m/15m/30m/1h 网格对齐，通常精确命中同刻K线）
        const placeR4 = (t4: number, pos: 'aboveBar' | 'belowBar', color: string) => {
          let a = 0, b = klines.length - 1, r = -1;
          while (a <= b) {
            const m = (a + b) >> 1;
            if (klines[m].time <= t4) { r = m; a = m + 1; } else b = m - 1;
          }
          if (r < 0) return;
          mk.push({ time: klines[r].time as Time, position: pos, color, shape: pos === 'aboveBar' ? 'arrowDown' : 'arrowUp', size: 1, text: 'R4' });
        };
        const fs4 = detectFractals(k4);
        const confirmed4 = new Set<number>();
        for (const h of fs4.fractalHighs) {
          const t = k4[h.idx]?.time;
          if (t == null) continue;
          confirmed4.add(t);
          placeR4(t, 'aboveBar', '#f87171');
        }
        for (const l of fs4.fractalLows) {
          const t = k4[l.idx]?.time;
          if (t == null) continue;
          confirmed4.add(t);
          placeR4(t, 'belowBar', '#34d399');
        }
        // 4h 尾部未确认分型预览（半透明 R4，与当前周期预览同口径）
        const PROV4 = 3;
        const ps4 = k4.length - PROV4;
        if (ps4 > PROV4) {
          for (let i = ps4; i <= k4.length - 1; i++) {
            const t = k4[i].time;
            if (confirmed4.has(t)) continue;
            const inProgress = i === k4.length - 1;
            let topOk = true, botOk = true;
            for (let j = 1; j <= PROV4; j++) {
              const li = i - j, ri = i + j;
              if (li >= 0) {
                if (k4[i].high < k4[li].high) topOk = false;
                if (k4[i].low > k4[li].low) botOk = false;
              }
              if (ri < k4.length) {
                if (k4[i].high <= k4[ri].high) topOk = false;
                if (k4[i].low >= k4[ri].low) botOk = false;
              }
            }
            const alpha = inProgress ? 0.30 : 0.45;
            if (topOk) placeR4(t, 'aboveBar', `rgba(248,113,113,${alpha})`);
            if (botOk) placeR4(t, 'belowBar', `rgba(52,211,153,${alpha})`);
          }
        }
      }
    }

    // lightweight-charts 契约：markers 必须按时间升序排列。
    // 内部用二分查找（visibleTimedValues）计算可见标记范围，乱序数组会导致区间计算错误、
    // 标记被静默跳过（表现为部分/全部箭头消失、需滑动才出现）。
    mk.sort((a, b) => (a.time as number) - (b.time as number));
    candleSeries.current.setMarkers(mk);
  }, []); // 全部引用 ref，无需依赖

  // 开关切换（顶/底分型、MACD背离）时立即刷新标记，无需等待下一次 tick/收盘
  useEffect(() => {
    drawFractalDivergMarkers(allKlinesRef.current);
  }, [showFractal, showDiverg, drawFractalDivergMarkers]);

  // 会员状态异步加载（isMember 初始为 false，/api/auth/me 返回后才变 true）。
  // 若首屏 updateChart 时会员尚未就绪，标记会被跳过；此处会员状态变化时立即补画，
  // 避免"刷新才有信号"。会员降级时也会自动清空标记。
  useEffect(() => {
    drawFractalDivergMarkers(allKlinesRef.current);
  }, [isMember, drawFractalDivergMarkers]);

  // 更新K线数据
  const updateChart = useCallback((klines: KlineData[], intv?: string) => {
    allKlinesRef.current = klines;
    if (!candleSeries.current || !volumeSeries.current) return;

    const candleData: CandlestickData[] = klines.map((k) => ({
      time: k.time as Time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
    const volumeData: HistogramData[] = klines.map((k) => ({
      time: k.time as Time,
      value: k.volume,
      color: k.close >= k.open ? 'rgba(14, 203, 129, 0.45)' : 'rgba(246, 70, 93, 0.45)',
    }));

    candleSeries.current.setData(candleData);
    volumeSeries.current.setData(volumeData);

    updateIndicators();

    // === AB9线 + 支撑/阻力线 ===
    redrawOverlayLines();

    // === 趋势通道 + 预测延伸线 + 音叉 ===
    drawTrendOverlays();

    // 顶/底分型 + 顶/底背离标记（实时 tick 也复用 drawFractalDivergMarkers 动态刷新）
    drawFractalDivergMarkers(klines);

    // 图例初始化为最新一根K线
    const lk = klines[klines.length - 1];
    if (lk) setLegend(legendOf(lk.open, lk.high, lk.low, lk.close));

    // 视图定位：
    // - 切换周期（intv 有值）：直接定位到最右端约 72 根，跳过 fitContent 避免视图缩放跳变
    // - 初始加载或币种切换：先 fitContent 再定位到右端，确保价格轴适配新范围
    if (mainChart.current) {
      const bars = Math.min(72, klines.length);
      const toIdx = klines.length - 1;
      const fromIdx = Math.max(0, toIdx - bars + 1);
      if (intv === undefined) {
        mainChart.current.timeScale().fitContent();
      }
      mainChart.current.timeScale().setVisibleLogicalRange({ from: fromIdx, to: toIdx + 4 });
      // 副图同步时间轴范围（保证所有副图与主图K线一一对齐）
      const range = { from: fromIdx, to: toIdx + 4 };
      if (macdChart.current) macdChart.current.timeScale().setVisibleLogicalRange(range);
      if (rsiChart.current) rsiChart.current.timeScale().setVisibleLogicalRange(range);
      if (kdjChart.current) kdjChart.current.timeScale().setVisibleLogicalRange(range);
      if (atrChart.current) atrChart.current.timeScale().setVisibleLogicalRange(range);
    }
  }, [updateIndicators, redrawOverlayLines, drawTrendOverlays, legendOf, drawFractalDivergMarkers]);

  // 切换画线开关时仅重画线（不再整图重载、不重置视图）
  useEffect(() => {
    redrawOverlayLines();
  }, [redrawOverlayLines]);

  // 趋势通道/VA/云图/合成 开关切换时重画
  useEffect(() => {
    drawTrendOverlays();
  }, [drawTrendOverlays, showTrendChannel, showValueArea, showIchimoku, showSynth]);

  // SuperTrend 开关切换时重算主图叠加
  useEffect(() => {
    updateIndicators();
  }, [showSuperTrend, updateIndicators]);

  // Tick 实时更新（rAF + 50ms 节流，和 v24 一致）
  const flushTick = useCallback(() => {
    rAFRef.current = null;
    if (!candleSeries.current || !volumeSeries.current) return;
    const klines = allKlinesRef.current;
    if (klines.length === 0) return;
    // 数据串扰守卫：切换周期/币种且新数据尚未装载完成时，跳过 tick（不写旧数组）
    if (loadedDataKeyRef.current !== dataKeyRef.current) return;
    const price = pendingTickRef.current;
    if (price == null) return;

    const last = klines[klines.length - 1];
    // 过期/乱序 tick 过滤：重连回放或旧成交的时间戳早于当前根/晚于上一笔有效成交时丢弃，
    // 既不撑高也不撑低，避免“假针”。不影响秒级实时 —— 当前根的实时撑高撑低照旧。
    const ts = pendingTickTsRef.current;
    if (ts != null && ts > 0) {
      if (ts < lastTradeTsRef.current || ts < last.time) {
        pendingTickRef.current = null;
        pendingTickTsRef.current = null;
        return;
      }
      lastTradeTsRef.current = ts;
    }
    last.close = price;
    if (price > last.high) last.high = price;
    if (price < last.low) last.low = price;

    candleSeries.current.update({
      time: last.time as Time,
      open: last.open, high: last.high, low: last.low, close: last.close,
    });
    // 图例跟随实时价（50ms 节流内更新，开销可忽略）
    setLegend(legendOf(last.open, last.high, last.low, last.close));

    // 分型/背离标记实时刷新（300ms 节流）：尾部未确认分型预览随 tick 即时呈现/消失，
    // 重算 300 根K线的分型+MACD 开销可忽略；确认区标记不随盘中波动变化，无抖动。
    const nowMs = performance.now();
    if (nowMs - lastMarkerDrawAtRef.current > 300) {
      lastMarkerDrawAtRef.current = nowMs;
      drawFractalDivergMarkers(klines);
    }
  }, [legendOf, drawFractalDivergMarkers]);

  const updateTick = useCallback((price: number, ts?: number) => {
    // 乱序保护：较旧的成交不清空已在等待刷新里的更新报价（避免旧 tick 覆盖新 tick）
    const prevTs = pendingTickTsRef.current;
    if (ts != null && ts > 0 && prevTs != null && ts < prevTs) return;
    pendingTickRef.current = price;
    if (ts != null && ts > 0) pendingTickTsRef.current = ts;
    const now = performance.now();
    if (now - lastTickAtRef.current > 50) {
      lastTickAtRef.current = now;
      if (rAFRef.current) cancelAnimationFrame(rAFRef.current);
      rAFRef.current = requestAnimationFrame(flushTick);
    } else if (!rAFRef.current) {
      rAFRef.current = requestAnimationFrame(() => {
        lastTickAtRef.current = performance.now();
        flushTick();
      });
    }
  }, [flushTick]);

  // 实时更新最后一根K线（kline 消息用）
  const updateLastKline = useCallback((kline: KlineData, isFinal: boolean) => {
    if (!candleSeries.current || !volumeSeries.current) return;
    const klines = allKlinesRef.current;
    if (klines.length === 0) return;
    // 数据串扰守卫：切换周期/币种且新数据尚未装载完成时，跳过 K 线消息（写旧数组会造成混图）
    if (loadedDataKeyRef.current !== dataKeyRef.current) return;

    const last = klines[klines.length - 1];
    if (kline.time === last.time) {
      klines[klines.length - 1] = kline;
      candleSeries.current.update({
        time: kline.time as Time,
        open: kline.open, high: kline.high, low: kline.low, close: kline.close,
      });
      volumeSeries.current.update({
        time: kline.time as Time,
        value: kline.volume,
        color: kline.close >= kline.open ? 'rgba(14, 203, 129, 0.45)' : 'rgba(246, 70, 93, 0.45)',
      });
    } else if (kline.time > last.time) {
      klines.push(kline);
      candleSeries.current.update({
        time: kline.time as Time,
        open: kline.open, high: kline.high, low: kline.low, close: kline.close,
      });
      volumeSeries.current.update({
        time: kline.time as Time,
        value: kline.volume,
        color: kline.close >= kline.open ? 'rgba(14, 203, 129, 0.45)' : 'rgba(246, 70, 93, 0.45)',
      });
    }
    // 图例跟随最新K线（新开的一根或盘中波动）
    setLegend(legendOf(kline.open, kline.high, kline.low, kline.close));

    // 判断“最新一根K线是否轮换”：
    //  - 若 time 变了，说明一根新的K线已开始，前一根必然已收盘（即使缺失 isFinal 消息）
    //  - 若 time 相同但 isFinal=true，说明当前这根正好收盘确认
    // 满足任一条件都代表“已有新的确认K线出现”，此时才值得重算缠论/九转（仍是收盘粒度，不做逐tick预览）
    const barSwitched = kline.time !== lastBarTimeRef.current;
    if (isFinal || barSwitched) {
      lastBarTimeRef.current = kline.time;
      updateIndicators();
      // K线收盘后重算 AB9 画线：新分形确认、突破换段都能及时反映
      redrawOverlayLines();
      // K线收盘后重算分型/背离标记（新分形确认 / 窗口滑动后及时更新）
      drawFractalDivergMarkers(klines);
      // K线收盘后重算九转序列
      if (indicators.NINE) {
        nineTurnDataRef.current = calcNineTurn(klines);
      }
    }
    // 九转/缠论 canvas 只在“已有确认K线”时重绘（避免盘中每次tick都重绘浪费性能）
    if (isFinal || barSwitched) {
      try { drawNineTurnRef.current(); } catch (e) { console.warn('[NineTurn] update error:', e); }
      try { drawChanRef.current(); } catch (e) { console.warn('[Chan] update error:', e); }
    }
  }, [updateIndicators, redrawOverlayLines, legendOf, drawFractalDivergMarkers, indicators.NINE, indicators.CHAN]);

  // 获取K线 — 用 ref 引用最新的 updateChart，避免指标切换导致重新拉取K线和重连WS
  const updateChartRef = useRef(updateChart);
  updateChartRef.current = updateChart;
  const updateLastKlineRef = useRef(updateLastKline);
  updateLastKlineRef.current = updateLastKline;

  const loadKlines = useCallback(async (intv: string) => {
    // 切换周期不显示 loading 骨架屏 —— 新数据直接覆盖旧图，保持视觉连贯
    // 仅初始加载（K线为空）才显示 loading，避免切换时图表闪烁
    const isInitial = allKlinesRef.current.length === 0;
    if (isInitial) setLoading(true);
    setError(null);
    try {
      // 300 根：OKX 直连上限（Binance/代理均支持更多），大级别波段的 A 点更不容易落在窗口外
      const klines = await fetchKlinesApi(symbol, okxId, intv, 300);
      updateChartRef.current(klines, intv);
      // 装载完成后打上数据签名：此后新内存/周期的实时 tick 才允许应用到图表
      loadedDataKeyRef.current = `${symbol}|${intv}`;
    } catch (err: any) {
      setError(err.message || '获取K线数据失败');
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [symbol, okxId]);

  // 初始化图表
  useEffect(() => {
    if (!mainChartRef.current || !macdChartRef.current) return;

    // 主图（视觉统一：Binance 色系、点状极淡网格、统一字体、右侧留白）
    const chart = createChart(mainChartRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#848e9c',
        fontSize: 11,
        fontFamily: CHART_FONT,
      },
      grid: {
        vertLines: { color: GRID_COLOR, style: LineStyle.Dotted },
        horzLines: { color: GRID_COLOR, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
        horzLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
      },
      timeScale: {
        borderColor: AXIS_BORDER,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        minBarSpacing: 1.2,
      },
      rightPriceScale: {
        borderColor: AXIS_BORDER,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    });

    const candle = chart.addCandlestickSeries({
      upColor: CANDLE_UP, downColor: CANDLE_DOWN,
      borderUpColor: CANDLE_UP, borderDownColor: CANDLE_DOWN,
      wickUpColor: CANDLE_UP, wickDownColor: CANDLE_DOWN,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(132, 142, 156, 0.55)',
      priceLineWidth: 1,
      priceLineStyle: LineStyle.Dotted,
    });

    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    // 十字线联动左上角 OHLC 图例（离开图表回落到最新一根）
    chart.subscribeCrosshairMove((param) => {
      if (!param || param.time == null) {
        const ks = allKlinesRef.current;
        if (ks.length) {
          const k = ks[ks.length - 1];
          setLegend(legendOf(k.open, k.high, k.low, k.close));
        }
        return;
      }
      const d = param.seriesData.get(candle) as CandlestickData | undefined;
      if (d) setLegend(legendOf(d.open, d.high, d.low, d.close));
    });

    // MACD 副图（时间轴隐藏：时间刻度统一由主图呈现，不再三排重复；配色与主图同主题）
    const mChart = createChart(macdChartRef.current, {
      layout: { background: { color: 'transparent' }, textColor: '#848e9c', fontSize: 10, fontFamily: CHART_FONT },
      grid: {
        vertLines: { color: GRID_COLOR, style: LineStyle.Dotted },
        horzLines: { color: GRID_COLOR_FAINT, style: LineStyle.Dotted },
      },
      timeScale: { visible: false, borderColor: AXIS_BORDER, timeVisible: true },
      rightPriceScale: { borderColor: AXIS_BORDER },
      crosshair: {
        vertLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
        horzLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
      },
    });

    const hist = mChart.addHistogramSeries({ priceFormat: { type: 'price', precision: 4 } });
    const dif = mChart.addLineSeries({ color: '#60a5fa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const dea = mChart.addLineSeries({ color: '#fbbf24', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    // RSI 副图
    let rChart: IChartApi | null = null;
    let rLine: ISeriesApi<'Line'> | null = null;
    let rOver: ISeriesApi<'Line'> | null = null;
    let rUnder: ISeriesApi<'Line'> | null = null;
    if (rsiChartRef.current) {
      rChart = createChart(rsiChartRef.current, {
        layout: { background: { color: 'transparent' }, textColor: '#848e9c', fontSize: 10, fontFamily: CHART_FONT },
        grid: {
          vertLines: { color: GRID_COLOR, style: LineStyle.Dotted },
          horzLines: { color: GRID_COLOR_FAINT, style: LineStyle.Dotted },
        },
        timeScale: { visible: false, borderColor: AXIS_BORDER, timeVisible: true },
        rightPriceScale: { borderColor: AXIS_BORDER, autoScale: true },
        crosshair: {
          vertLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
          horzLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
        },
      });
      rLine = rChart.addLineSeries({
        color: '#f97316',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      rOver = rChart.addLineSeries({
        color: 'rgba(239, 68, 68, 0.3)',
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      rUnder = rChart.addLineSeries({
        color: 'rgba(34, 197, 94, 0.3)',
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    }

    // KDJ 副图
    let kChart: IChartApi | null = null;
    let kK: ISeriesApi<'Line'> | null = null;
    let kD: ISeriesApi<'Line'> | null = null;
    let kJ: ISeriesApi<'Line'> | null = null;
    let kOver: ISeriesApi<'Line'> | null = null;
    let kUnder: ISeriesApi<'Line'> | null = null;
    if (kdjChartRef.current) {
      kChart = createChart(kdjChartRef.current, {
        layout: { background: { color: 'transparent' }, textColor: '#848e9c', fontSize: 10, fontFamily: CHART_FONT },
        grid: {
          vertLines: { color: GRID_COLOR, style: LineStyle.Dotted },
          horzLines: { color: GRID_COLOR_FAINT, style: LineStyle.Dotted },
        },
        timeScale: { visible: false, borderColor: AXIS_BORDER, timeVisible: true },
        rightPriceScale: { borderColor: AXIS_BORDER, autoScale: true },
        crosshair: {
          vertLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
          horzLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
        },
      });
      kK = kChart.addLineSeries({
        color: '#fbbf24',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      kD = kChart.addLineSeries({
        color: '#60a5fa',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      kJ = kChart.addLineSeries({
        color: '#f472b6',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      kOver = kChart.addLineSeries({
        color: 'rgba(239, 68, 68, 0.3)',
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      kUnder = kChart.addLineSeries({
        color: 'rgba(34, 197, 94, 0.3)',
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    }

    // ATR 副图
    let aChart: IChartApi | null = null;
    let aLine: ISeriesApi<'Line'> | null = null;
    if (atrChartRef.current) {
      aChart = createChart(atrChartRef.current, {
        layout: { background: { color: 'transparent' }, textColor: '#848e9c', fontSize: 10, fontFamily: CHART_FONT },
        grid: {
          vertLines: { color: GRID_COLOR, style: LineStyle.Dotted },
          horzLines: { color: GRID_COLOR_FAINT, style: LineStyle.Dotted },
        },
        timeScale: { visible: false, borderColor: AXIS_BORDER, timeVisible: true },
        rightPriceScale: { borderColor: AXIS_BORDER, autoScale: true },
        crosshair: {
          vertLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
          horzLine: { color: CROSSHAIR_COLOR, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CROSSHAIR_LABEL_BG },
        },
      });
      aLine = aChart.addLineSeries({
        color: '#a855f7',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
    }

    // ========== 神奇九转数字绘制 ==========
    const drawNineTurnNumbers = () => {
      try {
      const canvas = nineTurnCanvasRef.current;
      const chartAPI = mainChart.current;
      const nineData = nineTurnDataRef.current;
      const klines = allKlinesRef.current;
      if (!canvas || !chartAPI || !candleSeries.current) return;
      if (klines.length === 0) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // 确保 canvas 尺寸与图表容器一致
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // 先清空画布——即使九转已关闭或数据为空，也要清除残留的旧绘制
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 没有九转数据时，清空后直接返回
      if (!nineData || nineData.length === 0) return;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.font = 'bold 11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const timeScale = chartAPI.timeScale();
      const visibleRange = timeScale.getVisibleLogicalRange();
      if (!visibleRange) { ctx.restore(); return; }

      const from = Math.max(0, Math.floor(visibleRange.from));
      const to = Math.min(klines.length - 1, Math.ceil(visibleRange.to));

      for (let i = from; i <= to; i++) {
        const val = nineData[i];
        if (!val || val.value === 0 || val.value === undefined || val.value === null) continue;

        const time = klines[i].time as Time;
        const x = timeScale.timeToCoordinate(time);
        if (x === null || x === undefined) continue;

        const isBuy = val.value > 0;  // 正数=底部九转（K线下方显示）
        const num = Math.abs(val.value);
        const isNine = num === 9;

        // 计算Y坐标：底部九转显示在K线最低点下方，顶部九转显示在K线最高点上方
        const low = klines[i].low;
        const high = klines[i].high;
        // 使用 candleSeries 进行价格-坐标转换（IPriceScaleApi 在 v4 上没有 priceToCoordinate）
        const lowY = candleSeries.current?.priceToCoordinate(low);
        const highY = candleSeries.current?.priceToCoordinate(high);
        if (lowY === null || highY === null || lowY === undefined || highY === undefined) continue;

        let y: number;
        if (isBuy) {
          y = lowY + 14;  // K线最低点下方
        } else {
          y = highY - 14; // K线最高点上方
        }

        // 虚拟币国际惯例（与Binance K线色系一致）：绿色=买入/做多，红色=卖出/做空
        if (isNine && isBuy) {
          ctx.fillStyle = '#10b981'; // 绿色=底部九转=买入/做多信号
          ctx.font = 'bold 12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        } else if (isNine && !isBuy) {
          ctx.fillStyle = '#ef4444'; // 红色=顶部九转=卖出/做空信号
          ctx.font = 'bold 12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        } else if (isBuy) {
          ctx.fillStyle = 'rgba(16, 185, 129, 0.6)';
          ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        } else {
          ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
          ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        }

        ctx.fillText(String(num), x, y);
      }

      ctx.restore();
      } catch (e) {
        // 静默失败，避免九转渲染异常导致整个图表崩溃
        console.warn('[NineTurn] render error:', e);
      }
    };
    // 暴露给外部调用（updateChart 后重绘）
    drawNineTurnRef.current = drawNineTurnNumbers;

    // ========== 缠论（分型/笔/中枢）绘制 ==========
    const drawChan = () => {
      try {
        const canvas = chanCanvasRef.current;
        const chartAPI = mainChart.current;
        const chanData = chanDataRef.current;
        if (!canvas || !chartAPI) return;
        if (!candleSeries.current) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
          canvas.width = Math.floor(rect.width * dpr);
          canvas.height = Math.floor(rect.height * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // 先清空画布——即使所有叠层都已关闭，也要清除残留的旧绘制
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 没有任何叠层数据时，清空后直接返回
        if (!chanData && !trendChannelRef.current && !valueAreaRef.current && !ichimokuRef.current && !synthRef.current && !showGannRef.current && !showAutoAB9Ref.current) return;

        ctx.save();
        ctx.scale(dpr, dpr);

        const timeScale = chartAPI.timeScale();

        // ========== 时间→X坐标解析器（关键修复） ==========
        // lightweight-charts 的 timeToCoordinate 只认数据里真实存在的时间，
        // 通道/音叉的右端点延伸到了未来（最后一根K线之后，数据里没有这个时间），
        // 直接转换会返回 null，导致整块指标被非空校验拦截、静默不绘制。
        // 这里对未来时间用最后两根K线的实际像素间距外推。
        const ksForX = allKlinesRef.current;
        const timeToX = (t: number): number | null => {
          const x = timeScale.timeToCoordinate(t as Time);
          if (x !== null) return x;
          // 未命中数据时间：外推
          if (ksForX.length < 2) return null;
          const lastK = ksForX[ksForX.length - 1];
          const prevK = ksForX[ksForX.length - 2];
          const interval = lastK.time - prevK.time;
          if (interval <= 0) return null;

          // 未来时间外推（通道/音叉右端点延伸到最后一根K线之后）
          if (t > lastK.time) {
            const xLast = timeScale.timeToCoordinate(lastK.time as Time);
            const xPrev = timeScale.timeToCoordinate(prevK.time as Time);
            if (xLast === null || xPrev === null) return null;
            const spacing = xLast - xPrev;
            if (spacing === 0) return null;
            const barsAhead = (t - lastK.time) / interval;
            return xLast + barsAhead * spacing;
          }

          // 过去时间外推（音叉 A 点可能滚动到视野左侧之外）
          const firstK = ksForX[0];
          if (t < firstK.time) {
            const secondK = ksForX[1];
            const xFirst = timeScale.timeToCoordinate(firstK.time as Time);
            const xSecond = timeScale.timeToCoordinate(secondK.time as Time);
            if (xFirst === null || xSecond === null) return null;
            const spacing = xSecond - xFirst;
            if (spacing === 0) return null;
            const barsBehind = (firstK.time - t) / interval;
            return xFirst - barsBehind * spacing;
          }

          return null;
        };

        // 缠论绘制（仅当有缠论数据时）
        if (chanData) {

        // 1. 画中枢（半透明矩形）
        for (const zs of chanData.zhongshus) {
          const x1 = timeScale.timeToCoordinate(zs.startTime as Time);
          const x2 = timeScale.timeToCoordinate(zs.endTime as Time);
          const yHigh = candleSeries.current.priceToCoordinate(zs.high);
          const yLow = candleSeries.current.priceToCoordinate(zs.low);
          if (x1 === null || x2 === null || yHigh === null || yLow === null) continue;
          const x = Math.min(x1, x2);
          const w = Math.abs(x2 - x1);
          const y = Math.min(yHigh, yLow);
          const h = Math.abs(yLow - yHigh);
          // 矩形背景
          ctx.fillStyle = 'rgba(100, 181, 246, 0.08)';
          ctx.fillRect(x, y, w, h);
          // 边框
          ctx.strokeStyle = 'rgba(100, 181, 246, 0.5)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x, y, w, h);
          ctx.setLineDash([]);
          // 标签
          ctx.fillStyle = 'rgba(100, 181, 246, 0.6)';
          ctx.font = '10px -apple-system, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(
            zs.level > 1
              ? `中枢L${zs.level}(${zs.biCount}笔${zs.isExtended ? '·延伸' : ''})`
              : `中枢(${zs.biCount}笔${zs.isExtended ? '·延伸' : ''})`,
            x + 4, y + 2
          );
        }

        // 2. 画笔（折线）
        ctx.lineWidth = 1.5;
        for (const bi of chanData.bis) {
          const x1 = timeScale.timeToCoordinate(bi.startTime as Time);
          const x2 = timeScale.timeToCoordinate(bi.endTime as Time);
          const y1 = candleSeries.current.priceToCoordinate(bi.startPrice);
          const y2 = candleSeries.current.priceToCoordinate(bi.endPrice);
          if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
          // 上升笔绿色，下降笔红色
          ctx.strokeStyle = bi.direction === 'up' ? 'rgba(34, 197, 94, 0.9)' : 'rgba(248, 113, 113, 0.9)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }

        // 3. 画分型标记（小圆点）
        for (const f of chanData.fractals) {
          const x = timeScale.timeToCoordinate(f.time as Time);
          const y = candleSeries.current.priceToCoordinate(f.price);
          if (x === null || y === null) continue;
          ctx.fillStyle = f.type === 'top' ? 'rgba(248, 113, 113, 0.9)' : 'rgba(34, 197, 94, 0.9)';
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // 4. 画买卖点信号（三类买卖点标注）
        for (const sig of chanData.signals) {
          const x = timeScale.timeToCoordinate(sig.time as Time);
          const y = candleSeries.current.priceToCoordinate(sig.price);
          if (x === null || y === null) continue;
          const isBuy = sig.type.includes('Buy');
          const color = isBuy ? 'rgba(34, 197, 94, 1)' : 'rgba(248, 113, 113, 1)';
          const bgColor = isBuy ? 'rgba(34, 197, 94, 0.2)' : 'rgba(248, 113, 113, 0.2)';
          const label = sig.type === 'firstBuy' ? '1B' : sig.type === 'secondBuy' ? '2B' : sig.type === 'thirdBuy' ? '3B'
            : sig.type === 'firstSell' ? '1S' : sig.type === 'secondSell' ? '2S' : '3S';
          // 背景圆
          ctx.fillStyle = bgColor;
          ctx.beginPath();
          ctx.arc(x, y, 12, 0, Math.PI * 2);
          ctx.fill();
          // 边框圆
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, 12, 0, Math.PI * 2);
          ctx.stroke();
          // 文字
          ctx.fillStyle = color;
          ctx.font = 'bold 11px -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, x, y);
        }

        // 5. 画预警投射线（提前预测画线）
        for (const proj of chanData.projections) {
          const x1 = timeScale.timeToCoordinate(proj.time as Time);
          const x2 = timeScale.timeToCoordinate(proj.endTime as Time);
          const y = candleSeries.current.priceToCoordinate(proj.price);
          if (y === null) continue;
          const startX = x1 !== null ? x1 : 0;
          const endX = x2 !== null ? x2 : rect.width;

          if (proj.type === 'zsBreakoutUp' || proj.type === 'zsBreakoutDown') {
            // 中枢上下沿突破投射线：虚线水平延伸
            const isUp = proj.type === 'zsBreakoutUp';
            const baseColor = isUp ? 'rgba(248, 113, 113, ' : 'rgba(34, 197, 94, ';
            const alpha = proj.isNear ? '1' : '0.65';
            ctx.strokeStyle = baseColor + alpha + ')';
            ctx.lineWidth = proj.isNear ? 2.5 : 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
            ctx.setLineDash([]);
            // 标签
            ctx.fillStyle = baseColor + (proj.isNear ? '1' : '0.6') + ')';
            ctx.font = proj.isNear ? 'bold 10px -apple-system, sans-serif' : '10px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(proj.label, endX - 50, y - 8);
            // 接近时闪烁圆点
            if (proj.isNear) {
              ctx.fillStyle = baseColor + '0.3)';
              ctx.beginPath();
              ctx.arc(endX - 55, y, 5, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = baseColor + '1)';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(endX - 55, y, 5, 0, Math.PI * 2);
              ctx.stroke();
            }
          } else if (proj.type === 'potentialBuy' || proj.type === 'potentialSell') {
            // 潜在买卖点预标：半透明圆 + 标签
            const isBuy = proj.type === 'potentialBuy';
            const color = isBuy ? 'rgba(34, 197, 94, ' : 'rgba(248, 113, 113, ';
            const x = timeScale.timeToCoordinate(proj.time as Time);
            if (x === null) continue;
            // 虚线连接到价格位
            ctx.strokeStyle = color + '0.4)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
            ctx.setLineDash([]);
            // 预标圆
            ctx.fillStyle = color + '0.15)';
            ctx.beginPath();
            ctx.arc(x, y, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = color + '0.8)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.arc(x, y, 10, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            // 标签
            ctx.fillStyle = color + '0.9)';
            ctx.font = 'bold 9px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(proj.label, x, y);
          } else if (proj.type === 'pendingFractal') {
            // 未完成分型预警：菱形标记 + 确认价位线
            const x = timeScale.timeToCoordinate(proj.time as Time);
            if (x === null) continue;
            const isTop = proj.label.includes('顶');
            const color = isTop ? 'rgba(248, 113, 113, ' : 'rgba(34, 197, 94, ';
            // 菱形
            ctx.fillStyle = color + '0.3)';
            ctx.beginPath();
            ctx.moveTo(x, y - 6);
            ctx.lineTo(x + 6, y);
            ctx.lineTo(x, y + 6);
            ctx.lineTo(x - 6, y);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = color + '0.7)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([2, 2]);
            ctx.stroke();
            ctx.setLineDash([]);
            // 标签
            ctx.fillStyle = color + '0.8)';
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(proj.label, x + 8, y);
          } else if (proj.type === 'biExtension') {
            // 笔延长投射：虚线箭头
            const x1Coord = timeScale.timeToCoordinate(proj.time as Time);
            if (x1Coord === null) continue;
            ctx.strokeStyle = 'rgba(168, 85, 247, 0.7)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x1Coord, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
            ctx.setLineDash([]);
            // 标签
            ctx.fillStyle = 'rgba(168, 85, 247, 0.7)';
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(proj.label, endX - 40, y - 8);
          }
        }

        } // end of chanData

        // ========== 趋势通道绘制 ==========
        const tc = trendChannelRef.current;
        if (tc) {
          const xUpperStart = timeToX(tc.upperStart.time);
          const xUpperEnd = timeToX(tc.upperEnd.time);
          const xLowerStart = timeToX(tc.lowerStart.time);
          const xLowerEnd = timeToX(tc.lowerEnd.time);
          const yUpperStart = candleSeries.current?.priceToCoordinate(tc.upperStart.price);
          const yUpperEnd = candleSeries.current?.priceToCoordinate(tc.upperEnd.price);
          const yLowerStart = candleSeries.current?.priceToCoordinate(tc.lowerStart.price);
          const yLowerEnd = candleSeries.current?.priceToCoordinate(tc.lowerEnd.price);
          const yMidStart = candleSeries.current?.priceToCoordinate(tc.midStart.price);
          const yMidEnd = candleSeries.current?.priceToCoordinate(tc.midEnd.price);

          if (xUpperStart !== null && xUpperEnd !== null && xLowerStart !== null && xLowerEnd !== null
            && yUpperStart !== null && yUpperEnd !== null && yLowerStart !== null && yLowerEnd !== null
            && yMidStart !== null && yMidEnd !== null) {

            const chanColor = tc.direction === 'up' ? 'rgba(34, 197, 94,' : tc.direction === 'down' ? 'rgba(246, 70, 93,' : 'rgba(148, 163, 184,';

            // 通道填充（淡）
            ctx.fillStyle = chanColor + '0.08)';
            ctx.beginPath();
            ctx.moveTo(xUpperStart, yUpperStart);
            ctx.lineTo(xUpperEnd, yUpperEnd);
            ctx.lineTo(xLowerEnd, yLowerEnd);
            ctx.lineTo(xLowerStart, yLowerStart);
            ctx.closePath();
            ctx.fill();

            // 上轨
            ctx.strokeStyle = chanColor + '0.7)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(xUpperStart, yUpperStart);
            ctx.lineTo(xUpperEnd, yUpperEnd);
            ctx.stroke();

            // 中轨
            ctx.strokeStyle = chanColor + '0.4)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 4]);
            ctx.beginPath();
            ctx.moveTo(xLowerStart, yMidStart);
            ctx.lineTo(xLowerEnd, yMidEnd);
            ctx.stroke();

            // 下轨
            ctx.strokeStyle = chanColor + '0.7)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(xLowerStart, yLowerStart);
            ctx.lineTo(xLowerEnd, yLowerEnd);
            ctx.stroke();
            ctx.setLineDash([]);

            // 标签
            const labelX = xUpperEnd - 2;
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = chanColor + '0.6)';
            ctx.fillText(`通道上轨 ${tc.upperTouches}触`, labelX, yUpperEnd - 2);
            ctx.textBaseline = 'top';
            ctx.fillText(`通道下轨 ${tc.lowerTouches}触`, labelX, yLowerEnd + 2);
          }
        }

        // ========== 价值区域（VAH / POC / VAL）绘制 ==========
        const va = valueAreaRef.current;
        if (va) {
          const toYva = (p: number) => candleSeries.current?.priceToCoordinate(p) ?? null;
          const yVah = toYva(va.vah);
          const yPoc = toYva(va.poc);
          const yVal = toYva(va.val);
          if (yVah !== null && yPoc !== null && yVal !== null) {
            // 左边界：从带开盘（窗口起点），右边界：延伸到最右端
            const xStart = timeToX(va.windowStart);
            const xStartSafe = xStart !== null ? xStart : 0;
            const xEndSafe = rect.width;

            // 价值区淡色填充带（VAH 与 VAL 之间）
            ctx.fillStyle = 'rgba(56, 189, 248, 0.07)';
            ctx.fillRect(xStartSafe, yVah, xEndSafe - xStartSafe, yVal - yVah);

            // VAH 上轨（虚线）
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(xStartSafe, yVah);
            ctx.lineTo(xEndSafe, yVah);
            ctx.stroke();

            // VAL 下轨（虚线）
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
            ctx.beginPath();
            ctx.moveTo(xStartSafe, yVal);
            ctx.lineTo(xEndSafe, yVal);
            ctx.stroke();
            ctx.setLineDash([]);

            // POC 实线（最显眼）
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(xStartSafe, yPoc);
            ctx.lineTo(xEndSafe, yPoc);
            ctx.stroke();

            // 右侧成交量密度剖面（直方图，按 POC 归一化）
            const histW = Math.min(70, rect.width * 0.08);
            const histX = xEndSafe - histW - 2;
            for (const bar of va.profile) {
              const yBar = candleSeries.current.priceToCoordinate(bar.price);
              if (yBar === null) continue;
              const binHalfH = yVah - yVal > 0
                ? Math.max((yVah - yVal) / (va.profile.length) * 0.9, 1)
                : 1;
              const bw = Math.max(histW * bar.volume, 2);
              // 价值区内的桶稍亮，价值区外更淡
              const inside = bar.price >= va.val && bar.price <= va.vah;
              ctx.fillStyle = 'rgba(56, 189, 248, ' + (inside ? 0.45 : 0.18) + ')';
              ctx.fillRect(histX + (histW - bw), yBar - binHalfH / 2, bw, binHalfH);
            }

            // 标签
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
            ctx.fillText(`VAH ${va.vah.toFixed(2)}`, xStartSafe + 4, yVah - 2);
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(56, 189, 248, 1)';
            ctx.fillText(`POC ${va.poc.toFixed(2)}`, xStartSafe + 4, yPoc + 2);
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
            ctx.fillText(`VAL ${va.val.toFixed(2)}`, xStartSafe + 4, yVal + 3);

            // 右上角概要
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(56, 189, 248, 0.6)';
            ctx.fillText(
              `价值区 ${(va.targetRatio * 100).toFixed(0)}% · ${va.lookback}K`,
              rect.width - 4, 2
            );
            ctx.textAlign = 'left';
          }
        }

        // ========== 一目均衡表（Ichimoku Cloud）绘制 ==========
        const icm = ichimokuRef.current;
        if (icm) {
          const pt = (t: number, p: number): { x: number; y: number } | null => {
            const x = timeToX(t);
            const y = candleSeries.current?.priceToCoordinate(p) ?? null;
            if (x === null || y === null) return null;
            return { x, y };
          };

          // 1. 云带（先行区间，含外推未来）：top 与 bottom 之间的填充
          const cloudPt: { x: number; yT: number; yB: number }[] = [];
          for (const c of icm.cloud) {
            const pT = pt(c.time, c.top);
            const pB = pt(c.time, c.bottom);
            if (!pT || !pB) continue;
            cloudPt.push({ x: pT.x, yT: pT.y, yB: pB.y });
          }
          if (cloudPt.length > 1) {
            ctx.beginPath();
            ctx.moveTo(cloudPt[0].x, cloudPt[0].yT);
            for (let i = 1; i < cloudPt.length; i++) ctx.lineTo(cloudPt[i].x, cloudPt[i].yT);
            for (let i = cloudPt.length - 1; i >= 0; i--) ctx.lineTo(cloudPt[i].x, cloudPt[i].yB);
            ctx.closePath();
            ctx.fillStyle = 'rgba(76, 110, 245, 0.14)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(120, 144, 255, 0.35)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          // 2. 转换线 tenkan（快，暖色）+ 基准线 kijun（慢，青色）
          const drawPoly = (
            arr: { time: number; price: number }[],
            color: string,
            width: number,
            dash: number[] = [],
          ) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.setLineDash(dash);
            ctx.beginPath();
            let started = false;
            for (const p of arr) {
              const c = pt(p.time, p.price);
              if (!c) continue;
              if (!started) { ctx.moveTo(c.x, c.y); started = true; }
              else ctx.lineTo(c.x, c.y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
          };
          drawPoly(icm.tenkan, 'rgba(249, 115, 22, 0.75)', 1.3);
          drawPoly(icm.kijun, 'rgba(34, 211, 238, 0.85)', 1.5);
          // 3. 迟行线 chikou（最淡）
          drawPoly(icm.chikou, 'rgba(240, 240, 240, 0.4)', 1, [2, 3]);
        }

        // ========== 预测信号合成器（方向 + 置信度 + 目标 + 拐点）绘制 ==========
        const synth = synthRef.current;
        if (synth) {
          const toY = (p: number) => candleSeries.current?.priceToCoordinate(p) ?? null;
          const toX = (t: number) => timeToX(t);

          // 1. 快周期超趋势线（按方向着色）
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          let stStarted = false;
          let lastC: { x: number; y: number } | null = null;
          for (const p of synth.supertrendFast.line) {
            const x = toX(p.time);
            const y = toY(p.price);
            if (x === null || y === null) { lastC = null; continue; }
            ctx.strokeStyle = p.state === 'up' ? 'rgba(14, 203, 129, 0.85)' : 'rgba(246, 70, 93, 0.85)';
            if (stStarted && lastC) {
              ctx.beginPath();
              ctx.moveTo(lastC.x, lastC.y);
              ctx.lineTo(x, y);
              ctx.stroke();
            }
            lastC = { x, y };
            stStarted = true;
          }

          // 2. 翻转点标记（小圆圈）
          for (const f of synth.supertrendFast.flips) {
            const x = toX(f.time);
            const y = toY(f.price);
            if (x === null || y === null) continue;
            ctx.fillStyle = f.direction === 'up' ? 'rgba(14, 203, 129, 1)' : 'rgba(246, 70, 93, 1)';
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
          }

          // 3. ATR 目标区：上下目标水平虚线 + 概率标注（只画到右端）
          if (synth.atrTarget && synth.atrTarget.atr > 0) {
            const tgt = synth.atrTarget;
            const baseY = toY(tgt.price);
            if (baseY !== null) {
              const lineX = Math.min(toX(tgt.price) ?? rect.width, rect.width);
              // 上方目标
              for (const u of tgt.upTargets) {
                const y = toY(u.price);
                if (y === null) continue;
                ctx.strokeStyle = `rgba(14, 203, 129, ${0.25 + u.mult * 0.2})`;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 5]);
                ctx.beginPath();
                ctx.moveTo(lineX - 30, y);
                ctx.lineTo(rect.width, y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.font = '8px -apple-system, sans-serif';
                ctx.fillStyle = 'rgba(14, 203, 129, 0.95)';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                ctx.fillText(`+${(u.mult).toFixed(1)}A ${u.price.toFixed(2)} (${u.prob}%)`, rect.width - 3, y - 1);
              }
              // 下方目标
              for (const d of tgt.downTargets) {
                const y = toY(d.price);
                if (y === null) continue;
                ctx.strokeStyle = `rgba(246, 70, 93, ${0.25 + d.mult * 0.2})`;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 5]);
                ctx.beginPath();
                ctx.moveTo(lineX - 30, y);
                ctx.lineTo(rect.width, y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.font = '8px -apple-system, sans-serif';
                ctx.fillStyle = 'rgba(246, 70, 93, 0.95)';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'top';
                ctx.fillText(`-${(d.mult).toFixed(1)}A ${d.price.toFixed(2)} (${d.prob}%)`, rect.width - 3, y + 1);
              }
            }
          }

          // 4. RSI 背离标记（拐点预警）
          for (const d of synth.divergences) {
            const x = toX(d.time);
            const y = toY(d.price);
            if (x === null || y === null) continue;
            const bullish = d.type === 'bullish';
            const color = bullish ? 'rgba(14, 203, 129, 1)' : 'rgba(246, 70, 93, 1)';
            ctx.fillStyle = color + '';
            ctx.beginPath();
            if (bullish) {
              // 底部背离：向上的提示
              ctx.moveTo(x, y - 8);
              ctx.lineTo(x - 6, y);
              ctx.lineTo(x + 6, y);
              ctx.closePath();
            } else {
              ctx.moveTo(x, y + 8);
              ctx.lineTo(x - 6, y);
              ctx.lineTo(x + 6, y);
              ctx.closePath();
            }
            ctx.fill();
            ctx.font = 'bold 8px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = bullish ? 'bottom' : 'top';
            ctx.fillText(bullish ? '底背离' : '顶背离', x, bullish ? y - 8 : y + 10);
          }

          // 5. 顶部置信度横幅（方向 + 置信度 + 主信号）
          const dirColor =
            synth.direction === 'up' ? 'rgba(14, 203, 129, ' :
            synth.direction === 'down' ? 'rgba(246, 70, 93, ' : 'rgba(148, 163, 184, ';
          const dirText = synth.direction === 'up' ? '偏多' : synth.direction === 'down' ? '偏空' : '震荡';
          const bannerW = 168;
          const bannerH = 24 + synth.signals.length * 13;
          const bx = 64;
          const by = 4;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
          ctx.beginPath();
          ctx.roundRect(bx, by, bannerW, bannerH, 6);
          ctx.fill();
          ctx.strokeStyle = dirColor + '0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();
          // 方向 + 置信度
          ctx.font = 'bold 11px -apple-system, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillStyle = dirColor + '1)';
          ctx.fillText(`预测 ${dirText} · 置信${synth.confidence}`, bx + 8, by + 6);
          // 信号文本
          ctx.font = '9px -apple-system, sans-serif';
          ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
          let ly = by + 22;
          for (const s of synth.signals.slice(0, 5)) {
            ctx.fillText(`· ${s.label} ${s.text}`, bx + 8, ly);
            ly += 12;
          }
        }

        // ========== 江恩工具箱（角度线/时间周期/时价四方/轮中轮/三分位）绘制 ==========
        if (showGannRef.current) {
          const ksG = allKlinesRef.current;
          const sigG = ksG.length > 0 ? `${ksG.length}:${ksG[ksG.length - 1].time}` : '';
          if (sigG !== gannSigRef.current) {
            gannSigRef.current = sigG;
            gannRef.current = calcGannAll(ksG);
          }
          const gr = gannRef.current;
          if (gr) {
            drawGannSuite(ctx, timeToX, (p) => candleSeries.current?.priceToCoordinate(p) ?? null, rect.width, rect.height, gr);
          }
        }

        ctx.restore();
      } catch (e) {
        console.warn('[Chan] render error:', e);
      }
    };
    drawChanRef.current = drawChan;

    // 主图和所有副图联动（平移/缩放时保持时间轴同步）
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) {
        mChart.timeScale().setVisibleLogicalRange(range);
        if (rChart) rChart.timeScale().setVisibleLogicalRange(range);
        if (kChart) kChart.timeScale().setVisibleLogicalRange(range);
        if (aChart) aChart.timeScale().setVisibleLogicalRange(range);
      }
      // 九转数字随视图滚动重绘
      try { drawNineTurnNumbers(); } catch (e) { console.warn('[NineTurn] scroll error:', e); }
      // 缠论随视图滚动重绘
      try { drawChan(); } catch (e) { console.warn('[Chan] scroll error:', e); }
    });

    mainChart.current = chart;
    macdChart.current = mChart;
    rsiChart.current = rChart;
    kdjChart.current = kChart;
    atrChart.current = aChart;
    candleSeries.current = candle;
    volumeSeries.current = volume;
    macdHist.current = hist;
    macdDif.current = dif;
    macdDea.current = dea;
    rsiLine.current = rLine;
    rsiOverbought.current = rOver;
    rsiOversold.current = rUnder;
    kdjKLine.current = kK;
    kdjDLine.current = kD;
    kdjJLine.current = kJ;
    kdjOverbought.current = kOver;
    kdjOversold.current = kUnder;
    atrLine.current = aLine;

    const handleResize = () => {
      if (mainChartRef.current && mainChart.current) {
        mainChart.current.applyOptions({
          width: mainChartRef.current.clientWidth,
          height: mainChartRef.current.clientHeight,
        });
      }
      if (macdChartRef.current && macdChart.current) {
        macdChart.current.applyOptions({
          width: macdChartRef.current.clientWidth,
          height: macdChartRef.current.clientHeight,
        });
      }
      if (rsiChartRef.current && rsiChart.current) {
        rsiChart.current.applyOptions({
          width: rsiChartRef.current.clientWidth,
          height: rsiChartRef.current.clientHeight,
        });
      }
      if (kdjChartRef.current && kdjChart.current) {
        kdjChart.current.applyOptions({
          width: kdjChartRef.current.clientWidth,
          height: kdjChartRef.current.clientHeight,
        });
      }
      if (atrChartRef.current && atrChart.current) {
        atrChart.current.applyOptions({
          width: atrChartRef.current.clientWidth,
          height: atrChartRef.current.clientHeight,
        });
      }
      // 九转数字随 resize 重绘
      try { drawNineTurnNumbers(); } catch (e) { console.warn('[NineTurn] resize error:', e); }
      // 缠论随 resize 重绘
      try { drawChan(); } catch (e) { console.warn('[Chan] resize error:', e); }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    // 容器尺寸变化时跟随重排（面板开合 / 侧栏 / 响应式回流不触发 window.resize，需 ResizeObserver）
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && mainChartRef.current) {
      ro = new ResizeObserver(() => handleResize());
      ro.observe(mainChartRef.current);
    }

    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', handleResize);
      chart.remove();
      mChart.remove();
      if (rChart) rChart.remove();
      if (kChart) kChart.remove();
      if (aChart) aChart.remove();
    };
  }, []);

  // 全屏切换时重新调整图表尺寸
  useEffect(() => {
    const timer = setTimeout(() => {
      if (mainChartRef.current && mainChart.current) {
        mainChart.current.applyOptions({
          width: mainChartRef.current.clientWidth,
          height: mainChartRef.current.clientHeight,
        });
      }
      if (macdChartRef.current && macdChart.current) {
        macdChart.current.applyOptions({
          width: macdChartRef.current.clientWidth,
          height: macdChartRef.current.clientHeight,
        });
      }
      if (rsiChartRef.current && rsiChart.current) {
        rsiChart.current.applyOptions({
          width: rsiChartRef.current.clientWidth,
          height: rsiChartRef.current.clientHeight,
        });
      }
      if (kdjChartRef.current && kdjChart.current) {
        kdjChart.current.applyOptions({
          width: kdjChartRef.current.clientWidth,
          height: kdjChartRef.current.clientHeight,
        });
      }
      if (atrChartRef.current && atrChart.current) {
        atrChart.current.applyOptions({
          width: atrChartRef.current.clientWidth,
          height: atrChartRef.current.clientHeight,
        });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  // 加载数据 + 连接 WebSocket
  useEffect(() => {
    loadKlines(interval);

    // 预加载相邻周期数据 —— 利用 fetchKlines 的 TTL 缓存，
    // 用户点切换时直接命中缓存，零等待。
    // 比如当前是 15m，预加载 5m 和 1h；当前是 1h，预加载 15m 和 4h
    const idx = INTERVALS.findIndex((i) => i.value === interval);
    if (idx > 0) {
      // 不 await，后台静默拉取
      fetchKlinesApi(symbol, okxId, INTERVALS[idx - 1].value, 300).catch(() => {});
    }
    if (idx >= 0 && idx < INTERVALS.length - 1) {
      fetchKlinesApi(symbol, okxId, INTERVALS[idx + 1].value, 300).catch(() => {});
    }

    // 连接实时 WebSocket（按当前币种 + 周期订阅）
    const { updatePrice } = usePriceStore.getState();
    const ws = createMarketWS({
      onTrade: (price, ts) => {
        updateTick(price, ts);
        updatePrice(price);
      },
      onKline: (intv, kline, isFinal) => {
        if (intv === interval) {
          updateLastKlineRef.current(kline, isFinal);
        }
      },
      onConnect: (source) => {
        setDataStatus(source === 'binance' || source === 'okx' ? '实时' : '轮询');
      },
      onDisconnect: () => {
        setDataStatus('断开');
      },
    }, symbol, okxId, interval);
    ws.connect();

    return () => ws.disconnect();
  }, [interval, symbol, okxId, loadKlines, updateTick]);

  // R4 数据源：独立拉取 4h 级别K线（与当前显示周期无关，切周期不重复请求）。
  // fetchKlines 对 4h 有 5 分钟 TTL 缓存，此处到点静默刷新形成K线数据；
  // 数据就绪/刷新后立即重画标记（drawFractalDivergMarkers 内读取 k4hRef 投射 R4）。
  useEffect(() => {
    let alive = true;
    const load4h = () => {
      fetchKlinesApi(symbol, okxId, '4h', 300)
        .then((k4) => {
          if (alive && k4.length > 0) {
            k4hRef.current = k4;
            drawFractalDivergMarkers(allKlinesRef.current);
          }
        })
        .catch(() => {});
    };
    load4h();
    const t = setInterval(load4h, 300_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol, okxId, drawFractalDivergMarkers]);

  // 菜单点击外部时关闭（用 ref 判断是否点在工具栏内，避免 stopPropagation 时序导致开关点不上）
  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: Event) => {
      const target = e.target as Node | null;
      if (toolbarRef.current && target && !toolbarRef.current.contains(target)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [openMenu, isFullscreen]);

  // 绘图/叠加图层菜单项（会员）
  const currentOverlayPrefs = () => ({
    AB9: showAutoAB9, CHANNEL: showTrendChannel, VALUEAREA: showValueArea, ICHIMOKU: showIchimoku,
    SYNTH: showSynth, GANN: showGann, SUPER: showSuperTrend, FRACTAL: showFractal, DIVERG: showDiverg,
  });
  const layerMenu = [
    {
      key: 'AB9', label: '九线测算', active: showAutoAB9,
      on: () => { const v = !showAutoAB9; setShowAutoAB9(v); saveOverlayPrefs({ ...currentOverlayPrefs(), AB9: v }); saveUserPref('prefAB9', v); setOpenMenu(null); },
    },
    {
      key: 'CHANNEL', label: '趋势通道', active: showTrendChannel,
      on: () => { const v = !showTrendChannel; setShowTrendChannel(v); saveOverlayPrefs({ ...currentOverlayPrefs(), CHANNEL: v }); saveUserPref('prefCHANNEL', v); setOpenMenu(null); },
    },
    {
      key: 'VALUEAREA', label: '价值区域 VA', active: showValueArea,
      on: () => { const v = !showValueArea; setShowValueArea(v); saveOverlayPrefs({ ...currentOverlayPrefs(), VALUEAREA: v }); saveUserPref('prefVALUEAREA', v); setOpenMenu(null); },
    },
    {
      key: 'ICHIMOKU', label: '一目云图', active: showIchimoku,
      on: () => { const v = !showIchimoku; setShowIchimoku(v); saveOverlayPrefs({ ...currentOverlayPrefs(), ICHIMOKU: v }); saveUserPref('prefICHIMOKU', v); setOpenMenu(null); },
    },
    {
      key: 'SYNTH', label: '预测合成器', active: showSynth,
      on: () => { const v = !showSynth; setShowSynth(v); saveOverlayPrefs({ ...currentOverlayPrefs(), SYNTH: v }); saveUserPref('prefSYNTH', v); setOpenMenu(null); },
    },
    {
      key: 'GANN', label: '江恩工具箱', active: showGann,
      on: () => { const v = !showGann; setShowGann(v); saveOverlayPrefs({ ...currentOverlayPrefs(), GANN: v }); saveUserPref('prefGANN', v); setOpenMenu(null); },
    },
    {
      key: 'SUPER', label: 'SuperTrend', active: showSuperTrend,
      on: () => { const v = !showSuperTrend; setShowSuperTrend(v); saveOverlayPrefs({ ...currentOverlayPrefs(), SUPER: v }); saveUserPref('prefSUPER', v); setOpenMenu(null); },
    },
    {
      key: 'FRACTAL', label: '顶/底分型', active: showFractal,
      on: () => { const v = !showFractal; setShowFractal(v); saveOverlayPrefs({ ...currentOverlayPrefs(), FRACTAL: v }); saveUserPref('prefFRACTAL', v); setOpenMenu(null); },
    },
    {
      key: 'DIVERG', label: 'MACD背离', active: showDiverg,
      on: () => { const v = !showDiverg; setShowDiverg(v); saveOverlayPrefs({ ...currentOverlayPrefs(), DIVERG: v }); saveUserPref('prefDIVERG', v); setOpenMenu(null); },
    },
  ];

  return (
    <div className="glass-card overflow-hidden">
      {/* 工具栏 */}
      <div ref={toolbarRef} className="flex flex-wrap items-center justify-between gap-y-2 gap-x-3 px-3 py-2 border-b border-dark-700/50">
        {/* 左：币种 + 周期 */}
        <div className="flex items-center gap-2 min-w-0">
          <SymbolSelector
            symbol={symbol}
            symbolLabel={symbolLabel}
            symbolList={symbolList}
            onChange={(value) => setSymbol(value)}
          />
          <div className="w-px h-4 bg-dark-700 shrink-0" />
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
            {INTERVALS.map((item) => (
              <button
                key={item.value}
                onClick={() => setIntervalState(item.value)}
                className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  interval === item.value
                    ? 'bg-blue-600 text-white'
                    : 'text-dark-400 hover:text-white hover:bg-dark-700/50'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* 右：状态 + 指标菜单 + 图层菜单 + 全屏 */}
        <div className="flex items-center gap-1.5">
          <span className={`hidden sm:inline text-xs px-2 py-0.5 rounded whitespace-nowrap ${
            dataStatus === '实时' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
          }`}>
            {dataStatus}
          </span>

          {/* 指标菜单（副图 + 主图，收纳到下拉减少占用） */}
          <div className="relative">
            <button
              onClick={() => setOpenMenu(openMenu === 'ind' ? null : 'ind')}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-all ${
                openMenu === 'ind' ? 'bg-dark-700/80 text-white' : 'text-dark-400 hover:text-white hover:bg-dark-700/50'
              }`}
              title="指标"
            >
              指标
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openMenu === 'ind' && (
              <div className="absolute right-0 top-full mt-1 z-40 w-44 rounded-lg bg-dark-800 border border-dark-700 p-1.5 shadow-2xl">
                <div className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-dark-500">副图</div>
                {(['EMA', 'MA120', 'BOLL', 'MACD', 'RSI', 'VWAP', 'KDJ', 'ATR'] as const).map((ind) => (
                  <button
                    key={ind}
                    onClick={() => {
                      setIndicators((prev) => { const next = { ...prev, [ind]: !prev[ind] }; saveIndicatorPrefs(next); return next; });
                    }}
                    className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs hover:bg-dark-700/40 transition-all"
                  >
                    <span className={indicators[ind] ? 'text-blue-300' : 'text-dark-300'}>{ind}</span>
                    <span className={`text-[10px] ${indicators[ind] ? 'text-blue-400' : 'text-dark-600'}`}>{indicators[ind] ? '开' : '关'}</span>
                  </button>
                ))}
                <div className="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wider text-dark-500">主图</div>
                {(['NINE', 'CHAN'] as const).map((ind) => (
                  <button
                    key={ind}
                    onClick={() => {
                      setIndicators((prev) => { const next = { ...prev, [ind]: !prev[ind] }; saveIndicatorPrefs(next); return next; });
                    }}
                    className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs hover:bg-dark-700/40 transition-all"
                  >
                    <span className={indicators[ind] ? 'text-blue-300' : 'text-dark-300'}>{ind === 'NINE' ? '九转' : '缠论'}</span>
                    <span className={`text-[10px] ${indicators[ind] ? 'text-blue-400' : 'text-dark-600'}`}>{indicators[ind] ? '开' : '关'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 图层菜单（会员叠加层） */}
          {isMember && (
            <div className="relative">
              <button
                onClick={() => setOpenMenu(openMenu === 'layer' ? null : 'layer')}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-all ${
                  openMenu === 'layer' ? 'bg-dark-700/80 text-white' : 'text-dark-400 hover:text-white hover:bg-dark-700/50'
                }`}
                title="绘图/叠加图层"
              >
                图层
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {openMenu === 'layer' && (
                <div className="absolute right-0 top-full mt-1 z-40 w-52 rounded-lg bg-dark-800 border border-dark-700 p-1.5 shadow-2xl max-h-80 overflow-y-auto">
                  <div className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-dark-500">叠加图层</div>
                  {layerMenu.map((item) => (
                    <button
                      key={item.key}
                      onClick={item.on}
                      className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs hover:bg-dark-700/40 transition-all"
                    >
                      <span className={item.active ? 'text-blue-300' : 'text-dark-300'}>{item.label}</span>
                      <span className={`text-[10px] ${item.active ? 'text-blue-400' : 'text-dark-600'}`}>{item.active ? '开' : '关'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 信号面板按钮 */}
          <button
            onClick={() => setShowSignalsPanel((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-all ${
              showSignalsPanel ? 'bg-blue-600 text-white' : 'text-dark-400 hover:text-white hover:bg-dark-700/50'
            }`}
            title="信号面板"
          >
            信号
          </button>

          {/* 江恩面板按钮 */}
          <button
            onClick={() => setShowGannPanel((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-all ${
              showGannPanel ? 'bg-purple-600 text-white' : 'text-dark-400 hover:text-white hover:bg-dark-700/50'
            }`}
            title="江恩面板"
          >
            江恩
          </button>

          {/* 指标面板按钮 */}
          <button
            onClick={() => setShowIndicatorPanel((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-all ${
              showIndicatorPanel ? 'bg-cyan-600 text-white' : 'text-dark-400 hover:text-white hover:bg-dark-700/50'
            }`}
            title="指标面板"
          >
            指标
          </button>

          {/* 全屏按钮 */}
          <button
            onClick={onToggleFullscreen}
            className="px-2 py-1.5 rounded-md text-dark-400 hover:text-white hover:bg-dark-700/50 transition-all"
            title={isFullscreen ? '退出全屏' : '全屏'}
          >
            {isFullscreen ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 4l-5-5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* 主图 */}
      <div className="relative">
        {loading && !candleSeries.current && (
          <div className="absolute inset-0 flex items-center justify-center bg-dark-900/30 z-10">
            <div className="flex space-x-1">
              <div className="w-1.5 h-8 bg-blue-500/40 rounded-full animate-pulse" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-12 bg-blue-500/40 rounded-full animate-pulse" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-6 bg-blue-500/40 rounded-full animate-pulse" style={{ animationDelay: '300ms' }} />
              <div className="w-1.5 h-10 bg-blue-500/40 rounded-full animate-pulse" style={{ animationDelay: '450ms' }} />
              <div className="w-1.5 h-7 bg-blue-500/40 rounded-full animate-pulse" style={{ animationDelay: '600ms' }} />
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-dark-900/80 z-10">
            <div className="text-center">
              <p className="text-red-400 mb-2">{error}</p>
              <button onClick={() => loadKlines(interval)} className="btn-primary text-sm !py-1.5 !px-4">
                重试
              </button>
            </div>
          </div>
        )}
        <div className="relative w-full overflow-hidden" style={{ height: isFullscreen ? 'calc(100vh - 40px)' : '620px' }}>
          {/* 币种水印：图表背景透明，水印置于K线之下透出（专业图表标配） */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none select-none overflow-hidden"
            style={{ zIndex: 0 }}
          >
            <div className="text-center" style={{ opacity: 0.055 }}>
              <div className="text-5xl font-bold text-slate-100 tracking-wider">{symbolLabel}</div>
              <div className="mt-1.5 text-lg text-slate-100 tracking-[0.35em]">
                {INTERVALS.find((i) => i.value === interval)?.label ?? ''}
              </div>
            </div>
          </div>
          <div
            ref={mainChartRef}
            className="w-full h-full"
            style={{ cursor: 'default', position: 'relative', zIndex: 1 }}
          />
          {/* 神奇九转数字标注覆盖层 */}
          <canvas
            ref={nineTurnCanvasRef}
            className="absolute top-0 left-0 w-full h-full pointer-events-none"
            style={{ zIndex: 2 }}
          />
          {/* 缠论（分型/笔/中枢）覆盖层 */}
          <canvas
            ref={chanCanvasRef}
            className="absolute top-0 left-0 w-full h-full pointer-events-none"
            style={{ zIndex: 3 }}
          />
          {/* 多空信号覆盖层（已移除，信息在右侧快速信号卡片查看） */}
          {/* 左上角 OHLC 图例：十字线联动，颜色跟涨跌 */}
          {legend && (
            <div className="absolute top-2.5 left-3 z-[3] pointer-events-none flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-semibold text-slate-200">{symbolLabel}</span>
                <span className="text-[11px] text-dark-400">
                  {INTERVALS.find((i) => i.value === interval)?.label}
                </span>
              </div>
              <div
                className="flex items-center gap-2.5 text-[11px] font-mono tabular-nums"
                style={{ color: legend.pct >= 0 ? CANDLE_UP : CANDLE_DOWN }}
              >
                <span>O {legend.o.toFixed(Math.max(0, Math.min(8, pricePrecision)))}</span>
                <span>H {legend.h.toFixed(Math.max(0, Math.min(8, pricePrecision)))}</span>
                <span>L {legend.l.toFixed(Math.max(0, Math.min(8, pricePrecision)))}</span>
                <span>C {legend.c.toFixed(Math.max(0, Math.min(8, pricePrecision)))}</span>
                <span className="font-semibold">
                  {legend.pct >= 0 ? '+' : ''}{legend.pct.toFixed(2)}%
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* MACD 副图（全屏时隐藏） */}
      <div className={`relative border-t border-dark-700/30 ${isFullscreen ? 'hidden' : ''}`}>
        <div ref={macdChartRef} className="w-full" style={{ height: '120px' }} />
        <span className="absolute top-1.5 left-3 text-[10px] text-dark-400 pointer-events-none">
          MACD({periods.macdFast},{periods.macdSlow},{periods.macdSignal})
        </span>
      </div>

      {/* RSI 副图（全屏时隐藏） */}
      <div className={`relative border-t border-dark-700/30 ${isFullscreen ? 'hidden' : ''}`}>
        <div ref={rsiChartRef} className="w-full" style={{ height: '100px' }} />
        <span className="absolute top-1.5 left-3 text-[10px] text-dark-400 pointer-events-none">
          RSI({periods.rsiPeriod})
        </span>
      </div>

      {/* KDJ 副图（全屏时隐藏） */}
      <div className={`relative border-t border-dark-700/30 ${isFullscreen ? 'hidden' : ''}`}>
        <div ref={kdjChartRef} className="w-full" style={{ height: '100px' }} />
        <span className="absolute top-1.5 left-3 text-[10px] text-dark-400 pointer-events-none">
          KDJ({periods.kdjN},{periods.kdjK},{periods.kdjD})
        </span>
      </div>

      {/* ATR 副图（全屏时隐藏） */}
      <div className={`relative border-t border-dark-700/30 ${isFullscreen ? 'hidden' : ''}`}>
        <div ref={atrChartRef} className="w-full" style={{ height: '80px' }} />
        <span className="absolute top-1.5 left-3 text-[10px] text-dark-400 pointer-events-none">
          ATR({periods.atrPeriod})
        </span>
      </div>

      {/* 信号面板：聚合所有指标/画线工具的多空震荡（真实读数），位于K线图下方 */}
      {showSignalsPanel && (
        <SignalPanel
          klines={allKlinesRef.current}
          refreshKey={panelTick}
          precision={pricePrecision}
          symbol={symbol}
        />
      )}
      {showGannPanel && (
        <GannPanel
          klines={allKlinesRef.current}
          refreshKey={panelTick}
          precision={pricePrecision}
          symbol={symbol}
        />
      )}
      {showIndicatorPanel && (
        <IndicatorPanel
          klines={allKlinesRef.current}
          refreshKey={panelTick}
          precision={pricePrecision}
          symbol={symbol}
        />
      )}
    </div>
  );
}
