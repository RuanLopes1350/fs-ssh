import { useEffect, useState } from "react";
import { ArrowLeftRight, Plus, Trash2, Zap } from "lucide-react";

import { api, asAppError } from "../lib/ipc";
import type { PortForward } from "../lib/types";

const EMPTY: Omit<PortForward, "id" | "connectionId"> = {
  kind: "local",
  label: "",
  bindAddr: "127.0.0.1",
  localPort: 0,
  remoteHost: "localhost",
  remotePort: 0,
  autoStart: false,
};

/** Descrição humana do mapeamento, na direção em que os bytes fluem. */
export function describeForward(f: PortForward): string {
  return f.kind === "local"
    ? `localhost:${f.localPort} → ${f.remoteHost}:${f.remotePort} (via servidor)`
    : `servidor:${f.localPort} → ${f.remoteHost}:${f.remotePort} (sua máquina)`;
}

/**
 * Definições de port forwarding de uma conexão salva (formulário de edição).
 * Cada túnel salva/apaga na hora — não depende do botão Salvar do formulário.
 */
export function ForwardsSection({ connectionId }: { connectionId: string }) {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ ...EMPTY });
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setForwards(await api.forwardList(connectionId));
    } catch (e) {
      setError(asAppError(e).message);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const add = async () => {
    setError(null);
    try {
      await api.forwardSave({ ...draft, id: "", connectionId });
      setDraft({ ...EMPTY });
      setAdding(false);
      await reload();
    } catch (e) {
      setError(asAppError(e).message);
    }
  };

  const remove = async (f: PortForward) => {
    await api.forwardDelete(f.id);
    await reload();
  };

  const toggleAuto = async (f: PortForward) => {
    await api.forwardSave({ ...f, autoStart: !f.autoStart });
    await reload();
  };

  return (
    <div className="field">
      <label>Port forwarding</label>

      {error && <div className="alert alert--danger">{error}</div>}

      {forwards.map((f) => (
        <div
          key={f.id}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}
        >
          <ArrowLeftRight size={13} color="var(--text-faint)" />
          <span style={{ flex: 1, fontSize: 12 }}>
            {f.label && <b>{f.label} · </b>}
            <span style={{ fontFamily: "ui-monospace, monospace" }}>
              {describeForward(f)}
            </span>
          </span>
          <button
            className="icon-btn"
            title={f.autoStart ? "Auto-início ligado" : "Ligar junto com a conexão"}
            style={f.autoStart ? { color: "var(--warn)" } : undefined}
            onClick={() => void toggleAuto(f)}
          >
            <Zap size={13} />
          </button>
          <button className="icon-btn" title="Excluir túnel" onClick={() => void remove(f)}>
            <Trash2 size={13} color="var(--danger)" />
          </button>
        </div>
      ))}

      {!adding ? (
        <button className="btn" style={{ alignSelf: "start" }} onClick={() => setAdding(true)}>
          <Plus size={13} style={{ verticalAlign: -2 }} /> Novo túnel
        </button>
      ) : (
        <div
          style={{
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div className="row">
            <div className="field">
              <label>Tipo</label>
              <select
                value={draft.kind}
                onChange={(e) =>
                  setDraft({ ...draft, kind: e.target.value as "local" | "remote" })
                }
              >
                <option value="local">Local (-L): acessar porta do servidor aqui</option>
                <option value="remote">Reverso (-R): expor porta local no servidor</option>
              </select>
            </div>
            <div className="field" style={{ maxWidth: 110 }}>
              <label>{draft.kind === "local" ? "Porta local" : "Porta no servidor"}</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.localPort || ""}
                onChange={(e) => setDraft({ ...draft, localPort: Number(e.target.value) || 0 })}
                placeholder="8080"
              />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>
                {draft.kind === "local" ? "Destino (visto pelo servidor)" : "Destino (sua máquina)"}
              </label>
              <input
                value={draft.remoteHost}
                onChange={(e) => setDraft({ ...draft, remoteHost: e.target.value })}
                placeholder="localhost"
              />
            </div>
            <div className="field" style={{ maxWidth: 110 }}>
              <label>Porta destino</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.remotePort || ""}
                onChange={(e) => setDraft({ ...draft, remotePort: Number(e.target.value) || 0 })}
                placeholder="5432"
              />
            </div>
          </div>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field">
              <label>Nome (opcional)</label>
              <input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="postgres, painel-admin…"
              />
            </div>
            <label
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                cursor: "pointer",
                paddingBottom: 6,
              }}
            >
              <input
                type="checkbox"
                checked={draft.autoStart}
                onChange={(e) => setDraft({ ...draft, autoStart: e.target.checked })}
                style={{ width: "auto" }}
              />
              <span style={{ fontSize: 12 }}>Ligar ao conectar</span>
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setAdding(false)}>
              Cancelar
            </button>
            <button
              className="btn btn--primary"
              disabled={!draft.localPort || !draft.remotePort || !draft.remoteHost.trim()}
              onClick={() => void add()}
            >
              Adicionar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
