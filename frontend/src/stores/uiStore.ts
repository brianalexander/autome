import { create } from 'zustand';

interface UIState {
  // Selected items
  selectedInstanceId: string | null;
  selectedStageId: string | null;

  // Panel state
  configPanelOpen: boolean;
  sessionViewerOpen: boolean;

  // Canvas mode
  canvasMode: 'author' | 'runtime';

  // WebSocket connection status — used to suppress polling when WS is live
  wsConnected: boolean;

  // Actions
  selectInstance: (id: string | null) => void;
  selectStage: (id: string | null) => void;
  openConfigPanel: () => void;
  closeConfigPanel: () => void;
  openSessionViewer: () => void;
  closeSessionViewer: () => void;
  setCanvasMode: (mode: 'author' | 'runtime') => void;
  setWsConnected: (connected: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedInstanceId: null,
  selectedStageId: null,
  configPanelOpen: false,
  sessionViewerOpen: false,
  canvasMode: 'runtime',
  wsConnected: false,

  selectInstance: (id) => set({ selectedInstanceId: id, selectedStageId: null }),
  selectStage: (id) => set({ selectedStageId: id }),
  openConfigPanel: () => set({ configPanelOpen: true }),
  closeConfigPanel: () => set({ configPanelOpen: false }),
  openSessionViewer: () => set({ sessionViewerOpen: true }),
  closeSessionViewer: () => set({ sessionViewerOpen: false }),
  setCanvasMode: (mode) => set({ canvasMode: mode }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
}));
