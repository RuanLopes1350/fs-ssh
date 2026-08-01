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
  Trash2,
} from "lucide-react";

import { ContextMenu, type MenuPosition } from "../components/ContextMenu";
import { ConfirmDialog, InputDialog } from "../components/Dialogs";
import { ConnIcon } from "../components/Icon";
import { withAlpha } from "../lib/color";
import { api } from "../lib/ipc";
import { filterConnections, useAppStore } from "../store/useAppStore";
import type { Connection, Folder } from "../lib/types";

/** Ids-sentinela das seções fixas, guardados junto com as pastas colapsadas. */
const SECTION_RECENT = "__recentes__";
const SECTION_ROOT = "__sem_pasta__";

export function Sidebar({
  onConnect,
  onEdit,
  onDuplicate,
  onDelete,
  onNew,
  onManage,
}: {
  onConnect: (c: Connection) => void;
  onEdit: (c: Connection) => void;
  onDuplicate: (c: Connection) => void;
  onDelete: (c: Connection) => void;
  onNew: () => void;
  onManage: () => void;
}) {
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const tags = useAppStore((s) => s.tags);
  const search = useAppStore((s) => s.search);
  const selectedTagIds = useAppStore((s) => s.selectedTagIds);
  const collapsedFolders = useAppStore((s) => s.collapsedFolders);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
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
  /** Pasta destacada como alvo (id da pasta ou SECTION_ROOT). */
  const [dropFolder, setDropFolder] = useState<string | null>(null);

  // A conexão da aba ativa fica destacada na lista — trocar de aba mostra na
  // hora "onde" você está.
  const activeConnectionId =
    tabs.find((t) => t.id === activeTabId)?.connectionId ?? null;

  const visible = useMemo(
    () => filterConnections(connections, search, selectedTagIds),
    [connections, search, selectedTagIds],
  );
  const filtering = search.trim().length > 0 || selectedTagIds.length > 0;

  const collapsed = (id: string) => collapsedFolders.includes(id) && !filtering;

  // Recentes primeiro ajuda mais que ordem alfabética: quem usa 40 servidores
  // volta aos mesmos 5 o dia inteiro.
  const recent = useMemo(
    () =>
      [...visible]
        .filter((c) => c.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
        .slice(0, 5),
    [visible],
  );
  // "Recentes" é um atalho, não uma pasta: as mesmas conexões continuam
  // listadas na pasta a que pertencem (aparecem duas vezes de propósito).
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

  const moveToFolder = async (connId: string, folderId: string | null) => {
    const conn = connections.find((c) => c.id === connId);
    if (!conn || conn.folderId === folderId) return;
    await api.connSave({ ...conn, folderId });
    await reloadConnections();
  };

  /** Cabeçalhos de pasta (e "Sem pasta") aceitam soltar uma conexão. */
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
    onConnect,
    onEdit,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({ conn: c, at: { x: e.clientX, y: e.clientY } });
    },
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
            <div
              className="sidebar__section sidebar__folder"
              role="button"
              tabIndex={0}
              onClick={() => toggleFolderCollapsed(SECTION_RECENT)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleFolderCollapsed(SECTION_RECENT);
                }
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {chevron(SECTION_RECENT)}
                <History size={11} />
                Recentes
              </span>
              <span>{recent.length}</span>
            </div>
            {/* A mesma conexão também aparece na sua pasta — o prefixo na key
                evita colisão entre as duas linhas irmãs. */}
            {!collapsed(SECTION_RECENT) &&
              recent.map((c) => <ConnRow key={`recent-${c.id}`} {...rowProps(c)} />)}
          </>
        )}

        {folders.map((f) => {
          const conns = byFolder.get(f.id) ?? [];
          // Durante uma busca, pasta vazia é ruído; sem busca ela aparece para
          // poder receber conexões.
          if (filtering && conns.length === 0) return null;
          return (
            <div key={f.id}>
              <div
                className="sidebar__section sidebar__folder"
                role="button"
                tabIndex={0}
                onClick={() => toggleFolderCollapsed(f.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleFolderCollapsed(f.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFolderMenu({ folder: f, at: { x: e.clientX, y: e.clientY } });
                }}
                {...folderDropProps(f.id)}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {chevron(f.id)}
                  <FolderIcon size={11} />
                  {f.name}
                </span>
                <span>{conns.length}</span>
              </div>
              {!collapsed(f.id) &&
                conns.map((c) => <ConnRow key={c.id} {...rowProps(c)} />)}
            </div>
          );
        })}

        <div
          className="sidebar__section sidebar__folder"
          role="button"
          tabIndex={0}
          onClick={() => toggleFolderCollapsed(SECTION_ROOT)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleFolderCollapsed(SECTION_ROOT);
            }
          }}
          {...folderDropProps(SECTION_ROOT)}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {chevron(SECTION_ROOT)}
            <Inbox size={11} />
            {folders.length || recent.length ? "Sem pasta" : "Conexões"}
          </span>
          <span>{rootConns.length}</span>
        </div>

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

      <div
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderTop: "1px solid var(--border)",
        }}
      >
        <button className="btn btn--quiet" style={{ flex: 1 }} onClick={onNew}>
          <Plus size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          Nova conexão
        </button>
        <button
          className="icon-btn"
          title="Nova pasta"
          onClick={() => setCreatingFolder(true)}
        >
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" title="Chaves, tags e temas" onClick={onManage}>
          <Settings2 size={15} />
        </button>
      </div>

      {menu && (
        <ContextMenu
          position={menu.at}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Conectar",
              icon: <Plug size={13} />,
              onSelect: () => onConnect(menu.conn),
            },
            {
              label: "Editar…",
              icon: <Pencil size={13} />,
              onSelect: () => onEdit(menu.conn),
            },
            {
              label: "Duplicar",
              icon: <Copy size={13} />,
              onSelect: () => onDuplicate(menu.conn),
            },
            {
              label: "Excluir",
              icon: <Trash2 size={13} />,
              danger: true,
              separatorBefore: true,
              onSelect: () => onDelete(menu.conn),
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
    </aside>
  );
}

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
    // A linha inteira é um `div` com role=button, não um `<button>`: o lápis de
    // editar é um botão próprio, e botão dentro de botão é HTML inválido — o
    // clique no filho seria imprevisível entre navegadores.
    <div
      className="conn"
      role="button"
      tabIndex={0}
      data-active={active}
      data-dragging={dragging}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{
        borderColor: withAlpha(conn.color, active ? 0.95 : 0.55),
        background: withAlpha(conn.color, active ? 0.16 : 0.07),
      }}
      // Um clique conecta. Não existe mais duplo-clique para editar: os dois
      // handlers disparavam juntos e a conexão abria enquanto o formulário
      // aparecia por cima. Editar é pelo lápis ou pelo menu de contexto.
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
      <ConnIcon name={conn.icon} color={conn.color} />
      <span className="conn__body">
        <span className="conn__name">
          {conn.name}
          {conn.isProduction && <span className="prod-badge">PROD</span>}
        </span>
        <span className="conn__host">
          {conn.username}@{conn.host}
          {conn.port !== 22 ? `:${conn.port}` : ""}
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
