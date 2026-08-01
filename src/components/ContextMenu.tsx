import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * Menu de contexto.
 *
 * Renderiza em portal no `<body>`: dentro da sidebar ele seria recortado pelo
 * `overflow-y: auto` da lista e ficaria abaixo de qualquer ancestral que crie
 * contexto de empilhamento (o `filter` do hover da linha, por exemplo).
 */
export function ContextMenu({
  position,
  items,
  onClose,
}: {
  position: MenuPosition;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);

  // Corrige a posição se o menu estourar a janela — abrir para fora da tela é o
  // modo clássico de um menu de contexto ficar inalcançável perto da borda.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      x: Math.max(margin, Math.min(position.x, window.innerWidth - r.width - margin)),
      y: Math.max(margin, Math.min(position.y, window.innerHeight - r.height - margin)),
    });
  }, [position]);

  useEffect(() => {
    // O listener roda na fase de captura, antes de o evento chegar ao botão.
    // Sem ignorar cliques dentro do menu, o `mousedown` do clique esquerdo
    // desmontaria o item antes do `click` — e nenhuma ação seria executada.
    const close = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();

    // Registra no próximo tick: o `mousedown` do botão direito que abriu este
    // menu ainda está sendo despachado, e um listener registrado agora o
    // receberia e fecharia o menu antes de ele aparecer.
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", close, true);
      window.addEventListener("contextmenu", close, true);
      window.addEventListener("resize", close);
      window.addEventListener("wheel", close, { capture: true, passive: true });
    }, 0);

    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="ctxmenu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className="ctxmenu__item"
          data-danger={item.danger}
          data-sep={item.separatorBefore}
          // Ação primeiro, fechamento depois: `onClose` desmonta este componente
          // e não deve poder interromper o que o item ia fazer.
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          <span className="ctxmenu__icon">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
