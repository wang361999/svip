import { create } from 'zustand';

export interface SymbolOption {
  label: string;
  value: string;
  okxId: string;
  baseAsset?: string;
  pricePrecision?: number;
  qtyPrecision?: number;
}

export interface SymbolState {
  symbol: string;
  okxId: string;
  label: string;
  /** 当前币种价格精度（价格显示/K线轴共用，来自 TradingSymbol 表） */
  pricePrecision: number;
  /** 当前币种数量精度（下单数量步进用） */
  qtyPrecision: number;
  symbols: SymbolOption[];
  loading: boolean;
  error: string | null;
  setSymbol: (symbol: string) => void;
  setSymbols: (symbols: SymbolOption[]) => void;
  fetchSymbols: () => Promise<void>;
}

function findSymbol(s: string, list: SymbolOption[]) {
  return list.find((x) => x.value === s) || list[0];
}

// ========== 交易对持久化（localStorage） ==========
const SYMBOL_KEY = 'chart-symbol';

function loadStoredSymbol(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(SYMBOL_KEY);
  } catch {
    return null;
  }
}

function saveSymbol(value: string) {
  try {
    window.localStorage.setItem(SYMBOL_KEY, value);
  } catch {}
}

const useSymbolStore = create<SymbolState>((set, get) => ({
  symbol: loadStoredSymbol() || 'ETHUSDT',
  okxId: 'ETH-USDT',
  label: 'ETH/USDT',
  pricePrecision: 2,
  qtyPrecision: 4,
  symbols: [
    { label: 'BTC/USDT', value: 'BTCUSDT', okxId: 'BTC-USDT' },
    { label: 'ETH/USDT', value: 'ETHUSDT', okxId: 'ETH-USDT' },
    { label: 'SOL/USDT', value: 'SOLUSDT', okxId: 'SOL-USDT' },
    { label: 'BNB/USDT', value: 'BNBUSDT', okxId: 'BNB-USDT' },
    { label: 'XRP/USDT', value: 'XRPUSDT', okxId: 'XRP-USDT' },
  ],
  loading: false,
  error: null,

  setSymbol: (symbol) => {
    const found = findSymbol(symbol, get().symbols);
    if (found) {
      set({
        symbol: found.value,
        okxId: found.okxId,
        label: found.label,
        pricePrecision: found.pricePrecision ?? 2,
        qtyPrecision: found.qtyPrecision ?? 4,
      });
      saveSymbol(found.value);
    }
  },

  setSymbols: (symbols) => {
    set({ symbols });
    // 如果当前 symbol 不在新列表中，切换到第一个
    const current = get().symbol;
    const found = findSymbol(current, symbols);
    if (found) {
      set({
        symbol: found.value,
        okxId: found.okxId,
        label: found.label,
        pricePrecision: found.pricePrecision ?? 2,
        qtyPrecision: found.qtyPrecision ?? 4,
      });
    } else if (symbols.length > 0) {
      set({
        symbol: symbols[0].value,
        okxId: symbols[0].okxId,
        label: symbols[0].label,
        pricePrecision: symbols[0].pricePrecision ?? 2,
        qtyPrecision: symbols[0].qtyPrecision ?? 4,
      });
      saveSymbol(symbols[0].value);
    }
  },

  fetchSymbols: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/symbols?active=true', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        const mapped: SymbolOption[] = data.data.map((s: any) => ({
          label: s.label,
          value: s.symbol,
          okxId: s.okxId,
          baseAsset: s.baseAsset,
          pricePrecision: s.pricePrecision,
          qtyPrecision: s.qtyPrecision,
        }));
        if (mapped.length > 0) {
          set({ symbols: mapped, loading: false });
          // 同步更新当前选中的 symbol 信息
          const current = get().symbol;
          const found = findSymbol(current, mapped);
          if (found) {
            set({
              symbol: found.value,
              okxId: found.okxId,
              label: found.label,
              pricePrecision: found.pricePrecision ?? 2,
              qtyPrecision: found.qtyPrecision ?? 4,
            });
          }
        } else {
          set({ loading: false });
        }
      } else {
        set({ loading: false });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));

export default useSymbolStore;
