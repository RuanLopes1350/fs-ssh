import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Cable,
  FileText,
  Gauge,
  Package,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Skull,
  Square,
  Zap,
} from "lucide-react";

import { ConfirmDialog, Spinner } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import type { SysOverview, SysPort, SysProcess, SysService, SysUpdates } from "../lib/types";

const encoder = new TextEncoder();

type Tab = "resumo" | "servicos" | "processos" | "portas" | "updates" | "log";

const TABS: { id: Tab; label: string; icon: typeof Gauge }[] = [
  { id: "resumo", label: "Resumo", icon: Gauge },
  { id: "servicos", label: "Serviços", icon: Activity },
  { id: "processos", label: "Processos", icon: Zap },
  { id: "portas", label: "Portas", icon: Cable },
  { id: "updates", label: "Updates", icon: Package },
  { id: "log", label: "Log", icon: ScrollText },
];

/** Atualização do resumo enquanto a aba está aberta. */
const OVERVIEW_INTERVAL = 5000;
/** Releitura do fim do arquivo quando "seguir" está ligado. */
const TAIL_INTERVAL = 2000;

/**
 * Observabilidade do host da sessão: carga, memória, disco, serviços,
 * processos, portas e cauda de arquivo — tudo pelo canal exec, sem instalar
 * nada no servidor e sem ocupar o terminal do usuário.
 */
export function SystemPanel({
  sessionId,
  connectionId,
  local = false,
}: {
  sessionId: string;
  connectionId: string;
  /** Sessão do terminal local — esconde o que só faz sentido via SSH. */
  local?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("resumo");

  return (
    <div className="docker sysinfo">
      <div className="pane__head">
        <Gauge size={14} />
        <span className="pane__path" style={{ direction: "ltr" }}>
          {local ? "Sistema desta máquina" : "Sistema deste host"}
        </span>
      </div>

      <div className="sysinfo__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className="sysinfo__tab"
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            <t.icon size={12} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "resumo" && <OverviewTab sessionId={sessionId} />}
      {tab === "servicos" && <ServicesTab sessionId={sessionId} />}
      {tab === "processos" && <ProcessesTab sessionId={sessionId} />}
      {tab === "portas" && (
        <PortsTab sessionId={sessionId} connectionId={connectionId} local={local} />
      )}
      {tab === "updates" && <UpdatesTab sessionId={sessionId} />}
      {tab === "log" && <LogTab sessionId={sessionId} />}
    </div>
  );
}

/** Carrega uma consulta e devolve estado + recarga, que toda aba repete. */
function useQuery<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(asAppError(e).message);
      setData(null);
    } finally {
      setLoading(false);
    }
    // `load` é recriada a cada render; as deps de verdade são as do chamador.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}

function TabHead({
  loading,
  onRefresh,
  children,
}: {
  loading: boolean;
  onRefresh: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="sysinfo__bar">
      {children}
      {loading && <Spinner />}
      <button className="icon-btn" title="Recarregar" onClick={onRefresh}>
        <RefreshCw size={13} />
      </button>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="alert alert--warn" style={{ margin: 8, fontSize: 11 }}>
      {message}
    </div>
  );
}

// -------------------------------------------------------------------- resumo

function OverviewTab({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refresh } = useQuery<SysOverview>(
    () => api.sysOverview(sessionId),
    [sessionId],
  );

  // Enquanto a aba está aberta o retrato se atualiza sozinho: carga e memória
  // só dizem algo se forem de agora.
  useEffect(() => {
    const id = window.setInterval(() => void refresh(), OVERVIEW_INTERVAL);
    return () => window.clearInterval(id);
  }, [refresh]);

  return (
    <>
      <TabHead loading={loading} onRefresh={() => void refresh()} />
      <div className="docker__list">
        {error && <ErrorBox message={error} />}
        {data && (
          <>
            <section className="sysinfo__block">
              <Field label="Sistema" value={data.os} />
              <Field label="Kernel" value={data.kernel} />
              <Field label="Ligado há" value={humanUptime(data.uptimeSecs)} />
              {data.load.length === 3 && (
                <Field
                  label="Carga"
                  value={`${data.load.map((l) => l.toFixed(2)).join("  ")}${
                    data.cpuCount ? `   (${data.cpuCount} núcleos)` : ""
                  }`}
                  warn={data.cpuCount > 0 && data.load[0] > data.cpuCount}
                />
              )}
            </section>

            <section className="sysinfo__block">
              {data.cpuPercent != null && (
                <Meter label="CPU" percent={data.cpuPercent} detail={`${data.cpuPercent.toFixed(0)}%`} />
              )}
              <Meter
                label="Memória"
                percent={pct(data.memUsed, data.memTotal)}
                detail={`${humanSize(data.memUsed)} / ${humanSize(data.memTotal)}`}
              />
              {data.swapTotal > 0 && (
                <Meter
                  label="Swap"
                  percent={pct(data.swapUsed, data.swapTotal)}
                  detail={`${humanSize(data.swapUsed)} / ${humanSize(data.swapTotal)}`}
                />
              )}
            </section>

            <section className="sysinfo__block">
              {data.disks.length === 0 && <span className="muted">Nenhum disco reportado.</span>}
              {data.disks.map((d) => (
                <Meter
                  key={d.mount}
                  label={d.mount}
                  percent={d.percent}
                  detail={`${humanSize(d.used)} / ${humanSize(d.total)}`}
                  title={d.filesystem}
                />
              ))}
            </section>
          </>
        )}
      </div>
    </>
  );
}

function Field({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="netinfo__row">
      <span className="netinfo__label">{label}</span>
      <span style={{ fontSize: 12, color: warn ? "var(--warn)" : undefined }}>{value}</span>
    </div>
  );
}

/** Barra de uso. Amarela a partir de 75%, vermelha a partir de 90%. */
function Meter({
  label,
  percent,
  detail,
  title,
}: {
  label: string;
  percent: number;
  detail: string;
  title?: string;
}) {
  const color = percent >= 90 ? "var(--danger)" : percent >= 75 ? "var(--warn)" : "var(--ok)";
  return (
    <div className="sysinfo__meter" title={title}>
      <div className="sysinfo__meter-head">
        <span className="file__name">{label}</span>
        <span className="muted">{detail}</span>
      </div>
      <div className="progress">
        <div style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: color }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ serviços

const SERVICE_ACTIONS = { start: "Iniciar", stop: "Parar", restart: "Reiniciar" } as const;
type ServiceAction = keyof typeof SERVICE_ACTIONS;

function ServicesTab({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refresh } = useQuery<SysService[]>(
    () => api.sysServices(sessionId),
    [sessionId],
  );
  const [filter, setFilter] = useState("");
  const [onlyProblem, setOnlyProblem] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ action: ServiceAction; unit: SysService } | null>(
    null,
  );

  const shown = (data ?? []).filter(
    (s) =>
      (!onlyProblem || s.active === "failed" || s.active === "activating") &&
      (filter === "" ||
        s.unit.toLowerCase().includes(filter.toLowerCase()) ||
        s.description.toLowerCase().includes(filter.toLowerCase())),
  );
  const failed = (data ?? []).filter((s) => s.active === "failed").length;

  const run = async (action: ServiceAction, unit: string) => {
    setBusy(unit);
    setActionError(null);
    try {
      await api.sysServiceAction(sessionId, action, unit);
      await refresh();
    } catch (e) {
      setActionError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TabHead loading={loading} onRefresh={() => void refresh()}>
        <input
          className="sysinfo__filter"
          placeholder="Filtrar serviços"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="icon-btn"
          data-active={onlyProblem}
          title={failed > 0 ? `${failed} com falha — mostrar só esses` : "Mostrar só o que falhou"}
          onClick={() => setOnlyProblem((v) => !v)}
        >
          <span style={{ fontSize: 11, color: failed > 0 ? "var(--danger)" : undefined }}>
            {failed > 0 ? `⚠ ${failed}` : "⚠"}
          </span>
        </button>
      </TabHead>

      <div className="docker__list">
        {error && <ErrorBox message={error} />}
        {actionError && <ErrorBox message={actionError} />}
        {!error && !loading && shown.length === 0 && (
          <div className="muted" style={{ padding: 16, textAlign: "center" }}>
            Nenhum serviço encontrado.
          </div>
        )}

        {shown.map((s) => (
          <div key={s.unit} className="docker__item">
            <span
              className="docker__dot"
              style={{ background: serviceColor(s) }}
              title={`${s.active} · ${s.sub}`}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="file__name" title={s.unit}>
                {s.unit.replace(/\.service$/, "")}
              </div>
              <div className="muted" style={{ fontSize: 10 }} title={s.description}>
                {s.active} · {s.sub}
                {s.enabled ? " · habilitado no boot" : ""}
              </div>
            </div>

            {busy === s.unit ? (
              <Spinner />
            ) : (
              <>
                {s.active === "active" ? (
                  <>
                    <button
                      className="icon-btn"
                      title={`Parar ${s.unit}`}
                      onClick={() => setConfirming({ action: "stop", unit: s })}
                    >
                      <Square size={13} />
                    </button>
                    <button
                      className="icon-btn"
                      title={`Reiniciar ${s.unit}`}
                      onClick={() => setConfirming({ action: "restart", unit: s })}
                    >
                      <RotateCw size={13} />
                    </button>
                  </>
                ) : (
                  <button
                    className="icon-btn"
                    title={`Iniciar ${s.unit}`}
                    onClick={() => void run("start", s.unit)}
                  >
                    <Play size={13} color="var(--ok)" />
                  </button>
                )}
                <button
                  className="icon-btn"
                  title={`Logs (journalctl -u ${s.unit} -n 100 -f)`}
                  onClick={() => typeInTerminal(sessionId, `journalctl -u ${s.unit} -n 100 -f`)}
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
          title={`${SERVICE_ACTIONS[confirming.action]} serviço`}
          danger
          confirmLabel={SERVICE_ACTIONS[confirming.action]}
          message={
            <>
              {confirming.action === "stop" ? "Parar" : "Reiniciar"}{" "}
              <b>{confirming.unit.unit}</b> neste host? O serviço fica indisponível
              {confirming.action === "restart" ? " durante o reinício." : "."}
            </>
          }
          onConfirm={() => {
            const { action, unit } = confirming;
            setConfirming(null);
            void run(action, unit.unit);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

function serviceColor(s: SysService) {
  if (s.active === "failed") return "var(--danger)";
  if (s.active === "active") return "var(--ok)";
  if (s.active === "activating" || s.active === "deactivating") return "var(--warn)";
  return "var(--text-faint)";
}

// ----------------------------------------------------------------- processos

function ProcessesTab({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refresh } = useQuery<SysProcess[]>(
    () => api.sysProcesses(sessionId),
    [sessionId],
  );
  const [filter, setFilter] = useState("");
  const [killing, setKilling] = useState<{ proc: SysProcess; force: boolean } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const shown = (data ?? []).filter(
    (p) =>
      filter === "" ||
      p.command.toLowerCase().includes(filter.toLowerCase()) ||
      p.user.toLowerCase().includes(filter.toLowerCase()) ||
      String(p.pid) === filter,
  );

  const kill = async (proc: SysProcess, force: boolean) => {
    setActionError(null);
    try {
      await api.sysKill(sessionId, proc.pid, force ? "kill" : "term");
      await refresh();
    } catch (e) {
      setActionError(asAppError(e).message);
    }
  };

  return (
    <>
      <TabHead loading={loading} onRefresh={() => void refresh()}>
        <input
          className="sysinfo__filter"
          placeholder="Filtrar por comando, usuário ou pid"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </TabHead>

      <div className="docker__list">
        {error && <ErrorBox message={error} />}
        {actionError && <ErrorBox message={actionError} />}

        {shown.map((p) => (
          <div key={p.pid} className="docker__item">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="file__name" title={p.command}>
                {p.command}
              </div>
              <div className="muted" style={{ fontSize: 10 }}>
                pid {p.pid} · {p.user} · cpu {p.cpu.toFixed(1)}% · mem {p.mem.toFixed(1)}% ·{" "}
                {p.elapsed}
              </div>
            </div>
            <button
              className="icon-btn"
              title={`Encerrar (SIGTERM) o pid ${p.pid}`}
              onClick={() => setKilling({ proc: p, force: false })}
            >
              <Square size={13} />
            </button>
            <button
              className="icon-btn"
              title={`Matar (SIGKILL) o pid ${p.pid}`}
              onClick={() => setKilling({ proc: p, force: true })}
            >
              <Skull size={13} color="var(--danger)" />
            </button>
          </div>
        ))}
      </div>

      {killing && (
        <ConfirmDialog
          title={killing.force ? "Matar processo" : "Encerrar processo"}
          danger
          confirmLabel={killing.force ? "Matar" : "Encerrar"}
          message={
            <>
              Enviar <b>{killing.force ? "SIGKILL" : "SIGTERM"}</b> ao pid{" "}
              <b>{killing.proc.pid}</b> ({killing.proc.command.slice(0, 80)})?
              {killing.force && " SIGKILL não dá ao processo chance de salvar nada."}
            </>
          }
          onConfirm={() => {
            const { proc, force } = killing;
            setKilling(null);
            void kill(proc, force);
          }}
          onCancel={() => setKilling(null)}
        />
      )}
    </>
  );
}

// -------------------------------------------------------------------- portas

function PortsTab({
  sessionId,
  connectionId,
  local,
}: {
  sessionId: string;
  connectionId: string;
  local: boolean;
}) {
  const { data, loading, error, refresh } = useQuery<SysPort[]>(
    () => api.sysPorts(sessionId),
    [sessionId],
  );
  const [note, setNote] = useState<string | null>(null);

  /** Cria e liga um túnel -L para a porta escutada, sem sair do painel. */
  const tunnel = async (p: SysPort) => {
    setNote(null);
    try {
      const forward = {
        id: crypto.randomUUID(),
        connectionId,
        kind: "local" as const,
        label: p.process || `porta ${p.port}`,
        bindAddr: "127.0.0.1",
        localPort: p.port,
        remoteHost: "localhost",
        remotePort: p.port,
        autoStart: false,
      };
      await api.forwardSave(forward);
      await api.forwardStart(sessionId, forward.id);
      setNote(`Túnel ligado: 127.0.0.1:${p.port} → localhost:${p.port} no servidor.`);
    } catch (e) {
      setNote(asAppError(e).message);
    }
  };

  return (
    <>
      <TabHead loading={loading} onRefresh={() => void refresh()} />
      <div className="docker__list">
        {error && <ErrorBox message={error} />}
        {note && (
          <div className="alert" style={{ margin: 8, fontSize: 11 }}>
            {note}
          </div>
        )}
        {!error && !loading && (data ?? []).length === 0 && (
          <div className="muted" style={{ padding: 16, textAlign: "center" }}>
            Nenhuma porta em escuta.
          </div>
        )}

        {(data ?? []).map((p) => (
          <div key={`${p.proto}-${p.address}-${p.port}`} className="docker__item">
            <span className="sysinfo__port">{p.port}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="file__name">{p.process || "processo desconhecido"}</div>
              <div className="muted" style={{ fontSize: 10 }}>
                {p.proto} · {p.address}
                {p.pid != null ? ` · pid ${p.pid}` : ""}
              </div>
            </div>
            {!local && p.proto === "tcp" && (
              <button
                className="icon-btn"
                title={`Criar e ligar um túnel local para a porta ${p.port}`}
                onClick={() => void tunnel(p)}
              >
                <Cable size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// --------------------------------------------------------------- atualizações

function UpdatesTab({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refresh } = useQuery<SysUpdates>(
    () => api.sysUpdates(sessionId),
    [sessionId],
  );

  return (
    <>
      <TabHead loading={loading} onRefresh={() => void refresh()} />
      <div className="docker__list">
        {error && <ErrorBox message={error} />}
        {data && (
          <>
            <section className="sysinfo__block">
              <Field label="Gerente" value={data.manager} />
              <Field
                label="Pendentes"
                value={
                  data.packages.length === 0
                    ? "nenhuma atualização"
                    : `${data.packages.length} pacote${data.packages.length > 1 ? "s" : ""}`
                }
                warn={data.packages.length > 0}
              />
              {data.rebootRequired && (
                <div className="alert alert--warn" style={{ fontSize: 11 }}>
                  Este host precisa de reboot para concluir uma atualização.
                </div>
              )}
            </section>

            {data.packages.map((p) => (
              <div key={p} className="docker__item">
                <span className="file__name" title={p} style={{ fontSize: 11 }}>
                  {p}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

// ----------------------------------------------------------------------- log

const LOG_SUGGESTIONS = ["/var/log/syslog", "/var/log/messages", "/var/log/nginx/error.log"];

function LogTab({ sessionId }: { sessionId: string }) {
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState(200);
  const [follow, setFollow] = useState(true);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);

  const read = useCallback(async () => {
    if (!path.trim()) return;
    setLoading(true);
    try {
      setText(await api.sysTail(sessionId, path, lines, filter));
      setError(null);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, path, lines, filter]);

  // "Seguir" é poll: relê o fim do arquivo em intervalo fixo. Um `tail -f` de
  // verdade prenderia um canal por painel aberto e não sobreviveria a reconexão.
  useEffect(() => {
    if (!follow || !path.trim()) return;
    const id = window.setInterval(() => void read(), TAIL_INTERVAL);
    return () => window.clearInterval(id);
  }, [follow, path, read]);

  // Rolagem colada no fim: log novo aparece sem precisar arrastar a barra.
  useEffect(() => {
    const box = boxRef.current;
    if (box && follow) box.scrollTop = box.scrollHeight;
  }, [text, follow]);

  return (
    <>
      <div className="sysinfo__bar">
        <input
          className="sysinfo__filter"
          placeholder="/var/log/syslog"
          value={path}
          list="sysinfo-log-paths"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void read()}
        />
        <datalist id="sysinfo-log-paths">
          {LOG_SUGGESTIONS.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        {loading && <Spinner />}
        <button className="icon-btn" title="Ler agora" onClick={() => void read()}>
          <RefreshCw size={13} />
        </button>
        <button
          className="icon-btn"
          data-active={follow}
          title={follow ? "Seguindo o arquivo — clique para pausar" : "Seguir o arquivo"}
          onClick={() => setFollow((v) => !v)}
        >
          {follow ? <Square size={13} /> : <Play size={13} />}
        </button>
      </div>

      <div className="sysinfo__bar">
        <input
          className="sysinfo__filter"
          placeholder="Filtrar (texto literal, como grep -F)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void read()}
        />
        <select
          className="sysinfo__lines"
          value={lines}
          onChange={(e) => setLines(Number(e.target.value))}
          title="Linhas lidas do fim do arquivo"
        >
          {[100, 200, 500, 1000, 2000].map((n) => (
            <option key={n} value={n}>
              {n} linhas
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBox message={error} />}
      <pre className="sysinfo__log" ref={boxRef}>
        {text || (path ? "" : "Informe o caminho de um arquivo do host.")}
      </pre>
    </>
  );
}

// -------------------------------------------------------------------- helpers

function typeInTerminal(sessionId: string, command: string) {
  void api.sshWrite(sessionId, Array.from(encoder.encode(`${command}\n`))).catch(() => {});
}

function pct(used: number, total: number) {
  return total > 0 ? (used / total) * 100 : 0;
}

function humanUptime(secs: number) {
  if (secs <= 0) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d} dia${d > 1 ? "s" : ""}, ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

function humanSize(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
