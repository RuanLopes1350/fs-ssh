import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { terminals } from "./session";

/**
 * Busca no scrollback (⌘F). Flutuante sobre o terminal, sem roubar o layout.
 * Enter avança, Shift+Enter volta, Esc fecha e devolve o foco ao terminal.
 */
export function TerminalSearchBar({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const session = terminals.get(tabId);

  useEffect(() => ref.current?.focus(), []);

  // Busca incremental enquanto digita.
  useEffect(() => {
    if (!session) return;
    if (q) session.search.findNext(q, { incremental: true });
    else session.search.clearDecorations();
  }, [q, session]);

  const close = () => {
    session?.search.clearDecorations();
    session?.term.focus();
    onClose();
  };

  const next = () => q && session?.search.findNext(q);
  const prev = () => q && session?.search.findPrevious(q);

  return (
    <div className="term-search">
      <input
        ref={ref}
        value={q}
        placeholder="Buscar no terminal…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.shiftKey ? prev() : next();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <button className="icon-btn" title="Anterior (⇧Enter)" onClick={prev}>
        <ChevronUp size={13} />
      </button>
      <button className="icon-btn" title="Próximo (Enter)" onClick={next}>
        <ChevronDown size={13} />
      </button>
      <button className="icon-btn" title="Fechar (Esc)" onClick={close}>
        <X size={13} />
      </button>
    </div>
  );
}
