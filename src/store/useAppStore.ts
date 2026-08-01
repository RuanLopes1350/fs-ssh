import { create } from "zustand";
import { persist } from "zustand/middleware";

import { api } from "../lib/ipc";
import { terminals } from "../terminal/session";
import type {
  Connection,
  Folder,
  Identity,
  Snippet,
  Tag,
  Theme,
  TerminalPalette,
} from "../lib/types";

/** Uma sessão SSH viva dentro de uma aba (a aba pode ter vários painéis). */
export interface Pane {
  /** Id do painel — também é a chave do `TerminalSession` no mapa de terminais. */
  id: string;
  connectionId: string;
  title: string;
  color: string;
  icon: string;
  isProduction: boolean;
  /** `empty` = painel recém-dividido mostrando o seletor de servidor. */
  status: "empty" | "connecting" | "open" | "closed";
  sessionId: string | null;
  detail: string | null;
  /** Tentativa atual do auto-reconnect (0 = não está reconectando). */
  reconnectAttempt: number;
}

export type SplitDir = "row" | "col";

/** Árvore binária de layout: folha = painel, nó = divisão com proporção. */
export type PaneLayout =
  | { type: "leaf"; paneId: string }
  | { type: "split"; id: string; dir: SplitDir; ratio: number; a: PaneLayout; b: PaneLayout };

export interface Tab {
  id: string;
  panes: Pane[];
  layout: PaneLayout;
  activePaneId: string;
}

/** Preferências persistidas — a tela de configurações edita isto. */
export interface Settings {
  /** Reabrir as abas da última sessão ao iniciar (pergunta antes de conectar). */
  restoreTabs: boolean;
  /** Broadcast ignora abas marcadas como produção. */
  broadcastSkipProd: boolean;
  /** Reconectar sozinho quando a conexão cai (com backoff). */
  autoReconnect: boolean;
}

export const FALLBACK_PALETTE: TerminalPalette = {
  background: "#11141b",
  foreground: "#d8dee9",
  cursor: "#7dd3fc",
  selectionBackground: "#334155cc",
  black: "#1e222a",
  red: "#f87171",
  green: "#86efac",
  yellow: "#fde68a",
  blue: "#93c5fd",
  magenta: "#d8b4fe",
  cyan: "#a5f3fc",
  white: "#e2e8f0",
  brightBlack: "#475569",
  brightRed: "#fca5a5",
  brightGreen: "#bbf7d0",
  brightYellow: "#fef3c7",
  brightBlue: "#bfdbfe",
  brightMagenta: "#e9d5ff",
  brightCyan: "#cffafe",
  brightWhite: "#f8fafc",
};

// ------------------------------------------------- manipulação da árvore

function replaceLeaf(node: PaneLayout, paneId: string, next: PaneLayout): PaneLayout {
  if (node.type === "leaf") return node.paneId === paneId ? next : node;
  return {
    ...node,
    a: replaceLeaf(node.a, paneId, next),
    b: replaceLeaf(node.b, paneId, next),
  };
}

/** Remove a folha; o split pai colapsa para o irmão. `null` = árvore vazia. */
function removeLeaf(node: PaneLayout, paneId: string): PaneLayout | null {
  if (node.type === "leaf") return node.paneId === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

function setRatio(node: PaneLayout, splitId: string, ratio: number): PaneLayout {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}

// -------------------------------------------------------------- helpers

export function findPane(tabs: Tab[], paneId: string): { tab: Tab; pane: Pane } | null {
  for (const tab of tabs) {
    const pane = tab.panes.find((p) => p.id === paneId);
    if (pane) return { tab, pane };
  }
  return null;
}

export function findPaneBySession(
  tabs: Tab[],
  sessionId: string,
): { tab: Tab; pane: Pane } | null {
  for (const tab of tabs) {
    const pane = tab.panes.find((p) => p.sessionId === sessionId);
    if (pane) return { tab, pane };
  }
  return null;
}

export function activePaneOf(tab: Tab | null | undefined): Pane | null {
  if (!tab) return null;
  return tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0] ?? null;
}

/** Conexões de todos os painéis abertos — base da restauração de sessão. */
function snapshotSession(tabs: Tab[]): string[] {
  return [
    ...new Set(tabs.flatMap((t) => t.panes.map((p) => p.connectionId).filter(Boolean))),
  ];
}

interface AppStore {
  connections: Connection[];
  folders: Folder[];
  tags: Tag[];
  themes: Theme[];
  identities: Identity[];
  snippets: Snippet[];

  tabs: Tab[];
  activeTabId: string | null;

  search: string;
  selectedTagIds: string[];
  fontSize: number;
  sftpOpen: boolean;
  dockerOpen: boolean;
  tunnelsOpen: boolean;
  broadcast: boolean;
  sidebarOpen: boolean;
  collapsedFolders: string[];
  settings: Settings;

  /** Conexões abertas na última sessão do app — base da restauração. */
  lastSessionConnectionIds: string[];

  loadAll: () => Promise<void>;
  reloadConnections: () => Promise<void>;
  reloadFolders: () => Promise<void>;
  reloadIdentities: () => Promise<void>;

  paletteFor: (connectionId: string) => TerminalPalette;
  /** Reaplica o tema de cada painel aberto — chamado após salvar/importar temas. */
  applyPalettes: () => void;

  addTab: (pane: Pane) => void;
  /** Divide o painel ativo da aba, colocando `pane` na nova metade. */
  splitPane: (tabId: string, dir: SplitDir, pane: Pane) => void;
  updatePane: (paneId: string, patch: Partial<Pane>) => void;
  /** Remove o painel; se era o último da aba, a aba vai junto. */
  removePane: (paneId: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  setSplitRatio: (tabId: string, splitId: string, ratio: number) => void;

  setSearch: (s: string) => void;
  toggleTag: (id: string) => void;
  setFontSize: (n: number) => void;
  toggleSftp: () => void;
  toggleDocker: () => void;
  toggleTunnels: () => void;
  toggleBroadcast: () => void;
  toggleSidebar: () => void;
  toggleFolderCollapsed: (id: string) => void;
  setSettings: (patch: Partial<Settings>) => void;
  clearLastSession: () => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      connections: [],
      folders: [],
      tags: [],
      themes: [],
      identities: [],
      snippets: [],

      tabs: [],
      activeTabId: null,

      search: "",
      selectedTagIds: [],
      fontSize: 13,
      sftpOpen: false,
      dockerOpen: false,
      tunnelsOpen: false,
      broadcast: false,
      sidebarOpen: true,
      collapsedFolders: [],
      settings: {
        restoreTabs: true,
        broadcastSkipProd: true,
        autoReconnect: true,
      },
      lastSessionConnectionIds: [],

      loadAll: async () => {
        const [connections, folders, tags, themes, snippets] = await Promise.all([
          api.connList(),
          api.folderList(),
          api.tagList(),
          api.themeList(),
          api.snippetList(),
        ]);
        set({ connections, folders, tags, themes, snippets });
        // A varredura de chaves toca o disco e o agente; fica fora do Promise.all
        // para não atrasar a primeira pintura da lista de conexões.
        void get().reloadIdentities();
      },

      reloadConnections: async () => {
        set({ connections: await api.connList() });
      },
      reloadFolders: async () => {
        set({ folders: await api.folderList() });
      },
      reloadIdentities: async () => {
        try {
          set({ identities: await api.keysList() });
        } catch {
          set({ identities: [] });
        }
      },

      paletteFor: (connectionId) => {
        const { connections, themes } = get();
        const conn = connections.find((c) => c.id === connectionId);
        const theme = themes.find((t) => t.id === conn?.themeId);
        return (theme?.json as TerminalPalette | undefined) ?? FALLBACK_PALETTE;
      },

      applyPalettes: () => {
        for (const tab of get().tabs) {
          for (const pane of tab.panes) {
            terminals.get(pane.id)?.setPalette(get().paletteFor(pane.connectionId));
          }
        }
      },

      addTab: (pane) =>
        set((s) => {
          const tab: Tab = {
            id: crypto.randomUUID(),
            panes: [pane],
            layout: { type: "leaf", paneId: pane.id },
            activePaneId: pane.id,
          };
          const tabs = [...s.tabs, tab];
          return {
            tabs,
            activeTabId: tab.id,
            lastSessionConnectionIds: snapshotSession(tabs),
          };
        }),

      splitPane: (tabId, dir, pane) =>
        set((s) => {
          const tabs = s.tabs.map((t) => {
            if (t.id !== tabId) return t;
            const target = t.activePaneId;
            const split: PaneLayout = {
              type: "split",
              id: crypto.randomUUID(),
              dir,
              ratio: 0.5,
              a: { type: "leaf", paneId: target },
              b: { type: "leaf", paneId: pane.id },
            };
            return {
              ...t,
              panes: [...t.panes, pane],
              layout: replaceLeaf(t.layout, target, split),
              activePaneId: pane.id,
            };
          });
          return { tabs, lastSessionConnectionIds: snapshotSession(tabs) };
        }),

      updatePane: (paneId, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.panes.some((p) => p.id === paneId)
              ? {
                  ...t,
                  panes: t.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p)),
                }
              : t,
          ),
        })),

      removePane: (paneId) =>
        set((s) => {
          const tabs: Tab[] = [];
          for (const t of s.tabs) {
            if (!t.panes.some((p) => p.id === paneId)) {
              tabs.push(t);
              continue;
            }
            const layout = removeLeaf(t.layout, paneId);
            if (layout === null) continue; // último painel: a aba sai junto
            const panes = t.panes.filter((p) => p.id !== paneId);
            const activePaneId =
              t.activePaneId === paneId ? (panes[panes.length - 1]?.id ?? "") : t.activePaneId;
            tabs.push({ ...t, panes, layout, activePaneId });
          }
          const activeTabId = tabs.some((t) => t.id === s.activeTabId)
            ? s.activeTabId
            : (tabs[tabs.length - 1]?.id ?? null);
          return { tabs, activeTabId, lastSessionConnectionIds: snapshotSession(tabs) };
        }),

      closeTab: (id) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.id !== id);
          const activeTabId =
            s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId;
          return { tabs, activeTabId, lastSessionConnectionIds: snapshotSession(tabs) };
        }),

      setActiveTab: (id) => set({ activeTabId: id }),
      setActivePane: (tabId, paneId) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
        })),
      setSplitRatio: (tabId, splitId, ratio) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, layout: setRatio(t.layout, splitId, ratio) } : t,
          ),
        })),

      setSearch: (search) => set({ search }),
      toggleTag: (id) =>
        set((s) => ({
          selectedTagIds: s.selectedTagIds.includes(id)
            ? s.selectedTagIds.filter((t) => t !== id)
            : [...s.selectedTagIds, id],
        })),
      setFontSize: (fontSize) => set({ fontSize: Math.min(24, Math.max(9, fontSize)) }),
      toggleSftp: () =>
        set((s) => ({ sftpOpen: !s.sftpOpen, dockerOpen: false, tunnelsOpen: false })),
      toggleDocker: () =>
        set((s) => ({ dockerOpen: !s.dockerOpen, sftpOpen: false, tunnelsOpen: false })),
      toggleTunnels: () =>
        set((s) => ({ tunnelsOpen: !s.tunnelsOpen, sftpOpen: false, dockerOpen: false })),
      toggleBroadcast: () => set((s) => ({ broadcast: !s.broadcast })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleFolderCollapsed: (id) =>
        set((s) => ({
          collapsedFolders: s.collapsedFolders.includes(id)
            ? s.collapsedFolders.filter((f) => f !== id)
            : [...s.collapsedFolders, id],
        })),
      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      clearLastSession: () => set({ lastSessionConnectionIds: [] }),
    }),
    {
      name: "fs-ssh-ui",
      // Só preferências e o snapshot da sessão — nunca dados do catálogo (vêm
      // do SQLite) nem segredos.
      partialize: (s) => ({
        fontSize: s.fontSize,
        sftpOpen: s.sftpOpen,
        sidebarOpen: s.sidebarOpen,
        collapsedFolders: s.collapsedFolders,
        settings: s.settings,
        lastSessionConnectionIds: s.lastSessionConnectionIds,
      }),
    },
  ),
);

/** Filtro combinado da sidebar: texto livre + tags selecionadas. */
export function filterConnections(
  connections: Connection[],
  search: string,
  tagIds: string[],
): Connection[] {
  const q = search.trim().toLowerCase();
  return connections.filter((c) => {
    if (tagIds.length && !tagIds.every((t) => c.tagIds.includes(t))) return false;
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      c.host.toLowerCase().includes(q) ||
      c.username.toLowerCase().includes(q) ||
      c.notes.toLowerCase().includes(q)
    );
  });
}
