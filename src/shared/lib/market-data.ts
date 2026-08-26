// 市场数据获取 - 多源直连 + Vercel 代理降级

export const INTERVALS = [
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '30m', value: '30m' },
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
];

export interface KlineData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ========== 工具函数 ==========

async function fetchWithTimeout(url: string, ms = 5000, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: headers || {
        'Accept': 'application/json',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ========== 直连端点（国内免VPN优先） ==========

// Binance 公开数据节点（国内可直连）
const BINANCE_REST = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api.binance.com',
];

// Binance WS 节点
const BINANCE_WS = [
  'wss://data-stream.binance.vision/stream',
  'wss://stream.binance.com:9443/stream',
];

// ========== K线获取 ==========

/**
 * K线分级缓存（Vercel 免费 4 CPU-hrs 配额优化）
 * 一根 5m 蜡烛 5 分钟才更新一次，缓存期内数据实质不变；
 * 多标签页 / 多组件并发拉同一周期时直接复用，砍掉重复的出站请求与 JSON 解析
 */
const KLINE_TTL_MS: Record<string, number> = {
  '1m': 5_000,
  '5m': 10_000,
  '15m': 20_000,
  '30m': 30_000,
  '1h': 60_000,
  '4h': 300_000,
  '1d': 600_000,
};
const klineCache = new Map<string, { data: KlineData[]; at: number }>();
/** 进行中的 K线请求去重：同一瞬间多个调用共享一次出站请求 */
const klineInflight = new Map<string, Promise<KlineData[]>>();

async function getBinanceKlinesDirect(symbol: string, interval: string, limit: number): Promise<KlineData[]> {
  for (const base of BINANCE_REST) {
    try {
      const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetchWithTimeout(url, 3500);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;
      return data.map((k: any[]) => ({
        time: Math.floor(k[0] / 1000),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch {}
  }
  return [];
}

async function getOkxKlinesDirect(okxId: string, interval: string, limit: number): Promise<KlineData[]> {
  const okxMap: Record<string, string> = {
    '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1H', '4h': '4H', '1d': '1D',
  };
  const bar = okxMap[interval] || '1H';
  try {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${okxId}&bar=${bar}&limit=${Math.min(limit, 300)}`;
    const res = await fetchWithTimeout(url, 5000);
    if (!res.ok) return [];
    const json = await res.json();
    if (!json.data || !Array.isArray(json.data)) return [];
    return json.data.reverse().map((row: any[]) => ({
      time: Math.floor(parseInt(row[0]) / 1000),
      open: parseFloat(row[1]),
      high: parseFloat(row[2]),
      low: parseFloat(row[3]),
      close: parseFloat(row[4]),
      volume: parseFloat(row[5]) || 0,
    }));
  } catch {
    return [];
  }
}

export async function fetchKlines(symbol: string, okxId: string, interval: string, limit: number = 200): Promise<KlineData[]> {
  // 0. 命中缓存直接返回（TTL 按周期分级，均远小于该周期一根蜡烛的更新时间）
  const key = `${symbol}|${interval}|${limit}`;
  const cached = klineCache.get(key);
  if (cached && Date.now() - cached.at < (KLINE_TTL_MS[interval] ?? 10_000)) {
    return cached.data;
  }

  // 0.5 并发去重：同一请求已在进行中，直接共享（避免多标签页同时触发重复拉取）
  const inflight = klineInflight.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<KlineData[]> => {
    try {
      // 1. 直连 Binance 公开节点
      let klines = await getBinanceKlinesDirect(symbol, interval, limit);
      if (klines.length > 0) return klines;

      // 2. 直连 OKX
      klines = await getOkxKlinesDirect(okxId, interval, limit);
      if (klines.length > 0) return klines;

      // 3. Vercel API 代理
      try {
        const res = await fetchWithTimeout(`/api/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, 8000);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            return data.map((k: any[]) => ({
              time: Math.floor(k[0] / 1000),
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
            }));
          }
        }
      } catch {}

      throw new Error('所有行情源不可用，请检查网络');
    } finally {
      klineInflight.delete(key);
    }
  })();

  klineInflight.set(key, task);

  const result = await task;
  // 仅成功结果入缓存（空数组/异常不缓存，下次调用重试）
  if (result.length > 0) {
    klineCache.set(key, { data: result, at: Date.now() });
    // 防泄漏：缓存条目超过 64 个时清掉最旧的一半
    if (klineCache.size > 64) {
      const entries = Array.from(klineCache.entries()).sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < Math.floor(entries.length / 2); i++) klineCache.delete(entries[i][0]);
    }
  }
  return result;
}

// ========== 价格获取 ==========

async function getBinancePriceDirect(symbol: string): Promise<number | null> {
  for (const base of BINANCE_REST) {
    try {
      const res = await fetchWithTimeout(`${base}/api/v3/ticker/price?symbol=${symbol}`, 3000);
      if (!res.ok) continue;
      const data = await res.json();
      const price = parseFloat(data.price);
      if (price > 0) return price;
    } catch {}
  }
  return null;
}

async function getOkxPriceDirect(okxId: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(`https://www.okx.com/api/v5/market/ticker?instId=${okxId}`, 3000);
    if (!res.ok) return null;
    const json = await res.json();
    const price = parseFloat(json?.data?.[0]?.last);
    if (price > 0) return price;
  } catch {}
  return null;
}

/**
 * 价格微缓存（2.5 秒）：引擎每 5 秒巡检、AI 分析、面板刷新并发取价时共享一次出站请求
 * SL/TP 巡检场景下 2.5 秒内的价格差异无实际影响（前端 WS 实时价独立更新，不走这里）
 */
const priceCache = new Map<string, { price: number; at: number }>();
const PRICE_TTL_MS = 2500;

export async function fetchPrice(symbol: string, okxId: string): Promise<number | null> {
  const key = `${symbol}|${okxId}`;
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.price;

  // 1. Binance 直连
  let price = await getBinancePriceDirect(symbol);
  if (price) {
    priceCache.set(key, { price, at: Date.now() });
    return price;
  }

  // 2. OKX 直连
  price = await getOkxPriceDirect(okxId);
  if (price) {
    priceCache.set(key, { price, at: Date.now() });
    return price;
  }

  // 3. Vercel API 代理
  try {
    const res = await fetchWithTimeout(`/api/ticker?symbol=${symbol}`, 5000);
    if (res.ok) {
      const data = await res.json();
      if (data.price) {
        const p = parseFloat(data.price);
        priceCache.set(key, { price: p, at: Date.now() });
        return p;
      }
    }
  } catch {}

  return null;
}

// ========== 24h 统计 ==========

export async function fetch24hStats(symbol: string, okxId: string) {
  for (const base of BINANCE_REST) {
    try {
      const res = await fetchWithTimeout(`${base}/api/v3/ticker/24hr?symbol=${symbol}`, 3500);
      if (!res.ok) continue;
      const data = await res.json();
      return {
        price: parseFloat(data.lastPrice),
        change: parseFloat(data.priceChange),
        changePercent: data.priceChangePercent,
        volume: parseFloat(data.volume),
        high: parseFloat(data.highPrice),
        low: parseFloat(data.lowPrice),
      };
    } catch {}
  }

  // OKX fallback
  try {
    const res = await fetchWithTimeout(`https://www.okx.com/api/v5/market/ticker?instId=${okxId}`, 3500);
    if (res.ok) {
      const json = await res.json();
      const d = json?.data?.[0];
      if (d) {
        const price = parseFloat(d.last);
        const open24h = parseFloat(d.open24h);
        return {
          price,
          change: price - open24h,
          changePercent: open24h > 0 ? ((price - open24h) / open24h * 100).toFixed(2) : '0',
          volume: parseFloat(d.vol24h) || 0,
          high: parseFloat(d.high24h) || price,
          low: parseFloat(d.low24h) || price,
        };
      }
    }
  } catch {}

  return null;
}

// ========== WebSocket 实时数据 ==========

export interface WSCallbacks {
  onTrade?: (price: number) => void;
  onKline?: (interval: string, kline: KlineData, isFinal: boolean) => void;
  onConnect?: (source: string) => void;
  onDisconnect?: () => void;
}

export function createMarketWS(callbacks: WSCallbacks, symbol: string, okxId: string, klineInterval: string = '1h') {
  let ws: WebSocket | null = null;
  let source = 'none';
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastMsgAt = 0;
  let restTimer: ReturnType<typeof setInterval> | null = null;
  let isConnecting = false;
  let closed = false;

  // Binance stream name: lowercase symbol (ETHUSDT -> ethusdt)
  const streamPrefix = symbol.toLowerCase();

  function cleanup() {
    closed = true;
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (restTimer) { clearInterval(restTimer); restTimer = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  function handleBinanceMessage(msg: any) {
    if (!msg.stream || !msg.data) return;
    const stream = msg.stream;
    const data = msg.data;

    if (stream === `${streamPrefix}@trade`) {
      const price = parseFloat(data.p);
      if (price > 0) callbacks.onTrade?.(price);
    } else if (stream.includes('kline_')) {
      const k = data.k;
      if (!k) return;
      const interval = stream.replace(`${streamPrefix}@kline_`, '');
      callbacks.onKline?.(interval, {
        time: Math.floor(k.t / 1000),
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
      }, !!k.x);
    }
  }

  function handleOKXMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);
      if (!msg.arg || !msg.data || !msg.data.length) return;
      const channel = msg.arg.channel;

      if (channel === 'tickers') {
        const t = msg.data[0];
        const price = parseFloat(t.last);
        if (price > 0) callbacks.onTrade?.(price);
      } else if (channel.startsWith('candle')) {
        const d = msg.data[0];
        const intervalMap: Record<string, string> = {
          'candle1m': '1m', 'candle5m': '5m', 'candle15m': '15m',
          'candle30m': '30m', 'candle1H': '1h', 'candle4H': '4h', 'candle1D': '1d',
        };
        const interval = intervalMap[channel];
        if (interval) {
          callbacks.onKline?.(interval, {
            time: Math.floor(parseInt(d[0]) / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
          }, d.length > 8 ? d[8] === '1' : false);
        }
      }
    } catch {}
  }

  // 连接 Binance WS
  function connectBinanceWS(idx: number) {
    if (closed || isConnecting) return;
    isConnecting = true;

    if (idx >= BINANCE_WS.length) {
      connectOKX();
      return;
    }

    const baseUrl = BINANCE_WS[idx];
    // 只订阅当前周期 K线 + 逐笔成交，去掉无用的 15m/4h 额外流
    const streams = [`${streamPrefix}@trade`, `${streamPrefix}@kline_${klineInterval}`].join('/');
    const url = `${baseUrl}?streams=${streams}`;

    try {
      ws = new WebSocket(url);
    } catch {
      isConnecting = false;
      connectBinanceWS(idx + 1);
      return;
    }

    connectTimer = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch {}
      }
    }, 3000);

    ws.onopen = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      source = 'binance';
      isConnecting = false;
      lastMsgAt = Date.now();
      callbacks.onConnect?.('binance');
      stopRestFallback();
      startWatchdog();
    };

    ws.onmessage = (event) => {
      lastMsgAt = Date.now();
      try { handleBinanceMessage(JSON.parse(event.data)); } catch {}
    };

    ws.onclose = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      ws = null;
      isConnecting = false;
      if (!closed) {
        setTimeout(() => connect(), 2000);
      }
    };

    ws.onerror = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (ws) { try { ws.close(); } catch {} }
      ws = null;
      isConnecting = false;
      if (idx < BINANCE_WS.length - 1) connectBinanceWS(idx + 1);
      else connectOKX();
    };
  }

  // 连接 OKX WS
  function connectOKX() {
    if (closed || isConnecting) return;
    isConnecting = true;

    try {
      ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    } catch {
      isConnecting = false;
      startRestFallback();
      return;
    }

    connectTimer = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch {}
      }
    }, 3000);

    ws.onopen = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      const okxKlineMap: Record<string, string> = {
        '1m': 'candle1m', '5m': 'candle5m', '15m': 'candle15m', '30m': 'candle30m',
        '1h': 'candle1H', '4h': 'candle4H', '1d': 'candle1D',
      };
      const args: { channel: string; instId: string }[] = [
        { channel: 'tickers', instId: okxId },
        { channel: okxKlineMap[klineInterval] || 'candle1H', instId: okxId },
      ];
      ws!.send(JSON.stringify({ op: 'subscribe', args }));
      source = 'okx';
      isConnecting = false;
      lastMsgAt = Date.now();
      callbacks.onConnect?.('okx');
      stopRestFallback();
      startWatchdog();
    };

    ws.onmessage = (event) => {
      lastMsgAt = Date.now();
      handleOKXMessage(event.data);
    };

    ws.onclose = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      ws = null;
      isConnecting = false;
      if (!closed) {
        setTimeout(() => connect(), 2000);
      }
    };

    ws.onerror = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (ws) { try { ws.close(); } catch {} }
      ws = null;
      isConnecting = false;
      startRestFallback();
    };
  }

  // REST 轮询降级
  function startRestFallback() {
    if (closed) return;
    source = 'rest';
    if (ws) { try { ws.close(); } catch {} ws = null; }
    callbacks.onConnect?.('rest');

    if (restTimer) clearInterval(restTimer);

    const poll = async () => {
      if (closed || document.hidden) return;
      try {
        const price = await fetchPrice(symbol, okxId);
        if (price) callbacks.onTrade?.(price);
      } catch {}
    };

    poll();
    restTimer = setInterval(poll, 3000);

    setTimeout(() => {
      if (source === 'rest' && !closed) {
        stopRestFallback();
        connectBinanceWS(0);
      }
    }, 30000);
  }

  function stopRestFallback() {
    if (restTimer) { clearInterval(restTimer); restTimer = null; }
  }

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (closed || document.hidden || source === 'rest') return;
      if (Date.now() - lastMsgAt > 15000) {
        if (ws) { try { ws.close(); } catch {} }
      }
    }, 5000);
  }

  function connect() {
    if (isConnecting) return;
    closed = false;
    source = 'none';
    connectBinanceWS(0);
  }

  function disconnect() {
    cleanup();
    callbacks.onDisconnect?.();
  }

  return { connect, disconnect, getSource: () => source };
}
