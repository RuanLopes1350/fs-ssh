import { useEffect, useState } from "react";
import {
  Check,
  Download,
  KeyRound,
  Palette,
  Pencil,
  Plus,
  ServerCog,
  ShieldCheck,
  Tag as TagIcon,
  TerminalSquare,
  Trash2,
  Upload,
} from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { ConfirmDialog, InputDialog, Spinner } from "../components/Dialogs";
import { Modal } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import { terminals } from "../terminal/session";
import { useAppStore } from "../store/useAppStore";
import type {
  Identity,
  KnownHost,
  Snippet,
  SshConfigHost,
  TerminalPalette,
  Theme,
} from "../lib/types";

type TabKey = "keys" | "snippets" | "tags" | "themes" | "hosts" | "import";

export function ManagePanel({
  activeSessionId,
  activeSessionTitle,
  onClose,
}: {
  /** Sessão da aba ativa (se aberta) — habilita "instalar chave no servidor". */
  activeSessionId: string | null;
  activeSessionTitle: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("keys");

  return (
    <Modal
      title="Chaves, snippets, tags, temas e hosts"
      wide
      tall
      onClose={onClose}
      footer={
        <button className="btn btn--primary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {(
          [
            ["keys", "Chaves"],
            ["snippets", "Snippets"],
            ["tags", "Tags"],
            ["themes", "Temas"],
            ["hosts", "Hosts conhecidos"],
            ["import", "~/.ssh/config"],
          ] as [TabKey, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            className="btn"
            data-active={tab === k}
            style={
              tab === k
                ? { borderColor: "var(--accent)", color: "var(--accent)" }
                : undefined
            }
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "keys" && (
        <KeysTab
          activeSessionId={activeSessionId}
          activeSessionTitle={activeSessionTitle}
        />
      )}
      {tab === "snippets" && <SnippetsTab />}
      {tab === "tags" && <TagsTab />}
      {tab === "themes" && <ThemesTab />}
      {tab === "hosts" && <HostsTab />}
      {tab === "import" && <ImportTab />}
    </Modal>
  );
}

// ------------------------------------------------------------------- chaves

function KeysTab({
  activeSessionId,
  activeSessionTitle,
}: {
  activeSessionId: string | null;
  activeSessionTitle: string | null;
}) {
  const identities = useAppStore((s) => s.identities);
  const reload = useAppStore((s) => s.reloadIdentities);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("id_fs_ssh");
  const [kind, setKind] = useState<"ed25519" | "rsa">("ed25519");
  const [comment, setComment] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [useKeychain, setUseKeychain] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askPassFor, setAskPassFor] = useState<Identity | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.keysGenerate({
        kind,
        name,
        comment: comment || `${name}@fs-ssh`,
        passphrase: passphrase || undefined,
        addToAgent: true,
        useKeychain,
      });
      await reload();
      setCreating(false);
      setPassphrase("");
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const addToAgent = async (identity: Identity, pass?: string) => {
    if (!identity.path) return;
    setBusy(true);
    setError(null);
    try {
      await api.keysAddToAgent(identity.path, pass, true);
      await reload();
      setNotice(`${identity.label} carregada no agente.`);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const installOnHost = async (identity: Identity) => {
    if (!activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      await api.keysInstallOnHost(activeSessionId, identity.id);
      setNotice(
        `Chave pública instalada no authorized_keys de ${activeSessionTitle}. ` +
          "A próxima conexão pode entrar sem senha.",
      );
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="muted" style={{ fontSize: 11 }}>
        As chaves ficam em <code>~/.ssh</code> no formato OpenSSH — as mesmas que o{" "}
        <code>ssh</code> da linha de comando usa. Este app nunca copia material de chave
        privada para o próprio banco.
      </div>

      {error && <div className="alert alert--danger">{error}</div>}
      {notice && <div className="alert alert--warn">{notice}</div>}

      {identities.map((i) => (
        <div
          key={i.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <KeyRound size={14} color={i.inAgent ? "var(--ok)" : "var(--text-faint)"} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{i.label}</div>
            <div className="muted" style={{ fontSize: 10, wordBreak: "break-all" }}>
              {i.keyType} · {i.fingerprint}
            </div>
          </div>
          <div className="muted" style={{ fontSize: 10, textAlign: "right" }}>
            {i.source === "agent" ? "só no agente" : i.source === "generated" ? "criada aqui" : "~/.ssh"}
            <br />
            {i.hasPassphrase ? "cifrada" : "sem passphrase"}
            {i.inAgent && " · carregada"}
          </div>
          {!i.inAgent && i.path && (
            <button
              className="icon-btn"
              title="Carregar no ssh-agent"
              disabled={busy}
              onClick={() => {
                if (i.hasPassphrase) setAskPassFor(i);
                else void addToAgent(i);
              }}
            >
              <Upload size={14} />
            </button>
          )}
          <button
            className="icon-btn"
            title={
              activeSessionId
                ? `Instalar no authorized_keys de ${activeSessionTitle} (ssh-copy-id)`
                : "Instalar no servidor — abra uma sessão primeiro"
            }
            disabled={busy || !activeSessionId}
            onClick={() => void installOnHost(i)}
          >
            <ServerCog size={14} />
          </button>
        </div>
      ))}

      {identities.length === 0 && (
        <div className="muted">Nenhuma chave encontrada em ~/.ssh nem no agente.</div>
      )}

      {!creating ? (
        <button className="btn" onClick={() => setCreating(true)}>
          <Plus size={13} style={{ verticalAlign: -2 }} /> Gerar nova chave
        </button>
      ) : (
        <div
          style={{
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div className="row">
            <div className="field">
              <label>Tipo</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="ed25519">Ed25519 (recomendado)</option>
                <option value="rsa">RSA 4096</option>
              </select>
            </div>
            <div className="field">
              <label>Nome do arquivo (em ~/.ssh)</label>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>Comentário</label>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="marco@macbook"
              />
            </div>
            <div className="field">
              <label>Passphrase (opcional)</label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </div>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={useKeychain}
              onChange={(e) => setUseKeychain(e.target.checked)}
              style={{ width: "auto" }}
            />
            <span>
              Guardar a passphrase no Keychain do macOS
              <span className="muted"> (ssh-add --apple-use-keychain)</span>
            </span>
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {busy && <Spinner />}
            <button className="btn" onClick={() => setCreating(false)}>
              Cancelar
            </button>
            <button className="btn btn--primary" onClick={create} disabled={busy}>
              Gerar
            </button>
          </div>
        </div>
      )}

      {askPassFor && (
        <InputDialog
          title={`Passphrase de ${askPassFor.label}`}
          label="A chave é cifrada; a passphrase vai para o ssh-add e não fica guardada."
          password
          confirmLabel="Carregar no agente"
          onSubmit={(pass) => {
            const identity = askPassFor;
            setAskPassFor(null);
            void addToAgent(identity, pass);
          }}
          onCancel={() => setAskPassFor(null)}
        />
      )}
    </>
  );
}

// ----------------------------------------------------------------- snippets

const EMPTY_SNIPPET: Snippet = { id: "", name: "", body: "", tagScope: null };

function SnippetsTab() {
  const snippets = useAppStore((s) => s.snippets);
  const loadAll = useAppStore((s) => s.loadAll);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!editing || !editing.name.trim() || !editing.body.trim()) return;
    try {
      await api.snippetSave(editing);
      await loadAll();
      setEditing(null);
      setError(null);
    } catch (e) {
      setError(asAppError(e).message);
    }
  };

  return (
    <>
      <div className="muted" style={{ fontSize: 11 }}>
        Snippets aparecem na paleta (⌘K) quando há uma sessão aberta e são digitados no
        terminal ativo. Com o broadcast ligado, valem para todas as abas.
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      {snippets.map((s) => (
        <div
          key={s.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <TerminalSquare size={14} color="var(--text-faint)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{s.name}</div>
            <div
              className="muted"
              style={{
                fontSize: 10,
                fontFamily: "ui-monospace, monospace",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {s.body}
            </div>
          </div>
          <button className="icon-btn" title="Editar" onClick={() => setEditing({ ...s })}>
            <Pencil size={13} />
          </button>
          <button className="icon-btn" title="Excluir" onClick={() => setDeleting(s)}>
            <Trash2 size={13} color="var(--danger)" />
          </button>
        </div>
      ))}

      {snippets.length === 0 && <div className="muted">Nenhum snippet ainda.</div>}

      {!editing ? (
        <button className="btn" onClick={() => setEditing({ ...EMPTY_SNIPPET })}>
          <Plus size={13} style={{ verticalAlign: -2 }} /> Novo snippet
        </button>
      ) : (
        <div
          style={{
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div className="field">
            <label>Nome</label>
            <input
              value={editing.name}
              autoFocus
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="restart nginx"
            />
          </div>
          <div className="field">
            <label>Comando (é digitado no terminal, com Enter no final)</label>
            <textarea
              rows={3}
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              placeholder="sudo systemctl restart nginx"
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button
              className="btn btn--primary"
              onClick={() => void save()}
              disabled={!editing.name.trim() || !editing.body.trim()}
            >
              Salvar
            </button>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="Excluir snippet"
          danger
          confirmLabel="Excluir"
          message={
            <>
              Excluir <b>{deleting.name}</b>?
            </>
          }
          onConfirm={() => {
            const s = deleting;
            setDeleting(null);
            void (async () => {
              await api.snippetDelete(s.id);
              await loadAll();
            })();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}

// --------------------------------------------------------------------- tags

const TAG_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#a855f7", "#64748b"];

function TagsTab() {
  const tags = useAppStore((s) => s.tags);
  const loadAll = useAppStore((s) => s.loadAll);
  const [name, setName] = useState("");
  const [color, setColor] = useState(TAG_COLORS[5]);

  const add = async () => {
    if (!name.trim()) return;
    await api.tagSave({ id: "", name: name.trim(), color, parentId: null, sort: 0 });
    setName("");
    await loadAll();
  };

  return (
    <>
      {tags.map((t) => (
        <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="tag__dot" style={{ background: t.color }} />
          <span style={{ flex: 1 }}>{t.name}</span>
          <button
            className="icon-btn"
            onClick={async () => {
              await api.tagDelete(t.id);
              await loadAll();
            }}
          >
            <Trash2 size={13} color="var(--danger)" />
          </button>
        </div>
      ))}

      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field">
          <label>Nova tag</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            placeholder="produção, cliente-x, k8s…"
          />
        </div>
        <div className="field" style={{ flex: "none" }}>
          <label>Cor</label>
          <div className="swatches">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                className="swatch"
                data-active={color === c}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        <button className="btn btn--primary" style={{ flex: "none" }} onClick={add}>
          <TagIcon size={13} />
        </button>
      </div>
    </>
  );
}

// -------------------------------------------------------------------- temas

/** Campos editáveis de uma paleta, na ordem em que aparecem no editor. */
const PALETTE_FIELDS: [keyof TerminalPalette, string][] = [
  ["background", "fundo"],
  ["foreground", "texto"],
  ["cursor", "cursor"],
  ["selectionBackground", "seleção"],
  ["black", "preto"],
  ["red", "vermelho"],
  ["green", "verde"],
  ["yellow", "amarelo"],
  ["blue", "azul"],
  ["magenta", "magenta"],
  ["cyan", "ciano"],
  ["white", "branco"],
  ["brightBlack", "preto claro"],
  ["brightRed", "vermelho claro"],
  ["brightGreen", "verde claro"],
  ["brightYellow", "amarelo claro"],
  ["brightBlue", "azul claro"],
  ["brightMagenta", "magenta claro"],
  ["brightCyan", "ciano claro"],
  ["brightWhite", "branco claro"],
];

function ThemesTab() {
  const themes = useAppStore((s) => s.themes);
  const loadAll = useAppStore((s) => s.loadAll);
  const applyPalettes = useAppStore((s) => s.applyPalettes);
  const [editing, setEditing] = useState<Theme | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const duplicate = async (t: Theme) => {
    const copy = await api.themeSave({
      id: "",
      name: `${t.name} (cópia)`,
      isBuiltin: false,
      json: { ...t.json },
    });
    await loadAll();
    setEditing(copy);
  };

  const importItermcolors = async () => {
    setError(null);
    try {
      const path = await openFileDialog({
        multiple: false,
        filters: [{ name: "iTerm colors", extensions: ["itermcolors"] }],
      });
      if (typeof path !== "string") return;
      const xml = await api.localReadText(path);
      const palette = parseItermcolors(xml);
      const name = path.split("/").pop()?.replace(/\.itermcolors$/, "") ?? "importado";
      await api.themeSave({ id: "", name, isBuiltin: false, json: palette });
      await loadAll();
      setNotice(`Tema "${name}" importado.`);
    } catch (e) {
      setError(asAppError(e).message);
    }
  };

  return (
    <>
      <div className="muted" style={{ fontSize: 11 }}>
        Cada conexão escolhe o seu tema no formulário de edição. Temas embutidos podem
        ser duplicados e editados; também dá para importar um <code>.itermcolors</code>.
      </div>

      {error && <div className="alert alert--danger">{error}</div>}
      {notice && <div className="alert alert--warn">{notice}</div>}

      {themes.map((t) => (
        <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 92,
              height: 34,
              borderRadius: 6,
              border: "1px solid var(--border-strong)",
              background: t.json.background,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
            }}
          >
            {[t.json.red, t.json.green, t.json.yellow, t.json.blue, t.json.magenta].map(
              (c, i) => (
                <span
                  key={i}
                  style={{ width: 7, height: 7, borderRadius: "50%", background: c }}
                />
              ),
            )}
          </div>
          <span style={{ flex: 1 }}>{t.name}</span>
          {t.isBuiltin ? (
            <>
              <span className="muted">embutido</span>
              <button
                className="icon-btn"
                title="Duplicar para editar"
                onClick={() => void duplicate(t)}
              >
                <Palette size={13} />
              </button>
            </>
          ) : (
            <>
              <button className="icon-btn" title="Editar" onClick={() => setEditing(t)}>
                <Pencil size={13} />
              </button>
              <button
                className="icon-btn"
                title="Excluir"
                onClick={() =>
                  void (async () => {
                    await api.themeDelete(t.id);
                    await loadAll();
                    // Conexões que usavam o tema caem para o padrão na hora.
                    applyPalettes();
                  })()
                }
              >
                <Trash2 size={13} color="var(--danger)" />
              </button>
            </>
          )}
        </div>
      ))}

      <button className="btn" onClick={() => void importItermcolors()}>
        <Download size={13} style={{ verticalAlign: -2 }} /> Importar .itermcolors
      </button>

      {editing && (
        <ThemeEditor
          theme={editing}
          onSaved={() =>
            void (async () => {
              // Recarrega ANTES de desmontar o editor: o cleanup do editor
              // reaplica as paletas a partir do store, que já precisa ter o
              // tema novo para os terminais abertos não voltarem ao antigo.
              await loadAll();
              applyPalettes();
              setEditing(null);
            })()
          }
          onCancel={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ThemeEditor({
  theme,
  onSaved,
  onCancel,
}: {
  theme: Theme;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(theme.name);
  const [palette, setPalette] = useState<TerminalPalette>({ ...theme.json });
  const [error, setError] = useState<string | null>(null);

  // Preview ao vivo: cada mudança de cor é aplicada na hora aos terminais
  // abertos que usam este tema. Cancelar (unmount) reverte pelo store.
  useEffect(() => {
    const { tabs, connections } = useAppStore.getState();
    for (const t of tabs) {
      const conn = connections.find((c) => c.id === t.connectionId);
      if (conn?.themeId === theme.id) terminals.get(t.id)?.setPalette(palette);
    }
  }, [palette, theme.id]);

  useEffect(() => () => useAppStore.getState().applyPalettes(), []);

  const save = async () => {
    try {
      await api.themeSave({ ...theme, name, json: palette });
      onSaved();
    } catch (e) {
      setError(asAppError(e).message);
    }
  };

  return (
    <Modal
      title={`Editar tema ${theme.name}`}
      wide
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={() => void save()}>
            Salvar
          </button>
        </>
      }
    >
      {error && <div className="alert alert--danger">{error}</div>}
      <div className="field">
        <label>Nome</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 8,
        }}
      >
        {PALETTE_FIELDS.map(([key, label]) => (
          <div key={key} className="field">
            <label>{label}</label>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="color"
                value={toHex6(palette[key] ?? "#000000")}
                onChange={(e) => setPalette((p) => ({ ...p, [key]: e.target.value }))}
                style={{ width: 30, height: 24, padding: 0, border: "none", flex: "none" }}
              />
              <input
                value={palette[key] ?? ""}
                onChange={(e) => setPalette((p) => ({ ...p, [key]: e.target.value }))}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}
              />
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          borderRadius: 8,
          padding: "10px 12px",
          background: palette.background,
          color: palette.foreground,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          border: "1px solid var(--border-strong)",
        }}
      >
        deploy@web-01:~$ tail -f /var/log/nginx/access.log
        <br />
        {[palette.red, palette.green, palette.yellow, palette.blue, palette.magenta, palette.cyan].map(
          (c, i) => (
            <span key={i} style={{ color: c }}>
              ██
            </span>
          ),
        )}
      </div>
    </Modal>
  );
}

/** `#rrggbbaa`/`#rgb` → `#rrggbb` para o input type=color. */
function toHex6(color: string): string {
  const c = color.trim();
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7);
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return "#000000";
}

/** Parser do plist XML do iTerm2 (`.itermcolors`). */
function parseItermcolors(xml: string): TerminalPalette {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("arquivo .itermcolors inválido");
  }

  const colors = new Map<string, string>();
  const rootDict = doc.querySelector("plist > dict");
  if (!rootDict) throw new Error("arquivo .itermcolors sem dicionário raiz");

  const children = Array.from(rootDict.children);
  for (let i = 0; i < children.length - 1; i++) {
    if (children[i].tagName !== "key" || children[i + 1].tagName !== "dict") continue;
    const name = children[i].textContent ?? "";
    const dict = children[i + 1];
    const comp: Record<string, number> = {};
    const inner = Array.from(dict.children);
    for (let j = 0; j < inner.length - 1; j++) {
      if (inner[j].tagName === "key" && inner[j + 1].tagName === "real") {
        comp[inner[j].textContent ?? ""] = parseFloat(inner[j + 1].textContent ?? "0");
      }
    }
    const to255 = (v: number | undefined) =>
      Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255)
        .toString(16)
        .padStart(2, "0");
    colors.set(
      name,
      `#${to255(comp["Red Component"])}${to255(comp["Green Component"])}${to255(comp["Blue Component"])}`,
    );
  }

  const ansi = (n: number, fallback: string) => colors.get(`Ansi ${n} Color`) ?? fallback;
  return {
    background: colors.get("Background Color") ?? "#000000",
    foreground: colors.get("Foreground Color") ?? "#ffffff",
    cursor: colors.get("Cursor Color") ?? "#ffffff",
    selectionBackground: colors.get("Selection Color") ?? "#264f78",
    black: ansi(0, "#000000"),
    red: ansi(1, "#cd3131"),
    green: ansi(2, "#0dbc79"),
    yellow: ansi(3, "#e5e510"),
    blue: ansi(4, "#2472c8"),
    magenta: ansi(5, "#bc3fbc"),
    cyan: ansi(6, "#11a8cd"),
    white: ansi(7, "#e5e5e5"),
    brightBlack: ansi(8, "#666666"),
    brightRed: ansi(9, "#f14c4c"),
    brightGreen: ansi(10, "#23d18b"),
    brightYellow: ansi(11, "#f5f543"),
    brightBlue: ansi(12, "#3b8eea"),
    brightMagenta: ansi(13, "#d670d6"),
    brightCyan: ansi(14, "#29b8db"),
    brightWhite: ansi(15, "#ffffff"),
  };
}

// -------------------------------------------------------------------- hosts

function HostsTab() {
  const [hosts, setHosts] = useState<KnownHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [forgetting, setForgetting] = useState<KnownHost | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      setHosts(await api.knownHostsList());
      setError(null);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  return (
    <>
      <div className="muted" style={{ fontSize: 11 }}>
        Fingerprints confirmados no diálogo de primeira conexão (TOFU). Esquecer um host
        faz o app perguntar de novo na próxima conexão — use depois de reinstalar um
        servidor, nunca para silenciar um aviso de chave alterada que você não entendeu.
      </div>

      {error && <div className="alert alert--danger">{error}</div>}
      {loading && <Spinner />}

      {hosts.map((h) => (
        <div
          key={`${h.host}:${h.port}:${h.keyType}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <ShieldCheck size={14} color="var(--ok)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>
              {h.host}
              {h.port !== 22 ? `:${h.port}` : ""}
              <span className="muted"> · {h.keyType}</span>
            </div>
            <div className="muted" style={{ fontSize: 10, wordBreak: "break-all" }}>
              {h.fingerprint}
            </div>
          </div>
          <div className="muted" style={{ fontSize: 10, textAlign: "right", flex: "none" }}>
            visto em
            <br />
            {new Date(h.lastSeen).toLocaleDateString("pt-BR")}
          </div>
          <button className="icon-btn" title="Esquecer host" onClick={() => setForgetting(h)}>
            <Trash2 size={13} color="var(--danger)" />
          </button>
        </div>
      ))}

      {!loading && hosts.length === 0 && (
        <div className="muted">Nenhum host confirmado ainda.</div>
      )}

      {forgetting && (
        <ConfirmDialog
          title="Esquecer host"
          danger
          confirmLabel="Esquecer"
          message={
            <>
              Esquecer <b>{forgetting.host}</b>
              {forgetting.port !== 22 ? `:${forgetting.port}` : ""}? A próxima conexão
              vai pedir para confirmar o fingerprint de novo.
            </>
          }
          onConfirm={() => {
            const h = forgetting;
            setForgetting(null);
            void (async () => {
              await api.knownHostsForget(h.host, h.port);
              await reload();
            })();
          }}
          onCancel={() => setForgetting(null)}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------- import

function ImportTab() {
  const [hosts, setHosts] = useState<SshConfigHost[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const loadAll = useAppStore((s) => s.loadAll);

  useEffect(() => {
    void api
      .sshconfigRead()
      .then((h) => {
        setHosts(h);
        setSelected(new Set(h.map((x) => x.alias)));
      })
      .catch(() => setHosts([]));
  }, []);

  const doImport = async () => {
    const chosen = hosts.filter((h) => selected.has(h.alias));
    const r = await api.sshconfigImport(chosen);
    setResult(
      `${r.imported} importada(s)` +
        (r.skipped.length ? `, ${r.skipped.length} já existiam: ${r.skipped.join(", ")}` : ""),
    );
    await loadAll();
  };

  if (hosts.length === 0) {
    return <div className="muted">Nenhum host encontrado em ~/.ssh/config.</div>;
  }

  return (
    <>
      {result && <div className="alert alert--warn">{result}</div>}
      {hosts.map((h) => (
        <label
          key={h.alias}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={selected.has(h.alias)}
            onChange={(e) => {
              const next = new Set(selected);
              e.target.checked ? next.add(h.alias) : next.delete(h.alias);
              setSelected(next);
            }}
            style={{ width: "auto" }}
          />
          <span style={{ flex: 1 }}>
            {h.alias}
            <span className="muted">
              {" "}
              → {h.user ? `${h.user}@` : ""}
              {h.hostname}
              {h.port && h.port !== 22 ? `:${h.port}` : ""}
              {h.proxyJump ? ` (via ${h.proxyJump})` : ""}
            </span>
          </span>
          {selected.has(h.alias) && <Check size={13} color="var(--ok)" />}
        </label>
      ))}
      <button className="btn btn--primary" onClick={doImport}>
        <Download size={13} style={{ verticalAlign: -2 }} /> Importar selecionadas
      </button>
    </>
  );
}
