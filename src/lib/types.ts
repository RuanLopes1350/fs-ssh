export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
}

export interface Identity {
  id: string;
  label: string;
  /** `host` (achada em ~/.ssh), `generated` (criada aqui) ou `agent` (só no agente). */
  source: "host" | "generated" | "agent";
  path: string | null;
  pubkey: string;
  fingerprint: string;
  keyType: string;
  hasPassphrase: boolean;
  comment: string;
  inAgent: boolean;
}

/** Paleta no formato ITheme do xterm.js — vai direto em `term.options.theme`. */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  isBuiltin: boolean;
  json: TerminalPalette;
}

/**
 * Id da "conexão" sintética do terminal local. Não existe no banco: serve para
 * o resto da UI tratar o shell da máquina como mais uma conexão.
 */
export const LOCAL_CONNECTION_ID = "__local__";

export type AuthMethod = "auto" | "agent" | "key" | "password";

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  identityId: string | null;
  jumpHostId: string | null;
  folderId: string | null;
  color: string;
  icon: string;
  themeId: string | null;
  isProduction: boolean;
  notes: string;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface SessionInfo {
  sessionId: string;
  connectionId: string;
  host: string;
  username: string;
  fingerprint: string;
  banner: string | null;
}

export interface SessionClosed {
  sessionId: string;
  exitStatus: number | null;
  reason: string;
}

export interface KnownHost {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  pubkey: string;
  firstSeen: string;
  lastSeen: string;
}

export interface Snippet {
  id: string;
  name: string;
  body: string;
  tagScope: string | null;
}

export interface RemoteEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "symlink" | "other";
  size: number;
  permissions: number | null;
  mtime: number | null;
  uid: number | null;
  gid: number | null;
  user: string | null;
  group: string | null;
}

export interface LocalEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "symlink";
  size: number;
}

export interface Progress {
  transferred: number;
  total: number;
  done: boolean;
  error: string | null;
}

export interface SshConfigHost {
  alias: string;
  hostname: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyJump: string | null;
  forwardAgent: boolean;
}

/** Erro estruturado vindo do Rust. `kind` decide qual diálogo abrir. */
export interface AppError {
  kind:
    | "error"
    | "db"
    | "io"
    | "sftp"
    | "no_session"
    | "host_key_unknown"
    | "host_key_changed"
    | "auth_required"
    | "auth_failed";
  message: string;
  data: Record<string, unknown> | null;
}

export interface HostKeyPrompt {
  host: string;
  port: number;
  fingerprint: string;
  algorithm: string;
  knownFingerprint?: string;
  changed: boolean;
}

export interface AuthPrompt {
  authKind: "passphrase" | "password";
  prompt: string;
  /** O segredo pedido é do jump host (bastion), não do destino. */
  forJump: boolean;
}

export interface PortForward {
  id: string;
  connectionId: string;
  /** `local` (-L), `remote` (-R) ou `dynamic` (-D, proxy SOCKS5). */
  kind: "local" | "remote" | "dynamic";
  label: string;
  bindAddr: string;
  /** -L: porta local escutada; -R: porta exposta no servidor. */
  localPort: number;
  /** -L: destino alcançado pelo servidor; -R: destino na máquina local. */
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface LogEntry {
  id: number;
  /** RFC3339 em UTC. */
  ts: string;
  level: "info" | "warn" | "error";
  kind: string;
  connectionId: string | null;
  connection: string;
  message: string;
}

/** Filtros da tela de logs. Datas em `YYYY-MM-DD`. */
export interface LogQuery {
  from?: string;
  to?: string;
  connectionId?: string;
  level?: string;
  search?: string;
  limit?: number;
}

export interface Recording {
  name: string;
  path: string;
  size: number;
  /** Epoch em segundos. */
  modified: number;
}

export interface AutostartResult {
  started: string[];
  errors: string[];
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  running: boolean;
}

/** Evento `edit-saved`: o watcher do "editar localmente" gravou no servidor. */
export interface EditSaved {
  sessionId: string;
  remote: string;
  local: string;
  ok: boolean;
  error: string | null;
}
