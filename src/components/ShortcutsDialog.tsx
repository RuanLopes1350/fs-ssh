import { Keyboard } from "lucide-react";

import { Modal } from "./Dialogs";

/** Grupos de atalhos, na ordem em que aparecem no diálogo (⌘/). */
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "Conexões",
    items: [
      ["⌘K", "Busca rápida: conectar ou rodar snippet"],
      ["⌘↵ na busca", "Conectar em split"],
      ["⌘N", "Nova conexão"],
      ["⌘L", "Focar a busca da barra lateral"],
      ["↑ ↓ / ↵", "Navegar e conectar pela lista"],
      ["⌘R", "Reconectar a sessão do painel"],
    ],
  },
  {
    title: "Abas e painéis",
    items: [
      ["⌘T", "Abrir busca para uma nova aba"],
      ["⌘D / ⌘⇧D", "Dividir lado a lado / empilhado"],
      ["⌘W", "Fechar painel (o último fecha a aba)"],
      ["⌘1…⌘9", "Ir para a aba N (⌘9 = última)"],
      ["⌘⇧[ / ⌘⇧]", "Aba anterior / seguinte"],
      ["⌘⌥← → ↑ ↓", "Circular o foco entre painéis"],
    ],
  },
  {
    title: "Painéis laterais",
    items: [
      ["⌘E", "Arquivos (SFTP)"],
      ["⌘⇧C", "Containers Docker/Podman"],
      ["⌘⇧N", "Rede do host (IP, máscara, gateway, DNS)"],
      ["⌘⇧S", "Sistema: carga, memória, disco, serviços, portas"],
      ["⌘⇧T", "Túneis (port forwarding)"],
      ["⌘⇧H", "Histórico de comandos (clique roda de novo)"],
      ["⌘⇧M", "Chaves, snippets, temas, gravações e logs"],
      ["⌘,", "Configurações"],
    ],
  },
  {
    title: "Terminal e janela",
    items: [
      ["⌘F", "Buscar no scrollback"],
      ["⌘+ / ⌘−", "Aumentar / diminuir a fonte"],
      ["⌘⇧R", "Gravar a sessão"],
      ["⌘B / ⌘⇧B", "Recolher para ícones / esconder a barra lateral"],
      ["⌘⇧F", "Focus mode (tela cheia)"],
      ["Esc", "Sair do focus mode ou fechar o que estiver aberto"],
      ["⌘/", "Esta lista"],
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
