import { useCallback, useEffect, useState } from "react";
import { Container, FileText, RefreshCw, SquareTerminal } from "lucide-react";

import { Spinner } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import type { DockerContainer } from "../lib/types";

const encoder = new TextEncoder();

/** Nome que pode ir para a linha de comando do shell sem aspas nem sustos. */
function shellSafe(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

/**
 * Containers do host remoto (docker/podman), detectados via canal exec da
 * própria sessão SSH — nada instalado no servidor.
 *
 * As ações não executam nada sozinhas: elas digitam o comando no terminal da
 * aba ativa e apertam Enter, para o usuário ver exatamente o que rodou.
 */
export function DockerPanel({ sessionId }: { sessionId: string }) {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setContainers(await api.dockerPs(sessionId));
    } catch (e) {
      setError(asAppError(e).message);
      setContainers([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const typeInTerminal = (command: string) => {
    void api
      .sshWrite(sessionId, Array.from(encoder.encode(`${command}\n`)))
      .catch(() => {});
  };

  return (
    <div className="docker">
      <div className="pane__head">
        <Container size={14} />
        <span className="pane__path" style={{ direction: "ltr" }}>
          Containers no host
        </span>
        {loading && <Spinner />}
        <button className="icon-btn" title="Recarregar" onClick={() => void refresh()}>
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="docker__list">
        {error && (
          <div className="alert alert--warn" style={{ margin: 8, fontSize: 11 }}>
            {error}
          </div>
        )}

        {!error && !loading && containers.length === 0 && (
          <div className="muted" style={{ padding: 16, textAlign: "center" }}>
            Nenhum container encontrado neste host.
          </div>
        )}

        {containers.map((c) => (
          <div key={c.id} className="docker__item">
            <span
              className="docker__dot"
              style={{ background: c.running ? "var(--ok)" : "var(--text-faint)" }}
              title={c.running ? "rodando" : "parado"}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="file__name" title={c.name}>
                {c.name}
              </div>
              <div className="muted" style={{ fontSize: 10 }} title={c.ports || undefined}>
                {c.image} · {c.status}
                {c.ports ? ` · ${c.ports}` : ""}
              </div>
            </div>
            {shellSafe(c.name) && (
              <>
                {c.running && (
                  <button
                    className="icon-btn"
                    title={`Shell no container (docker exec ${c.name})`}
                    onClick={() =>
                      typeInTerminal(
                        `docker exec -it ${c.name} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`,
                      )
                    }
                  >
                    <SquareTerminal size={14} />
                  </button>
                )}
                <button
                  className="icon-btn"
                  title={`Logs (docker logs --tail 100 -f ${c.name})`}
                  onClick={() => typeInTerminal(`docker logs --tail 100 -f ${c.name}`)}
                >
                  <FileText size={14} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
