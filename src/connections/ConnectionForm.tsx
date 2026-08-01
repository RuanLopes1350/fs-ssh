import { useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";

import { Modal } from "../components/Dialogs";
import { ConnIcon, ICON_NAMES } from "../components/Icon";
import { ForwardsSection } from "./ForwardsSection";
import { api } from "../lib/ipc";
import { terminals } from "../terminal/session";
import { FALLBACK_PALETTE, useAppStore } from "../store/useAppStore";
import type { AuthMethod, Connection } from "../lib/types";

const PRESET_COLORS = [
  "#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e", "#84cc16",
  "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7",
  "#8b5cf6", "#64748b",
];

export const EMPTY_CONNECTION: Connection = {
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "",
  authMethod: "auto",
  identityId: null,
  jumpHostId: null,
  folderId: null,
  color: "#3b82f6",
  icon: "server",
  themeId: null,
  isProduction: false,
  notes: "",
  createdAt: "",
  lastUsedAt: null,
  useCount: 0,
  tagIds: [],
};

export function ConnectionForm({
  initial,
  onClose,
}: {
  initial: Connection;
  onClose: () => void;
}) {
  const [conn, setConn] = useState<Connection>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const identities = useAppStore((s) => s.identities);
  const themes = useAppStore((s) => s.themes);
  const tags = useAppStore((s) => s.tags);
  const folders = useAppStore((s) => s.folders);
  const connections = useAppStore((s) => s.connections);
  const reload = useAppStore((s) => s.reloadConnections);

  const set = <K extends keyof Connection>(k: K, v: Connection[K]) =>
    setConn((c) => ({ ...c, [k]: v }));

  // Preview ao vivo do tema: trocar a seleção já pinta as abas abertas desta
  // conexão, para escolher vendo o resultado. Cancelar (unmount) reverte.
  useEffect(() => {
    if (!conn.id) return;
    const palette = themes.find((t) => t.id === conn.themeId)?.json ?? FALLBACK_PALETTE;
    for (const t of useAppStore.getState().tabs) {
      if (t.connectionId === conn.id) terminals.get(t.id)?.setPalette(palette);
    }
  }, [conn.themeId, conn.id, themes]);

  useEffect(() => () => useAppStore.getState().applyPalettes(), []);

  const save = async () => {
    if (!conn.name.trim() || !conn.host.trim() || !conn.username.trim()) {
      setError("Nome, host e usuário são obrigatórios.");
      return;
    }
    setSaving(true);
    try {
      await api.connSave(conn);
      await reload();
      // Se a conexão tem abas abertas, o tema escolhido vale imediatamente.
      useAppStore.getState().applyPalettes();
      onClose();
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await api.connDelete(conn.id);
    await reload();
    onClose();
  };

  return (
    <Modal
      title={conn.id ? `Editar ${initial.name}` : "Nova conexão"}
      wide
      onClose={onClose}
      footer={
        <>
          {conn.id && (
            <button className="btn btn--danger" onClick={remove} title="Excluir conexão">
              <Trash2 size={13} />
            </button>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            Salvar
          </button>
        </>
      }
    >
      {error && <div className="alert alert--danger">{error}</div>}

      <div className="row">
        <div className="field" style={{ flex: 2 }}>
          <label>Nome</label>
          <input
            value={conn.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="api-prod-01"
            autoFocus
          />
        </div>
        <div className="field" style={{ flex: 3 }}>
          <label>Host (IP ou DNS)</label>
          <input
            value={conn.host}
            onChange={(e) => set("host", e.target.value)}
            placeholder="10.0.0.12 ou api.exemplo.com"
          />
        </div>
        <div className="field" style={{ maxWidth: 80 }}>
          <label>Porta</label>
          <input
            type="number"
            value={conn.port}
            onChange={(e) => set("port", Number(e.target.value) || 22)}
          />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label>Usuário</label>
          <input
            value={conn.username}
            onChange={(e) => set("username", e.target.value)}
            placeholder="deploy"
          />
        </div>
        <div className="field">
          <label>Autenticação</label>
          <select
            value={conn.authMethod}
            onChange={(e) => set("authMethod", e.target.value as AuthMethod)}
          >
            <option value="auto">Automática (agente → chave → senha)</option>
            <option value="agent">Somente ssh-agent</option>
            <option value="key">Somente chave</option>
            <option value="password">Somente senha</option>
          </select>
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label>Chave</label>
          <select
            value={conn.identityId ?? ""}
            onChange={(e) => set("identityId", e.target.value || null)}
          >
            <option value="">Qualquer uma disponível</option>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label} · {i.keyType}
                {i.inAgent ? " · no agente" : ""}
                {i.hasPassphrase ? " · cifrada" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Jump host (bastion)</label>
          <select
            value={conn.jumpHostId ?? ""}
            onChange={(e) => set("jumpHostId", e.target.value || null)}
          >
            <option value="">Conexão direta</option>
            {connections
              .filter((c) => c.id !== conn.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.host})
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label>Pasta</label>
          <select
            value={conn.folderId ?? ""}
            onChange={(e) => set("folderId", e.target.value || null)}
          >
            <option value="">Sem pasta</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label>Tags</label>
        <div className="tags" style={{ padding: 0 }}>
          {tags.length === 0 && <span className="muted">Nenhuma tag criada ainda.</span>}
          {tags.map((t) => {
            const active = conn.tagIds.includes(t.id);
            return (
              <button
                key={t.id}
                className="tag"
                data-active={active}
                style={active ? { color: t.color } : undefined}
                onClick={() =>
                  set(
                    "tagIds",
                    active ? conn.tagIds.filter((x) => x !== t.id) : [...conn.tagIds, t.id],
                  )
                }
              >
                <span className="tag__dot" style={{ background: t.color }} />
                {t.name}
                {active && <Check size={11} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label>Cor</label>
          <div className="swatches">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                className="swatch"
                data-active={conn.color === c}
                style={{ background: c }}
                onClick={() => set("color", c)}
              />
            ))}
            <input
              type="color"
              value={conn.color}
              onChange={(e) => set("color", e.target.value)}
              style={{ width: 34, height: 24, padding: 0, border: "none" }}
            />
          </div>
        </div>
        <div className="field">
          <label>Tema do terminal</label>
          <select
            value={conn.themeId ?? ""}
            onChange={(e) => set("themeId", e.target.value || null)}
          >
            <option value="">Padrão</option>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label>Ícone</label>
        <div className="icon-grid">
          {ICON_NAMES.map((name) => (
            <button
              key={name}
              className="icon-choice"
              data-active={conn.icon === name}
              onClick={() => set("icon", name)}
              title={name}
            >
              <ConnIcon name={name} size={16} />
            </button>
          ))}
        </div>
      </div>

      <label
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={conn.isProduction}
          onChange={(e) => set("isProduction", e.target.checked)}
          style={{ width: "auto" }}
        />
        <span>
          Servidor de produção
          <span className="muted">
            {" "}
            — pede confirmação ao conectar e marca a aba com faixa vermelha
          </span>
        </span>
      </label>

      {conn.id ? (
        <ForwardsSection connectionId={conn.id} />
      ) : (
        <div className="field">
          <label>Port forwarding</label>
          <span className="muted" style={{ fontSize: 11 }}>
            Salve a conexão primeiro para adicionar túneis (-L/-R).
          </span>
        </div>
      )}

      <div className="field">
        <label>Notas</label>
        <textarea
          rows={2}
          value={conn.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Contexto, responsável, runbook…"
        />
      </div>
    </Modal>
  );
}
