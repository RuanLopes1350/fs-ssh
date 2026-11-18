import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";
import type {
  AppError,
  AutostartResult,
  Checksum,
  Connection,
  ContainerEngineKind,
  ContainerRuntime,
  DiffEntry,
  DockerContainer,
  DockerImage,
  ExecResult,
  Folder,
  PortForward,
  Recording,
  Identity,
  KnownHost,
  KubePod,
  LocalEntry,
  LogEntry,
  LogQuery,
  NetInfo,
  Progress,
  RemoteEntry,
  RemotePubkey,
  SessionInfo,
  SftpBookmark,
  Snippet,
  SshConfigHost,
  SysOverview,
  SysPort,
  SysProcess,
  SysService,
  SysUpdates,
  Theme,
  Transfer,
  WalkEntry,
  WslDistro,
} from "./types";

/**
 * O Rust serializa erro como `{kind, message, data}`. O Tauri entrega esse
 * objeto cru no `catch`, então normalizamos aqui — o resto da UI só lida com
 * `AppError`, nunca com `unknown`.
 */
export function asAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    return e as AppError;
  }
  return { kind: "error", message: String(e), data: null };
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    throw asAppError(e);
  }
}

// ------------------------------------------------------------------ catálogo

export const api = {
  connList: () => invoke<Connection[]>("conn_list"),
  connGet: (id: string) => invoke<Connection>("conn_get", { id }),
  connSave: (conn: Partial<Connection>) => invoke<Connection>("conn_save", { conn }),
  connDelete: (id: string) => invoke<void>("conn_delete", { id }),

  dbBackup: (path: string) => invoke<void>("db_backup", { path }),

  folderList: () => invoke<Folder[]>("folder_list"),
  folderSave: (folder: Partial<Folder>) => invoke<Folder>("folder_save", { folder }),
  folderDelete: (id: string) => invoke<void>("folder_delete", { id }),

  themeList: () => invoke<Theme[]>("theme_list"),
  themeSave: (theme: Partial<Theme>) => invoke<Theme>("theme_save", { theme }),
  themeDelete: (id: string) => invoke<void>("theme_delete", { id }),

  snippetList: () => invoke<Snippet[]>("snippet_list"),
  snippetSave: (snippet: Partial<Snippet>) => invoke<Snippet>("snippet_save", { snippet }),
  snippetDelete: (id: string) => invoke<void>("snippet_delete", { id }),

  knownHostsList: () => invoke<KnownHost[]>("known_hosts_list"),
  knownHostsForget: (host: string, port: number) =>
    invoke<void>("known_hosts_forget", { host, port }),
  hostKeyTrust: (host: string, port: number, keyType: string, fingerprint: string) =>
    invoke<void>("host_key_trust", { host, port, keyType, fingerprint }),

  sshconfigRead: () => invoke<SshConfigHost[]>("sshconfig_read"),
  sshconfigImport: (hosts: SshConfigHost[]) =>
    invoke<{ imported: number; skipped: string[] }>("sshconfig_import", { hosts }),

  // ---------------------------------------------------------------- sessões

  /**
   * Abre a sessão. `onOutput` recebe ArrayBuffer cru — o backend manda
   * `InvokeResponseBody::Raw`, sem passar por JSON.
   */
  sshConnect: (
    args: {
      connectionId: string;
      cols: number;
      rows: number;
      secret?: string;
      jumpSecret?: string;
    },
    onOutput: Channel<ArrayBuffer>,
  ) => invoke<SessionInfo>("ssh_connect", { args, onOutput }),

  /** Abre um shell local com PTY (nativo ou WSL) — mesma interface de uma sessão SSH. */
  localOpen: (
    args: {
      cols: number;
      rows: number;
      shell?: string;
      wslDistro?: string | null;
      connectionId?: string;
    },
    onOutput: Channel<ArrayBuffer>,
  ) => invoke<SessionInfo>("local_open", { ...args, onOutput }),
  /** Lista distribuições WSL instaladas (retorna vazio fora do Windows). */
  wslList: () => invoke<WslDistro[]>("wsl_list"),

  /** Detalhes de disponibilidade e distros do WSL no Windows. */
  wslInfo: () =>
    invoke<{ available: boolean; distros: string[]; defaultDistro: string | null }>(
      "wsl_info",
    ),

  sshWrite: (sessionId: string, data: number[]) =>
    invoke<void>("ssh_write", { sessionId, data }),
  sshResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshDisconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),
  sshSessions: () => invoke<SessionInfo[]>("ssh_sessions"),
  sshBroadcast: (sessionIds: string[], data: number[]) =>
    invoke<string[]>("ssh_broadcast", { sessionIds, data }),
  forwardList: (connectionId: string) =>
    invoke<PortForward[]>("forward_list", { connectionId }),
  forwardSave: (forward: Partial<PortForward>) =>
    invoke<PortForward>("forward_save", { forward }),
  forwardDelete: (id: string) => invoke<void>("forward_delete", { id }),
  forwardStart: (sessionId: string, forwardId: string) =>
    invoke<void>("forward_start", { sessionId, forwardId }),
  forwardStop: (sessionId: string, forwardId: string) =>
    invoke<void>("forward_stop", { sessionId, forwardId }),
  forwardActive: (sessionId: string) =>
    invoke<string[]>("forward_active", { sessionId }),
  forwardAutostart: (sessionId: string) =>
    invoke<AutostartResult>("forward_autostart", { sessionId }),

  recordingStart: (
    sessionId: string,
    format: "text" | "cast" = "text",
    cols = 80,
    rows = 24,
  ) => invoke<string>("recording_start", { sessionId, format, cols, rows }),
  /** Grava um texto no caminho escolhido no diálogo do sistema (exportações). */
  exportText: (path: string, contents: string) =>
    invoke<void>("export_text", { path, contents }),
  sshSetReadOnly: (sessionId: string, value: boolean) =>
    invoke<void>("ssh_set_read_only", { sessionId, value }),
  recordingStop: (sessionId: string) => invoke<void>("recording_stop", { sessionId }),
  recordingActive: (sessionId: string) =>
    invoke<string | null>("recording_active", { sessionId }),
  recordingList: () => invoke<Recording[]>("recording_list"),
  recordingRead: (path: string) => invoke<string>("recording_read", { path }),
  recordingDelete: (path: string) => invoke<void>("recording_delete", { path }),
  recordingsDirPath: () => invoke<string>("recordings_dir_path"),

  logList: (query: LogQuery) => invoke<LogEntry[]>("log_list", { query }),
  logClear: () => invoke<void>("log_clear"),

  logsRead: () => invoke<string>("logs_read"),
  logsPath: () => invoke<string>("logs_path"),
  logsClear: () => invoke<void>("logs_clear"),

  sshExec: (sessionId: string, command: string) =>
    invoke<ExecResult>("ssh_exec", { sessionId, command }),
  containerRuntimes: (sessionId: string) =>
    invoke<ContainerRuntime[]>("container_runtimes", { sessionId }),
  dockerPs: (sessionId: string, engine?: ContainerEngineKind) =>
    invoke<DockerContainer[]>("docker_ps", { sessionId, engine }),
  dockerImages: (sessionId: string, engine?: ContainerEngineKind) =>
    invoke<DockerImage[]>("docker_images", { sessionId, engine }),
  dockerAction: (
    sessionId: string,
    action: "start" | "stop" | "restart" | "rm",
    container: string,
    engine?: ContainerEngineKind,
  ) => invoke<void>("docker_action", { sessionId, action, container, engine }),
  dockerImageRm: (
    sessionId: string,
    image: string,
    force = false,
    engine?: ContainerEngineKind,
  ) => invoke<void>("docker_image_rm", { sessionId, image, force, engine }),
  kubePods: (sessionId: string, engine?: ContainerEngineKind) =>
    invoke<KubePod[]>("kube_pods", { sessionId, engine }),
  kubePodDelete: (
    sessionId: string,
    namespace: string,
    pod: string,
    engine?: ContainerEngineKind,
  ) => invoke<void>("kube_pod_delete", { sessionId, namespace, pod, engine }),
  kubeImages: (sessionId: string, engine?: ContainerEngineKind) =>
    invoke<DockerImage[]>("kube_images", { sessionId, engine }),
  kubeImageRm: (sessionId: string, image: string, engine?: ContainerEngineKind) =>
    invoke<void>("kube_image_rm", { sessionId, image, engine }),
  netInfo: (sessionId: string) => invoke<NetInfo>("net_info", { sessionId }),

  // ------------------------------------------------ observabilidade do host

  sysOverview: (sessionId: string) => invoke<SysOverview>("sys_overview", { sessionId }),
  sysServices: (sessionId: string) => invoke<SysService[]>("sys_services", { sessionId }),
  sysServiceAction: (
    sessionId: string,
    action: "start" | "stop" | "restart" | "reload",
    unit: string,
  ) => invoke<void>("sys_service_action", { sessionId, action, unit }),
  sysProcesses: (sessionId: string) => invoke<SysProcess[]>("sys_processes", { sessionId }),
  sysKill: (sessionId: string, pid: number, signal: "term" | "kill" | "hup") =>
    invoke<void>("sys_kill", { sessionId, pid, signal }),
  sysPorts: (sessionId: string) => invoke<SysPort[]>("sys_ports", { sessionId }),
  sysUpdates: (sessionId: string) => invoke<SysUpdates>("sys_updates", { sessionId }),
  sysTail: (sessionId: string, path: string, lines: number, filter: string) =>
    invoke<string>("sys_tail", { sessionId, path, lines, filter }),

  // ------------------------------------------------------------------ sftp

  sftpList: (sessionId: string, path: string) =>
    invoke<RemoteEntry[]>("sftp_list", { sessionId, path }),
  sftpHome: (sessionId: string) => invoke<string>("sftp_home", { sessionId }),
  sftpDownload: (
    sessionId: string,
    transferId: string,
    remote: string,
    local: string,
    resume: boolean,
    onProgress: Channel<Progress>,
  ) =>
    invoke<void>("sftp_download", {
      sessionId,
      transferId,
      remote,
      local,
      resume,
      onProgress,
    }),
  sftpUpload: (
    sessionId: string,
    transferId: string,
    local: string,
    remote: string,
    resume: boolean,
    onProgress: Channel<Progress>,
  ) =>
    invoke<void>("sftp_upload", {
      sessionId,
      transferId,
      local,
      remote,
      resume,
      onProgress,
    }),
  /** Pausa/cancela uma transferência em andamento. */
  sftpCancel: (transferId: string) => invoke<boolean>("sftp_cancel", { transferId }),
  sftpMkdirP: (sessionId: string, path: string) =>
    invoke<void>("sftp_mkdir_p", { sessionId, path }),
  /** Árvore de um diretório (arquivos e subpastas) para copiar a pasta inteira. */
  sftpTree: (sessionId: string, path: string) =>
    invoke<WalkEntry[]>("sftp_tree", { sessionId, path }),
  localTree: (path: string) => invoke<WalkEntry[]>("local_tree", { path }),
  localMkdirP: (path: string) => invoke<void>("local_mkdir_p", { path }),
  sftpFind: (sessionId: string, root: string, pattern: string, maxDepth: number) =>
    invoke<string[]>("sftp_find", { sessionId, root, pattern, maxDepth }),
  sftpChecksum: (sessionId: string, remote: string, local: string) =>
    invoke<Checksum>("sftp_checksum", { sessionId, remote, local }),
  sftpArchive: (
    sessionId: string,
    cwd: string,
    action: "compress" | "extract",
    target: string,
    entries: string[],
  ) => invoke<string>("sftp_archive", { sessionId, cwd, action, target, entries }),
  sftpDiff: (sessionId: string, localDir: string, remoteDir: string) =>
    invoke<DiffEntry[]>("sftp_diff", { sessionId, localDir, remoteDir }),

  transferList: (limit?: number) => invoke<Transfer[]>("transfer_list", { limit }),
  transferClear: () => invoke<void>("transfer_clear"),

  bookmarkList: (connectionId: string) =>
    invoke<SftpBookmark[]>("bookmark_list", { connectionId }),
  bookmarkSave: (bookmark: Partial<SftpBookmark>) =>
    invoke<SftpBookmark>("bookmark_save", { bookmark }),
  bookmarkDelete: (id: string) => invoke<void>("bookmark_delete", { id }),
  sftpMkdir: (sessionId: string, path: string) => invoke<void>("sftp_mkdir", { sessionId, path }),
  sftpRename: (sessionId: string, from: string, to: string) =>
    invoke<void>("sftp_rename", { sessionId, from, to }),
  sftpRemove: (sessionId: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { sessionId, path, isDir }),
  sftpChmod: (sessionId: string, path: string, mode: number) =>
    invoke<void>("sftp_chmod", { sessionId, path, mode }),
  sftpEditLocal: (sessionId: string, path: string) =>
    invoke<string>("sftp_edit_local", { sessionId, path }),

  localList: (path: string) => invoke<LocalEntry[]>("local_list", { path }),
  localHome: () => invoke<string>("local_home"),
  localParent: (path: string) => invoke<string>("local_parent", { path }),
  localReadText: (path: string) => invoke<string>("local_read_text", { path }),

  // ---------------------------------------------------------------- chaves

  keysList: () => invoke<Identity[]>("keys_list"),
  keysImportFile: (path: string) => invoke<Identity>("keys_import_file", { path }),
  keysGenerate: (args: {
    kind: "ed25519" | "rsa";
    name: string;
    comment: string;
    passphrase?: string;
    addToAgent: boolean;
    useKeychain: boolean;
  }) => invoke<Identity>("keys_generate", { args }),
  keysAddToAgent: (path: string, passphrase: string | undefined, useKeychain: boolean) =>
    invoke<void>("keys_add_to_agent", { path, passphrase, useKeychain }),
  keysInstallOnHost: (sessionId: string, identityId: string) =>
    invoke<void>("keys_install_on_host", { sessionId, identityId }),
  keysRemoteList: (sessionId: string) =>
    invoke<RemotePubkey[]>("keys_remote_list", { sessionId }),
};

export { Channel };
