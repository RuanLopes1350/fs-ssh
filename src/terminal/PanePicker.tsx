import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { ConnIcon } from "../components/Icon";
import { LOCAL_CONNECTION, WSL_CONNECTION, useAppStore } from "../store/useAppStore";
import type { Connection } from "../lib/types";

/**
 * Seletor dentro de um painel recém-dividido: escolha o servidor que abre ali.
 *
 * A conexão da sessão de origem vem pré-selecionada — ⌘D + Enter duplica a
 * sessão atual em dois toques; digitar filtra para abrir qualquer outra.
 * Esc cancela e desfaz o split.
 */
export function PanePicker({
  connections,
  currentId,
  onChoose,
  onCancel,
}: {
  connections: Connection[];
  /** Conexão do painel de origem — aparece primeiro, marcada. */
  currentId: string | null;
  onChoose: (c: Connection) => void;
  onCancel: () => void;
}) {
  const wslDistros = useAppStore((s) => s.wslDistros);
  const wslAvailable = useAppStore((s) => s.wslAvailable);
  const wslShell = useAppStore((s) => s.settings.wslShell);
  const showWslPref = useAppStore((s) => s.settings.showWslInSidebar !== false);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const match = (c: Connection) =>
      !query ||
      c.name.toLowerCase().includes(query) ||
      c.host.toLowerCase().includes(query) ||
      c.username.toLowerCase().includes(query);
    const wslEntries = !showWslPref
      ? []
      : wslDistros.length > 0
        ? wslShell.trim()
          ? [WSL_CONNECTION, ...wslDistros]
          : wslDistros
        : wslAvailable || wslShell.trim()
          ? [WSL_CONNECTION]
          : [];
    const list = [LOCAL_CONNECTION, ...wslEntries, ...connections].filter(match);
    // Sessão de origem primeiro: Enter direto = duplicar.
    return [...list].sort((a, b) =>
      a.id === currentId ? -1 : b.id === currentId ? 1 : 0,
    );
  }, [q, connections, wslDistros, currentId, showWslPref, wslShell, wslAvailable]);

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
      if (item) onChoose(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="pane-picker">
      <div className="pane-picker__box">
        <div className="pane-picker__head">
          <Search size={13} color="var(--text-faint)" />
          <input
            ref={inputRef}
            value={q}
            placeholder="Abrir neste painel…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="icon-btn" title="Cancelar (Esc)" onClick={onCancel}>
            <X size={13} />
          </button>
        </div>
        <div className="pane-picker__list">
          {items.map((c, i) => (
            <button
              key={c.id}
              className="palette__item"
              data-active={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onChoose(c)}
            >
              <ConnIcon name={c.icon} color={c.color} />
              <span style={{ flex: 1, textAlign: "left" }}>
                {c.name}
                <span className="muted">
                  {" "}
                  {c.username ? `${c.username}@${c.host}` : c.host}
                </span>
              </span>
              {c.id === currentId && <span className="pane-picker__tag">sessão atual</span>}
              {c.isProduction && <span className="prod-badge">PROD</span>}
            </button>
          ))}
          {items.length === 0 && (
            <div className="palette__item muted">Nada encontrado</div>
          )}
        </div>
        <div className="palette__hint">
          <span className="kbd">↵</span> conectar
          <span className="kbd" style={{ marginLeft: 10 }}>
            Esc
          </span>{" "}
          cancelar o split
        </div>
      </div>
    </div>
  );
}
