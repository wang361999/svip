import { create } from 'zustand';

export interface ChartState {
  interval: string;
  setInterval: (interval: string) => void;
}

const CHART_INTERVAL_KEY = 'chart-interval';

function loadInterval(): string {
  if (typeof window === 'undefined') return '15m';
  try {
    return window.localStorage.getItem(CHART_INTERVAL_KEY) || '15m';
  } catch {
    return '15m';
  }
}

const useChartStore = create<ChartState>((set) => ({
  interval: loadInterval(),
  setInterval: (interval) => {
    set({ interval });
    try {
      window.localStorage.setItem(CHART_INTERVAL_KEY, interval);
    } catch {}
  },
}));

export default useChartStore;
