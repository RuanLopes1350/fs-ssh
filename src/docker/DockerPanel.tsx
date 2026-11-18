import { useCallback, useEffect, useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Box,
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
import type {
  ContainerEngineKind,
  ContainerRuntime,
  DockerContainer,
  DockerImage,
  KubePod,
} from "../lib/types";

const encoder = new TextEncoder();

type Tab = "containers" | "images";
type Action = "start" | "stop" | "restart" | "rm";

const ACTION_LABEL: Record<Action, string> = {
  start: "Iniciar",
  stop: "Parar",
  restart: "Reiniciar",
  rm: "Excluir",
};

function isKubeKind(kind: ContainerEngineKind | null): boolean {
  return kind === "k3s" || kind === "microk8s" || kind === "kubectl";
}

/** Nome que pode ir para a linha de comando do shell sem aspas nem sustos. */
function shellSafe(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

/** Referência usável no `rmi` / clipboard (`repo:tag` ou ID quando `<none>`). */
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

function isKubeImageInUse(img: DockerImage, pods: KubePod[]): boolean {
  const ref = imageRef(img);
  const shortRepo = img.repository.replace(/^docker\.io\/(library\/)?/, "");
  const shortRef =
    img.tag && img.tag !== "<none>" ? `${shortRepo}:${img.tag}` : shortRepo;
  return pods.some((p) =>
    p.image
      .split(",")
      .map((s) => s.trim())
      .some(
        (podImg) =>
          podImg === ref ||
          podImg === shortRef ||
          (img.tag === "latest" &&
            img.repository !== "<none>" &&
            (podImg === img.repository || podImg === shortRepo)),
      ),
  );
}

function podDotColor(pod: KubePod): string {
  if (pod.running || pod.status === "Completed" || pod.status === "Succeeded") {
    return "var(--ok)";
  }
  if (/BackOff|Error|Failed|ErrImagePull|OOMKilled|Evicted/i.test(pod.status)) {
    return "var(--danger)";
  }
  return "var(--warn)";
}

/**
 * Painel unificado de containers e Kubernetes (Docker, Podman, k3s, MicroK8s,
 * kubectl), detectados de forma leve pelo canal exec da própria sessão — nada
 * instalado no servidor.
 *
 * Cada runtime roda isolado para não interferir no outro; shell e logs digitam
 * o comando no terminal com o binário exato do runtime selecionado para o
 * usuário ver o que rodou e poder interromper com ⌃C.
 */
export function DockerPanel({
  sessionId,
  local = false,
}: {
  sessionId: string;
  /** Sessão do terminal local — muda só o texto do cabeçalho. */
  local?: boolean;
}) {
  const [runtimes, setRuntimes] = useState<ContainerRuntime[]>([]);
  const [selectedKind, setSelectedKind] = useState<ContainerEngineKind | null>(null);
  const [detecting, setDetecting] = useState(true);

  const [tab, setTab] = useState<Tab>("containers");
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [pods, setPods] = useState<KubePod[]>([]);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [imagesLoaded, setImagesLoaded] = useState(false);

  const [nsFilter, setNsFilter] = useState<string>("all");
  const [podSearch, setPodSearch] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    action: Action;
    container: DockerContainer;
  } | null>(null);
  const [confirmingPod, setConfirmingPod] = useState<KubePod | null>(null);
  const [confirmingImage, setConfirmingImage] = useState<DockerImage | null>(null);

  const activeRuntime = useMemo(
    () => runtimes.find((r) => r.kind === selectedKind) ?? null,
    [runtimes, selectedKind],
  );
  const isKube = isKubeKind(selectedKind);

  const detectRuntimes = useCallback(async () => {
    setDetecting(true);
    setLoading(true);
    setError(null);
    setContainers([]);
    setPods([]);
    setImages([]);
    setImagesLoaded(false);
    try {
      const detected = await api.containerRuntimes(sessionId);
      setRuntimes(detected);
      setSelectedKind(detected[0]?.kind ?? null);
      if (detected.length === 0) {
        setLoading(false);
      }
    } catch (e) {
      setError(asAppError(e).message);
      setRuntimes([]);
      setSelectedKind(null);
      setLoading(false);
    } finally {
      setDetecting(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void detectRuntimes();
  }, [detectRuntimes]);

  const loadWorkloads = useCallback(
    async (kind: ContainerEngineKind) => {
      setLoading(true);
      setError(null);
      try {
        if (isKubeKind(kind)) {
          const list = await api.kubePods(sessionId, kind);
          setPods(list);
        } else {
          const list = await api.dockerPs(sessionId, kind);
          setContainers(list);
        }
      } catch (e) {
        setError(asAppError(e).message);
        if (isKubeKind(kind)) setPods([]);
        else setContainers([]);
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  const loadImages = useCallback(
    async (kind: ContainerEngineKind) => {
      setLoading(true);
      setError(null);
      try {
        const list = isKubeKind(kind)
          ? await api.kubeImages(sessionId, kind)
          : await api.dockerImages(sessionId, kind);
        setImages(list);
        setImagesLoaded(true);
      } catch (e) {
        setError(asAppError(e).message);
        setImages([]);
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!selectedKind) return;
    void loadWorkloads(selectedKind);
  }, [selectedKind, loadWorkloads]);

  useEffect(() => {
    if (selectedKind && tab === "images" && !imagesLoaded) {
      void loadImages(selectedKind);
    }
  }, [selectedKind, tab, imagesLoaded, loadImages]);

  const selectRuntime = (next: ContainerEngineKind) => {
    if (next === selectedKind) return;
    setError(null);
    setContainers([]);
    setPods([]);
    setImages([]);
    setImagesLoaded(false);
    setNsFilter("all");
    setPodSearch("");
    setSelectedKind(next);
  };

  const refresh = () => {
    if (!selectedKind) {
      void detectRuntimes();
      return;
    }
    if (tab === "containers") void loadWorkloads(selectedKind);
    else void loadImages(selectedKind);
  };

  const run = async (action: Action, c: DockerContainer) => {
    if (!selectedKind) return;
    setBusy(c.id);
    setError(null);
    try {
      await api.dockerAction(sessionId, action, c.id, selectedKind);
      await loadWorkloads(selectedKind);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const deletePod = async (pod: KubePod) => {
    if (!selectedKind) return;
    const key = `${pod.namespace}/${pod.name}`;
    setBusy(key);
    setError(null);
    try {
      await api.kubePodDelete(sessionId, pod.namespace, pod.name, selectedKind);
      await loadWorkloads(selectedKind);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const removeImage = async (img: DockerImage) => {
    if (!selectedKind) return;
    const target = imageRef(img);
    setBusy(target);
    setError(null);
    try {
      if (isKubeKind(selectedKind)) {
        await api.kubeImageRm(sessionId, target, selectedKind);
      } else {
        await api.dockerImageRm(sessionId, target, false, selectedKind);
      }
      await loadImages(selectedKind);
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

  const namespaces = useMemo(
    () => Array.from(new Set(pods.map((p) => p.namespace))).sort(),
    [pods],
  );

  const filteredPods = useMemo(() => {
    const q = podSearch.trim().toLowerCase();
    return pods.filter((p) => {
      if (nsFilter !== "all" && p.namespace !== nsFilter) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.namespace.toLowerCase().includes(q) ||
        p.status.toLowerCase().includes(q) ||
        p.image.toLowerCase().includes(q)
      );
    });
  }, [pods, nsFilter, podSearch]);

  const ociCli = activeRuntime?.cli || "docker";
  const kubeCli = activeRuntime?.cli || "kubectl";
  const workloadCount = isKube ? pods.length : containers.length;

  return (
    <div className="docker">
      <div className="pane__head">
        <Container size={14} />
        <span className="pane__path" style={{ direction: "ltr" }}>
          {activeRuntime
            ? `${activeRuntime.label} ${local ? "nesta máquina" : "no host"}`
            : `Containers ${local ? "nesta máquina" : "no host"}`}
        </span>
        {(loading || detecting) && <Spinner />}
        <button className="icon-btn" title="Recarregar" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>

      {runtimes.length > 1 && (
        <div className="docker__engines" role="tablist" aria-label="Runtimes detectados">
          {runtimes.map((r) => (
            <button
              key={r.kind}
              role="tab"
              aria-selected={r.kind === selectedKind}
              className="docker__engine-pill"
              data-active={r.kind === selectedKind}
              data-inactive={!r.active}
              title={
                r.active
                  ? `${r.label} (${r.cli})`
                  : `${r.label} instalado, mas socket/kubeconfig não acessível`
              }
              onClick={() => selectRuntime(r.kind)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {selectedKind && (
        <div className="sysinfo__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "containers"}
            className="sysinfo__tab"
            data-active={tab === "containers"}
            onClick={() => switchTab("containers")}
          >
            {isKube ? <Box size={12} /> : <Container size={12} />}
            {isKube ? "Pods" : "Containers"}
            {workloadCount > 0 ? ` (${workloadCount})` : ""}
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
      )}

      {isKube && tab === "containers" && (
        <div className="sysinfo__bar">
          <select
            className="docker__ns-select"
            value={nsFilter}
            onChange={(e) => setNsFilter(e.target.value)}
            title="Filtrar por namespace"
          >
            <option value="all">Todos os namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
          <input
            className="sysinfo__filter"
            placeholder="Filtrar pods..."
            value={podSearch}
            onChange={(e) => setPodSearch(e.target.value)}
          />
        </div>
      )}

      <div className="docker__list">
        {error && (
          <div className="alert alert--warn" style={{ margin: 8, fontSize: 11 }}>
            {error}
          </div>
        )}

        {!detecting && !selectedKind && !error && (
          <div className="muted" style={{ padding: 16, textAlign: "center" }}>
            Nenhum runtime encontrado (docker, podman, k3s, kubectl)
            {local ? " nesta máquina" : " neste host"}.
          </div>
        )}

        {selectedKind && !isKube && tab === "containers" && (
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
                        title={`Shell no container (${ociCli} exec ${c.name})`}
                        onClick={() =>
                          typeInTerminal(
                            `${ociCli} exec -it ${c.name} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`,
                          )
                        }
                      >
                        <SquareTerminal size={14} />
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      title={`Logs (${ociCli} logs --tail 100 -f ${c.name})`}
                      onClick={() => typeInTerminal(`${ociCli} logs --tail 100 -f ${c.name}`)}
                    >
                      <FileText size={14} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </>
        )}

        {selectedKind && isKube && tab === "containers" && (
          <>
            {!error && !loading && filteredPods.length === 0 && (
              <div className="muted" style={{ padding: 16, textAlign: "center" }}>
                {pods.length === 0
                  ? "Nenhum pod encontrado neste cluster."
                  : "Nenhum pod corresponde ao filtro."}
              </div>
            )}

            {filteredPods.map((pod) => {
              const podKey = `${pod.namespace}/${pod.name}`;
              const displayName = nsFilter === "all" ? podKey : pod.name;
              const safeNames = shellSafe(pod.namespace) && shellSafe(pod.name);
              return (
                <div key={podKey} className="docker__item">
                  <span
                    className="docker__dot"
                    style={{ background: podDotColor(pod) }}
                    title={`${pod.status} (${pod.ready})`}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="file__name" title={podKey}>
                      {displayName}
                    </div>
                    <div
                      className="muted"
                      style={{ fontSize: 10 }}
                      title={pod.node ? `Node: ${pod.node}` : undefined}
                    >
                      {pod.ready} · {pod.status}
                      {pod.restarts !== "0" ? ` · ↻ ${pod.restarts}` : ""}
                      {pod.age ? ` · ${pod.age}` : ""}
                      {pod.image ? ` · ${pod.image}` : ""}
                    </div>
                  </div>

                  {busy === podKey ? (
                    <Spinner />
                  ) : (
                    <>
                      <button
                        className="icon-btn"
                        title={`Reiniciar / excluir pod ${podKey}`}
                        onClick={() => setConfirmingPod(pod)}
                      >
                        <Trash2 size={13} color="var(--danger)" />
                      </button>
                      {safeNames && (
                        <>
                          {pod.status === "Running" && (
                            <button
                              className="icon-btn"
                              title={`Shell no pod (${kubeCli} exec -n ${pod.namespace} ${pod.name})`}
                              onClick={() =>
                                typeInTerminal(
                                  `${kubeCli} exec -it -n ${pod.namespace} ${pod.name} -- sh -c 'command -v bash >/dev/null && exec bash || exec sh'`,
                                )
                              }
                            >
                              <SquareTerminal size={14} />
                            </button>
                          )}
                          <button
                            className="icon-btn"
                            title={`Logs (${kubeCli} logs --tail 100 -f -n ${pod.namespace} ${pod.name})`}
                            onClick={() =>
                              typeInTerminal(
                                `${kubeCli} logs --tail 100 -f -n ${pod.namespace} ${pod.name}`,
                              )
                            }
                          >
                            <FileText size={14} />
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}

        {selectedKind && tab === "images" && (
          <>
            {!error && !loading && images.length === 0 && (
              <div className="muted" style={{ padding: 16, textAlign: "center" }}>
                Nenhuma imagem encontrada{local ? " nesta máquina" : " neste host"}.
              </div>
            )}

            {images.map((img, idx) => {
              const ref = imageRef(img);
              const inUse = isKube
                ? isKubeImageInUse(img, pods)
                : isImageInUse(img, containers);
              const repoLabel =
                img.repository === "<none>" ? "<sem repositório>" : img.repository;
              const fullTitle =
                img.tag && img.tag !== "<none>" ? `${repoLabel}:${img.tag}` : repoLabel;
              return (
                <div key={`${img.id}:${img.repository}:${img.tag}:${idx}`} className="docker__item">
                  <span
                    className="docker__dot"
                    style={{ background: inUse ? "var(--ok)" : "var(--text-faint)" }}
                    title={inUse ? "em uso" : "sem uso detectado"}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="file__name" title={fullTitle}>
                      {fullTitle}
                    </div>
                    <div className="muted" style={{ fontSize: 10 }}>
                      {img.id ? `${img.id} · ` : ""}
                      {img.size}
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

      {confirmingPod && (
        <ConfirmDialog
          title="Reiniciar / excluir pod"
          danger
          confirmLabel="Excluir pod"
          message={
            <>
              Excluir o pod <b>{confirmingPod.namespace}/{confirmingPod.name}</b>? Se ele
              pertencer a um Deployment, StatefulSet ou DaemonSet, o Kubernetes criará um
              novo pod automaticamente (reiniciando a carga). Pods avulsos são removidos.
            </>
          }
          onConfirm={() => {
            const target = confirmingPod;
            setConfirmingPod(null);
            void deletePod(target);
          }}
          onCancel={() => setConfirmingPod(null)}
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
              {(isKube
                ? isKubeImageInUse(confirmingImage, pods)
                : isImageInUse(confirmingImage, containers)) &&
                ` Há pelo menos um ${isKube ? "pod" : "container"} usando esta imagem; o runtime pode recusar a remoção enquanto ele existir.`}
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
