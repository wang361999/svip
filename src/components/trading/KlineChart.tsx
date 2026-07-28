'use client';

import {
  calcBollinger,
  calcMACD,
  calcFibonacci,
  calcSMAArray,
  calcEMAArray,
  calcRSIArray,
  calcATRArray,
  calcAB9Lines,
  calcTDSequential,
  AB9Analysis,
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

const FIB_COLORS: Record<number, string> = {
  0: 'rgba(148, 163, 184, 0.8)',
  236: 'rgba(56, 189, 248, 0.85)',
  382: 'rgba(34, 197, 94, 0.95)',
  50: 'rgba(251, 191, 36, 0.9)',
  618: 'rgba(249, 115, 22, 1.0)',
  786: 'rgba(239, 68, 68, 0.85)',
  100: 'rgba(168, 85, 247, 0.85)',
  1272: 'rgba(236, 72, 153, 0.75)',
  1618: 'rgba(20, 184, 166, 0.75)',
};

const FIB_LABELS: Record<number, string> = {
  0: '0', 236: '0.236', 382: '0.382', 50: '0.5',
  618: '0.618', 786: '0.786', 100: '1', 1272: 'E1.272', 1618: 'E1.618',
};

const FIB_LINE_STYLES: Record<number, number> = {
  0: 0, 236: 0, 382: 0, 50: 0,
  618: 0, 786: 0, 100: 0, 1272: 2, 1618: 2, // 扩展位用虚线(2)
};

// 手动斐波那契多组颜色
const FIB_GROUP_PALETTES = [
  { name: '琥珀', border: '#f59e0b', color: 'rgba(251, 191, 36, %OP%)' },
  { name: '青色', border: '#06b6d4', color: 'rgba(6, 182, 212, %OP%)' },
  { name: '绿色', border: '#22c55e', color: 'rgba(34, 197, 94, %OP%)' },
  { name: '玫红', border: '#f43f5e', color: 'rgba(244, 63, 94, %OP%)' },
  { name: '紫色', border: '#a855f7', color: 'rgba(168, 85, 247, %OP%)' },
];

interface KlineChartProps {
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
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
  const maSeries = useRef<ISeriesApi<'Line'> | null>(null);
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
  const fibLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const manualFibRef = useRef<ISeriesApi<'Line'>[]>([]);
  const manualFibGroupsRef = useRef<{ series: ISeriesApi<'Line'>[]; colorIdx: number }[]>([]);
  const fibDrawPointsRef = useRef<{ price: number; time: number }[]>([]);

  const [markers, setMarkers] = useState<{ id: number; x: number; y: number }[]>([]);

  const allKlinesRef = useRef<KlineData[]>([]);
  const pendingTickRef = useRef<number | null>(null);
  const rAFRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number>(0);

  // 手动画斐波那契状态
  const [fibDrawMode, setFibDrawMode] = useState(false);
  const [fibDrawStep, setFibDrawStep] = useState(0); // 0: 未开始, 1: 等第二点, 2: 已完成
  const [fibDrawPoints, setFibDrawPoints] = useState<{ price: number; time: number }[]>([]);
  const [showFibDraw, setShowFibDraw] = useState(true);
  const [fibGroupCount, setFibGroupCount] = useState(0);

  // 自动画线（斐波那契 + AB9线）— 默认 AB9开、斐波那契关，避免两种画线同时显示
  const [showAutoFib, setShowAutoFib] = useState(false);
  const [showAutoAB9, setShowAutoAB9] = useState(true);
  const [showAB9Labels, setShowAB9Labels] = useState(true);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // 斐波那契线显示开关（从后台加载）
  const [fibLabeled, setFibLabeled] = useState(true);
  const [fibUnlabeled, setFibUnlabeled] = useState(true);
  const autoLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const autoPriceLinesRef = useRef<any[]>([]);


  const [indicators, setIndicators] = useState({
    MA: true,
    EMA: false,
    BOLL: true,
    MACD: true,
    RSI: false,
    ATR: false,
    TD: false,
    FIB: false,
    NAKED: false,
  });
  // 指标周期参数（从后台加载）
  const [periods, setPeriods] = useState({
    maPeriod: 50,
    emaPeriod: 20,
    bollPeriod: 20,
    rsiPeriod: 14,
    atrPeriod: 14,
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

  // AB9线颜色配置（从后台加载）
  const [ab9Colors, setAb9Colors] = useState<Record<number, string>>({
    1: 'rgba(100, 116, 139, 0.3)',
    2: 'rgba(100, 116, 139, 0.35)',
    3: 'rgba(239, 68, 68, 0.75)',
    4: 'rgba(148, 163, 184, 0.7)',
    5: 'rgba(34, 197, 94, 0.75)',
    6: 'rgba(100, 116, 139, 0.45)',
    7: 'rgba(100, 116, 139, 0.45)',
    8: 'rgba(148, 163, 184, 0.6)',
    9: 'rgba(168, 85, 247, 0.6)',
  });

  // 加载币种列表
  useEffect(() => {
    fetchSymbols();
  }, [fetchSymbols]);

  // 从后台 API 加载指标配置
  useEffect(() => {
    apiGet<Record<string, string>>('/api/settings')
      .then((data) => {
        setIndicators({
          MA: data.indicatorMA === 'true',
          EMA: data.indicatorEMA === 'true',
          BOLL: data.indicatorBOLL === 'true',
          MACD: data.indicatorMACD === 'true',
          RSI: data.indicatorRSI === 'true',
          ATR: data.indicatorATR === 'true',
          TD: data.indicatorTDSequential === 'true',
          FIB: data.indicatorFIB === 'true',
          NAKED: data.indicatorNAKED === 'true',
        });
        // 加载指标周期参数
        setPeriods({
          maPeriod: parseInt(data.maPeriod || '50', 10) || 50,
          emaPeriod: parseInt(data.emaPeriod || '20', 10) || 20,
          bollPeriod: parseInt(data.bollPeriod || '20', 10) || 20,
          rsiPeriod: parseInt(data.rsiPeriod || '14', 10) || 14,
          atrPeriod: parseInt(data.atrPeriod || '14', 10) || 14,
          macdFast: parseInt(data.macdFast || '12', 10) || 12,
          macdSlow: parseInt(data.macdSlow || '26', 10) || 26,
          macdSignal: parseInt(data.macdSignal || '9', 10) || 9,
        });
        setShowFibDraw(data.showFibDraw === 'true');
        setFibLabeled((data.fibLabeled ?? 'true') === 'true');
        setFibUnlabeled((data.fibUnlabeled ?? 'true') === 'true');
        // 加载 AB9 线颜色配置
        setAb9Colors({
          1: data.ab9Line1Color || 'rgba(100, 116, 139, 0.3)',
          2: data.ab9Line2Color || 'rgba(100, 116, 139, 0.35)',
          3: data.ab9Line3Color || 'rgba(239, 68, 68, 0.75)',
          4: data.ab9Line4Color || 'rgba(148, 163, 184, 0.7)',
          5: data.ab9Line5Color || 'rgba(34, 197, 94, 0.75)',
          6: data.ab9Line6Color || 'rgba(100, 116, 139, 0.45)',
          7: data.ab9Line7Color || 'rgba(100, 116, 139, 0.45)',
          8: data.ab9Line8Color || 'rgba(148, 163, 184, 0.6)',
          9: data.ab9Line9Color || 'rgba(168, 85, 247, 0.6)',
        });
      })
      .catch(() => {});
  }, []);

  // 从用户偏好 API 加载画线开关设置（VIP用户专属）
  useEffect(() => {
    if (!isMember) {
      setPrefsLoaded(true);
      return;
    }
    apiGet<{ prefAB9?: boolean; prefAutoFib?: boolean; prefAB9Labels?: boolean }>('/api/user/preferences')
      .then((data) => {
        if (data.prefAB9 !== undefined) setShowAutoAB9(data.prefAB9);
        if (data.prefAutoFib !== undefined) setShowAutoFib(data.prefAutoFib);
        if (data.prefAB9Labels !== undefined) setShowAB9Labels(data.prefAB9Labels);
        setPrefsLoaded(true);
      })
      .catch(() => setPrefsLoaded(true));
  }, [isMember]);

  // 持久化画线开关偏好到后端
  const saveUserPref = useCallback((key: string, value: boolean) => {
    apiPut('/api/user/preferences', { [key]: value }).catch(() => {});
  }, []);

  // 更新所有指标线
  const updateIndicators = useCallback(() => {
    const klines = allKlinesRef.current;
    if (!klines.length || !mainChart.current) return;

    // 清除旧的斐波那契线
    fibLinesRef.current.forEach((s) => {
      try { mainChart.current?.removeSeries(s); } catch {}
    });
    fibLinesRef.current = [];

    // 清除旧的布林带
    [bbUpper.current, bbMiddle.current, bbLower.current, maSeries.current, emaSeries.current].forEach((s) => {
      if (s) { try { mainChart.current?.removeSeries(s); } catch {} }
    });
    bbUpper.current = bbMiddle.current = bbLower.current = maSeries.current = emaSeries.current = null;

    const from = klines[0].time;
    const to = klines[klines.length - 1].time;

    // MA 均线
    if (indicators.MA) {
      maSeries.current = mainChart.current.addLineSeries({
        color: 'rgba(168, 85, 247, 0.85)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const sma = calcSMAArray(klines, periods.maPeriod);
      const maData: LineData[] = [];
      sma.forEach((v, i) => {
        if (v !== null) maData.push({ time: klines[i].time as Time, value: v });
      });
      maSeries.current.setData(maData);
    }

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

    // 斐波那契（仅会员可用，带标签）
    if (indicators.FIB && isMember && fibLabeled) {
      const fib = calcFibonacci(klines);
      if (fib) {
        // 黄金区域高亮（0.382 ~ 0.618）
        if (fib.levels[382] && fib.levels[618]) {
          const goldenZone = mainChart.current!.addLineSeries({
            color: 'rgba(251, 191, 36, 0.08)',
            lineWidth: 1 as any,
            lineStyle: 0,
            priceLineVisible: false,
            lastValueVisible: false,
            title: '',
            crosshairMarkerVisible: false,
          });
          goldenZone.setData([
            { time: from as Time, value: fib.levels[382] },
            { time: to as Time, value: fib.levels[382] },
          ]);
          // 上边界线
          const goldenTop = mainChart.current!.addLineSeries({
            color: 'rgba(251, 191, 36, 0.2)',
            lineWidth: 1,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            title: '',
            crosshairMarkerVisible: false,
          });
          goldenTop.setData([
            { time: from as Time, value: fib.levels[382] },
            { time: to as Time, value: fib.levels[382] },
          ]);
          fibLinesRef.current.push(goldenZone, goldenTop);
        }

        // 各级别斐波那契线
        [0, 236, 382, 50, 618, 786, 100, 1272, 1618].forEach((k) => {
          if (fib.levels[k] !== undefined) {
            const s = mainChart.current!.addLineSeries({
              color: FIB_COLORS[k] || 'rgba(244, 114, 182, 0.55)',
              lineWidth: 1,
              lineStyle: FIB_LINE_STYLES[k] || 0,
              priceLineVisible: false,
              lastValueVisible: true,
              title: FIB_LABELS[k] || String(k),
            });
            s.setData([
              { time: from as Time, value: fib.levels[k] },
              { time: to as Time, value: fib.levels[k] },
            ]);
            fibLinesRef.current.push(s);
          }
        });
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
    }
  }, [indicators, fibLabeled, periods]);

  // 更新K线数据
  const updateChart = useCallback((klines: KlineData[]) => {
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

    // === 自动画线：斐波那契 + AB9线 ===
    if (mainChart.current) {
      // 先清除旧的自动画线
      for (const s of autoLinesRef.current) {
        try { mainChart.current!.removeSeries(s); } catch {}
      }
      autoLinesRef.current = [];
      // 清除旧的 AB9 priceLine 标签
      if (candleSeries.current) {
        for (const pl of autoPriceLinesRef.current) {
          try { candleSeries.current.removePriceLine(pl); } catch {}
        }
      }
      autoPriceLinesRef.current = [];

      const firstTime = klines[0].time as Time;
      const lastTime = klines[klines.length - 1].time as Time;

      // 斐波那契自动画线（虚线，低饱和度，不显示标签，不干扰）
      if (showAutoFib && fibUnlabeled) {
        const fib = calcFibonacci(klines);
        if (fib) {
          const fibLevels = [
            { key: 236, color: 'rgba(56, 189, 248, 0.3)' },
            { key: 382, color: 'rgba(34, 197, 94, 0.35)' },
            { key: 50, color: 'rgba(251, 191, 36, 0.35)' },
            { key: 618, color: 'rgba(249, 115, 22, 0.45)' },
            { key: 786, color: 'rgba(239, 68, 68, 0.3)' },
          ];
          for (const lv of fibLevels) {
            const price = fib.levels[lv.key];
            if (!price) continue;
            const s = mainChart.current!.addLineSeries({
              color: lv.color,
              lineWidth: 1,
              lineStyle: 2,
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerVisible: false,
              title: '',
            });
            s.setData([
              { time: firstTime, value: price },
              { time: lastTime, value: price },
            ]);
            autoLinesRef.current.push(s);
          }
        }
      }

      // AB9线自动画线（虚线，标签放左侧用 priceLine）
      if (showAutoAB9 && isMember) {
        const ab9 = calcAB9Lines(klines);
        if (ab9 && candleSeries.current) {
          const ab9Styles: Record<number, { color: string; width: 1 | 2 | 3 | 4; label: string }> = {
            1: { color: ab9Colors[1], width: 1, label: '1线' },
            2: { color: ab9Colors[2], width: 1, label: '2线' },
            3: { color: ab9Colors[3], width: 1, label: '3线' },
            4: { color: ab9Colors[4], width: 1, label: '4线' },
            5: { color: ab9Colors[5], width: 1, label: '5线' },
            6: { color: ab9Colors[6], width: 1, label: '6线' },
            7: { color: ab9Colors[7], width: 1, label: '7线' },
            8: { color: ab9Colors[8], width: 1, label: '8线' },
            9: { color: ab9Colors[9], width: 1, label: '9线' },
          };
          for (const line of ab9.lines) {
            const style = ab9Styles[line.lineNo];
            if (!style) continue;

            if (showAB9Labels) {
              // 有标签模式：只用 priceLine（自带虚线+左侧标签，不重复画线）
              try {
                const pl = candleSeries.current.createPriceLine({
                  price: line.price,
                  color: style.color.replace(/[\d.]+\)$/, '0.85)'),
                  lineWidth: 1,
                  lineStyle: 2,
                  axisLabelVisible: true,
                  title: ` ${style.label}`,
                });
                autoPriceLinesRef.current.push(pl);
              } catch {}
            } else {
              // 无标签模式：用独立 LineSeries 画虚线
              const s = mainChart.current!.addLineSeries({
                color: style.color,
                lineWidth: style.width,
                lineStyle: 2,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
                title: '',
              });
              s.setData([
                { time: firstTime, value: line.price },
                { time: lastTime, value: line.price },
              ]);
              autoLinesRef.current.push(s);
            }
          }
        }
      }
    }

    // TD Sequential 九转标注（1-9数字）
    if (indicators.TD && candleSeries.current) {
      const tdPoints = calcTDSequential(klines);
      const tdMarkers = tdPoints.map((p) => {
        const isBuy = p.type === 'buy';
        const isNine = p.num === 9;
        return {
          time: p.time as Time,
          position: isBuy ? 'belowBar' as 'belowBar' : 'aboveBar' as 'aboveBar',
          color: isBuy ? '#22c55e' : '#ef4444',
          shape: 'circle' as 'circle',
          text: String(p.num),
          size: isNine ? 2 : 0,
        };
      });
      candleSeries.current.setMarkers(tdMarkers);
    } else if (candleSeries.current) {
      candleSeries.current.setMarkers([]);
    }

    // 切换币种后重置视图，fitContent 先让价格轴适配新数据范围
    if (mainChart.current) {
      mainChart.current.timeScale().fitContent();
      const bars = Math.min(72, klines.length);
      const toIdx = klines.length - 1;
      const fromIdx = Math.max(0, toIdx - bars + 1);
      mainChart.current.timeScale().setVisibleLogicalRange({ from: fromIdx, to: toIdx + 4 });
    }
  }, [updateIndicators, showAutoFib, showAutoAB9, showAB9Labels, ab9Colors, fibUnlabeled]);

  // 切换自动画线开关时重新绘制
  useEffect(() => {
    if (allKlinesRef.current.length > 0) {
      updateChart(allKlinesRef.current);
    }
  }, [showAutoFib, showAutoAB9, showAB9Labels, updateChart]);

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
    }
  }, [updateIndicators]);

  // 获取K线
  const loadKlines = useCallback(async (intv: string) => {
    setLoading(true);
    setError(null);
    try {
      const klines = await fetchKlinesApi(symbol, okxId, intv);
      updateChart(klines);
    } catch (err: any) {
      setError(err.message || '获取K线数据失败');
    } finally {
      setLoading(false);
    }
  }, [updateChart, symbol, okxId]);

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

    // 主图和MACD联动
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) mChart.timeScale().setVisibleLogicalRange(range);
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
    }, 100);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  // 手动画斐波那契
  const markerIdRef = useRef(0);
  const fibColorIdxRef = useRef(0);

  const clearAllManualFib = useCallback(() => {
    manualFibGroupsRef.current.forEach((g) => {
      g.series.forEach((s) => { try { mainChart.current?.removeSeries(s); } catch {} });
    });
    manualFibGroupsRef.current = [];
    fibDrawPointsRef.current = [];
    setMarkers([]);
    setFibDrawStep(0);
    setFibDrawPoints([]);
    setFibDrawMode(false);
    setFibGroupCount(0);
    fibColorIdxRef.current = 0;
  }, []);

  const clearLastManualFib = useCallback(() => {
    if (manualFibGroupsRef.current.length === 0) return;
    const last = manualFibGroupsRef.current.pop()!;
    last.series.forEach((s) => { try { mainChart.current?.removeSeries(s); } catch {} });
    setFibGroupCount(manualFibGroupsRef.current.length);
    setFibDrawStep(0);
    setFibDrawPoints([]);
    setMarkers([]);
  }, []);

  // 吸附到最近的K线针尖（high 或 low，取距离点击位置更近的）
  const snapToWick = useCallback((clickTime: number, clickPrice: number): { price: number; time: number } | null => {
    const klines = allKlinesRef.current;
    if (klines.length === 0) return null;

    // 找时间最近的K线
    let closestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < klines.length; i++) {
      const dist = Math.abs(klines[i].time - clickTime);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    }

    const k = klines[closestIdx];
    // 选距离点击价格更近的针尖（high 或 low）
    const distHigh = Math.abs(k.high - clickPrice);
    const distLow = Math.abs(k.low - clickPrice);

    return {
      price: distHigh <= distLow ? k.high : k.low,
      time: k.time,
    };
  }, []);

  const drawManualFib = useCallback((p1: { price: number; time: number }, p2: { price: number; time: number }) => {
    if (!mainChart.current) return;

    const from = p1.time < p2.time ? p1.time : p2.time;
    const to = p1.time < p2.time ? p2.time : p1.time;
    const startPrice = p1.time < p2.time ? p1.price : p2.price;
    const endPrice = p1.time < p2.time ? p2.price : p1.price;
    const isDown = endPrice < startPrice;
    const range = Math.abs(endPrice - startPrice);

    const palette = FIB_GROUP_PALETTES[fibColorIdxRef.current % FIB_GROUP_PALETTES.length];
    const colorIdx = fibColorIdxRef.current;
    const groupSeries: ISeriesApi<'Line'>[] = [];

    const levels = [
      { ratio: 0, key: 0 },
      { ratio: 0.236, key: 236 },
      { ratio: 0.382, key: 382 },
      { ratio: 0.5, key: 50 },
      { ratio: 0.618, key: 618 },
      { ratio: 0.786, key: 786 },
      { ratio: 1, key: 100 },
    ];

    levels.forEach(({ ratio, key }) => {
      const value = isDown ? startPrice - range * ratio : startPrice + range * ratio;
      const opacity = key === 618 ? 0.9 : 0.6;
      const color = palette.color.replace('%OP%', String(opacity));
      const s = mainChart.current!.addLineSeries({
        color,
        lineWidth: key === 618 ? 2 : 1,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: true,
        title: `${palette.name} ${FIB_LABELS[key]}`,
      });
      s.setData([
        { time: from as Time, value },
        { time: to as Time, value },
      ]);
      groupSeries.push(s);
    });

    manualFibGroupsRef.current.push({ series: groupSeries, colorIdx });
    fibColorIdxRef.current++;
    setFibGroupCount(manualFibGroupsRef.current.length);
    setFibDrawStep(0);
    setFibDrawPoints([]);
    setMarkers([]);
    setFibDrawMode(false);
  }, []);

  // 图表点击事件（手动画斐波那契）
  useEffect(() => {
    const chart = mainChart.current;
    if (!chart) return;

    const handler = (param: any) => {
      if (!fibDrawMode || !param || !param.time || fibDrawStep >= 2) return;

      // 获取点击位置的价格
      const price = param.pointY !== undefined ? (chart.priceScale('right') as any).coordinateToPrice(param.pointY) : 0;
      if (!price || price <= 0) return;

      // 吸附到K线针尖
      const snapped = snapToWick(param.time as number, price);
      if (!snapped) return;

      if (fibDrawStep === 0) {
        // 第一个点 — 吸附 + 画标记小圈
        fibDrawPointsRef.current = [snapped];
        setFibDrawPoints([snapped]);
        setFibDrawStep(1);

        // 用 HTML overlay 画小圆圈
        const chartApi = mainChart.current!;
        const x = (chartApi as any).timeScale().timeToCoordinate(snapped.time as Time);
        const y = (chartApi.priceScale('right') as any).priceToCoordinate(snapped.price);
        if (x !== undefined && y !== undefined) {
          markerIdRef.current++;
          setMarkers([{ id: markerIdRef.current, x: Math.round(x), y: Math.round(y) }]);
        }
      } else if (fibDrawStep === 1) {
        // 第二个点 — 从 ref 取第一个点（避免闭包问题）
        const p1 = fibDrawPointsRef.current[0];
        if (p1) {
          fibDrawPointsRef.current = [];
          setFibDrawPoints([]);
          drawManualFib(p1, snapped);
        }
      }
    };

    chart.subscribeClick(handler);
    return () => chart.unsubscribeClick(handler);
  }, [fibDrawMode, fibDrawStep, drawManualFib, snapToWick]);

  // 加载数据 + 连接 WebSocket
  useEffect(() => {
    loadKlines(interval);

    // 连接实时 WebSocket（按当前币种 + 周期订阅）
    const { updatePrice } = usePriceStore.getState();
    const ws = createMarketWS({
      onTrade: (price) => {
        updateTick(price);
        updatePrice(price);
      },
      onKline: (intv, kline, isFinal) => {
        if (intv === interval) {
          updateLastKline(kline, isFinal);
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
  }, [interval, symbol, okxId, loadKlines, updateLastKline]);

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
          {(['MA', 'EMA', 'BOLL', 'MACD', 'RSI', 'ATR', 'TD', 'FIB', 'NAKED'] as const).map((ind) => {
            const isFibLocked = ind === 'FIB' && !isMember;
            return (
              <span
                key={ind}
                className={`px-2.5 py-1 text-xs font-medium cursor-default select-none transition-all ${
                  isFibLocked
                    ? 'text-dark-600 line-through'
                    : indicators[ind]
                    ? 'text-blue-300 border-b-2 border-blue-400 pb-0.5'
                    : 'text-dark-600 line-through'
                }`}
                title={isFibLocked ? 'VIP会员专属' : undefined}
              >
                {ind}{isFibLocked && <span className="ml-0.5 text-[10px]">&#128274;</span>}
              </span>
            );
          })}
          {/* 自动画线开关 */}
          {isMember && (
            <>
              <div className="w-px h-4 bg-dark-700" />
              <button
                onClick={() => { const v = !showAutoFib; setShowAutoFib(v); saveUserPref('prefAutoFib', v); }}
                className={`px-2 py-1 text-xs font-medium rounded transition-all ${showAutoFib ? 'text-sky-400' : 'text-dark-600'}`}
                title="自动斐波那契线"
              >
                Fib
              </button>
              <button
                onClick={() => { const v = !showAutoAB9; setShowAutoAB9(v); saveUserPref('prefAB9', v); }}
                className={`px-2 py-1 text-xs font-medium rounded transition-all ${showAutoAB9 ? 'text-cyan-400' : 'text-dark-600'}`}
                title="AB9线"
              >
                AB9
              </button>
              <button
                onClick={() => { const v = !showAB9Labels; setShowAB9Labels(v); saveUserPref('prefAB9Labels', v); }}
                className={`px-1.5 py-1 text-[10px] font-medium rounded transition-all ${showAB9Labels ? 'text-white/70' : 'text-dark-600'}`}
                title="AB9标签"
              >
                标
              </button>
            </>
          )}
          {/* 手动画斐波那契按钮 */}
          {showFibDraw && isMember && (
            <>
              <div className="w-px h-4 bg-dark-700" />
              {fibDrawStep === 0 ? (
                <button
                  onClick={() => { setFibDrawMode(!fibDrawMode); if (fibDrawMode) { setFibDrawPoints([]); setMarkers([]); } }}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-all ${
                    fibDrawMode ? 'bg-amber-600 text-white' : 'text-dark-400 hover:text-amber-400 hover:bg-dark-700/50'
                  }`}
                >
                  画线
                </button>
              ) : fibDrawStep === 1 ? (
                <span className="px-2.5 py-1 text-xs font-medium text-amber-400 animate-pulse">
                  点击第二点...
                </span>
              ) : null}
              {fibGroupCount > 0 && !fibDrawMode && (
                <>
                  <button
                    onClick={clearLastManualFib}
                    className="px-2 py-1 text-xs font-medium text-yellow-400 hover:bg-yellow-500/10 rounded transition-all"
                    title="撤回上一组"
                  >
                    撤回
                  </button>
                  <button
                    onClick={clearAllManualFib}
                    className="px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10 rounded transition-all"
                    title="清除全部手动画线"
                  >
                    清除{fibGroupCount > 1 ? `(${fibGroupCount})` : ''}
                  </button>
                </>
              )}
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
        <div className="relative w-full" style={{ height: isFullscreen ? 'calc(100vh - 40px)' : '520px' }}>
          <div
            ref={mainChartRef}
            className="w-full h-full"
            style={{ cursor: fibDrawMode ? 'crosshair' : 'default' }}
          />
          {/* 手动画斐波那契 - 小圆圈标记 */}
          {markers.map((m) => (
            <div
              key={m.id}
              className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-amber-400 bg-amber-400/20 pointer-events-none"
              style={{ left: m.x, top: m.y }}
            />
          ))}
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
