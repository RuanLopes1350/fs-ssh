import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronUp,
  FileArchive,
  File as FileIcon,
  FolderPlus,
  Folder,
  GitCompare,
  History,
  Link2,
  Lock,
  PackageOpen,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";

import { ConfirmDialog, InputDialog, Modal, Spinner } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import type {
  Checksum,
  DiffEntry,
  EditSaved,
  LocalEntry,
  RemoteEntry,
  SftpBookmark,
  Transfer,
} from "../lib/types";
import { useTransferQueue } from "./queue";

/** Carga arrastada. `dir` diz de qual painel o item saiu. */
interface DragPayload {
  dir: "local" | "remote";
  path: string;
  name: string;
  isDir: boolean;
}

const MIME = "application/x-fs-ssh-entry";
const ROW_HEIGHT = 24;

/** Nome vindo de fora nunca vira caminho com separador (defesa extra à do Rust). */
function safeName(name: string) {
  return name.replaceAll("/", "_").replaceAll("\\", "_");
}

export function SftpPanel({
  sessionId,
  connectionId,
}: {
  sessionId: string;
  /** Favoritos de diretório são por conexão, não por sessão. */
  connectionId: string;
}) {
  const [remotePath, setRemotePath] = useState<string>("");
  const [remote, setRemote] = useState<RemoteEntry[]>([]);
  const [localPath, setLocalPath] = useState<string>("");
  const [local, setLocal] = useState<LocalEntry[]>([]);
  const [selRemote, setSelRemote] = useState<string | null>(null);
  const [selLocal, setSelLocal] = useState<string | null>(null);
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

  const [finding, setFinding] = useState(false);
  const [archiving, setArchiving] = useState<"compress" | null>(null);
  const [checksum, setChecksum] = useState<{ remote: string; local: string } | null>(null);
  const [diffing, setDiffing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [bookmarks, setBookmarks] = useState<SftpBookmark[]>([]);

  const queue = useTransferQueue();
  const transfers = queue.items.filter((t) => t.sessionId === sessionId);

  const loadBookmarks = useCallback(async () => {
    try {
      setBookmarks(await api.bookmarkList(connectionId));
    } catch {
      // Favorito é conveniência: banco indisponível não pode derrubar o painel.
    }
  }, [connectionId]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

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
      setError(e.payload.ok ? null : (e.payload.error ?? `falha ao salvar ${name}`));
    });
    return () => {
      void un.then((f) => f());
    };
  }, [sessionId]);

  const download = useCallback(
    (remoteFile: string, name: string, intoDir: string) => {
      useTransferQueue.getState().enqueue({
        sessionId,
        direction: "down",
        remote: remoteFile,
        local: join(intoDir, safeName(name)),
        label: name,
      });
    },
    [sessionId],
  );

  const upload = useCallback(
    (localFile: string, name: string, intoDir: string) => {
      useTransferQueue.getState().enqueue({
        sessionId,
        direction: "up",
        local: localFile,
        remote: join(intoDir, safeName(name)),
        label: name,
      });
    },
    [sessionId],
  );

  // A listagem só faz sentido depois que a transferência termina; observar a
  // fila evita recarregar a cada bloco copiado.
  const settled = transfers.filter((t) => t.status === "done").length;
  useEffect(() => {
    if (settled === 0) return;
    void loadRemote(remotePath);
    void loadLocal(localPath);
    // Recarregar os dois lados a cada conclusão basta; caminho é dependência
    // estável aqui (mudou de pasta, a própria navegação já recarregou).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

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
        upload(payload.path, payload.name, intoDir ?? remotePath);
      } else {
        download(payload.path, payload.name, intoDir ?? localPath);
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

  const extract = async (name: string) => {
    try {
      await api.sftpArchive(sessionId, remotePath, "extract", name, []);
      await loadRemote(remotePath);
      setError(null);
    } catch (e) {
      setError(asAppError(e).message);
    }
  };

  /** Envia (ou baixa) tudo que a comparação apontou como diferente. */
  const sync = async (entries: DiffEntry[], direction: "up" | "down") => {
    for (const e of entries) {
      const localFile = join(localPath, e.rel);
      const remoteFile = join(remotePath, e.rel);
      if (direction === "up") {
        // O destino pode estar em subpasta que ainda não existe no servidor.
        const dir = parent(remoteFile);
        if (dir !== remotePath) await api.sftpMkdirP(sessionId, dir).catch(() => {});
      }
      useTransferQueue.getState().enqueue({
        sessionId,
        direction,
        local: localFile,
        remote: remoteFile,
        label: e.rel,
      });
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
            <BookmarkButton
              side="local"
              path={localPath}
              connectionId={connectionId}
              bookmarks={bookmarks}
              onGo={(p) => void loadLocal(p)}
              onChanged={loadBookmarks}
            />
            <button
              className="icon-btn"
              title="Enviar para o servidor"
              disabled={!selectedLocal || selectedLocal.kind === "dir"}
              onClick={() =>
                selectedLocal && upload(selectedLocal.path, selectedLocal.name, remotePath)
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
            <BookmarkButton
              side="remote"
              path={remotePath}
              connectionId={connectionId}
              bookmarks={bookmarks}
              onGo={(p) => void loadRemote(p)}
              onChanged={loadBookmarks}
            />
            <button
              className="icon-btn"
              title="Procurar arquivos neste diretório (find)"
              onClick={() => setFinding(true)}
            >
              <Search size={14} />
            </button>
            <button
              className="icon-btn"
              title="Comparar esta pasta com a pasta local (prévia da sincronização)"
              onClick={() => setDiffing(true)}
            >
              <GitCompare size={14} />
            </button>
            <button
              className="icon-btn"
              title="Compactar a seleção no servidor (tar.gz)"
              disabled={!selRemote}
              onClick={() => setArchiving("compress")}
            >
              <FileArchive size={14} />
            </button>
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
                selectedRemote && download(selectedRemote.path, selectedRemote.name, localPath)
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
              {isArchive(selectedRemote.name) && (
                <button
                  className="icon-btn"
                  title={`Extrair ${selectedRemote.name} no servidor`}
                  onClick={() => void extract(selectedRemote.name)}
                >
                  <PackageOpen size={14} />
                </button>
              )}
              {selectedRemote.kind === "file" && (
                <button
                  className="icon-btn"
                  title={`Conferir SHA-256 contra ${join(localPath, selectedRemote.name)}`}
                  onClick={() =>
                    setChecksum({
                      remote: selectedRemote.path,
                      local: join(localPath, selectedRemote.name),
                    })
                  }
                >
                  <ShieldCheck size={14} />
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

      {(transfers.length > 0 || showHistory) && (
        <div className="transfers">
          <div className="transfers__head">
            <span className="muted">
              {transfers.length > 0
                ? `${transfers.filter((t) => t.status === "running").length} em curso · ${transfers.length} na fila`
                : "Fila vazia"}
            </span>
            <button
              className="icon-btn"
              data-active={showHistory}
              title="Histórico de transferências"
              onClick={() => setShowHistory((v) => !v)}
            >
              <History size={13} />
            </button>
            <button
              className="icon-btn"
              title="Limpar o que já terminou"
              onClick={() => queue.clearFinished()}
            >
              <Trash2 size={13} />
            </button>
          </div>

          {transfers.map((t) => (
            <div key={t.id} className="transfer">
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {t.direction === "up" ? (
                  <ArrowUpFromLine size={11} />
                ) : (
                  <ArrowDownToLine size={11} />
                )}
                <span className="file__name" title={t.direction === "up" ? t.remote : t.local}>
                  {t.label}
                </span>
                <span className="muted" style={{ flex: 1, textAlign: "right" }}>
                  {t.error
                    ? t.error
                    : t.status === "done"
                      ? "concluído"
                      : t.status === "queued"
                        ? "na fila"
                        : t.status === "paused"
                          ? `pausado em ${humanSize(t.transferred)}`
                          : `${humanSize(t.transferred)} / ${humanSize(t.total)}`}
                </span>
                {(t.status === "running" || t.status === "queued") && (
                  <button
                    className="icon-btn"
                    title="Pausar (retomar continua de onde parou)"
                    onClick={() => queue.pause(t.id)}
                  >
                    <Pause size={12} />
                  </button>
                )}
                {(t.status === "paused" || t.status === "error") && (
                  <button
                    className="icon-btn"
                    title={t.status === "error" ? "Tentar de novo" : "Retomar"}
                    onClick={() => queue.resume(t.id)}
                  >
                    <Play size={12} />
                  </button>
                )}
                <button
                  className="icon-btn"
                  title="Tirar da fila"
                  onClick={() => queue.remove(t.id)}
                >
                  <X size={12} />
                </button>
              </div>
              <div className="progress">
                <div
                  style={{
                    width: `${t.total ? Math.min(100, (t.transferred / t.total) * 100) : 0}%`,
                    background: t.error
                      ? "var(--danger)"
                      : t.status === "paused"
                        ? "var(--warn)"
                        : undefined,
                  }}
                />
              </div>
            </div>
          ))}

          {showHistory && <TransferHistory />}
        </div>
      )}

      {transfers.length === 0 && !showHistory && (
        <button
          className="transfers__toggle"
          title="Histórico de transferências"
          onClick={() => setShowHistory(true)}
        >
          <History size={12} /> Histórico de transferências
        </button>
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

      {finding && (
        <FindDialog
          sessionId={sessionId}
          root={remotePath}
          onGo={(path) => {
            setFinding(false);
            void loadRemote(parent(path));
            setSelRemote(path);
          }}
          onClose={() => setFinding(false)}
        />
      )}

      {archiving === "compress" && selectedRemote && (
        <InputDialog
          title="Compactar no servidor"
          label={`tar.gz de ${selectedRemote.name} em ${remotePath}`}
          initial={`${selectedRemote.name}.tar.gz`}
          confirmLabel="Compactar"
          onSubmit={(name) => {
            const entry = selectedRemote;
            setArchiving(null);
            void (async () => {
              try {
                await api.sftpArchive(sessionId, remotePath, "compress", safeName(name), [
                  entry.name,
                ]);
                await loadRemote(remotePath);
                setError(null);
              } catch (e) {
                setError(asAppError(e).message);
              }
            })();
          }}
          onCancel={() => setArchiving(null)}
        />
      )}

      {checksum && (
        <ChecksumDialog
          sessionId={sessionId}
          remote={checksum.remote}
          local={checksum.local}
          onClose={() => setChecksum(null)}
        />
      )}

      {diffing && (
        <DiffDialog
          sessionId={sessionId}
          localDir={localPath}
          remoteDir={remotePath}
          onSync={(entries, direction) => {
            setDiffing(false);
            void sync(entries, direction);
          }}
          onClose={() => setDiffing(false)}
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

/** Estrela do diretório atual + atalho para os já favoritados. */
function BookmarkButton({
  side,
  path,
  connectionId,
  bookmarks,
  onGo,
  onChanged,
}: {
  side: "remote" | "local";
  path: string;
  connectionId: string;
  bookmarks: SftpBookmark[];
  onGo: (path: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const mine = bookmarks.filter((b) => b.side === side);
  const current = mine.find((b) => b.path === path);

  const toggle = async () => {
    try {
      if (current) await api.bookmarkDelete(current.id);
      else await api.bookmarkSave({ connectionId, side, path, label: path.split("/").pop() || path });
      onChanged();
    } catch {
      // Sem favorito o painel segue igual; não vale um alerta.
    }
  };

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="icon-btn"
        title={current ? "Tirar dos favoritos" : "Favoritar este diretório"}
        onClick={() => void toggle()}
      >
        <Star size={14} fill={current ? "currentColor" : "none"} />
      </button>
      {mine.length > 0 && (
        <button
          className="icon-btn"
          title="Ir para um favorito"
          data-active={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronUp size={14} style={{ transform: "rotate(180deg)" }} />
        </button>
      )}
      {open && (
        <div className="bookmarks" onMouseLeave={() => setOpen(false)}>
          {mine.map((b) => (
            <button
              key={b.id}
              className="bookmarks__item"
              title={b.path}
              onClick={() => {
                setOpen(false);
                onGo(b.path);
              }}
            >
              {b.label || b.path}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Busca por nome no servidor (`find -iname`), com o resultado navegável. */
function FindDialog({
  sessionId,
  root,
  onGo,
  onClose,
}: {
  sessionId: string;
  root: string;
  onGo: (path: string) => void;
  onClose: () => void;
}) {
  const [pattern, setPattern] = useState("");
  const [depth, setDepth] = useState(6);
  const [results, setResults] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setResults(await api.sftpFind(sessionId, root, pattern, depth));
    } catch (e) {
      setError(asAppError(e).message);
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Procurar no servidor"
      icon={<Search size={16} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void search()}>
            Procurar
          </button>
        </>
      }
    >
      <div className="field">
        <label>Nome contém</label>
        <input
          autoFocus
          value={pattern}
          placeholder="nginx.conf, *.log"
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
        />
      </div>
      <div className="field">
        <label>Profundidade a partir de {root}</label>
        <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
          {[1, 2, 4, 6, 10, 20].map((d) => (
            <option key={d} value={d}>
              {d} {d === 1 ? "nível" : "níveis"}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="alert alert--warn">{error}</div>}
      {busy && <Spinner />}
      {results && (
        <div className="find__results">
          {results.length === 0 && <span className="muted">Nada encontrado.</span>}
          {results.map((p) => (
            <button key={p} className="find__item" title={p} onClick={() => onGo(p)}>
              {p}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Conferência de cópia: SHA-256 das duas pontas, lado a lado. */
function ChecksumDialog({
  sessionId,
  remote,
  local,
  onClose,
}: {
  sessionId: string;
  remote: string;
  local: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<Checksum | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setResult(await api.sftpChecksum(sessionId, remote, local));
      } catch (e) {
        setError(asAppError(e).message);
      }
    })();
  }, [sessionId, remote, local]);

  return (
    <Modal
      title="Conferir cópia (SHA-256)"
      icon={<ShieldCheck size={16} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <button className="btn btn--primary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <div className="muted" style={{ fontSize: 11 }}>
        O hash remoto é calculado no próprio servidor; só ele trafega.
      </div>
      {error && <div className="alert alert--warn">{error}</div>}
      {!result && !error && <Spinner />}
      {result && (
        <>
          <div
            className={result.equal ? "alert" : "alert alert--danger"}
            style={{ borderColor: result.equal ? "var(--ok)" : undefined }}
          >
            {result.equal ? "Os dois arquivos são idênticos." : "Os arquivos são diferentes."}
          </div>
          <div className="field">
            <label>Remoto — {remote}</label>
            <code className="hash">{result.remote}</code>
          </div>
          <div className="field">
            <label>Local — {local}</label>
            <code className="hash">{result.local}</code>
          </div>
        </>
      )}
    </Modal>
  );
}

const DIFF_LABEL: Record<DiffEntry["status"], string> = {
  onlyLocal: "só local",
  onlyRemote: "só remoto",
  differs: "diferente",
  equal: "igual",
};

/** Prévia da sincronização: o que difere entre a pasta local e a remota. */
function DiffDialog({
  sessionId,
  localDir,
  remoteDir,
  onSync,
  onClose,
}: {
  sessionId: string;
  localDir: string;
  remoteDir: string;
  onSync: (entries: DiffEntry[], direction: "up" | "down") => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<DiffEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setEntries(await api.sftpDiff(sessionId, localDir, remoteDir));
      } catch (e) {
        setError(asAppError(e).message);
      }
    })();
  }, [sessionId, localDir, remoteDir]);

  const toUpload = (entries ?? []).filter(
    (e) => e.status === "onlyLocal" || e.status === "differs",
  );
  const toDownload = (entries ?? []).filter(
    (e) => e.status === "onlyRemote" || e.status === "differs",
  );
  const different = (entries ?? []).filter((e) => e.status !== "equal");

  return (
    <Modal
      title="Comparar pastas"
      wide
      icon={<GitCompare size={16} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
          <button
            className="btn"
            disabled={toDownload.length === 0}
            onClick={() => onSync(toDownload, "down")}
          >
            Baixar {toDownload.length} para o local
          </button>
          <button
            className="btn btn--primary"
            disabled={toUpload.length === 0}
            onClick={() => onSync(toUpload, "up")}
          >
            Enviar {toUpload.length} para o servidor
          </button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 11 }}>
        {localDir} ↔ {remoteDir} — comparação por tamanho e data, recursiva. A cópia entra na
        fila; nada é apagado dos dois lados.
      </div>
      {error && <div className="alert alert--warn">{error}</div>}
      {!entries && !error && <Spinner />}
      {entries && different.length === 0 && (
        <div className="alert" style={{ borderColor: "var(--ok)" }}>
          As duas pastas estão iguais ({entries.length} arquivos).
        </div>
      )}
      {entries && different.length > 0 && (
        <div className="find__results">
          {different.map((e) => (
            <div key={e.rel} className="diff__row" title={e.rel}>
              <span className={`diff__tag diff__tag--${e.status}`}>{DIFF_LABEL[e.status]}</span>
              <span className="file__name">{e.rel}</span>
              <span className="muted">
                {e.status === "onlyRemote"
                  ? humanSize(e.remoteSize)
                  : e.status === "onlyLocal"
                    ? humanSize(e.localSize)
                    : `${humanSize(e.localSize)} ↔ ${humanSize(e.remoteSize)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Últimas transferências gravadas no banco — sobrevive ao fechar do painel. */
function TransferHistory() {
  const [items, setItems] = useState<Transfer[]>([]);

  const load = useCallback(async () => {
    try {
      setItems(await api.transferList(100));
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="transfers__history">
      <div className="transfers__head">
        <span className="muted">Histórico ({items.length})</span>
        <button className="icon-btn" title="Recarregar" onClick={() => void load()}>
          <RefreshCw size={12} />
        </button>
        <button
          className="icon-btn"
          title="Apagar o histórico"
          onClick={() => void api.transferClear().then(load)}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {items.length === 0 && <span className="muted">Nada transferido ainda.</span>}
      {items.map((t) => (
        <div key={t.id} className="transfers__row" title={`${t.local}\n${t.remote}`}>
          {t.direction === "up" ? <ArrowUpFromLine size={11} /> : <ArrowDownToLine size={11} />}
          <span className="file__name">{(t.direction === "up" ? t.remote : t.local).split("/").pop()}</span>
          <span className="muted">{t.connection}</span>
          <span
            className="muted"
            style={{ color: t.status === "error" ? "var(--danger)" : undefined }}
          >
            {t.status === "done"
              ? humanSize(t.bytes)
              : t.status === "cancelled"
                ? "pausado"
                : t.error || "erro"}
          </span>
          <span className="muted">{new Date(t.ts).toLocaleString("pt-BR")}</span>
        </div>
      ))}
    </div>
  );
}

/** Extensões que o `sftp_archive` sabe extrair. */
function isArchive(name: string) {
  return /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar|zip|gz)$/i.test(name);
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
