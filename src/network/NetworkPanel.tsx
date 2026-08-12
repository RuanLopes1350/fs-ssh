import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Network, RefreshCw } from "lucide-react";

import { Spinner } from "../components/Dialogs";
import { api, asAppError } from "../lib/ipc";
import type { NetInfo, NetInterface } from "../lib/types";

/**
 * Configuração de rede do host da sessão: IP, máscara, gateway e DNS, lidos por
 * um exec só (não passa pelo terminal do usuário).
 *
 * Cada valor é clicável e vai para a área de transferência — anotar IP à mão
 * olhando para a tela é exatamente o que este painel existe para evitar.
 */
export function NetworkPanel({
  sessionId,
  local = false,
}: {
  sessionId: string;
  /** Sessão do terminal local — muda só o texto do cabeçalho. */
  local?: boolean;
}) {
  const [info, setInfo] = useState<NetInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Interfaces sem endereço ficam escondidas: um host com Docker tem dezenas. */
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInfo(await api.netInfo(sessionId));
    } catch (e) {
      setError(asAppError(e).message);
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withAddr = (i: NetInterface) => i.ipv4.length > 0 || i.ipv6.length > 0;
  const all = info?.interfaces ?? [];
  const shown = showAll ? all : all.filter(withAddr);
  const hidden = all.length - shown.length;

  return (
    <div className="docker netinfo">
      <div className="pane__head">
        <Network size={14} />
        <span className="pane__path" style={{ direction: "ltr" }}>
          {local ? "Rede desta máquina" : "Rede do host"}
          {info?.hostname ? ` · ${info.hostname}` : ""}
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

        {info && (
          <>
            <section className="netinfo__block">
              <Row label="Gateway">
                {info.gateways.length === 0 ? (
                  <span className="muted">sem rota padrão</span>
                ) : (
                  info.gateways.map((g) => (
                    <Value key={`${g.gateway}-${g.iface}`} value={g.gateway}>
                      {g.gateway}
                      {g.iface && <span className="muted"> via {g.iface}</span>}
                    </Value>
                  ))
                )}
              </Row>

              <Row label="DNS">
                {info.dns.length === 0 ? (
                  <span className="muted">não informado</span>
                ) : (
                  info.dns.map((d) => <Value key={d} value={d} />)
                )}
              </Row>

              {info.search.length > 0 && (
                <Row label="Domínios">
                  {info.search.map((d) => (
                    <Value key={d} value={d} />
                  ))}
                </Row>
              )}
            </section>

            {shown.map((i) => (
              <section key={i.name} className="netinfo__iface">
                <div className="netinfo__iface-head">
                  <span
                    className="docker__dot"
                    style={{ background: i.up ? "var(--ok)" : "var(--text-faint)" }}
                    title={i.up ? "ativa" : "desativada"}
                  />
                  <b>{i.name}</b>
                  {i.mac && <Value value={i.mac} className="muted netinfo__mac" />}
                  {!i.up && <span className="muted">down</span>}
                </div>

                {i.ipv4.map((a) => (
                  <Row key={a.addr} label="IPv4">
                    <Value value={a.addr}>
                      {a.addr}
                      <span className="muted">/{a.prefix}</span>
                    </Value>
                    <span className="muted">máscara {a.netmask}</span>
                  </Row>
                ))}

                {i.ipv6.map((a) => (
                  <Row key={a.addr} label="IPv6">
                    <Value value={a.addr}>
                      {a.addr}
                      <span className="muted">/{a.prefix}</span>
                    </Value>
                  </Row>
                ))}

                {!withAddr(i) && <div className="muted netinfo__empty">sem endereço</div>}
              </section>
            ))}

            {all.length === 0 && (
              <div className="muted" style={{ padding: 16, textAlign: "center" }}>
                Nenhuma interface reportada por este host.
              </div>
            )}

            {(hidden > 0 || showAll) && (
              <button className="netinfo__more" onClick={() => setShowAll((v) => !v)}>
                {showAll
                  ? "Mostrar só as interfaces com endereço"
                  : `Mostrar mais ${hidden} interface${hidden > 1 ? "s" : ""} sem endereço`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="netinfo__row">
      <span className="netinfo__label">{label}</span>
      <div className="netinfo__values">{children}</div>
    </div>
  );
}

/**
 * Valor copiável. O `children` existe para o texto na tela poder ser mais rico
 * que o que vai para a área de transferência (o `/24` fica de fora do IP).
 */
function Value({
  value,
  children,
  className,
}: {
  value: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // WebView sem permissão de área de transferência: seleção manual ainda
      // funciona, então não vale um alerta na cara do usuário.
    }
  };

  return (
    <button
      className={`netinfo__value${className ? ` ${className}` : ""}`}
      title={`Copiar ${value}`}
      onClick={() => void copy()}
    >
      <span>{children ?? value}</span>
      {copied ? <Check size={11} color="var(--ok)" /> : <Copy size={11} />}
    </button>
  );
}
