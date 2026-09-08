import { create } from 'zustand';
import { fetchPrice } from '@/shared/lib/market-data';

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
  /** 数据库（后台维护）交易对列表：自加币种与它合并成 symbols */
  dbSymbols: SymbolOption[];
  /** 用户自加交易对（持久化到 localStorage，跨刷新保留） */
  customSymbols: SymbolOption[];
  loading: boolean;
  error: string | null;
  setSymbol: (symbol: string) => void;
  setSymbols: (symbols: SymbolOption[]) => void;
  fetchSymbols: () => Promise<void>;
  /** 用户手动添加任意交易对（自动校验可交易性 + 推断价格精度 + 自动切换）。返回 ok/error */
  addCustomSymbol: (raw: string) => Promise<{ ok: boolean; error?: string }>;
  /** 移除用户自加的交易对（仅影响前端本地列表，不动数据库） */
  removeCustomSymbol: (value: string) => void;
}

function findSymbol(s: string, list: SymbolOption[]) {
  return list.find((x) => x.value === s) || list[0];
}

// ========== 交易对持久化（localStorage） ==========
const SYMBOL_KEY = 'chart-symbol';
const CUSTOM_SYMBOLS_KEY = 'chart-custom-symbols';

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

function loadCustomSymbols(): SymbolOption[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_SYMBOLS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x: any) => x && typeof x.value === 'string' && typeof x.label === 'string'
    ) as SymbolOption[];
  } catch {
    return [];
  }
}

function saveCustomSymbols(list: SymbolOption[]) {
  try {
    window.localStorage.setItem(CUSTOM_SYMBOLS_KEY, JSON.stringify(list));
  } catch {}
}

// 数据库列表在前，用户自加在后；按 value 去重（保留数据库版本）
function mergeLists(db: SymbolOption[], custom: SymbolOption[]): SymbolOption[] {
  const seen = new Set<string>();
  const out: SymbolOption[] = [];
  for (const s of [...db, ...custom]) {
    if (s && typeof s.value === 'string' && !seen.has(s.value)) {
      seen.add(s.value);
      out.push(s);
    }
  }
  return out;
}

// 从价格数值推断价格精度（PEPE 类低价币需要更多小数位）
function decimalsOf(price: number): number {
  const s = String(price).toLowerCase();
  if (s.includes('e')) return price >= 1 ? 2 : 6;
  const i = s.indexOf('.');
  if (i < 0) return 2;
  const d = s.length - i - 1;
  return Math.max(0, Math.min(8, d));
}

// ========== 默认交易对（fetchSymbols 拉取后台数据前的兜底列表） ==========
const DEFAULT_SYMBOLS: SymbolOption[] = [
  { label: 'BTC/USDT', value: 'BTCUSDT', okxId: 'BTC-USDT' },
  { label: 'ETH/USDT', value: 'ETHUSDT', okxId: 'ETH-USDT' },
  { label: 'SOL/USDT', value: 'SOLUSDT', okxId: 'SOL-USDT' },
  { label: 'BNB/USDT', value: 'BNBUSDT', okxId: 'BNB-USDT' },
  { label: 'XRP/USDT', value: 'XRPUSDT', okxId: 'XRP-USDT' },
];

const initialCustom = loadCustomSymbols();

const useSymbolStore = create<SymbolState>((set, get) => ({
  symbol: loadStoredSymbol() || 'ETHUSDT',
  okxId: 'ETH-USDT',
  label: 'ETH/USDT',
  pricePrecision: 2,
  qtyPrecision: 4,
  symbols: mergeLists(DEFAULT_SYMBOLS, initialCustom),
  dbSymbols: DEFAULT_SYMBOLS,
  customSymbols: initialCustom,
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
          const dbSymbols = mapped;
          const symbols = mergeLists(dbSymbols, get().customSymbols);
          set({ dbSymbols, symbols, loading: false });
          // 同步更新当前选中的 symbol 信息
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

  addCustomSymbol: async (raw) => {
    const t = (raw || '').trim().toUpperCase().replace(/[\s/]+/g, '');
    if (!t) return { ok: false, error: '请输入交易对' };
    const value = t.endsWith('USDT') ? t : `${t}USDT`;
    const base = value.slice(0, -4);
    if (!base) return { ok: false, error: '交易对格式无效' };
    if (get().symbols.some((s) => s.value === value)) {
      return { ok: false, error: `${base}/USDT 已在列表中` };
    }
    const okxId = `${base}-USDT`;
    // 校验可交易性（Binance / OKX 直连或接口代理任一可取到价即视为存在）+ 推断价格精度
    let price: number | null = -1;
    try {
      price = await fetchPrice(value, okxId);
    } catch {
      price = null;
    }
    if (!price || price <= 0) {
      return { ok: false, error: '交易所未找到或当前无法取得该币种行情' };
    }
    const sym: SymbolOption = {
      label: `${base}/USDT`,
      value,
      okxId,
      baseAsset: base,
      pricePrecision: decimalsOf(price),
      qtyPrecision: 4,
    };
    const custom = [...get().customSymbols, sym];
    set({ customSymbols: custom, symbols: mergeLists(get().dbSymbols, custom) });
    saveCustomSymbols(custom);
    // 添加成功后自动切换到新币种
    get().setSymbol(value);
    return { ok: true };
  },

  removeCustomSymbol: (value) => {
    if (!get().customSymbols.some((s) => s.value === value)) return;
    const custom = get().customSymbols.filter((s) => s.value !== value);
    set({ customSymbols: custom, symbols: mergeLists(get().dbSymbols, custom) });
    saveCustomSymbols(custom);
    // 若删除的正是当前选中币种，切回列表第一项
    if (get().symbol === value) {
      const next = get().symbols[0];
      if (next) get().setSymbol(next.value);
    }
  },
}));

export default useSymbolStore;