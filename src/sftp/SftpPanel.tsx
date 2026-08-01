import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronUp,
  File as FileIcon,
  FolderPlus,
  Folder,
  Link2,
  Lock,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";

import { ConfirmDialog, InputDialog, Modal, Spinner } from "../components/Dialogs";
import { api, asAppError, Channel } from "../lib/ipc";
import type { EditSaved, LocalEntry, Progress, RemoteEntry } from "../lib/types";

interface Transfer {
  id: number;
  label: string;
  direction: "up" | "down";
  transferred: number;
  total: number;
  done: boolean;
  error: string | null;
}

/** Carga arrastada. `dir` diz de qual painel o item saiu. */
interface DragPayload {
  dir: "local" | "remote";
  path: string;
  name: string;
  isDir: boolean;
}

const MIME = "application/x-fs-ssh-entry";
const ROW_HEIGHT = 24;

let transferSeq = 0;

/** Nome vindo de fora nunca vira caminho com separador (defesa extra à do Rust). */
function safeName(name: string) {
  return name.replaceAll("/", "_").replaceAll("\\", "_");
}

export function SftpPanel({ sessionId }: { sessionId: string }) {
  const [remotePath, setRemotePath] = useState<string>("");
  const [remote, setRemote] = useState<RemoteEntry[]>([]);
  const [localPath, setLocalPath] = useState<string>("");
  const [local, setLocal] = useState<LocalEntry[]>([]);
  const [selRemote, setSelRemote] = useState<string | null>(null);
  const [selLocal, setSelLocal] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingRemote, setLoadingRemote] = useState(true);
  const [loadingLocal, setLoadingLocal] = useState(true);

  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [renaming, setRenaming] = useState<RemoteEntry | null>(null);
  const [removing, setRemoving] = useState<RemoteEntry | null>(null);
  const [chmoding, setChmoding] = useState<RemoteEntry | null>(null);

  const [dragging, setDragging] = useState<DragPayload | null>(null);
  /** Alvo destacado: `local`/`remote` para o painel, ou o caminho de um diretório. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const loadRemote = useCallback(
    async (path: string) => {
      setLoadingRemote(true);
      try {
        const entries = await api.sftpList(sessionId, path);
        setRemote(entries);
        setRemotePath(path);
        setError(null);
      } catch (e) {
        setError(asAppError(e).message);
      } finally {
        setLoadingRemote(false);
      }
    },
    [sessionId],
  );

  const loadLocal = useCallback(async (path: string) => {
    setLoadingLocal(true);
    try {
      setLocal(await api.localList(path));
      setLocalPath(path);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setLoadingLocal(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const home = await api.sftpHome(sessionId);
        await loadRemote(home);
      } catch (e) {
        setError(asAppError(e).message);
        setLoadingRemote(false);
      }
      await loadLocal(await api.localHome());
    })();
  }, [sessionId, loadRemote, loadLocal]);

  // Feedback do save-back do "editar localmente": cada gravação local enviada
  // ao servidor aparece na lista de transferências.
  useEffect(() => {
    const un = listen<EditSaved>("edit-saved", (e) => {
      if (e.payload.sessionId !== sessionId) return;
      const name = e.payload.remote.split("/").pop() ?? e.payload.remote;
      const id = ++transferSeq;
      setTransfers((t) => [
        {
          id,
          label: name,
          direction: "up",
          transferred: 1,
          total: 1,
          done: true,
          error: e.payload.ok ? null : (e.payload.error ?? "falha ao salvar"),
        },
        ...t.slice(0, 19),
      ]);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [sessionId]);

  const track = (label: string, direction: "up" | "down") => {
    const id = ++transferSeq;
    setTransfers((t) => [
      { id, label, direction, transferred: 0, total: 0, done: false, error: null },
      ...t.slice(0, 19),
    ]);
    const channel = new Channel<Progress>();
    channel.onmessage = (p) => {
      setTransfers((t) =>
        t.map((x) =>
          x.id === id
            ? { ...x, transferred: p.transferred, total: p.total, done: p.done, error: p.error }
            : x,
        ),
      );
    };
    return { id, channel };
  };

  const download = useCallback(
    async (remoteFile: string, name: string, intoDir: string) => {
      const target = join(intoDir, safeName(name));
      const { channel } = track(name, "down");
      try {
        await api.sftpDownload(sessionId, remoteFile, target, true, channel);
        await loadLocal(intoDir === localPath ? localPath : intoDir);
      } catch (e) {
        setError(asAppError(e).message);
      }
    },
    [sessionId, localPath, loadLocal],
  );

  const upload = useCallback(
    async (localFile: string, name: string, intoDir: string) => {
      const target = join(intoDir, safeName(name));
      const { channel } = track(name, "up");
      try {
        await api.sftpUpload(sessionId, localFile, target, true, channel);
        await loadRemote(remotePath);
      } catch (e) {
        setError(asAppError(e).message);
      }
    },
    [sessionId, remotePath, loadRemote],
  );

  /**
   * Resolve a soltura.
   *
   * Regras: soltar no painel oposto transfere para o diretório aberto; soltar
   * sobre um diretório transfere para dentro dele. Soltar no próprio painel de
   * origem não faz nada — mover arquivo local no disco não é papel deste painel.
   */
  const handleDrop = useCallback(
    (side: "local" | "remote", intoDir: string | null) => {
      const payload = dragging;
      setDragging(null);
      setDropTarget(null);
      if (!payload || payload.dir === side || payload.isDir) return;

      if (side === "remote") {
        void upload(payload.path, payload.name, intoDir ?? remotePath);
      } else {
        void download(payload.path, payload.name, intoDir ?? localPath);
      }
    },
    [dragging, remotePath, localPath, upload, download],
  );

  const dragProps = (payload: DragPayload) => ({
    draggable: !payload.isDir,
    "data-dragging": dragging?.path === payload.path,
    onDragStart: (e: React.DragEvent) => {
      setDragging(payload);
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData(MIME, JSON.stringify(payload));
      // Alguns alvos só aceitam a soltura se houver texto simples também.
      e.dataTransfer.setData("text/plain", payload.path);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropTarget(null);
    },
  });

  /** Um diretório aceita soltura vinda do painel oposto. */
  const dirDropProps = (side: "local" | "remote", dirPath: string) => ({
    "data-drop": dropTarget === dirPath,
    onDragOver: (e: React.DragEvent) => {
      if (!dragging || dragging.dir === side) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setDropTarget(dirPath);
    },
    onDragLeave: () => setDropTarget((t) => (t === dirPath ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handleDrop(side, dirPath);
    },
  });

  const paneDropProps = (side: "local" | "remote") => ({
    "data-drop": dropTarget === side,
    onDragOver: (e: React.DragEvent) => {
      if (!dragging || dragging.dir === side) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropTarget(side);
    },
    onDragLeave: (e: React.DragEvent) => {
      // `dragleave` dispara ao passar sobre os filhos; só limpa quando o
      // ponteiro realmente sai do painel.
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setDropTarget((t) => (t === side ? null : t));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      handleDrop(side, null);
    },
  });

  const editLocally = async (entry: RemoteEntry) => {
    try {
      const tmp = await api.sftpEditLocal(sessionId, entry.path);
      await openPath(tmp);
    } catch (e) {
      setError(asAppError(e).message);
    }
  };

  const selectedRemote = remote.find((r) => r.path === selRemote);
  const selectedLocal = local.find((l) => l.path === selLocal);

  // Virtualização: diretórios com milhares de entradas (node_modules, /var/log)
  // renderizam só o que está visível.
  const localScrollRef = useRef<HTMLDivElement>(null);
  const remoteScrollRef = useRef<HTMLDivElement>(null);
  const localVirtual = useVirtualizer({
    count: local.length,
    getScrollElement: () => localScrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const remoteVirtual = useVirtualizer({
    count: remote.length,
    getScrollElement: () => remoteScrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="sftp">
      {error && (
        <div className="alert alert--danger" style={{ margin: 8, fontSize: 11 }}>
          {error}
        </div>
      )}

      <div className="sftp__panes">
        {/* ------------------------------------------------------- local */}
        <div className="pane">
          <div className="pane__head">
            <button
              className="icon-btn"
              title="Subir um nível"
              onClick={() => void loadLocal(parent(localPath))}
            >
              <ChevronUp size={14} />
            </button>
            <span className="pane__path" title={localPath}>
              {localPath}
            </span>
            {loadingLocal && <Spinner />}
            <button
              className="icon-btn"
              title="Enviar para o servidor"
              disabled={!selectedLocal || selectedLocal.kind === "dir"}
              onClick={() =>
                selectedLocal && void upload(selectedLocal.path, selectedLocal.name, remotePath)
              }
            >
              <ArrowUpFromLine size={14} />
            </button>
          </div>

          <div className="pane__list" ref={localScrollRef} {...paneDropProps("local")}>
            <div
              style={{ height: localVirtual.getTotalSize(), position: "relative" }}
            >
              {localVirtual.getVirtualItems().map((v) => {
                const e = local[v.index];
                const payload: DragPayload = {
                  dir: "local",
                  path: e.path,
                  name: e.name,
                  isDir: e.kind === "dir",
                };
                return (
                  <div
                    key={e.path}
                    className="file"
                    role="button"
                    tabIndex={0}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: v.size,
                      transform: `translateY(${v.start}px)`,
                      ...(selLocal === e.path ? { background: "var(--bg-hover)" } : null),
                    }}
                    onClick={() => setSelLocal(e.path)}
                    onDoubleClick={() => e.kind === "dir" && void loadLocal(e.path)}
                    {...dragProps(payload)}
                    {...(e.kind === "dir" ? dirDropProps("local", e.path) : {})}
                  >
                    <EntryIcon kind={e.kind} />
                    <span className="file__name">{e.name}</span>
                    {e.kind !== "dir" && (
                      <span className="file__size">{humanSize(e.size)}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {dragging?.dir === "remote" && (
              <div className="drop-hint">Solte para baixar em {localPath}</div>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------ remoto */}
        <div className="pane">
          <div className="pane__head">
            <button
              className="icon-btn"
              title="Subir um nível"
              onClick={() => void loadRemote(parent(remotePath))}
            >
              <ChevronUp size={14} />
            </button>
            <span className="pane__path" title={remotePath}>
              {remotePath}
            </span>
            {loadingRemote && <Spinner />}
            <button className="icon-btn" title="Novo diretório" onClick={() => setMkdirOpen(true)}>
              <FolderPlus size={14} />
            </button>
            <button
              className="icon-btn"
              title="Recarregar"
              onClick={() => void loadRemote(remotePath)}
            >
              <RefreshCw size={14} />
            </button>
            <button
              className="icon-btn"
              title="Baixar"
              disabled={!selectedRemote || selectedRemote.kind === "dir"}
              onClick={() =>
                selectedRemote &&
                void download(selectedRemote.path, selectedRemote.name, localPath)
              }
            >
              <ArrowDownToLine size={14} />
            </button>
          </div>

          <div className="pane__list" ref={remoteScrollRef} {...paneDropProps("remote")}>
            <div
              style={{ height: remoteVirtual.getTotalSize(), position: "relative" }}
            >
              {remoteVirtual.getVirtualItems().map((v) => {
                const e = remote[v.index];
                const payload: DragPayload = {
                  dir: "remote",
                  path: e.path,
                  name: e.name,
                  isDir: e.kind === "dir",
                };
                return (
                  <div
                    key={e.path}
                    className="file"
                    role="button"
                    tabIndex={0}
                    title={fileTooltip(e)}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: v.size,
                      transform: `translateY(${v.start}px)`,
                      ...(selRemote === e.path ? { background: "var(--bg-hover)" } : null),
                    }}
                    onClick={() => setSelRemote(e.path)}
                    onDoubleClick={() => e.kind === "dir" && void loadRemote(e.path)}
                    {...dragProps(payload)}
                    {...(e.kind === "dir" ? dirDropProps("remote", e.path) : {})}
                  >
                    <EntryIcon kind={e.kind} />
                    <span className="file__name">{e.name}</span>
                    {e.mtime != null && (
                      <span className="file__size">{shortDate(e.mtime)}</span>
                    )}
                    {e.permissions != null && (
                      <span className="file__size">{octal(e.permissions)}</span>
                    )}
                    {e.kind !== "dir" && (
                      <span className="file__size">{humanSize(e.size)}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {dragging?.dir === "local" && (
              <div className="drop-hint">Solte para enviar para {remotePath}</div>
            )}
          </div>

          {selectedRemote && (
            <div
              style={{
                display: "flex",
                gap: 2,
                padding: 4,
                borderTop: "1px solid var(--border)",
              }}
            >
              {selectedRemote.kind === "file" && (
                <button
                  className="icon-btn"
                  title="Abrir no editor local (gravações voltam para o servidor)"
                  onClick={() => void editLocally(selectedRemote)}
                >
                  <Pencil size={14} />
                </button>
              )}
              <button
                className="icon-btn"
                title="Renomear"
                onClick={() => setRenaming(selectedRemote)}
              >
                <FileIcon size={14} />
              </button>
              <button
                className="icon-btn"
                title="Permissões (chmod)"
                onClick={() => setChmoding(selectedRemote)}
              >
                <Lock size={14} />
              </button>
              <button
                className="icon-btn"
                title="Excluir"
                onClick={() => setRemoving(selectedRemote)}
              >
                <Trash2 size={14} color="var(--danger)" />
              </button>
            </div>
          )}
        </div>
      </div>

      {transfers.length > 0 && (
        <div className="transfers">
          {transfers.map((t) => (
            <div key={t.id} className="transfer">
              <div style={{ display: "flex", gap: 6 }}>
                {t.direction === "up" ? (
                  <ArrowUpFromLine size={11} />
                ) : (
                  <ArrowDownToLine size={11} />
                )}
                <span className="file__name">{t.label}</span>
                <span className="muted">
                  {t.error
                    ? t.error
                    : t.done
                      ? "concluído"
                      : `${humanSize(t.transferred)} / ${humanSize(t.total)}`}
                </span>
              </div>
              <div className="progress">
                <div
                  style={{
                    width: `${t.total ? Math.min(100, (t.transferred / t.total) * 100) : 0}%`,
                    background: t.error ? "var(--danger)" : undefined,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {mkdirOpen && (
        <InputDialog
          title="Novo diretório"
          label={`Criar em ${remotePath}`}
          placeholder="nome-do-diretorio"
          confirmLabel="Criar"
          onSubmit={(name) => {
            setMkdirOpen(false);
            void (async () => {
              try {
                await api.sftpMkdir(sessionId, join(remotePath, safeName(name)));
                await loadRemote(remotePath);
              } catch (e) {
                setError(asAppError(e).message);
              }
            })();
          }}
          onCancel={() => setMkdirOpen(false)}
        />
      )}

      {renaming && (
        <InputDialog
          title={`Renomear ${renaming.name}`}
          label="Novo nome"
          initial={renaming.name}
          confirmLabel="Renomear"
          onSubmit={(name) => {
            const entry = renaming;
            setRenaming(null);
            if (name === entry.name) return;
            void (async () => {
              try {
                await api.sftpRename(sessionId, entry.path, join(remotePath, safeName(name)));
                await loadRemote(remotePath);
              } catch (e) {
                setError(asAppError(e).message);
              }
            })();
          }}
          onCancel={() => setRenaming(null)}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Excluir"
          danger
          confirmLabel="Excluir"
          message={
            <>
              Excluir <b>{removing.name}</b> de {remotePath}?
              {removing.kind === "dir" && " O diretório precisa estar vazio."}
            </>
          }
          onConfirm={() => {
            const entry = removing;
            setRemoving(null);
            void (async () => {
              try {
                await api.sftpRemove(sessionId, entry.path, entry.kind === "dir");
                await loadRemote(remotePath);
              } catch (e) {
                setError(asAppError(e).message);
              }
            })();
          }}
          onCancel={() => setRemoving(null)}
        />
      )}

      {chmoding && (
        <ChmodDialog
          entry={chmoding}
          onSubmit={(mode) => {
            const entry = chmoding;
            setChmoding(null);
            void (async () => {
              try {
                await api.sftpChmod(sessionId, entry.path, mode);
                await loadRemote(remotePath);
              } catch (e) {
                setError(asAppError(e).message);
              }
            })();
          }}
          onCancel={() => setChmoding(null)}
        />
      )}
    </div>
  );
}

const CHMOD_ROWS = [
  ["Dono", 8, 7, 6],
  ["Grupo", 5, 4, 3],
  ["Outros", 2, 1, 0],
] as const;

/** Editor de permissões: grade rwx sincronizada com o octal. */
function ChmodDialog({
  entry,
  onSubmit,
  onCancel,
}: {
  entry: RemoteEntry;
  onSubmit: (mode: number) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState((entry.permissions ?? 0o644) & 0o7777);

  const toggle = (bit: number) => setMode((m) => m ^ (1 << bit));

  return (
    <Modal
      title={`Permissões de ${entry.name}`}
      icon={<Lock size={16} color="var(--accent)" />}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={() => onSubmit(mode)}>
            Aplicar
          </button>
        </>
      }
    >
      <table style={{ borderCollapse: "collapse", alignSelf: "start" }}>
        <thead>
          <tr>
            <th />
            {["leitura", "escrita", "execução"].map((h) => (
              <th key={h} className="muted" style={{ fontWeight: 400, padding: "2px 10px", fontSize: 11 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CHMOD_ROWS.map(([label, r, w, x]) => (
            <tr key={label}>
              <td className="muted" style={{ fontSize: 11, paddingRight: 10 }}>
                {label}
              </td>
              {[r, w, x].map((bit) => (
                <td key={bit} style={{ textAlign: "center", padding: 4 }}>
                  <input
                    type="checkbox"
                    checked={(mode & (1 << bit)) !== 0}
                    onChange={() => toggle(bit)}
                    style={{ width: "auto" }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="field">
        <label>Octal</label>
        <input
          value={(mode & 0o777).toString(8).padStart(3, "0")}
          onChange={(e) => {
            const v = parseInt(e.target.value, 8);
            if (!Number.isNaN(v)) setMode(v & 0o7777);
          }}
          style={{ maxWidth: 90, fontFamily: "ui-monospace, monospace" }}
        />
      </div>
    </Modal>
  );
}

function fileTooltip(e: RemoteEntry) {
  const parts = [e.name];
  if (e.user || e.group) parts.push(`${e.user ?? e.uid ?? "?"}:${e.group ?? e.gid ?? "?"}`);
  if (e.permissions != null) parts.push(octal(e.permissions));
  if (e.mtime != null) parts.push(new Date(e.mtime * 1000).toLocaleString());
  return parts.join(" · ");
}

function EntryIcon({ kind }: { kind: string }) {
  if (kind === "dir") return <Folder size={13} color="var(--accent)" />;
  if (kind === "symlink") return <Link2 size={13} color="var(--text-faint)" />;
  return <FileIcon size={13} color="var(--text-faint)" />;
}

function humanSize(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function octal(mode: number) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/** Data curta: hora para hoje, dia/mês para o resto do ano, ano para o antigo. */
function shortDate(mtimeSec: number) {
  const d = new Date(mtimeSec * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  }
  return d.toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
}

/** Une caminho e nome. Serve para local e remoto: ambos usam `/` no macOS. */
function join(base: string, name: string) {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

function parent(path: string) {
  if (path === "/" || !path.includes("/")) return "/";
  const p = path.replace(/\/+$/, "");
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}
