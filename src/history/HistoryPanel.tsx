import { useMemo, useState } from "react";
import {
  BookmarkPlus,
  CornerDownLeft,
  Globe,
  History,
  Play,
  Server,
  Trash2,
} from "lucide-react";

import { ConfirmDialog } from "../components/Dialogs";
import { api } from "../lib/ipc";
import { useAppStore, type CommandEntry } from "../store/useAppStore";

const encoder = new TextEncoder();

/**
 * Histórico dos comandos digitados no terminal, do mais recente para o mais
 * antigo — a mesma ordem do `history` do shell.
 *
 * As linhas são capturadas no terminal (veja `TerminalSession.commitLine`): o
 * que foi digitado vem do teclado, o que veio do ↑ ou do ⇥ é lido da tela. Só
 * entra o que o servidor ecoou, e é isso que mantém senha fora daqui.
 *
 * Clicar roda de novo na sessão ativa. Como o comando pode ser destrutivo, em
 * painel de produção há confirmação, e o ⏎ ao lado escreve sem executar para
 * quem quer revisar antes.
 */
export function HistoryPanel({
  sessionId,
  connectionId,
  connectionName,
  isProduction,
}: {
  sessionId: string;
  connectionId: string;
  connectionName: string;
  /** Painel ativo é de produção: reexecutar pede confirmação. */
  isProduction: boolean;
}) {
  const history = useAppStore((s) => s.history);
  const recording = useAppStore((s) => s.settings.recordHistory);
  const [q, setQ] = useState("");
  /** Mostrar só o histórico deste servidor (o normal) ou o de todos. */
  const [onlyThis, setOnlyThis] = useState(true);
  const [confirming, setConfirming] = useState<CommandEntry | null>(null);
  const [clearing, setClearing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    return history.filter(
      (h) =>
        (!onlyThis || h.connectionId === connectionId) &&
        (!query || h.command.toLowerCase().includes(query)),
    );
  }, [history, q, onlyThis, connectionId]);

  /** Escreve no terminal; com `\n` o shell executa, sem ele fica para editar. */
  const type = (command: string, run: boolean) => {
    void api
      .sshWrite(sessionId, Array.from(encoder.encode(run ? `${command}\n` : command)))
      .catch(() => {});
  };

  const request = (entry: CommandEntry) => {
    if (isProduction) setConfirming(entry);
    else type(entry.command, true);
  };

  /** Comando bom vira snippet — o histórico é volátil, o snippet não. */
  const saveSnippet = (entry: CommandEntry) => {
    void (async () => {
      try {
        await api.snippetSave({
          name: entry.command.length > 40 ? `${entry.command.slice(0, 40)}…` : entry.command,
          body: entry.command,
          tagScope: null,
        });
        useAppStore.setState({ snippets: await api.snippetList() });
        setSaved(entry.id);
        window.setTimeout(() => setSaved(null), 1500);
      } catch {
        // Snippet duplicado ou banco ocupado: o histórico continua ali.
      }
    })();
  };

  return (
    <div className="docker history">
      <div className="pane__head">
        <History size={14} />
        <span className="pane__path" style={{ direction: "ltr" }}>
          Histórico de comandos
        </span>
        <button
          className="icon-btn"
          data-active={!onlyThis}
          title={
            onlyThis
              ? `Mostrando só ${connectionName} — clique para ver todos os servidores`
              : "Mostrando todos os servidores — clique para ver só este"
          }
          onClick={() => setOnlyThis((v) => !v)}
        >
          {onlyThis ? <Server size={14} /> : <Globe size={14} />}
        </button>
        <button
          className="icon-btn"
          title="Limpar o histórico"
          disabled={history.length === 0}
          onClick={() => setClearing(true)}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="history__search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtrar comandos…"
        />
      </div>

      <div className="docker__list">
        {!recording && (
          <div className="alert alert--warn" style={{ margin: 8, fontSize: 11 }}>
            O registro de comandos está desligado em ⚙ Configurações. O que já foi
            guardado continua aqui.
          </div>
        )}

        {items.length === 0 && (
          <div className="muted" style={{ padding: 16, textAlign: "center", fontSize: 12 }}>
            {history.length === 0
              ? "Nada ainda. Os comandos que você digitar no terminal aparecem aqui."
              : q
                ? "Nenhum comando com esse texto."
                : `Nenhum comando em ${connectionName} — o ícone acima mostra os outros servidores.`}
          </div>
        )}

        {items.map((h) => (
          <div key={h.id} className="docker__item history__item">
            <button
              className="history__cmd"
              title={`${h.command}\n\nClique para rodar em ${connectionName}`}
              onClick={() => request(h)}
            >
              <span className="history__text">{h.command}</span>
              <span className="muted history__meta">
                {!onlyThis && `${h.connectionName} · `}
                {shortWhen(h.at)}
              </span>
            </button>

            <button
              className="icon-btn"
              title="Rodar agora na sessão ativa"
              onClick={() => request(h)}
            >
              <Play size={13} color="var(--ok)" />
            </button>
            <button
              className="icon-btn"
              title="Escrever no terminal sem executar (para editar antes)"
              onClick={() => type(h.command, false)}
            >
              <CornerDownLeft size={13} />
            </button>
            <button
              className="icon-btn"
              title={saved === h.id ? "Salvo nos snippets" : "Salvar como snippet"}
              style={saved === h.id ? { color: "var(--ok)" } : undefined}
              onClick={() => saveSnippet(h)}
            >
              <BookmarkPlus size={13} />
            </button>
            <button
              className="icon-btn"
              title="Remover do histórico"
              onClick={() => useAppStore.getState().removeCommand(h.id)}
            >
              <Trash2 size={13} color="var(--danger)" />
            </button>
          </div>
        ))}
      </div>

      {confirming && (
        <ConfirmDialog
          title="Rodar comando em produção"
          danger
          confirmLabel="Rodar"
          message={
            <>
              O painel ativo é <b>{connectionName}</b>, marcado como produção. O comando
              abaixo será executado lá:
              <div className="history__preview">{confirming.command}</div>
            </>
          }
          onConfirm={() => {
            const entry = confirming;
            setConfirming(null);
            type(entry.command, true);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {clearing && (
        <ConfirmDialog
          title="Limpar histórico"
          danger
          confirmLabel={onlyThis ? `Limpar (${connectionName})` : "Limpar tudo"}
          message={
            onlyThis ? (
              <>
                Apagar os comandos guardados de <b>{connectionName}</b>? Os outros
                servidores continuam.
              </>
            ) : (
              <>Apagar o histórico de comandos de todos os servidores?</>
            )
          }
          onConfirm={() => {
            setClearing(false);
            useAppStore.getState().clearHistory(onlyThis ? connectionId : undefined);
          }}
          onCancel={() => setClearing(false)}
        />
      )}
    </div>
  );
}

/** Hora para hoje, dia/mês no resto do ano, mês/ano para o antigo. */
function shortWhen(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  }
  return d.toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
}
