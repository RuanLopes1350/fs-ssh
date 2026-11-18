import { Keyboard } from "lucide-react";

import { modAltKey, modKey, modShiftKey } from "../lib/platform";
import { Modal } from "./Dialogs";

/** Grupos de atalhos, na ordem em que aparecem no diálogo. */
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "Conexões",
    items: [
      [modKey("K"), "Busca rápida: conectar ou rodar snippet"],
      [`${modKey("↵")} na busca`, "Conectar em split"],
      [modKey("N"), "Nova conexão"],
      [modKey("L"), "Focar a busca da barra lateral"],
      ["↑ ↓ / ↵", "Navegar e conectar pela lista"],
      [modKey("R"), "Reconectar a sessão do painel"],
    ],
  },
  {
    title: "Abas e painéis",
    items: [
      [modKey("T"), "Abrir busca para uma nova aba"],
      [`${modKey("D")} / ${modShiftKey("D")}`, "Dividir lado a lado / empilhado"],
      [modKey("W"), "Fechar painel (o último fecha a aba)"],
      [`${modKey("1")}…${modKey("9")}`, `Ir para a aba N (${modKey("9")} = última)`],
      [`${modShiftKey("[")} / ${modShiftKey("]")}`, "Aba anterior / seguinte"],
      [modAltKey("← → ↑ ↓"), "Circular o foco entre painéis"],
    ],
  },
  {
    title: "Painéis laterais",
    items: [
      [modKey("E"), "Arquivos (SFTP)"],
      [modShiftKey("C"), "Containers Docker/Podman"],
      [modShiftKey("N"), "Rede do host (IP, máscara, gateway, DNS)"],
      [modShiftKey("S"), "Sistema: carga, memória, disco, serviços, portas"],
      [modShiftKey("T"), "Túneis (port forwarding)"],
      [modShiftKey("H"), "Histórico de comandos (clique roda de novo)"],
      [modKey(","), "Configurações (preferências, backup do banco)"],
      [modShiftKey("M"), "Configurações na aba de chaves, temas e gravações"],
    ],
  },
  {
    title: "Terminal e janela",
    items: [
      [modKey("F"), "Buscar no scrollback"],
      [`${modKey("+")} / ${modKey("−")}`, "Aumentar / diminuir a fonte"],
      [modShiftKey("R"), "Gravar a sessão"],
      [`${modKey("B")} / ${modShiftKey("B")}`, "Recolher para ícones / esconder a barra lateral"],
      [modShiftKey("F"), "Focus mode (tela cheia)"],
      ["Esc", "Sair do focus mode ou fechar o que estiver aberto"],
      [modKey("/"), "Esta lista"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Atalhos de teclado"
      wide
      icon={<Keyboard size={16} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <button className="btn btn--primary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <div className="shortcut-grid">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="shortcut-grid__title">{g.title}</h3>
            <dl className="shortcut-list">
              {g.items.map(([keys, what]) => (
                <div key={keys} className="shortcut-list__row">
                  <dt>
                    <span className="kbd">{keys}</span>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
