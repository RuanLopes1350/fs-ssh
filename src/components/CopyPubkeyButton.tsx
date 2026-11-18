import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { api, asAppError } from "../lib/ipc";
import type { RemotePubkey } from "../lib/types";

/**
 * Copia a chave pública do `~/.ssh` do host da sessão — o caso clássico é
 * colar no GitHub como deploy key sem abrir o terminal e dar `cat`.
 *
 * Com uma chave só, o clique já copia. Com várias, abre um menu para escolher;
 * sem nenhuma (ou com erro), o mesmo menu explica o porquê.
 */
export function CopyPubkeyButton({
  sessionId,
  local = false,
}: {
  sessionId: string | null | undefined;
  /** Sessão do terminal local — muda só os textos. */
  local?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<{ position: MenuPosition; items: MenuItem[] } | null>(
    null,
  );
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Pelo plugin, não por `navigator.clipboard`: o WKWebView só aceita escrita
  // na área de transferência durante o gesto do clique, e aqui ela acontece
  // depois de esperar o exec no host — o WebKit recusaria sem avisar.
  const copy = async (key: RemotePubkey) => {
    await writeText(key.pubkey);
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const run = async (anchor: HTMLElement) => {
    if (!sessionId) return;
    const r = anchor.getBoundingClientRect();
    const position = { x: r.left, y: r.bottom + 4 };
    const info = (label: string): MenuItem => ({ label, disabled: true, onSelect: () => {} });

    setLoading(true);
    try {
      const keys = await api.keysRemoteList(sessionId);
      if (keys.length === 1) {
        await copy(keys[0]);
      } else if (keys.length === 0) {
        setMenu({
          position,
          items: [
            info(`Nenhuma chave pública em ~/.ssh ${local ? "desta máquina" : "deste host"}.`),
            info("Gere uma com: ssh-keygen -t ed25519"),
          ],
        });
      } else {
        setMenu({
          position,
          items: keys.map((k) => ({
            label: `${k.path.split(/[/\\]/).pop()} · ${k.keyType}${k.comment ? ` · ${k.comment}` : ""}`,
            icon: <Copy size={12} />,
            onSelect: () =>
              void copy(k).catch((e) =>
                setMenu({ position, items: [info(`Não deu para copiar: ${asAppError(e).message}`)] }),
              ),
          })),
        });
      }
    } catch (e) {
      setMenu({ position, items: [info(asAppError(e).message)] });
    } finally {
      setLoading(false);
    }
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <>
      <button
        className="icon-btn"
        aria-label="Copiar chave pública do host"
        disabled={!sessionId || loading}
        title={
          copied
            ? "Chave pública copiada"
            : local
              ? "Copiar a chave pública desta máquina (~/.ssh/*.pub)"
              : "Copiar a chave pública deste host (~/.ssh/*.pub)"
        }
        onClick={(e) => void run(e.currentTarget)}
      >
        {copied ? <Check size={14} color="var(--ok)" /> : <KeyRound size={14} />}
      </button>
      {menu && <ContextMenu position={menu.position} items={menu.items} onClose={closeMenu} />}
    </>
  );
}
