import { create } from 'zustand';

export interface PriceState {
  currentPrice: number;
  lastPrice: number;
  change24h: number;
  changePercent24h: string;
  volume24h: number;
  high24h: number;
  low24h: number;
  priceDirection: 'up' | 'down' | 'none';
  lastUpdate: number;
  setPrice: (price: number, stats: Pick<PriceState, 'change24h' | 'changePercent24h' | 'volume24h' | 'high24h' | 'low24h'>) => void;
  updatePrice: (price: number) => void;
}

const usePriceStore = create<PriceState>((set) => ({
  currentPrice: 0,
  lastPrice: 0,
  change24h: 0,
  changePercent24h: '0',
  volume24h: 0,
  high24h: 0,
  low24h: 0,
  priceDirection: 'none',
  lastUpdate: Date.now(),
  setPrice: (price, stats) => set((state) => ({
    lastPrice: state.currentPrice,
    currentPrice: price,
    ...stats,
    priceDirection: price > state.currentPrice ? 'up' : price < state.currentPrice ? 'down' : 'none',
    lastUpdate: Date.now(),
  })),
  updatePrice: (price) => set((state) => ({
    lastPrice: state.currentPrice,
    currentPrice: price,
    priceDirection: price > state.currentPrice ? 'up' : price < state.currentPrice ? 'down' : 'none',
    lastUpdate: Date.now(),
  })),
}));

export default usePriceStore;