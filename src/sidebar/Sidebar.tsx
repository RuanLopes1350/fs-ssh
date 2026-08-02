import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder as FolderIcon,
  FolderPlus,
  History,
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
import { activePaneOf, filterConnections, useAppStore } from "../store/useAppStore";
import type { Connection, Folder } from "../lib/types";

/** Ids-sentinela das seções fixas, guardados junto com as pastas colapsadas. */
const SECTION_RECENT = "__recentes__";
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
  const tags = useAppStore((s) => s.tags);
  const search = useAppStore((s) => s.search);
  const selectedTagIds = useAppStore((s) => s.selectedTagIds);
  const collapsedFolders = useAppStore((s) => s.collapsedFolders);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const rail = useAppStore((s) => s.sidebarRail);
  const setSearch = useAppStore((s) => s.setSearch);
  const toggleTag = useAppStore((s) => s.toggleTag);
  const toggleFolderCollapsed = useAppStore((s) => s.toggleFolderCollapsed);
  const reloadFolders = useAppStore((s) => s.reloadFolders);
  const reloadConnections = useAppStore((s) => s.reloadConnections);

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
    () => filterConnections(connections, search, selectedTagIds),
    [connections, search, selectedTagIds],
  );
  const filtering = search.trim().length > 0 || selectedTagIds.length > 0;
  const collapsed = (id: string) => collapsedFolders.includes(id) && !filtering;

  const recent = useMemo(
    () =>
      [...visible]
        .filter((c) => c.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
        .slice(0, 5),
    [visible],
  );

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
    const railList = [
      ...recent,
      ...visible.filter((c) => !recent.some((r) => r.id === c.id)),
    ];
    return (
      <aside className="sidebar sidebar--rail">
        <div className="sidebar__drag" data-tauri-drag-region />
        <div className="rail__list">
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
                <ConnIcon name={c.icon} size={18} color={c.color} />
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
            placeholder="Buscar servidor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 26 }}
          />
        </div>
      </div>

      {tags.length > 0 && (
        <div className="tags">
          {tags.map((t) => {
            const active = selectedTagIds.includes(t.id);
            return (
              <button
                key={t.id}
                className="tag"
                data-active={active}
                style={active ? { color: t.color } : undefined}
                onClick={() => toggleTag(t.id)}
              >
                <span className="tag__dot" style={{ background: t.color }} />
                {t.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="sidebar__list">
        {recent.length > 0 && (
          <>
            <SectionHeader
              icon={<History size={11} />}
              label="Recentes"
              count={recent.length}
              chevron={chevron(SECTION_RECENT)}
              onToggle={() => toggleFolderCollapsed(SECTION_RECENT)}
            />
            {!collapsed(SECTION_RECENT) &&
              recent.map((c) => <ConnRow key={`recent-${c.id}`} {...rowProps(c)} />)}
          </>
        )}

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
          label={folders.length || recent.length ? "Sem pasta" : "Conexões"}
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
