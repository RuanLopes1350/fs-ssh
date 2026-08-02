import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Cable,
  Circle,
  Container,
  FolderTree,
  History,
  Maximize2,
  Minimize2,
  Minus,
  PanelLeft,
  Plug,
  Plus,
  Radio,
  RotateCw,
  Settings as SettingsIcon,
  SquareSplitHorizontal,
  Terminal as TerminalIcon,
  TriangleAlert,
  X,
} from "lucide-react";

import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { AuthDialog, ConfirmDialog, HostKeyDialog, Spinner } from "./components/Dialogs";
import { ConnIcon } from "./components/Icon";
import { SettingsDialog } from "./components/SettingsDialog";
import { ConnectionSheet, EMPTY_CONNECTION } from "./connections/ConnectionSheet";
import { ManagePanel } from "./connections/ManagePanel";
import { DockerPanel } from "./docker/DockerPanel";
import { api, asAppError } from "./lib/ipc";
import type {
  AppError,
  AuthPrompt,
  Connection,
  HostKeyPrompt,
  SessionClosed,
} from "./lib/types";
import { TooltipProvider } from "./components/ui/tooltip";
import { SftpPanel } from "./sftp/SftpPanel";
import { Sidebar } from "./sidebar/Sidebar";
import { TunnelsPanel } from "./tunnels/TunnelsPanel";
import { setInputRouter, TerminalSession, terminals } from "./terminal/session";
import { PanePicker } from "./terminal/PanePicker";
import { TerminalSearchBar } from "./terminal/SearchBar";
import { TerminalView } from "./terminal/TerminalView";
import {
  activePaneOf,
  findPane,
  findPaneBySession,
  useAppStore,
  type Pane,
  type PaneLayout,
  type SplitDir,
  type Tab,
} from "./store/useAppStore";

const encoder = new TextEncoder();

/** Backoff do auto-reconnect. Depois da última tentativa, desiste. */
const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];

/** Tentativa de conexão em andamento, retomada depois de um diálogo. */
interface Pending {
  paneId: string;
  connection: Connection;
  secret?: string;
  jumpSecret?: string;
}

/** Onde o próximo painel entra: aba nova ou split da aba indicada. */
type Placement = { type: "newtab" } | { type: "split"; tabId: string; dir: SplitDir };

export default function App() {
  const tabs = useAppStore((s) => s.tabs);
  const connections = useAppStore((s) => s.connections);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const sftpOpen = useAppStore((s) => s.sftpOpen);
  const dockerOpen = useAppStore((s) => s.dockerOpen);
  const tunnelsOpen = useAppStore((s) => s.tunnelsOpen);
  const broadcast = useAppStore((s) => s.broadcast);
  const fontSize = useAppStore((s) => s.fontSize);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const sidebarRail = useAppStore((s) => s.sidebarRail);
  const focusMode = useAppStore((s) => s.focusMode);
  const loadAll = useAppStore((s) => s.loadAll);

  const [editing, setEditing] = useState<Connection | null>(null);
  const [managing, setManaging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null);
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
  const [prodConfirm, setProdConfirm] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [broadcastConfirm, setBroadcastConfirm] = useState(false);
  const [restoreOffer, setRestoreOffer] = useState<Connection[] | null>(null);
  const pending = useRef<Pending | null>(null);
  const placement = useRef<Placement | null>(null);
  const reconnectTimers = useRef(new Map<string, number>());

  useEffect(() => {
    void (async () => {
      // Snapshot ANTES do loadAll: abrir abas sobrescreve a lista persistida.
      const wanted = useAppStore.getState().lastSessionConnectionIds;
      await loadAll();
      const { settings, connections } = useAppStore.getState();
      if (!settings.restoreTabs || wanted.length === 0) return;
      const found = wanted
        .map((id) => connections.find((c) => c.id === id))
        .filter((c): c is Connection => !!c);
      if (found.length) setRestoreOffer(found);
    })();
  }, [loadAll]);

  /**
   * Focus mode: tela cheia do sistema + esconde sidebar e barra de abas.
   * Só o terminal fica, com uma saída discreta no canto.
   */
  const setFocus = useCallback(async (on: boolean) => {
    useAppStore.getState().setFocusMode(on);
    try {
      await getCurrentWindow().setFullscreen(on);
    } catch {
      // Sem permissão de fullscreen o modo ainda vale dentro da janela.
    }
    // O terminal precisa remedir depois que o layout assenta.
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 120);
  }, []);

  const cancelReconnect = useCallback((paneId: string) => {
    const timer = reconnectTimers.current.get(paneId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      reconnectTimers.current.delete(paneId);
    }
  }, []);

  const startConnect = useCallback(
    async (connection: Connection, secret?: string, jumpSecret?: string) => {
      const store = useAppStore.getState();
      const existingPaneId = pending.current?.paneId;
      const paneId = existingPaneId ?? crypto.randomUUID();

      if (!existingPaneId) {
        const pane: Pane = {
          id: paneId,
          connectionId: connection.id,
          title: connection.name,
          color: connection.color,
          icon: connection.icon,
          isProduction: connection.isProduction,
          status: "connecting",
          sessionId: null,
          detail: null,
          reconnectAttempt: 0,
        };
        terminals.set(
          paneId,
          new TerminalSession(
            connection.id,
            store.paletteFor(connection.id),
            store.fontSize,
          ),
        );
        const where = placement.current ?? { type: "newtab" as const };
        placement.current = null;
        if (where.type === "split") {
          store.splitPane(where.tabId, where.dir, pane);
        } else {
          store.addTab(pane);
        }
      } else {
        // Retry ou painel vazio do split escolhendo servidor: garante o
        // terminal e assume a identidade visual da conexão escolhida.
        if (!terminals.has(paneId)) {
          terminals.set(
            paneId,
            new TerminalSession(
              connection.id,
              store.paletteFor(connection.id),
              store.fontSize,
            ),
          );
        }
        store.updatePane(paneId, {
          connectionId: connection.id,
          title: connection.name,
          color: connection.color,
          icon: connection.icon,
          isProduction: connection.isProduction,
          status: "connecting",
          detail: null,
        });
      }

      pending.current = { paneId, connection, secret, jumpSecret };

      try {
        const session = terminals.get(paneId)!;
        const info = await session.connect(secret, jumpSecret);
        useAppStore.getState().updatePane(paneId, {
          status: "open",
          sessionId: info.sessionId,
          detail: null,
          reconnectAttempt: 0,
        });
        pending.current = null;
        // Túneis marcados como auto-início sobem junto com a sessão; falhas
        // (porta ocupada etc.) aparecem no próprio terminal, sem bloquear nada.
        void api.forwardAutostart(info.sessionId).then((r) => {
          if (r.errors.length) {
            terminals
              .get(paneId)
              ?.term.write(`\r\n\x1b[33m── túneis: ${r.errors.join("; ")} ──\x1b[0m\r\n`);
          }
        });
        if (useAppStore.getState().settings.autoRecord) {
          void api
            .recordingStart(info.sessionId)
            .then((path) => useAppStore.getState().updatePane(paneId, { recording: path }))
            .catch(() => {});
        }
      } catch (raw) {
        const e = asAppError(raw);
        if (!handleConnectError(e)) {
          // O erro fica preso ao painel que falhou. Um banner global não diria
          // de qual servidor é a falha quando há vários abertos.
          useAppStore.getState().updatePane(paneId, { status: "closed", detail: e.message });
          terminals.get(paneId)?.markClosed(e.message);
          pending.current = null;
          // Se esta tentativa fazia parte de um auto-reconnect, agenda a próxima.
          const found = findPane(useAppStore.getState().tabs, paneId);
          if (found && found.pane.reconnectAttempt > 0) scheduleReconnect(paneId);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Agenda a próxima tentativa de reconexão do painel, com backoff. */
  const scheduleReconnect = useCallback(
    (paneId: string) => {
      const { tabs: current, updatePane } = useAppStore.getState();
      const found = findPane(current, paneId);
      if (!found) return;
      const attempt = found.pane.reconnectAttempt + 1;
      if (attempt > RECONNECT_DELAYS_MS.length) {
        updatePane(paneId, { reconnectAttempt: 0 });
        return;
      }
      updatePane(paneId, { reconnectAttempt: attempt });

      const timer = window.setTimeout(() => {
        reconnectTimers.current.delete(paneId);
        const st = useAppStore.getState();
        const f = findPane(st.tabs, paneId);
        const connection = st.connections.find((c) => c.id === f?.pane.connectionId);
        if (!f || !connection || f.pane.status !== "closed") return;
        pending.current = { paneId, connection };
        void startConnect(connection);
      }, RECONNECT_DELAYS_MS[attempt - 1]);
      reconnectTimers.current.set(paneId, timer);
    },
    [startConnect],
  );

  // O backend avisa quando o canal cai (logout, rede, kill). Sem isso o painel
  // ficaria "aberto" para sempre depois de um `exit`.
  useEffect(() => {
    const un = listen<SessionClosed>("session-closed", (e) => {
      const { sessionId, reason, exitStatus } = e.payload;
      const { tabs: current, updatePane, settings } = useAppStore.getState();
      const found = findPaneBySession(current, sessionId);
      if (!found) return;
      const wasOpen = found.pane.status === "open";
      terminals
        .get(found.pane.id)
        ?.markClosed(exitStatus != null ? `${reason} (código ${exitStatus})` : reason);
      // A gravação morre com a sessão; o backend já fechou o arquivo.
      updatePane(found.pane.id, { status: "closed", detail: reason, recording: null });

      // Auto-reconnect só para queda inesperada: `exit` limpo (exitStatus
      // preenchido) e fechamento pelo usuário não contam.
      const unexpected =
        wasOpen && exitStatus == null && reason !== "encerrada pelo usuário";
      if (unexpected && settings.autoReconnect) scheduleReconnect(found.pane.id);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [scheduleReconnect]);

  /** Retorna true quando o erro virou um diálogo (fluxo continua). */
  const handleConnectError = (e: AppError): boolean => {
    const d = (e.data ?? {}) as Record<string, string | number | boolean>;
    if (e.kind === "host_key_unknown" || e.kind === "host_key_changed") {
      setHostKey({
        host: String(d.host),
        port: Number(d.port),
        fingerprint: String(d.fingerprint),
        algorithm: String(d.algorithm),
        knownFingerprint: d.knownFingerprint ? String(d.knownFingerprint) : undefined,
        changed: e.kind === "host_key_changed",
      });
      return true;
    }
    if (e.kind === "auth_required") {
      setAuthPrompt({
        authKind: d.authKind === "passphrase" ? "passphrase" : "password",
        prompt: String(d.prompt),
        forJump: d.forJump === true,
      });
      return true;
    }
    return false;
  };

  const requestConnect = (connection: Connection, where?: Placement) => {
    pending.current = null;
    placement.current = where ?? null;
    if (connection.isProduction) {
      setProdConfirm(connection);
      return;
    }
    void startConnect(connection);
  };

  /**
   * Divide o painel ativo abrindo um painel VAZIO com o seletor de servidor —
   * a sessão de origem vem pré-selecionada (Enter duplica), Esc desfaz o split.
   */
  const splitActive = (dir: SplitDir) => {
    const st = useAppStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    const origin = activePaneOf(tab);
    if (!tab || !origin) return;
    st.splitPane(tab.id, dir, {
      id: crypto.randomUUID(),
      connectionId: origin.connectionId,
      title: "Novo painel",
      color: origin.color,
      icon: origin.icon,
      isProduction: false,
      status: "empty",
      sessionId: null,
      detail: null,
      reconnectAttempt: 0,
    });
  };

  /** Servidor escolhido no seletor de um painel vazio. */
  const choosePane = (pane: Pane, connection: Connection) => {
    pending.current = { paneId: pane.id, connection };
    placement.current = null;
    if (connection.isProduction) {
      setProdConfirm(connection);
      return;
    }
    void startConnect(connection);
  };

  /** Tenta de novo no mesmo painel, reaproveitando o terminal e o scrollback. */
  const retry = (pane: Pane) => {
    cancelReconnect(pane.id);
    useAppStore.getState().updatePane(pane.id, { reconnectAttempt: 0 });
    const connection = useAppStore
      .getState()
      .connections.find((c) => c.id === pane.connectionId);
    if (!connection) return;
    pending.current = { paneId: pane.id, connection };
    void startConnect(connection);
  };

  const closePane = useCallback(
    async (paneId: string) => {
      cancelReconnect(paneId);
      const session = terminals.get(paneId);
      await session?.disconnect();
      session?.dispose();
      terminals.delete(paneId);
      useAppStore.getState().removePane(paneId);
    },
    [cancelReconnect],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      for (const pane of tab.panes) {
        cancelReconnect(pane.id);
        const session = terminals.get(pane.id);
        await session?.disconnect();
        session?.dispose();
        terminals.delete(pane.id);
      }
      useAppStore.getState().closeTab(tabId);
    },
    [cancelReconnect],
  );

  const duplicate = async (c: Connection) => {
    const copy = await api.connSave({
      ...c,
      id: "",
      name: `${c.name} (cópia)`,
      createdAt: "",
      lastUsedAt: null,
      useCount: 0,
    });
    await useAppStore.getState().reloadConnections();
    setEditing(copy);
  };

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activePane = activePaneOf(activeTab);

  /** Abre a conexão num split da aba ativa (nova aba se não houver nenhuma). */
  const connectInSplit = (connection: Connection, dir: SplitDir) => {
    const st = useAppStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    requestConnect(connection, tab ? { type: "split", tabId: tab.id, dir } : undefined);
  };

  const runPalette = (action: PaletteAction, split: boolean) => {
    setPaletteOpen(false);
    if (action.type === "connect") {
      if (split) connectInSplit(action.connection, "row");
      else requestConnect(action.connection);
      return;
    }
    if (!activePane?.sessionId) return;
    const body = action.snippet.body.endsWith("\n")
      ? action.snippet.body
      : `${action.snippet.body}\n`;
    void api.sshWrite(activePane.sessionId, Array.from(encoder.encode(body)));
  };

  /** Liga/desliga a gravação da sessão do painel ativo. */
  const toggleRecording = () => {
    if (!activePane?.sessionId) return;
    const { id, sessionId, recording } = activePane;
    void (async () => {
      try {
        if (recording) {
          await api.recordingStop(sessionId);
          useAppStore.getState().updatePane(id, { recording: null });
        } else {
          const path = await api.recordingStart(sessionId);
          useAppStore.getState().updatePane(id, { recording: path });
        }
      } catch {
        // Sessão que morreu no meio: o painel já mostra o estado real.
      }
    })();
  };

  /** Liga o broadcast, pedindo confirmação quando painéis PROD receberiam input. */
  const toggleBroadcast = () => {
    const { broadcast: on, tabs: current, settings } = useAppStore.getState();
    const hasProdOpen = current.some((t) =>
      t.panes.some((p) => p.isProduction && p.status === "open"),
    );
    if (!on && !settings.broadcastSkipProd && hasProdOpen) {
      setBroadcastConfirm(true);
      return;
    }
    useAppStore.getState().toggleBroadcast();
  };

  // Atalhos globais.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const store = useAppStore.getState();

      // ⌘⌥←→↑↓ — circula o foco entre os painéis da aba ativa.
      if (e.altKey && e.key.startsWith("Arrow")) {
        const tab = store.tabs.find((t) => t.id === store.activeTabId);
        if (tab && tab.panes.length > 1) {
          e.preventDefault();
          const i = tab.panes.findIndex((p) => p.id === tab.activePaneId);
          const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
          const next = tab.panes[(i + dir + tab.panes.length) % tab.panes.length];
          store.setActivePane(tab.id, next.id);
          terminals.get(next.id)?.term.focus();
        }
        return;
      }

      // ⌘1…⌘9 — vai direto para a aba N (⌘9 = última, como nos navegadores).
      if (!e.shiftKey && e.key >= "1" && e.key <= "9") {
        const idx = e.key === "9" ? store.tabs.length - 1 : Number(e.key) - 1;
        const tab = store.tabs[idx];
        if (tab) {
          e.preventDefault();
          store.setActiveTab(tab.id);
        }
        return;
      }

      // ⌘⇧[ / ⌘⇧] — aba anterior/seguinte.
      if (e.shiftKey && (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}")) {
        const list = store.tabs;
        if (list.length > 1 && store.activeTabId) {
          e.preventDefault();
          const i = list.findIndex((t) => t.id === store.activeTabId);
          const dir = e.key === "[" || e.key === "{" ? -1 : 1;
          const next = list[(i + dir + list.length) % list.length];
          store.setActiveTab(next.id);
        }
        return;
      }

      if (e.key === "n") {
        e.preventDefault();
        setEditing({ ...EMPTY_CONNECTION });
      } else if (e.key === "d" || e.key === "D") {
        // ⌘D divide lado a lado; ⌘⇧D divide empilhado (como no iTerm).
        e.preventDefault();
        splitActive(e.shiftKey ? "col" : "row");
      } else if (e.key === "k" || e.key === "t") {
        // ⌘T abre a paleta: "nova aba" aqui é escolher a que servidor conectar.
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "w") {
        // Fecha o painel ativo; se for o último da aba, a aba vai junto.
        const tab = store.tabs.find((t) => t.id === store.activeTabId);
        if (tab) {
          e.preventDefault();
          void closePane(tab.activePaneId);
        }
      } else if (e.key === "f") {
        if (store.activeTabId) {
          e.preventDefault();
          setSearchOpen((v) => !v);
        }
      } else if (e.key === "b") {
        e.preventDefault();
        // ⌘B esconde/mostra; ⌘⇧B recolhe para a faixa de ícones.
        if (e.shiftKey) store.toggleSidebar();
        else useAppStore.setState({ sidebarOpen: !store.sidebarOpen });
      } else if ((e.key === "f" || e.key === "F") && e.shiftKey) {
        e.preventDefault();
        void setFocus(!useAppStore.getState().focusMode);
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        store.setFontSize(store.fontSize + 1);
      } else if (e.key === "-") {
        e.preventDefault();
        store.setFontSize(store.fontSize - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closePane]);

  // A busca é do painel ativo; trocar de aba/painel fecha a barra para não
  // buscar "no terminal errado" sem perceber.
  useEffect(() => setSearchOpen(false), [activeTabId, activeTab?.activePaneId]);

  // Zoom aplicado a todos os terminais abertos.
  useEffect(() => {
    terminals.forEach((t) => t.setFontSize(fontSize));
  }, [fontSize]);

  // Broadcast: o que for digitado em qualquer painel vai para todas as sessões
  // abertas. Um único `ssh_broadcast` no backend evita N round-trips de IPC por
  // tecla.
  useEffect(() => {
    if (!broadcast) {
      setInputRouter(null);
      return;
    }
    setInputRouter((_origin, bytes) => {
      const { tabs: current, settings } = useAppStore.getState();
      const ids = current
        .flatMap((t) => t.panes)
        .filter(
          (p) =>
            p.status === "open" &&
            p.sessionId &&
            !(settings.broadcastSkipProd && p.isProduction),
        )
        .map((p) => p.sessionId as string);
      if (ids.length) void api.sshBroadcast(ids, bytes).catch(() => {});
    });
    return () => setInputRouter(null);
  }, [broadcast]);

  /** Um painel (folha da árvore): terminal + overlays de estado + foco. */
  const renderPane = (tab: Tab, paneId: string, visible: boolean) => {
    const pane = tab.panes.find((p) => p.id === paneId);
    if (!pane) return null;
    const multi = tab.panes.length > 1;
    const focused = tab.activePaneId === pane.id;

    if (pane.status === "empty") {
      return (
        <div
          className="pane-slot"
          data-focused={multi && focused}
          onMouseDownCapture={() => {
            if (!focused) useAppStore.getState().setActivePane(tab.id, pane.id);
          }}
        >
          <PanePicker
            connections={connections}
            currentId={pane.connectionId || null}
            onChoose={(c) => choosePane(pane, c)}
            onCancel={() => void closePane(pane.id)}
          />
        </div>
      );
    }

    return (
      <div
        className="pane-slot"
        data-focused={multi && focused}
        onMouseDownCapture={() => {
          if (!focused) useAppStore.getState().setActivePane(tab.id, pane.id);
        }}
      >
        <TerminalView paneId={pane.id} visible={visible} />

        {searchOpen && visible && focused && (
          <TerminalSearchBar paneId={pane.id} onClose={() => setSearchOpen(false)} />
        )}

        {pane.status === "connecting" && (
          <div className="term-overlay term-overlay--quiet">
            <Plug size={20} />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Spinner />
              Conectando a {pane.title}…
            </div>
          </div>
        )}

        {pane.status === "closed" && pane.reconnectAttempt > 0 && (
          <div className="term-overlay term-overlay--quiet">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Spinner />
              Reconectando a {pane.title} — tentativa {pane.reconnectAttempt}/
              {RECONNECT_DELAYS_MS.length}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn"
                onClick={() => {
                  cancelReconnect(pane.id);
                  useAppStore.getState().updatePane(pane.id, { reconnectAttempt: 0 });
                }}
              >
                Cancelar
              </button>
              <button className="btn btn--primary" onClick={() => retry(pane)}>
                Agora
              </button>
            </div>
          </div>
        )}

        {pane.status === "closed" && pane.reconnectAttempt === 0 && pane.detail && (
          <div className="term-overlay">
            <div className="term-overlay__card">
              <div className="term-overlay__title">
                <TriangleAlert size={16} color="var(--danger)" />
                Não foi possível manter a sessão com {pane.title}
              </div>
              <div className="term-overlay__msg">{pane.detail}</div>
              <div className="term-overlay__actions">
                <button className="btn" onClick={() => void closePane(pane.id)}>
                  Fechar painel
                </button>
                <button className="btn btn--primary" onClick={() => retry(pane)}>
                  <RotateCw size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                  Tentar de novo
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  /** Render recursivo da árvore de splits de uma aba. */
  const renderLayout = (tab: Tab, node: PaneLayout, visible: boolean): React.ReactNode => {
    if (node.type === "leaf") return renderPane(tab, node.paneId, visible);
    return (
      <SplitView
        key={node.id}
        dir={node.dir}
        ratio={node.ratio}
        onRatio={(r) => useAppStore.getState().setSplitRatio(tab.id, node.id, r)}
        a={renderLayout(tab, node.a, visible)}
        b={renderLayout(tab, node.b, visible)}
      />
    );
  };

  /** Resumo visual da aba a partir dos seus painéis. */
  const tabSummary = (t: Tab) => {
    const first = t.panes[0];
    const status = t.panes.some((p) => p.status === "open")
      ? "open"
      : t.panes.some((p) => p.status === "connecting")
        ? "connecting"
        : "closed";
    return {
      title: first?.title ?? "",
      extra: t.panes.length > 1 ? t.panes.length : 0,
      color: first?.color ?? "var(--accent)",
      icon: first?.icon ?? "server",
      isProduction: t.panes.some((p) => p.isProduction),
      status,
      detail: activePaneOf(t)?.detail ?? null,
    };
  };

  return (
    // O provider precisa envolver a árvore inteira: o Radix Tooltip lança se
    // um `Tooltip.Root` (sidebar recolhida) renderizar sem ele.
    <TooltipProvider delayDuration={250} skipDelayDuration={400}>
    <div
      className="app"
      data-sidebar={sidebarOpen && !focusMode}
      data-rail={sidebarRail}
      data-focus={focusMode}
    >
      {sidebarOpen && !focusMode && (
        <Sidebar
          onConnect={requestConnect}
          onConnectSplit={activeTab ? connectInSplit : undefined}
          onEdit={setEditing}
          onDuplicate={(c) => void duplicate(c)}
          onDelete={setDeleting}
          onNew={() => setEditing({ ...EMPTY_CONNECTION })}
          onManage={() => setManaging(true)}
        />
      )}

      <main className="main">
        {focusMode && (
          <button
            className="focus-exit"
            title="Sair do focus mode (⌘⇧F ou Esc)"
            onClick={() => void setFocus(false)}
          >
            <Minimize2 size={13} /> sair do foco
          </button>
        )}

        <div className="tabbar">
          <button
            className="icon-btn"
            style={{ alignSelf: "center", flex: "none" }}
            title={
              !sidebarOpen
                ? "Mostrar barra lateral (⌘B)"
                : sidebarRail
                  ? "Expandir barra lateral (⌘⇧B)"
                  : "Recolher para ícones (⌘⇧B)"
            }
            data-active={!sidebarOpen || sidebarRail}
            onClick={() => {
              const s = useAppStore.getState();
              if (!s.sidebarOpen) useAppStore.setState({ sidebarOpen: true });
              else s.toggleSidebar();
            }}
          >
            <PanelLeft size={14} />
          </button>

          {tabs.map((t) => {
            const s = tabSummary(t);
            return (
              <div
                key={t.id}
                className="tab"
                data-active={t.id === activeTabId}
                style={{ borderTopColor: t.id === activeTabId ? s.color : "transparent" }}
                onClick={() => useAppStore.getState().setActiveTab(t.id)}
              >
                <span
                  className="tab__status"
                  style={{
                    background:
                      s.status === "open"
                        ? "var(--ok)"
                        : s.status === "connecting"
                          ? "var(--warn)"
                          : "var(--danger)",
                  }}
                />
                <ConnIcon name={s.icon} size={13} color={s.color} />
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                  title={s.detail ?? undefined}
                >
                  {s.title}
                </span>
                {s.extra > 0 && <span className="tab__panes">⊞{s.extra}</span>}
                {s.isProduction && <span className="prod-badge">PROD</span>}
                <span
                  className="tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(t.id);
                  }}
                >
                  <X size={12} />
                </span>
              </div>
            );
          })}

          <div className="toolbar">
            {broadcast && <span className="broadcast-badge">BROADCAST</span>}
            <button
              className="icon-btn"
              title="Dividir painel (⌘D lado a lado, ⌘⇧D empilhado)"
              disabled={!activePane}
              onClick={() => splitActive("row")}
            >
              <SquareSplitHorizontal size={14} />
            </button>
            <button
              className="icon-btn"
              title="Diminuir fonte (⌘−)"
              onClick={() => useAppStore.getState().setFontSize(fontSize - 1)}
            >
              <Minus size={14} />
            </button>
            <button
              className="icon-btn"
              title="Aumentar fonte (⌘+)"
              onClick={() => useAppStore.getState().setFontSize(fontSize + 1)}
            >
              <Plus size={14} />
            </button>
            <button
              className="icon-btn"
              data-active={broadcast}
              title="Enviar o que eu digitar para todas as sessões abertas"
              onClick={toggleBroadcast}
            >
              <Radio size={14} />
            </button>
            <button
              className="icon-btn"
              data-recording={!!activePane?.recording}
              disabled={!activePane?.sessionId}
              title={
                activePane?.recording
                  ? `Gravando em ${activePane.recording} — clique para parar`
                  : "Gravar a saída desta sessão em arquivo"
              }
              onClick={toggleRecording}
            >
              <Circle size={14} fill={activePane?.recording ? "currentColor" : "none"} />
            </button>
            <button
              className="icon-btn"
              data-active={sftpOpen}
              title="Painel de arquivos (SFTP)"
              onClick={() => useAppStore.getState().toggleSftp()}
            >
              <FolderTree size={14} />
            </button>
            <button
              className="icon-btn"
              data-active={dockerOpen}
              title="Containers Docker/Podman do host"
              onClick={() => useAppStore.getState().toggleDocker()}
            >
              <Container size={14} />
            </button>
            <button
              className="icon-btn"
              data-active={tunnelsOpen}
              title="Túneis (port forwarding -L/-R)"
              onClick={() => useAppStore.getState().toggleTunnels()}
            >
              <Cable size={14} />
            </button>
            <button
              className="icon-btn"
              data-active={focusMode}
              title="Focus mode — tela cheia só com o terminal (⌘⇧F)"
              onClick={() => void setFocus(!focusMode)}
            >
              <Maximize2 size={14} />
            </button>
            <button
              className="icon-btn"
              title="Configurações (⌘,)"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon size={14} />
            </button>
          </div>
        </div>

        {activePane && (
          <div
            className="session-strip"
            data-production={activePane.isProduction}
            style={activePane.isProduction ? undefined : { background: activePane.color }}
          />
        )}

        <div className="workarea" data-broadcast={broadcast}>
          {tabs.length === 0 ? (
            <div className="empty">
              <TerminalIcon size={30} />
              <div>Escolha um servidor na barra lateral para conectar.</div>
              <div>
                <span className="kbd">⌘K</span> abre a busca rápida ·{" "}
                <span className="kbd">⌘D</span> divide o painel
              </div>
            </div>
          ) : (
            tabs.map((t) => (
              <div
                key={t.id}
                className="term-slot"
                style={{ display: t.id === activeTabId ? "flex" : "none" }}
              >
                {renderLayout(t, t.layout, t.id === activeTabId)}
              </div>
            ))
          )}

          {sftpOpen && activePane?.sessionId && (
            <SftpPanel key={activePane.sessionId} sessionId={activePane.sessionId} />
          )}
          {dockerOpen && activePane?.sessionId && (
            <DockerPanel key={activePane.sessionId} sessionId={activePane.sessionId} />
          )}
          {tunnelsOpen && activePane?.sessionId && (
            <TunnelsPanel
              key={activePane.sessionId}
              sessionId={activePane.sessionId}
              connectionId={activePane.connectionId}
            />
          )}
        </div>
      </main>

      {editing && <ConnectionSheet initial={editing} onClose={() => setEditing(null)} />}
      {managing && (
        <ManagePanel
          activeSessionId={activePane?.status === "open" ? activePane.sessionId : null}
          activeSessionTitle={activePane?.title ?? null}
          onClose={() => setManaging(false)}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          hasSession={!!activePane?.sessionId}
          canSplit={!!activeTab}
          onRun={runPalette}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {restoreOffer && (
        <ConfirmDialog
          title="Restaurar sessão anterior"
          confirmLabel={`Reconectar (${restoreOffer.length})`}
          message={
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <History size={15} color="var(--accent)" />
                Estas conexões estavam abertas quando o app foi fechado:
              </div>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {restoreOffer.map((c) => (
                  <li key={c.id}>
                    {c.name}
                    {c.isProduction && (
                      <span className="prod-badge" style={{ marginLeft: 6 }}>
                        PROD
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          }
          onConfirm={() => {
            const list = restoreOffer;
            setRestoreOffer(null);
            for (const c of list) {
              pending.current = null;
              placement.current = null;
              void startConnect(c);
            }
          }}
          onCancel={() => setRestoreOffer(null)}
        />
      )}

      {broadcastConfirm && (
        <ConfirmDialog
          title="Broadcast com sessões de produção"
          danger
          confirmLabel="Ligar mesmo assim"
          message={
            <>
              Há sessões <b>PROD</b> abertas e a opção de ignorá-las está desligada. Tudo
              o que você digitar será enviado <b>também para produção</b>.
            </>
          }
          onConfirm={() => {
            setBroadcastConfirm(false);
            useAppStore.getState().toggleBroadcast();
          }}
          onCancel={() => setBroadcastConfirm(false)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Excluir conexão"
          danger
          confirmLabel="Excluir"
          message={
            <>
              Excluir <b>{deleting.name}</b> ({deleting.username}@{deleting.host})? As
              sessões já abertas continuam funcionando.
            </>
          }
          onConfirm={() => {
            const c = deleting;
            setDeleting(null);
            void (async () => {
              await api.connDelete(c.id);
              await useAppStore.getState().reloadConnections();
            })();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}

      {prodConfirm && (
        <ConfirmDialog
          title="Conectar em produção"
          danger
          confirmLabel="Conectar"
          message={
            <>
              <b>{prodConfirm.name}</b> está marcado como produção (
              {prodConfirm.username}@{prodConfirm.host}). O painel vai ficar com faixa
              vermelha enquanto a sessão estiver aberta.
            </>
          }
          onConfirm={() => {
            const c = prodConfirm;
            setProdConfirm(null);
            void startConnect(c);
          }}
          onCancel={() => {
            setProdConfirm(null);
            placement.current = null;
          }}
        />
      )}

      {hostKey && (
        <HostKeyDialog
          prompt={hostKey}
          onTrust={() => {
            const p = pending.current;
            const hk = hostKey;
            setHostKey(null);
            void (async () => {
              await api.hostKeyTrust(hk.host, hk.port, hk.algorithm, hk.fingerprint);
              if (p) await startConnect(p.connection, p.secret, p.jumpSecret);
            })();
          }}
          onCancel={() => {
            setHostKey(null);
            const p = pending.current;
            if (p) {
              useAppStore.getState().updatePane(p.paneId, {
                status: "closed",
                detail: "host key recusada",
              });
              terminals.get(p.paneId)?.markClosed("host key recusada");
            }
            pending.current = null;
          }}
        />
      )}

      {authPrompt && (
        <AuthDialog
          prompt={authPrompt}
          onSubmit={(secret) => {
            const p = pending.current;
            const forJump = authPrompt.forJump;
            setAuthPrompt(null);
            if (!p) return;
            // Segredo do bastion e do destino viajam separados — reaproveitar o
            // mesmo campo fazia o diálogo entrar em loop com bastion por senha.
            if (forJump) void startConnect(p.connection, p.secret, secret);
            else void startConnect(p.connection, secret, p.jumpSecret);
          }}
          onCancel={() => {
            setAuthPrompt(null);
            const p = pending.current;
            if (p) {
              useAppStore.getState().updatePane(p.paneId, {
                status: "closed",
                detail: "autenticação cancelada",
              });
              terminals.get(p.paneId)?.markClosed("autenticação cancelada");
            }
            pending.current = null;
          }}
        />
      )}
    </div>
    </TooltipProvider>
  );
}

/**
 * Divisão com divisor arrastável. `ratio` é a fração da primeira metade;
 * arrastar chama `onRatio` e os terminais se reajustam pelo ResizeObserver.
 */
function SplitView({
  dir,
  ratio,
  onRatio,
  a,
  b,
}: {
  dir: SplitDir;
  ratio: number;
  onRatio: (r: number) => void;
  a: React.ReactNode;
  b: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const frac =
        dir === "row"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      onRatio(Math.min(0.85, Math.max(0.15, frac)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div ref={ref} className={`split split--${dir}`}>
      <div className="split__cell" style={{ flexGrow: ratio }}>
        {a}
      </div>
      <div className="split__divider" onMouseDown={onMouseDown} />
      <div className="split__cell" style={{ flexGrow: 1 - ratio }}>
        {b}
      </div>
    </div>
  );
}
