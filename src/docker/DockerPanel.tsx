import { useCallback, useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Check,
  Container,
  Copy,
  FileText,
  Layers,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { ConfirmDialog, Spinner } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import type { DockerContainer, DockerImage } from "../lib/types";

const encoder = new TextEncoder();

type Tab = "containers" | "images";
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

/** Referência usável no `docker rmi` / clipboard (`repo:tag` ou ID quando `<none>`). */
function imageRef(img: DockerImage): string {
  if (img.repository && img.repository !== "<none>") {
    return img.tag && img.tag !== "<none>" ? `${img.repository}:${img.tag}` : img.repository;
  }
  return img.id;
}

function isImageInUse(img: DockerImage, containers: DockerContainer[]): boolean {
  const ref = imageRef(img);
  return containers.some(
    (c) =>
      c.image === ref ||
      c.image === img.id ||
      (img.tag === "latest" && img.repository !== "<none>" && c.image === img.repository),
  );
}

/**
 * Containers e imagens do host (docker/podman), detectados pelo canal exec da
 * própria sessão — nada instalado no servidor.
 *
 * Iniciar/parar/reiniciar/remover rodam pelo exec e reportam o erro do docker;
 * shell e logs digitam o comando no terminal, para o usuário ver o que rodou e
 * poder interromper com ⌃C.
 */
export function DockerPanel({
  sessionId,
  local = false,
}: {
  sessionId: string;
  /** Sessão do terminal local — muda só o texto do cabeçalho. */
  local?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("containers");
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    action: Action;
    container: DockerContainer;
  } | null>(null);
  const [confirmingImage, setConfirmingImage] = useState<DockerImage | null>(null);

  const loadContainers = useCallback(async () => {
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

  const loadImages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setImages(await api.dockerImages(sessionId));
      setImagesLoaded(true);
    } catch (e) {
      setError(asAppError(e).message);
      setImages([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadContainers();
  }, [loadContainers]);

  useEffect(() => {
    if (tab === "images" && !imagesLoaded) {
      void loadImages();
    }
  }, [tab, imagesLoaded, loadImages]);

  const refresh = () => {
    if (tab === "containers") void loadContainers();
    else void loadImages();
  };

  const run = async (action: Action, c: DockerContainer) => {
    setBusy(c.id);
    setError(null);
    try {
      await api.dockerAction(sessionId, action, c.id);
      await loadContainers();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const removeImage = async (img: DockerImage) => {
    const target = imageRef(img);
    setBusy(target);
    setError(null);
    try {
      await api.dockerImageRm(sessionId, target, false);
      await loadImages();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const copyImage = async (img: DockerImage) => {
    const ref = imageRef(img);
    try {
      await writeText(ref);
      setCopiedId(ref);
      window.setTimeout(() => setCopiedId((cur) => (cur === ref ? null : cur)), 1500);
    } catch {
      // Silencioso caso a área de transferência falhe.
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

  const switchTab = (next: Tab) => {
    setError(null);
    setTab(next);
  };

  return (
    <div className="docker">
      <div className="pane__head">
        <Container size={14} />
        <span className="pane__path" style={{ direction: "ltr" }}>
          {local ? "Docker nesta máquina" : "Docker no host"}
        </span>
        {loading && <Spinner />}
        <button className="icon-btn" title="Recarregar" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="sysinfo__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "containers"}
          className="sysinfo__tab"
          data-active={tab === "containers"}
          onClick={() => switchTab("containers")}
        >
          <Container size={12} />
          Containers{containers.length > 0 ? ` (${containers.length})` : ""}
        </button>
        <button
          role="tab"
          aria-selected={tab === "images"}
          className="sysinfo__tab"
          data-active={tab === "images"}
          onClick={() => switchTab("images")}
        >
          <Layers size={12} />
          Imagens{images.length > 0 ? ` (${images.length})` : ""}
        </button>
      </div>

      <div className="docker__list">
        {error && (
          <div className="alert alert--warn" style={{ margin: 8, fontSize: 11 }}>
            {error}
          </div>
        )}

        {tab === "containers" && (
          <>
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
          </>
        )}

        {tab === "images" && (
          <>
            {!error && !loading && images.length === 0 && (
              <div className="muted" style={{ padding: 16, textAlign: "center" }}>
                Nenhuma imagem encontrada{local ? " nesta máquina" : " neste host"}.
              </div>
            )}

            {images.map((img, idx) => {
              const ref = imageRef(img);
              const inUse = isImageInUse(img, containers);
              const repoLabel =
                img.repository === "<none>" ? "<sem repositório>" : img.repository;
              const fullTitle =
                img.tag && img.tag !== "<none>" ? `${repoLabel}:${img.tag}` : repoLabel;
              return (
                <div key={`${img.id}:${img.repository}:${img.tag}:${idx}`} className="docker__item">
                  <span
                    className="docker__dot"
                    style={{ background: inUse ? "var(--ok)" : "var(--text-faint)" }}
                    title={inUse ? "em uso por container" : "sem container associado"}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="file__name" title={fullTitle}>
                      {fullTitle}
                    </div>
                    <div className="muted" style={{ fontSize: 10 }}>
                      {img.id} · {img.size}
                      {img.created ? ` · ${img.created}` : ""}
                      {inUse ? " · em uso" : ""}
                    </div>
                  </div>

                  {busy === ref ? (
                    <Spinner />
                  ) : (
                    <>
                      <button
                        className="icon-btn"
                        title={`Copiar ${ref}`}
                        onClick={() => void copyImage(img)}
                      >
                        {copiedId === ref ? (
                          <Check size={13} color="var(--ok)" />
                        ) : (
                          <Copy size={13} />
                        )}
                      </button>
                      <button
                        className="icon-btn"
                        title={`Remover imagem ${ref}`}
                        onClick={() => setConfirmingImage(img)}
                      >
                        <Trash2 size={13} color="var(--danger)" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
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

      {confirmingImage && (
        <ConfirmDialog
          title="Remover imagem"
          danger
          confirmLabel="Remover"
          message={
            <>
              Remover a imagem <b>{imageRef(confirmingImage)}</b> ({confirmingImage.size})
              {local ? " desta máquina" : " deste host"}?
              {isImageInUse(confirmingImage, containers) &&
                " Há pelo menos um container usando esta imagem; o Docker pode recusar a remoção enquanto ele existir."}
            </>
          }
          onConfirm={() => {
            const target = confirmingImage;
            setConfirmingImage(null);
            void removeImage(target);
          }}
          onCancel={() => setConfirmingImage(null)}
        />
      )}
    </div>
  );
}
