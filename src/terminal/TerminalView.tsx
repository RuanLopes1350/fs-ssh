import { useEffect, useRef } from "react";

import { terminals } from "./session";

/**
 * Só hospeda o terminal.
 *
 * O `TerminalSession` vive fora do React (mapa em `terminals`), e este
 * componente apenas anexa/desanexa o DOM. Sem isso, cada re-render do React
 * recriaria o xterm e apagaria o scrollback.
 */
export function TerminalView({ tabId, visible }: { tabId: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const session = terminals.get(tabId);
    const host = ref.current;
    if (!session || !host || !visible) return;
    session.attach(host);
    return () => session.detach();
  }, [tabId, visible]);

  return (
    <div
      className="terminal-host"
      ref={ref}
      style={{ display: visible ? "block" : "none" }}
    />
  );
}
