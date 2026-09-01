'use client';

/**
 * 技术指标面板 · IndicatorPanel
 *
 * 路径：src/components/trading/IndicatorPanel.tsx
 *
 * 功能：
 *   - 独立小图展示 4 个核心指标（用 lightweight-charts 官方库）
 *   - 上：价格 + EMA9/EMA21 + 布林带（主图）
 *   - 中：RSI(14) 副图（含 30/70 超买超卖线）
 *   - 下：MACD 柱状图 + DIF/DEA 线副图
 *   - 60 秒自动刷新（4h 周期，不需要太快）
 *   - 暗色主题，适配盯盘
 *
 * 替代原来的 AI 分析卡片位置
 */

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
} from 'lightweight-charts';
import useSymbolStore from '@/store/symbolStore';

// 颜色
const CANDLE_UP = '#0ecb81';
const CANDLE_DOWN = '#f6465d';
const GRID_COLOR = 'rgba(132, 142, 156, 0.08)';
const AXIS_BORDER = 'rgba(132, 142, 156, 0.15)';
const EMA9_COLOR = '#f59e0b';
const EMA21_COLOR = '#3b82f6';
const BB_COLOR = 'rgba(168, 85, 247, 0.6)';
const RSI_COLOR = '#22d3ee';
const RSI_OVERBOUGHT = 'rgba(246, 70, 93, 0.4)';
const RSI_OVERSOLD = 'rgba(14, 203, 129, 0.4)';
const MACD_HIST_UP = '#0ecb81';
const MACD_HIST_DOWN = '#f6465d';
const MACD_DIF = '#3b82f6';
const MACD_DEA = '#f59e0b';

interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export default function IndicatorPanel() {
  const { symbol } = useSymbolStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [interval, setIntervalState] = useState('4h');

  const mainRef = useRef<HTMLDivElement>(null);
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);

  const mainChart = useRef<IChartApi | null>(null);
  const rsiChart = useRef<IChartApi | null>(null);
  const macdChart = useRef<IChartApi | null>(null);

  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema9Series = useRef<ISeriesApi<'Line'> | null>(null);
  const ema21Series = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpper = useRef<ISeriesApi<'Line'> | null>(null);
  const bbMiddle = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLower = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiLine = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiUpper = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiLower = useRef<ISeriesApi<'Line'> | null>(null);
  const macdHistSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const macdDifSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const macdDeaSeries = useRef<ISeriesApi<'Line'> | null>(null);

  const initialized = useRef(false);

  // ========== 指标计算 ==========

  const ema = (values: number[], period: number): number[] => {
    const k = 2 / (period + 1);
    const result: number[] = [values[0]];
    for (let i = 1; i < values.length; i++) {
      result.push(values[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  };

  const calcBollinger = (closes: number[], period: number = 20, stdDev: number = 2) => {
    const upper: number[] = [];
    const middle: number[] = [];
    const lower: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) {
        upper.push(NaN); middle.push(NaN); lower.push(NaN);
        continue;
      }
      const slice = closes.slice(i - period + 1, i + 1);
      const mid = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((sum, v) => sum + (v - mid) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      upper.push(mid + sd * stdDev);
      middle.push(mid);
      lower.push(mid - sd * stdDev);
    }
    return { upper, middle, lower };
  };

  const calcRSI = (closes: number[], period: number = 14): number[] => {
    const result: number[] = [50];
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      if (i <= period) {
        avgGain += gain;
        avgLoss += loss;
        if (i === period) {
          avgGain /= period;
          avgLoss /= period;
          const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
          result.push(100 - 100 / (1 + rs));
        } else {
          result.push(50);
        }
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push(100 - 100 / (1 + rs));
      }
    }
    return result;
  };

  const calcMACD = (closes: number[], fastP = 12, slowP = 26, signalP = 9) => {
    const emaFast = ema(closes, fastP);
    const emaSlow = ema(closes, slowP);
    const dif: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      dif.push(emaFast[i] - emaSlow[i]);
    }
    const dea = ema(dif, signalP);
    const hist: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      hist.push(dif[i] - dea[i]);
    }
    return { dif, dea, hist };
  };

  // ========== 初始化图表 ==========

  const initCharts = useCallback(() => {
    if (initialized.current) return;
    if (!mainRef.current || !rsiRef.current || !macdRef.current) return;

    const commonOpts = {
      layout: {
        background: { color: 'transparent' },
        textColor: '#848e9c',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: GRID_COLOR, style: 2 },
        horzLines: { color: GRID_COLOR, style: 2 },
      },
      rightPriceScale: {
        borderColor: AXIS_BORDER,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: AXIS_BORDER,
        timeVisible: false,
        secondsVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(88, 110, 160, 0.5)', style: 2 },
        horzLine: { color: 'rgba(88, 110, 160, 0.5)', style: 2 },
      },
      handleScroll: false,
      handleScale: false,
    };

    // 主图
    mainChart.current = createChart(mainRef.current, {
      ...commonOpts,
      height: 180,
      rightPriceScale: { ...commonOpts.rightPriceScale, scaleMargins: { top: 0.05, bottom: 0.05 } },
    });

    candleSeries.current = mainChart.current.addCandlestickSeries({
      upColor: CANDLE_UP,
      downColor: CANDLE_DOWN,
      borderUpColor: CANDLE_UP,
      borderDownColor: CANDLE_DOWN,
      wickUpColor: CANDLE_UP,
      wickDownColor: CANDLE_DOWN,
    });

    ema9Series.current = mainChart.current.addLineSeries({
      color: EMA9_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    ema21Series.current = mainChart.current.addLineSeries({
      color: EMA21_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    bbUpper.current = mainChart.current.addLineSeries({
      color: BB_COLOR,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    bbMiddle.current = mainChart.current.addLineSeries({
      color: BB_COLOR,
      lineWidth: 1,
      lineStyle: 3,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    bbLower.current = mainChart.current.addLineSeries({
      color: BB_COLOR,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // RSI 副图
    rsiChart.current = createChart(rsiRef.current, {
      ...commonOpts,
      height: 90,
      rightPriceScale: { ...commonOpts.rightPriceScale, scaleMargins: { top: 0.15, bottom: 0.15 } },
    });

    rsiLine.current = rsiChart.current.addLineSeries({
      color: RSI_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    rsiUpper.current = rsiChart.current.addLineSeries({
      color: RSI_OVERBOUGHT,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    rsiLower.current = rsiChart.current.addLineSeries({
      color: RSI_OVERSOLD,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // MACD 副图
    macdChart.current = createChart(macdRef.current, {
      ...commonOpts,
      height: 90,
      rightPriceScale: { ...commonOpts.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.1 } },
    });

    macdHistSeries.current = macdChart.current.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    });

    macdDifSeries.current = macdChart.current.addLineSeries({
      color: MACD_DIF,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    macdDeaSeries.current = macdChart.current.addLineSeries({
      color: MACD_DEA,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // 时间轴同步
    mainChart.current.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) {
        rsiChart.current?.timeScale().setVisibleLogicalRange(range);
        macdChart.current?.timeScale().setVisibleLogicalRange(range);
      }
    });

    initialized.current = true;
  }, []);

  // ========== 拉数据 + 更新图表 ==========

  const loadData = useCallback(async () => {
    if (!symbol) return;
    try {
      const res = await fetch(`/api/klines?symbol=${symbol}&interval=${interval}&limit=150`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error('无数据');
      const klines: Kline[] = data.map((k: any[]) => ({
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
      updateCharts(klines);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [symbol, interval]);

  const updateCharts = useCallback((klines: Kline[]) => {
    if (!initialized.current) return;
    if (!candleSeries.current || !ema9Series.current) return;

    const closes = klines.map(k => k.close);
    const times = klines.map(k => k.time as Time);

    // 蜡烛图
    const candleData: CandlestickData[] = klines.map(k => ({
      time: k.time as Time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
    candleSeries.current?.setData(candleData);

    // EMA
    const ema9Data = ema(closes, 9);
    const ema21Data = ema(closes, 21);
    ema9Series.current?.setData(times.map((t, i) => ({ time: t, value: ema9Data[i] })));
    ema21Series.current?.setData(times.map((t, i) => ({ time: t, value: ema21Data[i] })));

    // 布林带
    const bb = calcBollinger(closes, 20, 2);
    bbUpper.current?.setData(times.map((t, i) => ({ time: t, value: bb.upper[i] })).filter(d => !isNaN(d.value)));
    bbMiddle.current?.setData(times.map((t, i) => ({ time: t, value: bb.middle[i] })).filter(d => !isNaN(d.value)));
    bbLower.current?.setData(times.map((t, i) => ({ time: t, value: bb.lower[i] })).filter(d => !isNaN(d.value)));

    // RSI
    const rsiData = calcRSI(closes, 14);
    rsiLine.current?.setData(times.map((t, i) => ({ time: t, value: rsiData[i] })));
    rsiUpper.current?.setData(times.map(t => ({ time: t, value: 70 })));
    rsiLower.current?.setData(times.map(t => ({ time: t, value: 30 })));

    // MACD
    const macd = calcMACD(closes, 12, 26, 9);
    const histData: HistogramData[] = times.map((t, i) => ({
      time: t,
      value: macd.hist[i],
      color: macd.hist[i] >= 0 ? MACD_HIST_UP : MACD_HIST_DOWN,
    }));
    macdHistSeries.current?.setData(histData);
    macdDifSeries.current?.setData(times.map((t, i) => ({ time: t, value: macd.dif[i] })));
    macdDeaSeries.current?.setData(times.map((t, i) => ({ time: t, value: macd.dea[i] })));

    // 时间轴缩放到最后一段
    mainChart.current?.timeScale().fitContent();
  }, []);

  // ========== 生命周期 ==========

  // 初始化图表（仅客户端，挂载后执行一次）
  useEffect(() => {
    initCharts();
    loadData();
    const timer = setInterval(loadData, 60 * 1000);

    // resize 处理
    const handleResize = () => {
      if (!mainRef.current || !rsiRef.current || !macdRef.current) return;
      mainChart.current?.applyOptions({ width: mainRef.current.clientWidth });
      rsiChart.current?.applyOptions({ width: rsiRef.current.clientWidth });
      macdChart.current?.applyOptions({ width: macdRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);

    // 清理：卸载时销毁图表实例，防止内存泄漏
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', handleResize);
      mainChart.current?.remove();
      rsiChart.current?.remove();
      macdChart.current?.remove();
      mainChart.current = null;
      rsiChart.current = null;
      macdChart.current = null;
      initialized.current = false;
    };
  }, [initCharts, loadData]);

  const intervals = [
    { key: '15m', label: '15m' },
    { key: '1h', label: '1h' },
    { key: '4h', label: '4h' },
    { key: '1d', label: '1D' },
  ];

  return (
    <div className="glass-card overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">📊 技术指标</span>
          <span className="text-xs text-dark-500">{symbol}</span>
        </div>
        <div className="flex items-center gap-1">
          {intervals.map(iv => (
            <button
              key={iv.key}
              onClick={() => setIntervalState(iv.key)}
              className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                interval === iv.key
                  ? 'bg-blue-600/40 text-blue-300 border border-blue-500/40'
                  : 'text-dark-400 hover:text-dark-200 border border-transparent'
              }`}
            >
              {iv.label}
            </button>
          ))}
        </div>
      </div>

      {/* 图表区（始终渲染容器，保证 ref 在 useEffect 执行时已存在） */}
      <div className="px-2 py-2 relative">
        {/* 加载/错误覆盖层 */}
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-dark-900/80 text-dark-500 text-sm backdrop-blur-sm">
            加载指标数据...
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-dark-900/80 text-red-400 text-sm backdrop-blur-sm">
            {error}
          </div>
        )}

        <div className="space-y-1">
          {/* 主图：K线 + EMA + 布林带 */}
          <div>
            <div className="flex items-center justify-between px-2 mb-1">
              <div className="flex gap-3 text-[10px]">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-0.5" style={{ background: EMA9_COLOR }} />
                  <span className="text-dark-400">EMA9</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-0.5" style={{ background: EMA21_COLOR }} />
                  <span className="text-dark-400">EMA21</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-0.5" style={{ background: BB_COLOR }} />
                  <span className="text-dark-400">BOLL(20,2)</span>
                </span>
              </div>
            </div>
            <div ref={mainRef} className="w-full" style={{ height: 180 }} />
          </div>

          {/* RSI 副图 */}
          <div>
            <div className="flex items-center justify-between px-2 mb-1">
              <span className="text-[10px] text-dark-400">RSI(14)</span>
              <span className="text-[10px] text-dark-500">30 / 70</span>
            </div>
            <div ref={rsiRef} className="w-full" style={{ height: 90 }} />
          </div>

          {/* MACD 副图 */}
          <div>
            <div className="flex items-center justify-between px-2 mb-1">
              <div className="flex gap-3 text-[10px]">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-0.5" style={{ background: MACD_DIF }} />
                  <span className="text-dark-400">DIF</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-0.5" style={{ background: MACD_DEA }} />
                  <span className="text-dark-400">DEA</span>
                </span>
                <span className="text-dark-400">MACD柱</span>
              </div>
            </div>
            <div ref={macdRef} className="w-full" style={{ height: 90 }} />
          </div>
        </div>
      </div>

      {/* 底部说明 */}
      <div className="px-4 py-2 border-t border-dark-800 text-[10px] text-dark-500 flex items-center justify-between">
        <span>4 路指标实时计算 · 60 秒自动刷新</span>
        <span>EMA交叉 + BOLL + RSI + MACD</span>
      </div>
    </div>
  );
}
