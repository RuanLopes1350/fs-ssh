import { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder as FolderIcon,
  FolderPlus,
  Inbox,
  Pencil,
  Plug,
  Plus,
  Search,
  Settings2,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash2,
} from "lucide-react";

import { ContextMenu, type MenuPosition } from "../components/ContextMenu";
import { ConfirmDialog, InputDialog } from "../components/Dialogs";
import { ConnIcon } from "../components/Icon";
import { Tooltip } from "../components/ui/tooltip";
import { api } from "../lib/ipc";
import {
  activePaneOf,
  filterConnections,
  LOCAL_CONNECTION,
  WSL_CONNECTION,
  useAppStore,
} from "../store/useAppStore";
import type { Connection, Folder } from "../lib/types";

/** Id-sentinela da seção sem pasta, guardado junto com as pastas colapsadas. */
const SECTION_ROOT = "__sem_pasta__";

interface SidebarProps {
  onConnect: (c: Connection) => void;
  /** Presente quando há aba ativa para receber um split. */
  onConnectSplit?: (c: Connection, dir: "row" | "col") => void;
  onEdit: (c: Connection) => void;
  onDuplicate: (c: Connection) => void;
  onDelete: (c: Connection) => void;
  onNew: () => void;
  onManage: () => void;
}

export function Sidebar(props: SidebarProps) {
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const search = useAppStore((s) => s.search);
  const collapsedFolders = useAppStore((s) => s.collapsedFolders);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const rail = useAppStore((s) => s.sidebarRail);
  const setSearch = useAppStore((s) => s.setSearch);
  const toggleFolderCollapsed = useAppStore((s) => s.toggleFolderCollapsed);
  const reloadFolders = useAppStore((s) => s.reloadFolders);
  const reloadConnections = useAppStore((s) => s.reloadConnections);
  const showWslInSidebar = useAppStore(
    (s) =>
      (s.wslAvailable && s.settings.showWslInSidebar !== false) ||
      s.settings.wslShell.trim() !== "",
  );

  const [menu, setMenu] = useState<{ conn: Connection; at: MenuPosition } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: Folder; at: MenuPosition } | null>(
    null,
  );
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<Folder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);

  /** Conexão sendo arrastada para uma pasta. */
  const [dragConnId, setDragConnId] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);

  // A conexão do painel ativo fica destacada — trocar de aba (ou de painel num
  // split) mostra na hora "onde" você está.
  const activeConnectionId =
    activePaneOf(tabs.find((t) => t.id === activeTabId))?.connectionId ?? null;

  const visible = useMemo(
    () => filterConnections(connections, search),
    [connections, search],
  );
  const filtering = search.trim().length > 0;
  const collapsed = (id: string) => collapsedFolders.includes(id) && !filtering;

  const byFolder = useMemo(() => {
    const map = new Map<string | null, Connection[]>();
    for (const c of visible) {
      const key = c.folderId ?? null;
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return map;
  }, [visible]);

  const rootConns = byFolder.get(null) ?? [];

  const listRef = useRef<HTMLDivElement>(null);

  /** Move o foco entre as linhas da lista (índice negativo conta do fim). */
  const focusRow = (index: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-conn-row]");
    if (!rows?.length) return;
    const i = index < 0 ? rows.length + index : Math.min(index, rows.length - 1);
    rows[Math.max(0, i)]?.focus();
  };

  /** ↑ ↓ Home End navegam; da primeira linha, ↑ volta para a busca. */
  const onListKeyDown = (e: React.KeyboardEvent) => {
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-conn-row]") ?? [],
    );
    const current = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(current + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (current <= 0) document.querySelector<HTMLInputElement>("#sidebar-search")?.focus();
      else focusRow(current - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(-1);
    }
  };

  const openMenu = (conn: Connection) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ conn, at: { x: e.clientX, y: e.clientY } });
  };

  const moveToFolder = async (connId: string, folderId: string | null) => {
    const conn = connections.find((c) => c.id === connId);
    if (!conn || conn.folderId === folderId) return;
    await api.connSave({ ...conn, folderId });
    await reloadConnections();
  };

  const folderDropProps = (target: string) => ({
    "data-drop": dropFolder === target,
    onDragOver: (e: React.DragEvent) => {
      if (!dragConnId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropFolder(target);
    },
    onDragLeave: () => setDropFolder((t) => (t === target ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const id = dragConnId;
      setDragConnId(null);
      setDropFolder(null);
      if (id) void moveToFolder(id, target === SECTION_ROOT ? null : target);
    },
  });

  const rowProps = (c: Connection) => ({
    conn: c,
    active: c.id === activeConnectionId,
    dragging: c.id === dragConnId,
    onConnect: props.onConnect,
    onEdit: props.onEdit,
    onContextMenu: openMenu(c),
    onDragStart: (e: React.DragEvent) => {
      setDragConnId(c.id);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", c.id);
    },
    onDragEnd: () => {
      setDragConnId(null);
      setDropFolder(null);
    },
  });

  const saveFolder = async (name: string, folder?: Folder) => {
    await api.folderSave(
      folder ? { ...folder, name } : { id: "", name, parentId: null, sort: 0 },
    );
    await reloadFolders();
  };

  const chevron = (id: string) =>
    collapsed(id) ? <ChevronRight size={11} /> : <ChevronDown size={11} />;

  const dialogs = (
    <>
      {menu && (
        <ContextMenu
          position={menu.at}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Conectar",
              icon: <Plug size={13} />,
              onSelect: () => props.onConnect(menu.conn),
            },
            ...(props.onConnectSplit
              ? [
                  {
                    label: "Conectar em split (lado a lado)",
                    icon: <SquareSplitHorizontal size={13} />,
                    onSelect: () => props.onConnectSplit!(menu.conn, "row"),
                  },
                  {
                    label: "Conectar em split (empilhado)",
                    icon: <SquareSplitVertical size={13} />,
                    onSelect: () => props.onConnectSplit!(menu.conn, "col"),
                  },
                ]
              : []),
            {
              label: "Editar…",
              icon: <Pencil size={13} />,
              onSelect: () => props.onEdit(menu.conn),
            },
            {
              label: "Duplicar",
              icon: <Copy size={13} />,
              onSelect: () => props.onDuplicate(menu.conn),
            },
            {
              label: "Excluir",
              icon: <Trash2 size={13} />,
              danger: true,
              separatorBefore: true,
              onSelect: () => props.onDelete(menu.conn),
            },
          ]}
        />
      )}

      {folderMenu && (
        <ContextMenu
          position={folderMenu.at}
          onClose={() => setFolderMenu(null)}
          items={[
            {
              label: "Renomear…",
              icon: <Pencil size={13} />,
              onSelect: () => setRenamingFolder(folderMenu.folder),
            },
            {
              label: "Excluir pasta",
              icon: <Trash2 size={13} />,
              danger: true,
              separatorBefore: true,
              onSelect: () => setDeletingFolder(folderMenu.folder),
            },
          ]}
        />
      )}

      {creatingFolder && (
        <InputDialog
          title="Nova pasta"
          label="Nome da pasta"
          placeholder="clientes, produção, homelab…"
          confirmLabel="Criar"
          onSubmit={(name) => {
            setCreatingFolder(false);
            void saveFolder(name);
          }}
          onCancel={() => setCreatingFolder(false)}
        />
      )}

      {renamingFolder && (
        <InputDialog
          title={`Renomear ${renamingFolder.name}`}
          label="Novo nome"
          initial={renamingFolder.name}
          confirmLabel="Renomear"
          onSubmit={(name) => {
            const f = renamingFolder;
            setRenamingFolder(null);
            void saveFolder(name, f);
          }}
          onCancel={() => setRenamingFolder(null)}
        />
      )}

      {deletingFolder && (
        <ConfirmDialog
          title="Excluir pasta"
          danger
          confirmLabel="Excluir"
          message={
            <>
              Excluir a pasta <b>{deletingFolder.name}</b>? As conexões dentro dela não
              são apagadas — voltam para a lista sem pasta.
            </>
          }
          onConfirm={() => {
            const f = deletingFolder;
            setDeletingFolder(null);
            void (async () => {
              await api.folderDelete(f.id);
              await reloadFolders();
              await reloadConnections();
            })();
          }}
          onCancel={() => setDeletingFolder(null)}
        />
      )}
    </>
  );

  // ------------------------------------------------------------ modo rail

  if (rail) {
    // Recolhida: só os ícones, na cor da conexão. Nome, usuário e porta ficam
    // no tooltip — a lista continua navegável sem ocupar largura.
    const railList = visible;
    return (
      <aside className="sidebar sidebar--rail">
        <div className="sidebar__drag" data-tauri-drag-region />
        <div className="rail__list">
          <Tooltip content={<span className="whitespace-nowrap">Terminal local</span>}>
            <button
              className="rail__item"
              data-active={activeConnectionId === LOCAL_CONNECTION.id}
              style={{ color: LOCAL_CONNECTION.color }}
              onClick={() => props.onConnect(LOCAL_CONNECTION)}
            >
              <ConnIcon name={LOCAL_CONNECTION.icon} size={16} color={LOCAL_CONNECTION.color} />
            </button>
          </Tooltip>
          {showWslInSidebar && (
            <Tooltip content={<span className="whitespace-nowrap">WSL (Linux)</span>}>
              <button
                className="rail__item"
                data-active={activeConnectionId === WSL_CONNECTION.id}
                style={{ color: WSL_CONNECTION.color }}
                onClick={() => props.onConnect(WSL_CONNECTION)}
              >
                <ConnIcon name={WSL_CONNECTION.icon} size={16} color={WSL_CONNECTION.color} />
              </button>
            </Tooltip>
          )}
          {railList.map((c) => (
            <Tooltip
              key={c.id}
              content={
                <span className="whitespace-nowrap">
                  <b>{c.name}</b>
                  <span className="text-faint">
                    {" "}
                    {c.username}@{c.host}:{c.port}
                  </span>
                </span>
              }
            >
              <button
                className="rail__item"
                data-active={c.id === activeConnectionId}
                style={{ color: c.color }}
                onClick={() => props.onConnect(c)}
                onContextMenu={openMenu(c)}
              >
                <ConnIcon name={c.icon} size={16} color={c.color} />
                {c.isProduction && <span className="rail__prod" />}
              </button>
            </Tooltip>
          ))}
        </div>
        <div className="rail__foot">
          <Tooltip content="Nova conexão (⌘N)">
            <button className="icon-btn" onClick={props.onNew}>
              <Plus size={15} />
            </button>
          </Tooltip>
          <Tooltip content="Chaves, temas, gravações e logs">
            <button className="icon-btn" onClick={props.onManage}>
              <Settings2 size={15} />
            </button>
          </Tooltip>
        </div>
        {dialogs}
      </aside>
    );
  }

  // ------------------------------------------------------------ modo pleno

  return (
    <aside className="sidebar">
      <div className="sidebar__drag" data-tauri-drag-region />

      <div className="sidebar__search">
        <div style={{ position: "relative" }}>
          <Search
            size={13}
            style={{
              position: "absolute",
              left: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-faint)",
            }}
          />
          <input
            id="sidebar-search"
            type="search"
            aria-label="Buscar servidor"
            placeholder="Buscar servidor… (⌘L)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Da busca, ↓ entra na lista; ↵ conecta ao primeiro resultado.
              if (e.key === "ArrowDown") {
                e.preventDefault();
                focusRow(0);
              } else if (e.key === "Enter" && visible.length) {
                e.preventDefault();
                props.onConnect(visible[0]);
              }
            }}
            style={{ paddingLeft: 26 }}
          />
        </div>
      </div>

      <div
        className="sidebar__list"
        ref={listRef}
        role="list"
        aria-label="Conexões"
        onKeyDown={onListKeyDown}
      >
        {/* Fixo no topo: o shell da própria máquina e WSL, sempre a um clique. */}
        <button
          className="conn"
          data-conn-row
          role="listitem"
          data-active={activeConnectionId === LOCAL_CONNECTION.id}
          onClick={() => props.onConnect(LOCAL_CONNECTION)}
          title="Abrir um shell nesta máquina (PowerShell / Host)"
        >
          <ConnIcon name={LOCAL_CONNECTION.icon} color={LOCAL_CONNECTION.color} size={16} />
          <span className="conn__body">
            <span className="conn__name">
              <span className="conn__label">{LOCAL_CONNECTION.name}</span>
            </span>
            <span className="conn__host">shell local da máquina</span>
          </span>
          {activeConnectionId === LOCAL_CONNECTION.id && (
            <span className="conn__active-dot" />
          )}
        </button>
        {showWslInSidebar && (
          <button
            className="conn"
            data-conn-row
            role="listitem"
            data-active={activeConnectionId === WSL_CONNECTION.id}
            onClick={() => props.onConnect(WSL_CONNECTION)}
            title="Abrir um terminal WSL (Linux no Windows)"
          >
            <ConnIcon name={WSL_CONNECTION.icon} color={WSL_CONNECTION.color} size={16} />
            <span className="conn__body">
              <span className="conn__name">
                <span className="conn__label">{WSL_CONNECTION.name}</span>
              </span>
              <span className="conn__host">subsistema linux</span>
            </span>
            {activeConnectionId === WSL_CONNECTION.id && (
              <span className="conn__active-dot" />
            )}
          </button>
        )}
        <div className="sidebar__divider" />

        {folders.map((f) => {
          const conns = byFolder.get(f.id) ?? [];
          if (filtering && conns.length === 0) return null;
          return (
            <div key={f.id}>
              <SectionHeader
                icon={<FolderIcon size={11} />}
                label={f.name}
                count={conns.length}
                chevron={chevron(f.id)}
                onToggle={() => toggleFolderCollapsed(f.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFolderMenu({ folder: f, at: { x: e.clientX, y: e.clientY } });
                }}
                dropProps={folderDropProps(f.id)}
              />
              {!collapsed(f.id) &&
                conns.map((c) => <ConnRow key={c.id} {...rowProps(c)} />)}
            </div>
          );
        })}

        <SectionHeader
          icon={<Inbox size={11} />}
          label={folders.length ? "Sem pasta" : "Conexões"}
          count={rootConns.length}
          chevron={chevron(SECTION_ROOT)}
          onToggle={() => toggleFolderCollapsed(SECTION_ROOT)}
          dropProps={folderDropProps(SECTION_ROOT)}
        />
        {!collapsed(SECTION_ROOT) &&
          rootConns.map((c) => <ConnRow key={c.id} {...rowProps(c)} />)}

        {dragConnId && (
          <div className="muted" style={{ padding: "10px 8px", textAlign: "center", fontSize: 11 }}>
            Solte sobre uma pasta (ou em "Sem pasta") para mover.
          </div>
        )}

        {visible.length === 0 && (
          <div className="muted" style={{ padding: "16px 8px", textAlign: "center" }}>
            {connections.length === 0
              ? "Nenhuma conexão ainda."
              : "Nada corresponde ao filtro."}
          </div>
        )}
      </div>

      <div className="sidebar__foot">
        <button className="btn btn--quiet" style={{ flex: 1 }} onClick={props.onNew}>
          <Plus size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          Nova conexão
        </button>
        <button className="icon-btn" title="Nova pasta" onClick={() => setCreatingFolder(true)}>
          <FolderPlus size={15} />
        </button>
        <button
          className="icon-btn"
          title="Chaves, temas, gravações e logs"
          onClick={props.onManage}
        >
          <Settings2 size={15} />
        </button>
      </div>

      {dialogs}
    </aside>
  );
}

function SectionHeader({
  icon,
  label,
  count,
  chevron,
  onToggle,
  onContextMenu,
  dropProps,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  chevron: React.ReactNode;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  dropProps?: Record<string, unknown>;
}) {
  return (
    <div
      className="sidebar__section sidebar__folder"
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      onContextMenu={onContextMenu}
      {...dropProps}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        {chevron}
        {icon}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      </span>
      <span>{count}</span>
    </div>
  );
}

/**
 * Linha de conexão.
 *
 * Sem moldura: quem carrega a identidade do servidor é o ícone colorido, como
 * na paleta ⌘K. A linha inteira é um `div` com role=button, não um `<button>`:
 * o lápis é um botão próprio, e botão dentro de botão é HTML inválido.
 */
function ConnRow({
  conn,
  active,
  dragging,
  onConnect,
  onEdit,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: {
  conn: Connection;
  active: boolean;
  dragging: boolean;
  onConnect: (c: Connection) => void;
  onEdit: (c: Connection) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className="conn"
      role="button"
      tabIndex={0}
      data-conn-row
      aria-label={`${conn.name}, ${conn.username}@${conn.host}:${conn.port}${
        conn.isProduction ? ", produção" : ""
      }`}
      aria-current={active ? "true" : undefined}
      data-active={active}
      data-dragging={dragging}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onConnect(conn)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onConnect(conn);
        }
      }}
      onContextMenu={onContextMenu}
      title={`${conn.username}@${conn.host}:${conn.port}`}
    >
      <ConnIcon name={conn.icon} color={conn.color} size={16} />
      <span className="conn__body">
        <span className="conn__name">
          <span className="conn__label">{conn.name}</span>
          {conn.isProduction && <span className="prod-badge">PROD</span>}
        </span>
        <span className="conn__host">
          {conn.username}@{conn.host}:{conn.port}
        </span>
      </span>

      {active && <span className="conn__active-dot" />}

      <button
        className="conn__edit"
        title={`Editar ${conn.name}`}
        aria-label={`Editar ${conn.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onEdit(conn);
        }}
      >
        <Pencil size={13} />
      </button>
    </div>
  );
}
