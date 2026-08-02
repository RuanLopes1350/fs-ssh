import { useCallback, useEffect, useState } from "react";
import {
  Container,
  FileText,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { ConfirmDialog, Spinner } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import type { DockerContainer } from "../lib/types";

const encoder = new TextEncoder();

type Action = "start" | "stop" | "restart" | "rm";

const ACTION_LABEL: Record<Action, string> = {
  start: "Iniciar",
  stop: "Parar",
  restart: "Reiniciar",
  rm: "Excluir",
};

/** Nome que pode ir para a linha de comando do shell sem aspas nem sustos. */
function shellSafe(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

/**
 * Containers do host (docker/podman), detectados pelo canal exec da própria
 * sessão — nada instalado no servidor.
 *
 * Iniciar/parar/reiniciar rodam pelo exec e reportam o erro do docker; shell e
 * logs digitam o comando no terminal, para o usuário ver o que rodou e poder
 * interromper com ⌃C.
 */
export function DockerPanel({
  sessionId,
  local = false,
}: {
  sessionId: string;
  /** Sessão do terminal local — muda só o texto do cabeçalho. */
  local?: boolean;
}) {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    action: Action;
    container: DockerContainer;
  } | null>(null);

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

  const run = async (action: Action, c: DockerContainer) => {
    setBusy(c.id);
    setError(null);
    try {
      await api.dockerAction(sessionId, action, c.id);
      await refresh();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  /** Parar e reiniciar derrubam serviço: confirmam antes. Iniciar não. */
  const request = (action: Action, c: DockerContainer) => {
    if (action === "start") void run(action, c);
    else setConfirming({ action, container: c });
  };

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
          {local ? "Containers nesta máquina" : "Containers no host"}
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
            Nenhum container encontrado{local ? " nesta máquina" : " neste host"}.
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

            {busy === c.id ? (
              <Spinner />
            ) : c.running ? (
              <>
                <button
                  className="icon-btn"
                  title={`Parar ${c.name}`}
                  onClick={() => request("stop", c)}
                >
                  <Square size={13} />
                </button>
                <button
                  className="icon-btn"
                  title={`Reiniciar ${c.name}`}
                  onClick={() => request("restart", c)}
                >
                  <RotateCw size={13} />
                </button>
              </>
            ) : (
              <button
                className="icon-btn"
                title={`Iniciar ${c.name}`}
                onClick={() => request("start", c)}
              >
                <Play size={13} color="var(--ok)" />
              </button>
            )}

            {busy !== c.id && (
              <button
                className="icon-btn"
                title={`Excluir ${c.name}`}
                onClick={() => request("rm", c)}
              >
                <Trash2 size={13} color="var(--danger)" />
              </button>
            )}

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

      {confirming && (
        <ConfirmDialog
          title={`${ACTION_LABEL[confirming.action]} container`}
          danger
          confirmLabel={ACTION_LABEL[confirming.action]}
          message={
            confirming.action === "rm" ? (
              <>
                Excluir o container <b>{confirming.container.name}</b> (
                {confirming.container.image}){local ? " desta máquina" : " deste host"}?
                {confirming.container.running && " Ele está rodando e será parado antes."}{" "}
                A ação não tem volta — os volumes nomeados não são removidos, mas o
                container e seu sistema de arquivos sim.
              </>
            ) : (
              <>
                {confirming.action === "stop" ? "Parar" : "Reiniciar"}{" "}
                <b>{confirming.container.name}</b> ({confirming.container.image})
                {local ? " nesta máquina" : " no host"}? O serviço fica indisponível
                {confirming.action === "restart" ? " durante o reinício." : "."}
              </>
            )
          }
          onConfirm={() => {
            const { action, container } = confirming;
            setConfirming(null);
            void run(action, container);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
