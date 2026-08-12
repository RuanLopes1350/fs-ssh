import { create } from "zustand";
import { persist } from "zustand/middleware";

import { api } from "../lib/ipc";
import { terminals } from "../terminal/session";
import { LOCAL_CONNECTION_ID } from "../lib/types";
import type {
  Connection,
  Folder,
  Identity,
  Snippet,
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
  /** Sessão de observação: o backend recusa escrita enquanto estiver ligado. */
  readOnly?: boolean;
  /** `empty` = painel recém-dividido mostrando o seletor de servidor. */
  status: "empty" | "connecting" | "open" | "closed";
  sessionId: string | null;
  detail: string | null;
  /** Caminho da gravação em andamento, se houver. */
  recording?: string | null;
  /**
   * Painel lateral aberto nesta sessão.
   *
   * É por painel, não global: abrir os containers de um servidor não faz
   * sentido continuar aberto ao trocar para outro.
   */
  panel?: PanelKind;
  /** Tentativa atual do auto-reconnect (0 = não está reconectando). */
  reconnectAttempt: number;
}

export type SplitDir = "row" | "col";

/** Painel lateral da sessão: arquivos, containers, rede, sistema, túneis ou histórico. */
export type PanelKind = "sftp" | "docker" | "net" | "sys" | "tunnels" | "history" | null;

/** Um comando digitado no terminal, guardado para ser rodado de novo. */
export interface CommandEntry {
  id: string;
  command: string;
  connectionId: string;
  /** Nome do servidor na hora em que o comando rodou (a conexão pode sumir). */
  connectionName: string;
  /** ISO de quando o comando foi digitado. */
  at: string;
}

/** Teto do histórico: acima disso o mais antigo sai. */
const HISTORY_LIMIT = 1000;

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
  /** Gravar a saída de toda sessão nova automaticamente. */
  autoRecord: boolean;
  /** Shell do terminal local; vazio usa o `$SHELL` do sistema. */
  localShell: string;
  /** Escurecer os painéis sem foco quando a aba está dividida. */
  dimInactivePanes: boolean;
  /** Guardar os comandos digitados no terminal (painel de histórico). */
  recordHistory: boolean;
  /**
   * Formato da gravação de sessão: `text` (legível) ou `cast` (asciinema, com
   * timing e replay no player embutido).
   */
  recordFormat: "text" | "cast";
}

/** Conexão sintética do terminal local — nunca vai para o banco. */
export const LOCAL_CONNECTION: Connection = {
  id: LOCAL_CONNECTION_ID,
  name: "Terminal local",
  host: "localhost",
  port: 0,
  username: "",
  authMethod: "auto",
  identityId: null,
  jumpHostId: null,
  folderId: null,
  color: "#8b95a7",
  icon: "laptop",
  themeId: null,
  isProduction: false,
  readOnly: false,
  notes: "",
  createdAt: "",
  lastUsedAt: null,
  useCount: 0,
};

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

/**
 * Conexões de todos os painéis abertos — base da restauração de sessão.
 * O terminal local fica de fora: abrir um shell novo no boot não é o que se
 * espera de "restaurar a sessão anterior".
 */
function snapshotSession(tabs: Tab[]): string[] {
  return [
    ...new Set(
      tabs
        .flatMap((t) => t.panes.map((p) => p.connectionId))
        .filter((id) => id && id !== LOCAL_CONNECTION_ID),
    ),
  ];
}

interface AppStore {
  connections: Connection[];
  folders: Folder[];
  themes: Theme[];
  identities: Identity[];
  snippets: Snippet[];

  tabs: Tab[];
  activeTabId: string | null;

  search: string;
  fontSize: number;
  broadcast: boolean;
  sidebarOpen: boolean;
  /** Sidebar recolhida: só os ícones das conexões. */
  sidebarRail: boolean;
  /** Focus mode: tela cheia, sem sidebar nem barra de abas. */
  focusMode: boolean;
  collapsedFolders: string[];
  settings: Settings;

  /** Comandos digitados, do mais recente para o mais antigo (como o `history`). */
  history: CommandEntry[];

  /** Conexões abertas na última sessão do app — base da restauração. */
  lastSessionConnectionIds: string[];

  loadAll: () => Promise<void>;
  reloadConnections: () => Promise<void>;
  reloadFolders: () => Promise<void>;
  reloadIdentities: () => Promise<void>;

  paletteFor: (connectionId: string) => TerminalPalette;
  /** Reaplica o tema de cada painel aberto — chamado após salvar/importar temas. */
  applyPalettes: () => void;
  /**
   * Aplica uma conexão só em memória (pré-visualização do Sheet de edição):
   * atualiza o catálogo e os painéis abertos sem tocar no banco.
   */
  previewConnection: (conn: Connection) => void;

  addTab: (pane: Pane) => void;
  /** Divide o painel ativo da aba, colocando `pane` na nova metade. */
  splitPane: (tabId: string, dir: SplitDir, pane: Pane) => void;
  updatePane: (paneId: string, patch: Partial<Pane>) => void;
  /** Remove o painel; se era o último da aba, a aba vai junto. */
  removePane: (paneId: string) => void;
  closeTab: (id: string) => void;
  /** Move a aba arrastada para a posição da aba sob o cursor. */
  moveTab: (dragId: string, overId: string) => void;
  setActiveTab: (id: string | null) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  setSplitRatio: (tabId: string, splitId: string, ratio: number) => void;

  setSearch: (s: string) => void;
  setFontSize: (n: number) => void;
  /** Abre/fecha o painel lateral do painel ativo da aba ativa. */
  togglePanel: (kind: Exclude<PanelKind, null>) => void;
  toggleBroadcast: () => void;
  /** Alterna entre sidebar completa e recolhida (só ícones). */
  toggleSidebar: () => void;
  setFocusMode: (v: boolean) => void;
  toggleFolderCollapsed: (id: string) => void;
  setSettings: (patch: Partial<Settings>) => void;
  clearLastSession: () => void;

  /** Registra um comando digitado, no topo da lista. */
  recordCommand: (connectionId: string, command: string) => void;
  removeCommand: (id: string) => void;
  /** Limpa o histórico todo, ou só o de um servidor. */
  clearHistory: (connectionId?: string) => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      connections: [],
      folders: [],
      themes: [],
      identities: [],
      snippets: [],

      tabs: [],
      activeTabId: null,

      search: "",
      fontSize: 13,
      broadcast: false,
      sidebarOpen: true,
      sidebarRail: false,
      focusMode: false,
      collapsedFolders: [],
      settings: {
        restoreTabs: true,
        broadcastSkipProd: true,
        autoReconnect: true,
        autoRecord: false,
        localShell: "",
        dimInactivePanes: true,
        recordHistory: true,
        recordFormat: "text",
      },
      history: [],
      lastSessionConnectionIds: [],

      loadAll: async () => {
        const [connections, folders, themes, snippets] = await Promise.all([
          api.connList(),
          api.folderList(),
          api.themeList(),
          api.snippetList(),
        ]);
        set({ connections, folders, themes, snippets });
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

      previewConnection: (conn) =>
        set((s) => ({
          connections: s.connections.map((c) => (c.id === conn.id ? { ...c, ...conn } : c)),
          tabs: s.tabs.map((t) => ({
            ...t,
            panes: t.panes.map((p) =>
              p.connectionId === conn.id
                ? {
                    ...p,
                    title: conn.name,
                    color: conn.color,
                    icon: conn.icon,
                    isProduction: conn.isProduction,
                  }
                : p,
            ),
          })),
        })),

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

      moveTab: (dragId, overId) =>
        set((s) => {
          const from = s.tabs.findIndex((t) => t.id === dragId);
          const to = s.tabs.findIndex((t) => t.id === overId);
          if (from < 0 || to < 0 || from === to) return {};
          const tabs = [...s.tabs];
          const [moved] = tabs.splice(from, 1);
          tabs.splice(to, 0, moved);
          return { tabs };
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
      setFontSize: (fontSize) => set({ fontSize: Math.min(24, Math.max(9, fontSize)) }),
      togglePanel: (kind) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === s.activeTabId
              ? {
                  ...t,
                  panes: t.panes.map((p) =>
                    p.id === t.activePaneId
                      ? { ...p, panel: p.panel === kind ? null : kind }
                      : p,
                  ),
                }
              : t,
          ),
        })),
      toggleBroadcast: () => set((s) => ({ broadcast: !s.broadcast })),
      toggleSidebar: () => set((s) => ({ sidebarRail: !s.sidebarRail })),
      setFocusMode: (focusMode) => set({ focusMode }),
      toggleFolderCollapsed: (id) =>
        set((s) => ({
          collapsedFolders: s.collapsedFolders.includes(id)
            ? s.collapsedFolders.filter((f) => f !== id)
            : [...s.collapsedFolders, id],
        })),
      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      clearLastSession: () => set({ lastSessionConnectionIds: [] }),

      recordCommand: (connectionId, command) =>
        set((s) => {
          if (!s.settings.recordHistory) return {};
          const at = new Date().toISOString();
          const last = s.history[0];
          // Como o `history` do shell com `ignoredups`: a lista é cronológica,
          // do mais recente para o mais antigo, e repetir o comando só atualiza
          // a hora da linha do topo em vez de empilhar `ls` três vezes.
          if (last && last.command === command && last.connectionId === connectionId) {
            return { history: [{ ...last, at }, ...s.history.slice(1)] };
          }
          const entry: CommandEntry = {
            id: crypto.randomUUID(),
            command,
            connectionId,
            connectionName:
              connectionId === LOCAL_CONNECTION_ID
                ? LOCAL_CONNECTION.name
                : (s.connections.find((c) => c.id === connectionId)?.name ?? "servidor"),
            at,
          };
          return { history: [entry, ...s.history].slice(0, HISTORY_LIMIT) };
        }),

      removeCommand: (id) => set((s) => ({ history: s.history.filter((h) => h.id !== id) })),

      clearHistory: (connectionId) =>
        set((s) => ({
          history: connectionId
            ? s.history.filter((h) => h.connectionId !== connectionId)
            : [],
        })),
    }),
    {
      name: "fs-ssh-ui",
      // Só preferências, o snapshot da sessão e o histórico de comandos — nunca
      // dados do catálogo (vêm do SQLite) nem segredos. O histórico guarda o que
      // foi digitado no prompt (senha não passa por aqui: o terminal só registra
      // linha que apareceu na tela) e pode ser desligado/limpo nas configurações.
      partialize: (s) => ({
        fontSize: s.fontSize,
        sidebarOpen: s.sidebarOpen,
        sidebarRail: s.sidebarRail,
        collapsedFolders: s.collapsedFolders,
        settings: s.settings,
        history: s.history,
        lastSessionConnectionIds: s.lastSessionConnectionIds,
      }),
      // O merge padrão do persist é raso: o `settings` gravado por uma versão
      // antiga do app substituía o objeto inteiro, e toda preferência nova
      // nascia `undefined` — foi o que apagou o `recordHistory` de quem já
      // tinha o app instalado (o painel abria dizendo que estava desligado).
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppStore>;
        return {
          ...current,
          ...saved,
          settings: { ...current.settings, ...saved.settings },
          // Linhas gravadas antes de o histórico virar cronológico traziam
          // `lastAt` em vez de `at`; sem isto elas apareceriam sem data.
          history: (saved.history ?? []).map((h) => ({
            ...h,
            at: h.at ?? (h as { lastAt?: string }).lastAt ?? new Date().toISOString(),
          })),
        };
      },
    },
  ),
);

/** Filtro da sidebar: busca por nome, host, usuário ou notas. */
export function filterConnections(connections: Connection[], search: string): Connection[] {
  const q = search.trim().toLowerCase();
  return connections.filter((c) => {
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      c.host.toLowerCase().includes(q) ||
      c.username.toLowerCase().includes(q) ||
      c.notes.toLowerCase().includes(q)
    );
  });
}
