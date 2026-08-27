'use client';

import {
  calcBollinger,
  calcMACD,
  calcEMAArray,
  calcRSIArray,
  calcAB9Lines,
  calcFibonacci,
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

interface KlineChartProps {
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

// ========== 指标显示开关：前台徽章直接管控 ==========
// 开关状态仅存于浏览器本地（localStorage），后台/数据库不再有任何指标开关，
// 徽章点击即生效并持久化，刷新/换币种/换周期后保持用户的选择。
const INDICATOR_PREFS_KEY = 'kline-indicator-prefs';
const DEFAULT_INDICATORS = { EMA: false, BOLL: true, MACD: true, RSI: false };

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

// ========== 利润测算画线（结构分析数据，与 AI 分析卡片同源） ==========
const PROFIT_PREF_KEY = 'kline-profit-pref';

function loadProfitPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(PROFIT_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

// ========== 微观结构位画线开关（流动性池 + FVG 缺口，独立于止盈徽章） ==========
const MICRO_PREF_KEY = 'kline-micro-pref';

function loadMicroPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(MICRO_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

interface ProfitPlanLine {
  id: string;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  rrTp1: number;
  rrTp2: number;
  tp1ProbabilityPct?: number;
  tp2ProbabilityPct?: number;
}

/** 结构分析接口中与画线相关的字段 */
interface ProfitLineData {
  symbol: string;
  currentPrice: number;
  plans: ProfitPlanLine[];
  profitTargets: { label: string; price: number; probabilityPct: number }[];
  confluence: { low: number; high: number; mid: number; methods: string[]; probabilityPct: number } | null;
  extendedTarget: { label: string; price: number; probabilityPct: number } | null;
  invalidation: { price: number; note: string } | null;
  liquidityPools?: { price: number; side: 'high' | 'low'; distancePct: number; formedAt?: number; firstAt?: number }[];
  fairValueGaps?: { low: number; high: number; ce: number; dir: 'bull' | 'bear'; distancePct: number; formedAt?: number }[];
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

  const allKlinesRef = useRef<KlineData[]>([]);
  const pendingTickRef = useRef<number | null>(null);
  const rAFRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number>(0);

  // AB9线
  const [showAutoAB9, setShowAutoAB9] = useState(true);
  // 斐波那契回调线
  const [showFibonacci, setShowFibonacci] = useState(false);
  // 利润测算画线（结构分析：预案/汇流止盈区/目标位）
  const [showProfit, setShowProfit] = useState(loadProfitPref);
  const [showMicro, setShowMicro] = useState(loadMicroPref);
  // AB9线 ref
  const autoLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const autoPriceLinesRef = useRef<any[]>([]);
  // 斐波那契线 ref
  const fibLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const fibPriceLinesRef = useRef<any[]>([]);
  // 利润测算线 ref + 数据缓存（结构分析接口，服务端 4h 级缓存）
  const profitLinesRef = useRef<any[]>([]);
  const profitDataRef = useRef<ProfitLineData | null>(null);
  const profitFetchStateRef = useRef<{ symbol: string; at: number } | null>(null);
  // 测算透明框画布（叠加在K线上层，pointer-events: none 不挡交互）
  const zoneCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawZonesRef = useRef<() => void>(() => {});

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
    // 同时发起 settings + preferences，不串行等待
    const settingsPromise = apiGet<Record<string, string>>('/api/settings');
    const prefsPromise = isMember
      ? apiGet<{ prefAB9?: boolean; prefFibonacci?: boolean }>('/api/user/preferences').catch(() => ({}) as any)
      : Promise.resolve({} as any);

    Promise.all([settingsPromise, prefsPromise])
      .then(([data, prefs]) => {
        if (cancelled) return;
        setPeriods({
          emaPeriod: parseInt(data.emaPeriod || '20', 10) || 20,
          bollPeriod: parseInt(data.bollPeriod || '20', 10) || 20,
          rsiPeriod: parseInt(data.rsiPeriod || '14', 10) || 14,
          macdFast: parseInt(data.macdFast || '12', 10) || 12,
          macdSlow: parseInt(data.macdSlow || '26', 10) || 26,
          macdSignal: parseInt(data.macdSignal || '9', 10) || 9,
        });
        if (prefs.prefAB9 !== undefined) setShowAutoAB9(prefs.prefAB9);
        if (prefs.prefFibonacci !== undefined) setShowFibonacci(prefs.prefFibonacci);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isMember]);

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

    const from = klines[0].time;
    const to = klines[klines.length - 1].time;

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
          if (macdData.hist[i] != null) {
            histData.push({
              time: klines[i].time as Time,
              value: macdData.hist[i] as number,
              color: (macdData.hist[i] as number) >= 0 ? '#4ade80' : '#f87171',
            });
          }
          if (macdData.dif[i] != null) {
            difData.push({ time: klines[i].time as Time, value: macdData.dif[i] as number });
          }
          if (macdData.dea[i] != null) {
            deaData.push({ time: klines[i].time as Time, value: macdData.dea[i] as number });
          }
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
        if (rsiData[i] !== null) {
          const t = klines[i].time as Time;
          lineData.push({ time: t, value: rsiData[i] as number });
          overboughtData.push({ time: t, value: 70 });
          oversoldData.push({ time: t, value: 30 });
        }
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
  }, [indicators, periods]);

  // 徽章切换指标时立即重绘
  // 修复：此前徽章只改 state 不触发重绘，必须等K线收盘或刷新页面才生效
  useEffect(() => {
    if (allKlinesRef.current.length > 0 && mainChart.current) {
      updateIndicators();
    }
  }, [indicators, updateIndicators]);

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
    for (const pl of profitLinesRef.current) {
      try { series.removePriceLine(pl); } catch {}
    }
    profitLinesRef.current = [];

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

    // —— 利润测算（预案/汇流/微构 全部由画布层 drawZones 融合呈现） ——
    // 原生价格线已按反馈移除：与透明测算框叠加曾致同一价位双线双标签。

    // 透明测算框（风险/盈利/汇流/FVG 区域化呈现，叠加画布绘制）
    drawZonesRef.current();
  }, [showAutoAB9, showFibonacci, showProfit, showMicro, isMember, symbol]);

  // === 测算与结构画线（画布层：渐变区 / 边界线 / 芯片标签） ===
  // 画法原则（按用户反馈收敛）：
  //   AB9/FIB → 原生满宽价格线（价格轴精确读数，经典画法）
  //   流动性池 → 等高/等低两点连线 + 端点圆（EQH/EQL 经典标法）
  //   方案A（止损/入场/TP1/TP2）→ 区域边界即线：渐变面 + 贴边细线 + 带价格芯片，
  //     一个价位只出现一次（原生满宽线已移除，避免三层叠加双标签）
  //   汇流/FVG 区 → 渐变面 + 上下沿边线
  //   其余候选位射线（B方案/延伸档/目标位/FVG CE/池延伸）→ 已隐藏，数据在AI卡片呈现
  const drawZones = useCallback(() => {
    const canvas = zoneCanvasRef.current;
    const chart = mainChart.current;
    const series = candleSeries.current;
    if (!canvas || !chart || !series) return;
    const parent = canvas.parentElement;
    const ctx = canvas.getContext('2d');
    if (!parent || !ctx) return;

    // 画布尺寸与容器同步（含 devicePixelRatio，高分屏不糊）
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pdata = profitDataRef.current;
    const pd = isMember && pdata && pdata.symbol === symbol ? pdata : null;
    if (!isMember) return;
    if (!pd || (!showProfit && !showMicro)) return;

    // 可绘制区域 = 容器剔除右侧价格轴 + 底部时间轴
    let paneW = w;
    let paneH = h;
    try {
      paneW = w - chart.priceScale('right').width();
      paneH = h - chart.timeScale().height();
    } catch {}
    if (paneW <= 10 || paneH <= 10) return;

    const ts = chart.timeScale();
    const yOf = (p: number): number | null => {
      try {
        const c = series.priceToCoordinate(p);
        return c == null ? null : (c as number);
      } catch { return null; }
    };
    const xOf = (t: number): number | null => {
      try {
        const c = ts.timeToCoordinate(t as Time);
        return c == null ? null : (c as number);
      } catch { return null; }
    };

    const klines = allKlinesRef.current;
    const xEnd = paneW - 2;
    // 可视区左缘时间：锚点在其左侧时射线从 0 开始
    let visFrom: number | null = null;
    try {
      const vr = ts.getVisibleRange();
      if (vr) visFrom = vr.from as unknown as number;
    } catch {}
    const anchorX = (t: number | null | undefined): number | null => {
      if (t == null) return null;
      if (visFrom != null && t < visFrom) return 0;
      return xOf(t);
    };

    // 价位去重：方案A四条原生线已画，画布层同价（<0.2%现价）不再重复画
    const drawnPrices: number[] = [];
    const refPrice = pd?.currentPrice || (klines.length ? klines[klines.length - 1].close : 1);
    if (pd && showProfit) {
      const pa = pd.plans.find((p) => p.id === 'A');
      if (pa) drawnPrices.push(pa.entry, pa.stop, pa.tp1, pa.tp2);
    }
    const isDupPrice = (p: number) => drawnPrices.some((x) => Math.abs(x - p) / refPrice < 0.002);

    // —— 画法原语：水平线（实/虚/点，从 x0 到右缘） ——
    const hline = (y: number, x0: number, color: string, width: number, dash: number[]) => {
      if (xEnd - x0 < 4) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(xEnd, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();
    };
    // 统一标签槽位：芯片与射线标签共用（阈值 13px ≈ 标签框高，保证互不压字）
    const occupiedY: number[] = [];
    // 射线起点小标签（深底彩字）；与已占槽位冲突时上/下让位 13px，仍冲突则丢弃
    const rayLabel = (x: number, y: number, text: string, color: string) => {
      let yy = y;
      if (occupiedY.some((sy) => Math.abs(sy - yy) < 13)) {
        yy = y - 13;
        if (occupiedY.some((sy) => Math.abs(sy - yy) < 13)) {
          yy = y + 13;
          if (occupiedY.some((sy) => Math.abs(sy - yy) < 13)) return;
        }
      }
      occupiedY.push(yy);
      ctx.font = '10px -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif';
      const tw = ctx.measureText(text).width;
      const bx = Math.min(Math.max(x, 2), paneW - tw - 8);
      ctx.fillStyle = 'rgba(10, 14, 23, 0.75)';
      ctx.fillRect(bx, yy - 7, tw + 6, 14);
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 3, yy + 0.5);
    };
    // 锚点圆标记（A/B 波段端点、等高/等低端点）
    const dot = (x: number, y: number, color: string, r = 3, text?: string) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (text) {
        ctx.font = '600 10px -apple-system, "PingFang SC", sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + r + 3, y);
      }
    };

    // ===== 第一层：利润测算 / 微构（区域 + 芯片优先占槽位，核心信息不让位） =====
    if (pd && (showProfit || showMicro)) {

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    // 右缘纯文字标签：无底框无边框，颜色即语义（TradingView 头寸工具读数风格）；
    // 右对齐贴价格轴一侧，碰撞时上下让 12px；深色描边保证压 K 线时可读
    const tag = (y: number, text: string, color: string) => {
      let yy = y;
      if (occupiedY.some((sy) => Math.abs(sy - yy) < 12)) {
        yy = y - 12;
        if (occupiedY.some((sy) => Math.abs(sy - yy) < 12)) {
          yy = y + 12;
          if (occupiedY.some((sy) => Math.abs(sy - yy) < 12)) return;
        }
      }
      if (yy < 7 || yy > paneH - 7) return;
      occupiedY.push(yy);
      ctx.font = '600 10px -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(8, 12, 20, 0.85)';
      ctx.strokeText(text, xEnd - 5, yy);
      ctx.fillStyle = color;
      ctx.fillText(text, xEnd - 5, yy);
    };

    // 色带填充：a1 省略 = 平涂（TradingView 头寸工具风格）；传 a1 = 左实右虚渐变（微构沿用）
    const zoneFill = (
      y1: number | null, y2: number | null, x0: number,
      rgb: string, a0: number, a1?: number,
    ): { top: number; mid: number; h: number } | null => {
      if (y1 == null || y2 == null || !Number.isFinite(y1) || !Number.isFinite(y2)) return null;
      const top = Math.max(0, Math.min(y1, y2));
      const bot = Math.min(paneH, Math.max(y1, y2));
      if (bot - top < 1.5 || xEnd - x0 < 8) return null;
      if (a1 == null) {
        ctx.fillStyle = `rgba(${rgb}, ${a0})`;
      } else {
        const g = ctx.createLinearGradient(x0, 0, xEnd, 0);
        g.addColorStop(0, `rgba(${rgb}, ${a0})`);
        g.addColorStop(1, `rgba(${rgb}, ${a1})`);
        ctx.fillStyle = g;
      }
      ctx.fillRect(x0, top, xEnd - x0, bot - top);
      return { top, mid: (top + bot) / 2, h: bot - top };
    };

    if (showProfit) {
      // 投影区仅当最后一根K线在可视区附近才画（回看历史时不投影，避免色块盖旧K线误导）
      let planVisible = false;
      try {
        const lr = ts.getVisibleLogicalRange();
        if (lr && klines.length) {
          const lastIdx = klines.length - 1;
          planVisible = lr.to >= lastIdx - 1 && lr.from <= lastIdx + 8;
        }
      } catch {}
      if (planVisible && klines.length > 2) {
        // 锚点：最后一根K线往左约 18 根（覆盖近期K线 + 右侧未来空间）
        const xLast = xOf(klines[klines.length - 1].time);
        const xPrev = xOf(klines[klines.length - 2].time);
        if (xLast != null && xPrev != null) {
          const step = Math.max(1, Math.abs(xLast - xPrev));
          const projX0 = Math.max(0, xLast - step * 18);
          const pa = pd.plans.find((p) => p.id === 'A');
          if (pa) {
            const dist = (a: number, b: number) => ((Math.abs(a - b) / pa.entry) * 100).toFixed(1);
            const fmt = (p: number) => (p >= 100 ? p.toFixed(1) : p.toFixed(2));
            // ===== TradingView 头寸工具画法 =====
            // 平涂色带（红=风险 / 绿=盈利，TP2 档加深）+ 细线（入场虚线、目标点线）
            // + 右缘纯文字（名称+价格+距离/概率）。无渐变、无底框、无粗线。
            zoneFill(yOf(pa.entry), yOf(pa.stop), projX0, '239, 68, 68', 0.09);
            zoneFill(yOf(pa.entry), yOf(pa.tp1), projX0, '34, 197, 94', 0.07);
            zoneFill(yOf(pa.tp1), yOf(pa.tp2), projX0, '34, 197, 94', 0.13);
            const yE = yOf(pa.entry), yS = yOf(pa.stop), yT1 = yOf(pa.tp1), yT2 = yOf(pa.tp2);
            if (yE != null) hline(yE, projX0, 'rgba(96, 165, 250, 0.85)', 1, [5, 4]);
            if (yS != null) hline(yS, projX0, 'rgba(248, 113, 113, 0.7)', 1, [2, 3]);
            if (yT1 != null) hline(yT1, projX0, 'rgba(74, 222, 128, 0.7)', 1, [2, 3]);
            if (yT2 != null) hline(yT2, projX0, 'rgba(74, 222, 128, 0.8)', 1, [2, 3]);
            if (yS != null) tag(yS, `止损 ${fmt(pa.stop)} −${dist(pa.stop, pa.entry)}%`, '#f87171');
            if (yE != null) tag(yE, `入场 ${fmt(pa.entry)}`, '#60a5fa');
            if (yT1 != null) tag(yT1, `TP1 ${fmt(pa.tp1)} +${dist(pa.tp1, pa.entry)}%${pa.tp1ProbabilityPct != null ? `·${pa.tp1ProbabilityPct}%` : ''}`, '#4ade80');
            if (yT2 != null) tag(yT2, `TP2 ${fmt(pa.tp2)} +${dist(pa.tp2, pa.entry)}%${pa.tp2ProbabilityPct != null ? `·${pa.tp2ProbabilityPct}%` : ''}`, '#4ade80');
          }
          // ===== 汇流止盈区（平涂 + 点线边 + 右缘文字，与方案A同风格） =====
          if (pd.confluence) {
            const c = pd.confluence;
            zoneFill(yOf(c.high), yOf(c.low), projX0, '245, 158, 11', 0.10);
            const yh = yOf(c.high);
            const yl = yOf(c.low);
            if (yh != null && !isDupPrice(c.high)) hline(yh, projX0, 'rgba(251, 191, 36, 0.55)', 1, [2, 3]);
            if (yl != null && !isDupPrice(c.low)) hline(yl, projX0, 'rgba(251, 191, 36, 0.55)', 1, [2, 3]);
            if (yh != null && yl != null) tag((yh + yl) / 2, `汇流 ${c.probabilityPct}%`, '#fbbf24');
          }
          // ===== 汇流止盈区之后的候选位射线已按反馈隐藏 =====
          // （B方案射线 / 延伸档 / 8个方法候选目标位不再画线；
          //   数据仍在 AI 分析卡片中完整呈现，图表只保留方案A + 汇流区）
        }
      }
    }

    if (showMicro) {
      // ===== FVG 缺口（仅渐变面；CE 50% 射线按反馈隐藏） =====
      for (const f of pd.fairValueGaps || []) {
        let x0: number | null;
        if (f.formedAt == null) x0 = null;
        else x0 = anchorX(f.formedAt);
        if (x0 == null) continue;
        zoneFill(yOf(f.high), yOf(f.low), Math.max(0, x0), '99, 102, 241', 0.13);
      }
      // ===== 流动性池（等高/等低两点连线 + 端点圆；右延伸线按反馈隐藏） =====
      // 交易员标注 EQH/EQL 的经典画法：连线直观呈现"两个等高点"
      for (const p of pd.liquidityPools || []) {
        if (isDupPrice(p.price)) continue;
        const y = yOf(p.price);
        if (y == null || y < 0 || y > paneH) continue;
        const x2 = p.formedAt != null ? anchorX(p.formedAt) : null;
        const x1 = p.firstAt != null ? anchorX(p.firstAt) : null;
        const color = 'rgba(6, 182, 212, 0.9)';
        if (x1 != null && x2 != null && x2 - x1 > 3) {
          // 两点连线（实线，比射线粗一点——这是池的本体）
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(x1, Math.round(y) + 0.5);
          ctx.lineTo(x2, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.restore();
          // 端点小圆：两个等高/等低点
          dot(x1, y, color, 2.5);
          dot(x2, y, color, 2.5);
          // 标签贴在形成点右侧
          rayLabel(x2 + 4, y, `流动性池·${p.side === 'high' ? '等高' : '等低'}`, 'rgba(103, 232, 249, 0.95)');
        }
      }
    }
    } // ===== 第一层结束 =====
  }, [showProfit, showMicro, isMember, symbol]);
  drawZonesRef.current = drawZones;

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
      color: k.close >= k.open ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)',
    }));

    candleSeries.current.setData(candleData);
    volumeSeries.current.setData(volumeData);

    updateIndicators();

    // === AB9线 + 斐波那契回调线（各自独立控制）===
    redrawOverlayLines();

    if (candleSeries.current) {
      candleSeries.current.setMarkers([]);
    }

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
    }
  }, [updateIndicators, redrawOverlayLines]);

  // 切换画线开关时仅重画线（不再整图重载、不重置视图）
  useEffect(() => {
    redrawOverlayLines();
  }, [redrawOverlayLines]);

  // 拉取结构分析数据（利润测算+微构画线的数据源，与 AI 分析卡片同接口同缓存）
  // 服务端按 4h 收盘缓存，这里 5 分钟静默轮询：跨 4h 收盘后能自动换新结构
  useEffect(() => {
    if ((!showProfit && !showMicro) || !isMember || !symbol) return;
    let cancelled = false;
    const fetchOnce = () => {
      const st = profitFetchStateRef.current;
      if (st && st.symbol === symbol && Date.now() - st.at < 4.5 * 60_000 && profitDataRef.current) return;
      apiGet<Partial<ProfitLineData>>(`/api/structure-analysis?symbol=${symbol}`)
        .then((d) => {
          if (cancelled || !d || !Array.isArray(d.plans)) return;
          profitDataRef.current = { ...(d as ProfitLineData), symbol };
          profitFetchStateRef.current = { symbol, at: Date.now() };
          redrawOverlayLines();
        })
        .catch(() => {});
    };
    fetchOnce();
    const timer = setInterval(fetchOnce, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [showProfit, showMicro, isMember, symbol, redrawOverlayLines]);

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

    // 实时价可能推动价格刻度缩放，透明框的纵向坐标随之刷新（画几个矩形，开销可忽略）
    drawZonesRef.current();
  }, []);

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
        color: kline.close >= kline.open ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)',
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
        color: kline.close >= kline.open ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)',
      });
    }

    if (isFinal) {
      updateIndicators();
      // K线收盘后重算 AB9 / 斐波那契画线：新分形确认、突破换段都能及时反映，
      // 修复此前盘中形成的新高/新低要等手动刷新才会体现在画线上的问题
      redrawOverlayLines();
    }
  }, [updateIndicators, redrawOverlayLines]);

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

    // 主图
    const chart = createChart(mainChartRef.current, {
      layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
      grid: {
        vertLines: { color: 'rgba(71, 85, 105, 0.2)' },
        horzLines: { color: 'rgba(71, 85, 105, 0.2)' },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: '#3b82f6', width: 1, style: 2, labelBackgroundColor: '#3b82f6' },
        horzLine: { color: '#3b82f6', width: 1, style: 2, labelBackgroundColor: '#3b82f6' },
      },
      timeScale: { borderColor: 'rgba(71, 85, 105, 0.4)', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(71, 85, 105, 0.4)' },
    });

    const candle = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(148, 163, 184, 0.5)',
      priceLineWidth: 1,
      priceLineStyle: 2,
    });

    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    // MACD 副图
    const mChart = createChart(macdChartRef.current, {
      layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
      grid: {
        vertLines: { color: 'rgba(71, 85, 105, 0.12)' },
        horzLines: { color: 'rgba(71, 85, 105, 0.12)' },
      },
      timeScale: { borderColor: 'rgba(71, 85, 105, 0.4)', timeVisible: true },
      rightPriceScale: { borderColor: 'rgba(71, 85, 105, 0.4)' },
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
        layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
        grid: {
          vertLines: { color: 'rgba(71, 85, 105, 0.12)' },
          horzLines: { color: 'rgba(71, 85, 105, 0.12)' },
        },
        timeScale: { borderColor: 'rgba(71, 85, 105, 0.4)', timeVisible: true },
        rightPriceScale: { borderColor: 'rgba(71, 85, 105, 0.4)', autoScale: true },
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

    // 主图和MACD联动（平移/缩放同时刷新测算透明框的坐标）
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) mChart.timeScale().setVisibleLogicalRange(range);
      drawZonesRef.current();
    });

    mainChart.current = chart;
    macdChart.current = mChart;
    rsiChart.current = rChart;
    candleSeries.current = candle;
    volumeSeries.current = volume;
    macdHist.current = hist;
    macdDif.current = dif;
    macdDea.current = dea;
    rsiLine.current = rLine;
    rsiOverbought.current = rOver;
    rsiOversold.current = rUnder;

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
      // 尺寸变化后图表重排，下一帧再画透明框（坐标才是新的）
      requestAnimationFrame(() => drawZonesRef.current());
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      mChart.remove();
      if (rChart) rChart.remove();
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
      drawZonesRef.current();
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
          {(['EMA', 'BOLL', 'MACD', 'RSI'] as const).map((ind) => (
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
              {ind}
            </button>
          ))}
          {/* AB9 + 斐波那契 独立按钮 */}
          {isMember && (
            <>
              <div className="w-px h-4 bg-dark-700" />
              <button
                onClick={() => { const v = !showAutoAB9; setShowAutoAB9(v); saveUserPref('prefAB9', v); }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${showAutoAB9 ? 'text-cyan-400' : 'text-dark-600'}`}
                title="AB9线"
              >
                AB9
              </button>
              <button
                onClick={() => { const v = !showFibonacci; setShowFibonacci(v); saveUserPref('prefFibonacci', v); }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${showFibonacci ? 'text-cyan-400' : 'text-dark-600'}`}
                title="斐波那契回调线"
              >
                FIB
              </button>
              <button
                onClick={() => {
                  const v = !showProfit;
                  setShowProfit(v);
                  try { window.localStorage.setItem(PROFIT_PREF_KEY, v ? '1' : '0'); } catch {}
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${showProfit ? 'text-amber-400' : 'text-dark-600'}`}
                title="利润测算画线（结构分析：预案 / 汇流止盈区 / 目标位）"
              >
                止盈
              </button>
              <button
                onClick={() => {
                  const v = !showMicro;
                  setShowMicro(v);
                  try { window.localStorage.setItem(MICRO_PREF_KEY, v ? '1' : '0'); } catch {}
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${showMicro ? 'text-indigo-400' : 'text-dark-600'}`}
                title="微观结构位画线（流动性池·等高/等低 + FVG缺口·50%回补），独立于止盈画线"
              >
                微构
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
        <div className="relative w-full" style={{ height: isFullscreen ? 'calc(100vh - 40px)' : '620px' }}>
          <div
            ref={mainChartRef}
            className="w-full h-full"
            style={{ cursor: 'default' }}
          />
          {/* 测算透明框层：风险/盈利/汇流/FVG 区域化呈现；pointer-events-none 不挡K线交互 */}
          <canvas
            ref={zoneCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 2 }}
          />
        </div>
      </div>

      {/* MACD 副图（全屏时隐藏） */}
      <div className={`border-t border-dark-700/30 ${isFullscreen ? 'hidden' : ''}`}>
        <div ref={macdChartRef} className="w-full" style={{ height: '120px' }} />
      </div>

      {/* RSI 副图（全屏时隐藏） */}
      <div className={`border-t border-dark-700/30 ${isFullscreen ? 'hidden' : ''}`}>
        <div ref={rsiChartRef} className="w-full" style={{ height: '100px' }} />
      </div>
    </div>
  );
}
