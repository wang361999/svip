'use client';

import {
  calcBollinger,
  calcMACD,
  calcEMAArray,
  calcRSIArray,
  calcAB9Lines,
  calcFibonacci,
  calcVWAPArray,
  calcKDJ,
  calcATRArray,
  calcNineTurn,
  calcChan,
  calcTrendChannel,
  calcPitchfork,
  type ChanResult,
  type TrendChannel,
  type Pitchfork,
} from '@/shared/lib/indicators';
import { analyzeRapid, type RapidAnalysis } from '@/shared/lib/rapid-strategy';

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
const INDICATOR_PREFS_KEY = 'kline-indicator-prefs';
const DEFAULT_INDICATORS = { EMA: true, BOLL: false, MACD: true, RSI: false, VWAP: false, KDJ: false, ATR: false, NINE: false, CHAN: true };

function loadIndicatorPrefs(): typeof DEFAULT_INDICATORS {
  if (typeof window === 'undefined') return { ...DEFAULT_INDICATORS };
  try {
    const raw = window.localStorage.getItem(INDICATOR_PREFS_KEY);
    if (!raw) return { ...DEFAULT_INDICATORS };
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_INDICATORS>;
    return {
      EMA: !!parsed.EMA,
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

// ========== 画线开关持久化（AB9 / 斐波那契） ==========
// 同样存于浏览器本地，刷新/换币种/换周期后保持用户的选择
// 会员用户额外同步到后端（跨设备），非会员仅本地
const OVERLAY_PREFS_KEY = 'kline-overlay-prefs';
const DEFAULT_OVERLAY = { AB9: true, FIB: false, CHANNEL: true, PITCHFORK: true };

function loadOverlayPrefs() {
  if (typeof window === 'undefined') return { ...DEFAULT_OVERLAY };
  try {
    const raw = window.localStorage.getItem(OVERLAY_PREFS_KEY);
    if (!raw) return { ...DEFAULT_OVERLAY };
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_OVERLAY>;
    return {
      AB9: parsed.AB9 !== undefined ? !!parsed.AB9 : DEFAULT_OVERLAY.AB9,
      FIB: parsed.FIB !== undefined ? !!parsed.FIB : DEFAULT_OVERLAY.FIB,
      CHANNEL: parsed.CHANNEL !== undefined ? !!parsed.CHANNEL : DEFAULT_OVERLAY.CHANNEL,
      PITCHFORK: parsed.PITCHFORK !== undefined ? !!parsed.PITCHFORK : DEFAULT_OVERLAY.PITCHFORK,
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
  const pitchforkRef = useRef<Pitchfork | null>(null);
  const drawChanRef = useRef<() => void>(() => {});

  // 多空信号箭头画布
  const signalCanvasRef = useRef<HTMLCanvasElement>(null);
  const signalDataRef = useRef<RapidAnalysis | null>(null);
  const drawSignalsRef = useRef<() => void>(() => {});
  // 震荡区间价格线
  const rangePriceLinesRef = useRef<any[]>([]);

  const allKlinesRef = useRef<KlineData[]>([]);
  const pendingTickRef = useRef<number | null>(null);
  const rAFRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number>(0);

  // AB9线 + 斐波那契回调线 + 趋势通道 + 安德鲁音叉：从 localStorage 初始化
  const overlayPrefsInit = loadOverlayPrefs();
  const [showAutoAB9, setShowAutoAB9] = useState(overlayPrefsInit.AB9);
  const [showFibonacci, setShowFibonacci] = useState(overlayPrefsInit.FIB);
  const [showTrendChannel, setShowTrendChannel] = useState(overlayPrefsInit.CHANNEL);
  const [showPitchfork, setShowPitchfork] = useState(overlayPrefsInit.PITCHFORK);
  // ref 镜像：updateIndicators 的 useCallback 依赖里没有这两个开关，
  // 切换币种/周期重载数据时闭包里是旧值，会出现"关了又冒出来/开了不出来"的状态错乱
  const showTrendChannelRef = useRef(showTrendChannel);
  showTrendChannelRef.current = showTrendChannel;
  const showPitchforkRef = useRef(showPitchfork);
  showPitchforkRef.current = showPitchfork;
  // 左上角 OHLC 图例：随十字线联动（悬停读历史K线，离开回落到最新一根，tick 实时刷新）
  interface LegendInfo { o: number; h: number; l: number; c: number; pct: number }
  const [legend, setLegend] = useState<LegendInfo | null>(null);
  const legendOf = useCallback((o: number, h: number, l: number, c: number): LegendInfo => ({
    o, h, l, c, pct: o > 0 ? ((c - o) / o) * 100 : 0,
  }), []);
  // AB9线 ref（原生价格线）
  const autoPriceLinesRef = useRef<any[]>([]);
  // 斐波那契线 ref（原生价格线）
  const fibPriceLinesRef = useRef<any[]>([]);

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
  const interval = useChartStore((s) => s.interval);
  const setIntervalState = useChartStore((s) => s.setInterval);
  const symbol = useSymbolStore((s) => s.symbol);
  const okxId = useSymbolStore((s) => s.okxId);
  const symbolLabel = useSymbolStore((s) => s.label);
  const setSymbol = useSymbolStore((s) => s.setSymbol);
  const symbolList = useSymbolStore((s) => s.symbols);
  const fetchSymbols = useSymbolStore((s) => s.fetchSymbols);
  /** 当前币种价格精度（K线价格轴/十字线按此格式化 — 低价币不再显示成 0.00） */
  const pricePrecision = useSymbolStore((s) => s.pricePrecision);

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
    [bbUpper.current, bbMiddle.current, bbLower.current, emaSeries.current].forEach((s) => {
      if (s) { try { mainChart.current?.removeSeries(s); } catch {} }
    });
    bbUpper.current = bbMiddle.current = bbLower.current = emaSeries.current = null;

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

    // 安德鲁音叉（读 ref 镜像，避免闭包过期）
    if (showPitchforkRef.current) {
      pitchforkRef.current = calcPitchfork(klines, 80);
    } else {
      pitchforkRef.current = null;
    }

    requestAnimationFrame(() => {
      try { drawChanRef.current(); } catch (e) { console.warn('[Chan] raf error:', e); }
    });

    // 多空信号：基于当前K线计算快速策略信号
    try {
      signalDataRef.current = analyzeRapid(symbol, klines);

      // 支撑/阻力线（始终显示）
      const ri = signalDataRef.current?.rangeInfo;
      for (const pl of rangePriceLinesRef.current) {
        try { candleSeries.current?.removePriceLine(pl); } catch {}
      }
      rangePriceLinesRef.current = [];

      if (ri && ri.support > 0 && ri.resistance > 0 && candleSeries.current) {
        try {
          const isRange = ri.isRange;
          const supportLine = candleSeries.current.createPriceLine({
            price: ri.support,
            color: isRange ? 'rgba(34, 197, 94, 0.8)' : 'rgba(34, 197, 94, 0.5)',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: isRange ? ' 支撑' : ' 近端支撑',
          });
          const resistanceLine = candleSeries.current.createPriceLine({
            price: ri.resistance,
            color: isRange ? 'rgba(246, 70, 93, 0.8)' : 'rgba(246, 70, 93, 0.5)',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: isRange ? ' 阻力' : ' 近端阻力',
          });
          rangePriceLinesRef.current = [supportLine, resistanceLine];
        } catch {}
      }
    } catch (e) {
      console.warn('[Signals] analyze error:', e);
    }
    requestAnimationFrame(() => {
      try { drawSignalsRef.current(); } catch (e) { console.warn('[Signals] raf error:', e); }
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

  // 趋势通道/音叉开关切换时立即重算
  useEffect(() => {
    if (allKlinesRef.current.length > 0 && mainChart.current) {
      const klines = allKlinesRef.current;
      // 趋势通道
      if (showTrendChannel) {
        trendChannelRef.current = calcTrendChannel(klines, 60);
      } else {
        trendChannelRef.current = null;
      }
      // 安德鲁音叉
      if (showPitchfork) {
        pitchforkRef.current = calcPitchfork(klines, 80);
      } else {
        pitchforkRef.current = null;
      }
      requestAnimationFrame(() => {
        try { drawChanRef.current(); } catch (e) { console.warn('[Overlay] raf error:', e); }
      });
    }
  }, [showTrendChannel, showPitchfork]);

  // === AB9线 + 斐波那契回调线重绘 ===
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
    for (const pl of fibPriceLinesRef.current) {
      try { series.removePriceLine(pl); } catch {}
    }
    fibPriceLinesRef.current = [];

    // —— AB9线（原生满宽价格线，价格轴可读数；应反馈恢复原画法） ——
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

    // —— 斐波那契回调线（原生满宽价格线，价格轴可读数；应反馈恢复原画法） ——
    if (showFibonacci && isMember) {
      const fib = calcFibonacci(klines);
      if (fib) {
        const fibColors: Record<string, string> = {
          '0.0': 'rgba(239, 68, 68, 0.85)',
          '23.6': 'rgba(249, 115, 22, 0.75)',
          '38.2': 'rgba(245, 158, 11, 0.75)',
          '50.0': 'rgba(234, 179, 8, 0.85)',
          '61.8': 'rgba(34, 197, 94, 0.75)',
          '78.6': 'rgba(20, 184, 166, 0.75)',
          '100.0': 'rgba(59, 130, 246, 0.85)',
          '161.8': 'rgba(168, 85, 247, 0.75)',
          '261.8': 'rgba(236, 72, 153, 0.75)',
        };
        for (const level of fib.levels) {
          const color = fibColors[level.label] || 'rgba(148, 163, 184, 0.6)';
          const lineWidth = level.ratio === 0.5 || level.ratio === 0.618 ? 2 : 1;
          try {
            const pl = series.createPriceLine({
              price: level.price,
              color: color.replace(/[\d.]+\)$/, '0.85)'),
              lineWidth,
              lineStyle: level.type === 'extension' ? 3 : 2,
              axisLabelVisible: true,
              title: ` FIB ${level.label}%`,
            });
            fibPriceLinesRef.current.push(pl);
          } catch {}
        }
      }
    }
  }, [showAutoAB9, showFibonacci, isMember, symbol]);

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

    // === AB9线 + 斐波那契回调线（各自独立控制）===
    redrawOverlayLines();

    if (candleSeries.current) {
      candleSeries.current.setMarkers([]);
    }

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
  }, [updateIndicators, redrawOverlayLines, legendOf]);

  // 切换画线开关时仅重画线（不再整图重载、不重置视图）
  useEffect(() => {
    redrawOverlayLines();
  }, [redrawOverlayLines]);

  // Tick 实时更新（rAF + 50ms 节流，和 v24 一致）
  const flushTick = useCallback(() => {
    rAFRef.current = null;
    if (!candleSeries.current || !volumeSeries.current) return;
    const klines = allKlinesRef.current;
    if (klines.length === 0) return;
    const price = pendingTickRef.current;
    if (price == null) return;

    const last = klines[klines.length - 1];
    last.close = price;
    if (price > last.high) last.high = price;
    if (price < last.low) last.low = price;

    candleSeries.current.update({
      time: last.time as Time,
      open: last.open, high: last.high, low: last.low, close: last.close,
    });
    // 图例跟随实时价（50ms 节流内更新，开销可忽略）
    setLegend(legendOf(last.open, last.high, last.low, last.close));
  }, [legendOf]);

  const updateTick = useCallback((price: number) => {
    pendingTickRef.current = price;
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

    if (isFinal) {
      updateIndicators();
      // K线收盘后重算 AB9 / 斐波那契画线：新分形确认、突破换段都能及时反映，
      // 修复此前盘中形成的新高/新低要等手动刷新才会体现在画线上的问题
      redrawOverlayLines();
      // K线收盘后重算九转序列
      if (indicators.NINE) {
        nineTurnDataRef.current = calcNineTurn(klines);
      }
    }
    // 九转/缠论canvas只在K线收盘时重绘（避免盘中每次tick都重绘浪费性能）
    // 盘中价格变动不影响九转/缠论数据，只在K线收盘后数据才变化
    if (isFinal) {
      try { drawNineTurnRef.current(); } catch (e) { console.warn('[NineTurn] update error:', e); }
      try { drawChanRef.current(); } catch (e) { console.warn('[Chan] update error:', e); }
    }
    // 多空信号箭头每次tick都重绘（跟随最新价格）
    try { drawSignalsRef.current(); } catch (e) { console.warn('[Signals] update error:', e); }
  }, [updateIndicators, redrawOverlayLines, legendOf, indicators.NINE, indicators.CHAN]);

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
      if (!canvas || !chartAPI || !nineData || nineData.length === 0 || klines.length === 0) return;
      if (!candleSeries.current) return;

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
      ctx.clearRect(0, 0, canvas.width, canvas.height);
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
        // 至少要有一种数据才绘制（缠论/通道/音叉任一即可）
        if (!chanData && !trendChannelRef.current && !pitchforkRef.current) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
          canvas.width = Math.floor(rect.width * dpr);
          canvas.height = Math.floor(rect.height * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
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
          // 未命中数据时间：按未来时间外推
          if (ksForX.length < 2) return null;
          const lastK = ksForX[ksForX.length - 1];
          const prevK = ksForX[ksForX.length - 2];
          const interval = lastK.time - prevK.time;
          if (interval <= 0 || t <= lastK.time) return null;
          const xLast = timeScale.timeToCoordinate(lastK.time as Time);
          const xPrev = timeScale.timeToCoordinate(prevK.time as Time);
          if (xLast === null || xPrev === null) return null;
          const spacing = xLast - xPrev; // 有符号：时间向右递增
          if (spacing === 0) return null;
          const barsAhead = (t - lastK.time) / interval;
          return xLast + barsAhead * spacing;
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

        // ========== 安德鲁音叉绘制 ==========
        const pf = pitchforkRef.current;
        if (pf) {
          // 辅助函数：计算坐标（未来延伸时间用 timeToX 外推，确保右端点可解析）
          const toX = (t: number) => timeToX(t);
          const toY = (p: number) => candleSeries.current?.priceToCoordinate(p) ?? null;

          const xA = toX(pf.pointA.time);
          const yA = toY(pf.pointA.price);
          const xB = toX(pf.pointB.time);
          const yB = toY(pf.pointB.price);
          const xC = toX(pf.pointC.time);
          const yC = toY(pf.pointC.price);

          const xMedStart = toX(pf.medianStart.time);
          const yMedStart = toY(pf.medianStart.price);
          const xMedEnd = toX(pf.medianEnd.time);
          const yMedEnd = toY(pf.medianEnd.price);

          const xUpStart = toX(pf.upperStart.time);
          const yUpStart = toY(pf.upperStart.price);
          const xUpEnd = toX(pf.upperEnd.time);
          const yUpEnd = toY(pf.upperEnd.price);

          const xLowStart = toX(pf.lowerStart.time);
          const yLowStart = toY(pf.lowerStart.price);
          const xLowEnd = toX(pf.lowerEnd.time);
          const yLowEnd = toY(pf.lowerEnd.price);

          const xUpWarnStart = toX(pf.upperWarningStart.time);
          const yUpWarnStart = toY(pf.upperWarningStart.price);
          const xUpWarnEnd = toX(pf.upperWarningEnd.time);
          const yUpWarnEnd = toY(pf.upperWarningEnd.price);

          const xLowWarnStart = toX(pf.lowerWarningStart.time);
          const yLowWarnStart = toY(pf.lowerWarningStart.price);
          const xLowWarnEnd = toX(pf.lowerWarningEnd.time);
          const yLowWarnEnd = toY(pf.lowerWarningEnd.price);

          const allCoords = [xA, yA, xB, yB, xC, yC,
            xMedStart, yMedStart, xMedEnd, yMedEnd,
            xUpStart, yUpStart, xUpEnd, yUpEnd,
            xLowStart, yLowStart, xLowEnd, yLowEnd,
            xUpWarnStart, yUpWarnStart, xUpWarnEnd, yUpWarnEnd,
            xLowWarnStart, yLowWarnStart, xLowWarnEnd, yLowWarnEnd];

          if (allCoords.every(c => c !== null)) {
            const pfColor = pf.direction === 'up' ? 'rgba(251, 191, 36,' : 'rgba(168, 85, 247,';

            // 警告线（最淡）
            ctx.strokeStyle = pfColor + '0.25)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 6]);
            ctx.beginPath();
            ctx.moveTo(xUpWarnStart!, yUpWarnStart!);
            ctx.lineTo(xUpWarnEnd!, yUpWarnEnd!);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xLowWarnStart!, yLowWarnStart!);
            ctx.lineTo(xLowWarnEnd!, yLowWarnEnd!);
            ctx.stroke();

            // 上轨和下轨
            ctx.strokeStyle = pfColor + '0.6)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(xUpStart!, yUpStart!);
            ctx.lineTo(xUpEnd!, yUpEnd!);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xLowStart!, yLowStart!);
            ctx.lineTo(xLowEnd!, yLowEnd!);
            ctx.stroke();

            // 中轨（实线，最显眼）
            ctx.strokeStyle = pfColor + '0.9)';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(xMedStart!, yMedStart!);
            ctx.lineTo(xMedEnd!, yMedEnd!);
            ctx.stroke();

            // A/B/C 三个基准点
            const dotRadius = 4;
            ctx.fillStyle = pfColor + '1)';
            // A点
            ctx.beginPath();
            ctx.arc(xA!, yA!, dotRadius, 0, Math.PI * 2);
            ctx.fill();
            // B点
            ctx.beginPath();
            ctx.arc(xB!, yB!, dotRadius, 0, Math.PI * 2);
            ctx.fill();
            // C点
            ctx.beginPath();
            ctx.arc(xC!, yC!, dotRadius, 0, Math.PI * 2);
            ctx.fill();

            // AB和BC连线（淡虚线）
            ctx.strokeStyle = pfColor + '0.4)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(xA!, yA!);
            ctx.lineTo(xB!, yB!);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xB!, yB!);
            ctx.lineTo(xC!, yC!);
            ctx.stroke();
            ctx.setLineDash([]);

            // 标签
            ctx.font = '9px -apple-system, sans-serif';
            ctx.fillStyle = pfColor + '0.8)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(' A', xA! + 4, yA!);
            ctx.fillText(' B', xB! + 4, yB!);
            ctx.fillText(' C', xC! + 4, yC!);

            // 音叉末端标签
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText('音叉上轨', xUpEnd! - 2, yUpEnd! - 2);
            ctx.textBaseline = 'top';
            ctx.fillText('音叉下轨', xLowEnd! - 2, yLowEnd! + 2);
          }
        }

        ctx.restore();
      } catch (e) {
        console.warn('[Chan] render error:', e);
      }
    };
    drawChanRef.current = drawChan;

    // ===== 多空信号箭头绘制（透明框版） =====
    const drawSignals = () => {
      // 止盈止损框已移除（信息在右侧快速信号卡片中查看）
    };
    drawSignalsRef.current = drawSignals;

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
      // 多空信号随视图滚动重绘
      try { drawSignals(); } catch (e) { console.warn('[Signals] scroll error:', e); }
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

    return () => {
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
      onTrade: (price) => {
        updateTick(price);
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

  return (
    <div className="glass-card overflow-hidden">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-dark-700/50">
        <div className="flex items-center space-x-2">
          {/* 币种选择器 */}
          <SymbolSelector
            symbol={symbol}
            symbolLabel={symbolLabel}
            symbolList={symbolList}
            onChange={(value) => setSymbol(value)}
          />
          <div className="w-px h-4 bg-dark-700" />
          {INTERVALS.map((item) => (
            <button
              key={item.value}
              onClick={() => setIntervalState(item.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                interval === item.value
                  ? 'bg-blue-600 text-white'
                  : 'text-dark-400 hover:text-white hover:bg-dark-700/50'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded ${
            dataStatus === '实时' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
          }`}>
            {dataStatus}
          </span>
          {(['EMA', 'BOLL', 'MACD', 'RSI', 'VWAP', 'KDJ', 'ATR', 'NINE', 'CHAN'] as const).map((ind) => (
            <button
              key={ind}
              onClick={() => {
                // 前台徽章直接管控：点击即切换并持久化到浏览器本地
                // indicators 变化会被下方 useEffect 捕获并自动重绘，无需手动调用
                setIndicators((prev) => {
                  const next = { ...prev, [ind]: !prev[ind] };
                  saveIndicatorPrefs(next);
                  return next;
                });
              }}
              className={`px-2.5 py-1 text-xs font-medium cursor-pointer select-none transition-all ${
                indicators[ind]
                  ? 'text-blue-300 border-b-2 border-blue-400 pb-0.5'
                  : 'text-dark-600 line-through hover:text-dark-400'
              }`}
              title={`点击切换${ind}显示`}
            >
              {ind === 'NINE' ? '九转' : ind === 'CHAN' ? '缠论' : ind}
            </button>
          ))}
          {/* AB9 + 斐波那契 独立按钮 */}
          {isMember && (
            <>
              <div className="w-px h-4 bg-dark-700" />
              <button
                onClick={() => { const v = !showAutoAB9; setShowAutoAB9(v); saveOverlayPrefs({ AB9: v, FIB: showFibonacci, CHANNEL: showTrendChannel, PITCHFORK: showPitchfork }); saveUserPref('prefAB9', v); }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${showAutoAB9 ? 'text-cyan-400' : 'text-dark-600'}`}
                title="AB9线"
              >
                AB9
              </button>
              <button
                onClick={() => { const v = !showFibonacci; setShowFibonacci(v); saveOverlayPrefs({ AB9: showAutoAB9, FIB: v, CHANNEL: showTrendChannel, PITCHFORK: showPitchfork }); saveUserPref('prefFibonacci', v); }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${showFibonacci ? 'text-cyan-400' : 'text-dark-600'}`}
                title="斐波那契回调线"
              >
                FIB
              </button>
              <button
                onClick={() => { const v = !showTrendChannel; setShowTrendChannel(v); saveOverlayPrefs({ AB9: showAutoAB9, FIB: showFibonacci, CHANNEL: v, PITCHFORK: showPitchfork }); }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${showTrendChannel ? 'text-green-400' : 'text-dark-600'}`}
                title="趋势通道"
              >
                通道
              </button>
              <button
                onClick={() => { const v = !showPitchfork; setShowPitchfork(v); saveOverlayPrefs({ AB9: showAutoAB9, FIB: showFibonacci, CHANNEL: showTrendChannel, PITCHFORK: v }); }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${showPitchfork ? 'text-amber-400' : 'text-dark-600'}`}
                title="安德鲁音叉"
              >
                音叉
              </button>
            </>
          )}

          {/* 全屏按钮 */}
          <div className="w-px h-4 bg-dark-700" />
          <button
            onClick={onToggleFullscreen}
            className="px-2.5 py-1 text-xs font-medium rounded text-dark-400 hover:text-white hover:bg-dark-700/50 transition-all"
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
    </div>
  );
}
