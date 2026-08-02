import { useCallback, useEffect, useState } from "react";
import { Cable, Pause, Play, Plus, RefreshCw, Trash2, Zap } from "lucide-react";

import { describeForward, ForwardForm } from "../connections/ForwardsSection";
import { ConfirmDialog, Spinner } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import type { PortForward } from "../lib/types";

/**
 * Túneis da sessão ativa: cria, liga/desliga e apaga sem sair do terminal.
 * As definições são as mesmas da conexão (também editáveis no Sheet).
 */
export function TunnelsPanel({
  sessionId,
  connectionId,
}: {
  sessionId: string;
  connectionId: string;
}) {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<PortForward | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [defs, activeIds] = await Promise.all([
        api.forwardList(connectionId),
        api.forwardActive(sessionId),
      ]);
      setForwards(defs);
      setActive(new Set(activeIds));
      setError(null);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setLoading(false);
    }
  }, [connectionId, sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (f: PortForward) => {
    setBusy(f.id);
    setError(null);
    try {
      if (active.has(f.id)) await api.forwardStop(sessionId, f.id);
      else await api.forwardStart(sessionId, f.id);
      await reload();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async (f: PortForward) => {
    await api.forwardSave({ ...f, autoStart: !f.autoStart });
    await reload();
  };

  /** Apagar sempre desliga antes: senão o listener ficaria órfão na sessão. */
  const remove = async (f: PortForward) => {
    setBusy(f.id);
    try {
      if (active.has(f.id)) await api.forwardStop(sessionId, f.id);
      await api.forwardDelete(f.id);
      await reload();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="docker">
      <div className="pane__head">
        <Cable size={14} />
        <span className="pane__path" style={{ direction: "ltr" }}>
          Túneis (port forwarding)
        </span>
        {loading && <Spinner />}
        <button
          className="icon-btn"
          title="Novo túnel"
          data-active={adding}
          onClick={() => setAdding((v) => !v)}
        >
          <Plus size={14} />
        </button>
        <button className="icon-btn" title="Recarregar" onClick={() => void reload()}>
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="docker__list">
        {error && (
          <div className="alert alert--danger" style={{ margin: 8, fontSize: 11 }}>
            {error}
          </div>
        )}

        {adding && (
          <div style={{ padding: 8 }}>
            <ForwardForm
              connectionId={connectionId}
              onSaved={() => {
                setAdding(false);
                void reload();
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}

        {!loading && forwards.length === 0 && !adding && (
          <div className="muted" style={{ padding: 16, textAlign: "center", fontSize: 12 }}>
            Nenhum túnel nesta conexão.
            <br />
            Use o <b>+</b> acima para criar.
          </div>
        )}

        {forwards.map((f) => {
          const on = active.has(f.id);
          return (
            <div key={f.id} className="docker__item">
              <span
                className="docker__dot"
                style={{ background: on ? "var(--ok)" : "var(--text-faint)" }}
                title={on ? "ativo" : "desligado"}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="file__name">
                  {f.label ||
                    `${f.kind === "local" ? "-L" : f.kind === "remote" ? "-R" : "-D"} ${f.localPort}`}
                </div>
                <div
                  className="muted"
                  style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}
                >
                  {describeForward(f)}
                </div>
              </div>

              <button
                className="icon-btn"
                title={f.autoStart ? "Auto-início ligado" : "Ligar junto com a conexão"}
                style={f.autoStart ? { color: "var(--warn)" } : undefined}
                onClick={() => void toggleAuto(f)}
              >
                <Zap size={13} />
              </button>

              {busy === f.id ? (
                <Spinner />
              ) : (
                <button
                  className="icon-btn"
                  title={on ? "Desligar túnel" : "Ligar túnel"}
                  data-active={on}
                  onClick={() => void toggle(f)}
                >
                  {on ? <Pause size={14} /> : <Play size={14} />}
                </button>
              )}

              <button
                className="icon-btn"
                title="Excluir túnel"
                onClick={() => setDeleting(f)}
              >
                <Trash2 size={13} color="var(--danger)" />
              </button>
            </div>
          );
        })}
      </div>

      {deleting && (
        <ConfirmDialog
          title="Excluir túnel"
          danger
          confirmLabel="Excluir"
          message={
            <>
              Excluir <b>{deleting.label || describeForward(deleting)}</b>?
              {active.has(deleting.id) && " O túnel está ativo e será desligado antes."}
            </>
          }
          onConfirm={() => {
            const f = deleting;
            setDeleting(null);
            void remove(f);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
