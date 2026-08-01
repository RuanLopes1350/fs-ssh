import { useCallback, useEffect, useState } from "react";
import { Cable, Pause, Play, RefreshCw } from "lucide-react";

import { describeForward } from "../connections/ForwardsSection";
import { Spinner } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import type { PortForward } from "../lib/types";

/**
 * Túneis da sessão ativa: liga/desliga cada definição salva da conexão.
 * As definições em si são editadas no formulário da conexão (lápis).
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
      if (active.has(f.id)) {
        await api.forwardStop(sessionId, f.id);
      } else {
        await api.forwardStart(sessionId, f.id);
      }
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

        {!loading && forwards.length === 0 && (
          <div className="muted" style={{ padding: 16, textAlign: "center", fontSize: 12 }}>
            Nenhum túnel definido para esta conexão.
            <br />
            Adicione em <b>editar conexão (lápis) → Port forwarding</b>.
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
                  {f.autoStart && (
                    <span className="muted" style={{ fontSize: 10 }}>
                      {" "}
                      · auto
                    </span>
                  )}
                </div>
                <div
                  className="muted"
                  style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}
                >
                  {describeForward(f)}
                </div>
              </div>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
