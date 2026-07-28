import { create } from 'zustand';

export interface ChartState {
  interval: string;
  setInterval: (interval: string) => void;
}

const useChartStore = create<ChartState>((set) => ({
  interval: '15m',
  setInterval: (interval) => set({ interval }),
}));

export default useChartStore;
