import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Server, TerminalSquare } from "lucide-react";

import { ConnIcon } from "./Icon";
import { LOCAL_CONNECTION, WSL_CONNECTION, useAppStore } from "../store/useAppStore";
import type { Connection, Snippet } from "../lib/types";

export type PaletteAction =
  | { type: "connect"; connection: Connection }
  | { type: "snippet"; snippet: Snippet };

/**
 * Paleta ⌘K.
 *
 * Faz duas coisas: conectar a um servidor (Enter = nova aba, ⌘Enter = split no
 * painel ativo) e disparar um snippet na aba ativa. Snippets só aparecem quando
 * há sessão aberta, porque sem terminal não há para onde mandar o comando.
 */
export function CommandPalette({
  hasSession,
  canSplit,
  only,
  onRun,
  onClose,
}: {
  hasSession: boolean;
  /** Há uma aba ativa que pode receber um split. */
  canSplit: boolean;
  /** Restringe a paleta a um tipo (o botão de snippets abre assim). */
  only?: "snippets";
  onRun: (action: PaletteAction, split: boolean) => void;
  onClose: () => void;
}) {
  const connections = useAppStore((s) => s.connections);
  const snippets = useAppStore((s) => s.snippets);
  const showWsl = useAppStore(
    (s) =>
      (s.wslAvailable && s.settings.showWslInSidebar !== false) ||
      s.settings.wslShell.trim() !== "",
  );
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const match = (s: string) => s.toLowerCase().includes(query);

    const baseConns = showWsl ? [LOCAL_CONNECTION, WSL_CONNECTION] : [LOCAL_CONNECTION];
    const conns: PaletteAction[] =
      only === "snippets"
        ? []
        : // O terminal local (e o WSL quando disponível) entram na lista como qualquer servidor.
          [...baseConns, ...connections]
            .filter((c) => !query || match(c.name) || match(c.host) || match(c.username))
            .slice(0, 20)
            .map((connection) => ({ type: "connect", connection }));

    const snips: PaletteAction[] = hasSession
      ? snippets
          .filter((s) => !query || match(s.name) || match(s.body))
          .slice(0, only === "snippets" ? 50 : 10)
          .map((snippet) => ({ type: "snippet", snippet }))
      : [];

    return [...conns, ...snips];
  }, [q, connections, snippets, hasSession, only, showWsl]);

  useEffect(() => setIndex(0), [q]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[index];
      if (item) onRun(item, e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className="palette-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            only === "snippets"
              ? "Rodar um snippet no terminal ativo…"
              : "Conectar a… ou rodar um snippet"
          }
        />
        <div className="palette__list">
          {items.map((item, i) => (
            <button
              key={item.type === "connect" ? item.connection.id : item.snippet.id}
              className="palette__item"
              data-active={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={(e) => onRun(item, e.metaKey || e.ctrlKey)}
            >
              {item.type === "connect" ? (
                <>
                  <ConnIcon name={item.connection.icon} color={item.connection.color} />
                  <span style={{ flex: 1 }}>
                    {item.connection.name}
                    <span className="muted">
                      {" "}
                      {item.connection.username
                        ? `${item.connection.username}@${item.connection.host}`
                        : item.connection.host}
                    </span>
                  </span>
                  {item.connection.isProduction && <span className="prod-badge">PROD</span>}
                </>
              ) : (
                <>
                  <TerminalSquare size={15} color="var(--text-dim)" />
                  <span style={{ flex: 1 }}>
                    {item.snippet.name}
                    <span className="muted"> {item.snippet.body.slice(0, 48)}</span>
                  </span>
                </>
              )}
              {i === index && <CornerDownLeft size={12} className="muted" />}
            </button>
          ))}
          {items.length === 0 && (
            <div className="palette__item muted">
              <Server size={15} />
              {only === "snippets" && !hasSession
                ? "Abra uma sessão para rodar snippets"
                : only === "snippets"
                  ? "Nenhum snippet — crie em ⚙ → Snippets"
                  : "Nada encontrado"}
            </div>
          )}
        </div>
        {canSplit && (
          <div className="palette__hint">
            <span className="kbd">↵</span> nova aba
            <span className="kbd" style={{ marginLeft: 10 }}>
              ⌘↵
            </span>{" "}
            split no painel ativo
          </div>
        )}
      </div>
    </div>
  );
}
