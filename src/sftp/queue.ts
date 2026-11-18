import { create } from "zustand";

import { api, asAppError, Channel } from "../lib/ipc";
import type { Progress } from "../lib/types";

/**
 * Quantas transferências correm ao mesmo tempo.
 *
 * Duas aproveitam a janela do canal SSH sem competir entre si; acima disso o
 * ganho some (a banda é a mesma) e o progresso de cada uma fica errático.
 */
const MAX_PARALLEL = 2;

export type TransferStatus = "queued" | "running" | "paused" | "done" | "error";

export interface QueuedTransfer {
  /** O mesmo id que o Rust registra — é por ele que pausar chega ao laço. */
  id: string;
  sessionId: string;
  direction: "up" | "down";
  /** Origem e destino já resolvidos, para retomar sem recalcular nada. */
  local: string;
  remote: string;
  label: string;
  transferred: number;
  total: number;
  status: TransferStatus;
  error: string | null;
  /** Momento em que entrou na fila — ordena a lista. */
  at: number;
}

interface QueueStore {
  items: QueuedTransfer[];
  /** Enfileira uma transferência; começa sozinha quando houver vaga. */
  enqueue: (t: {
    sessionId: string;
    direction: "up" | "down";
    local: string;
    remote: string;
    label?: string;
  }) => string;
  pause: (id: string) => void;
  resume: (id: string) => void;
  remove: (id: string) => void;
  /** Tira da lista tudo que já terminou (com ou sem erro). */
  clearFinished: () => void;
  /** Chamado ao fechar a sessão: nada de fila órfã de servidor que já foi. */
  dropSession: (sessionId: string) => void;
}

export const useTransferQueue = create<QueueStore>((set, get) => {
  const patch = (id: string, p: Partial<QueuedTransfer>) =>
    set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, ...p } : t)) }));

  /** Dispara o que estiver na fila enquanto houver vaga. */
  const pump = () => {
    const { items } = get();
    const running = items.filter((t) => t.status === "running").length;
    // `Math.max` protege o `slice`: com as vagas negativas ele devolveria "tudo
    // menos o último" em vez de nada, e a fila inteira sairia de uma vez.
    const free = Math.max(0, MAX_PARALLEL - running);
    for (const t of items.filter((t) => t.status === "queued").slice(0, free)) {
      void run(t);
    }
  };

  const run = async (t: QueuedTransfer) => {
    patch(t.id, { status: "running", error: null });

    const channel = new Channel<Progress>();
    channel.onmessage = (p: Progress) => {
      // A pausa chega por aqui: `cancelled` distingue "parou porque pediram" de
      // "parou porque terminou" — e o que já veio fica no disco para a retomada.
      const status: TransferStatus = p.done
        ? p.error
          ? "error"
          : p.cancelled
            ? "paused"
            : "done"
        : "running";
      patch(t.id, {
        transferred: p.transferred,
        total: p.total,
        status,
        error: p.error ?? null,
      });
      if (p.done) pump();
    };

    try {
      // `resume: true` sempre: continuar de onde parou é o comportamento certo
      // tanto para retomada manual quanto para arquivo que já existe pela metade.
      if (t.direction === "down") {
        await api.sftpDownload(t.sessionId, t.id, t.remote, t.local, true, channel);
      } else {
        await api.sftpUpload(t.sessionId, t.id, t.local, t.remote, true, channel);
      }
      // Sem evento final (arquivo vazio, por exemplo) a fila não pode ficar
      // presa em "running".
      if (get().items.find((x) => x.id === t.id)?.status === "running") {
        patch(t.id, { status: "done" });
      }
    } catch (e) {
      patch(t.id, { status: "error", error: asAppError(e).message });
    } finally {
      pump();
    }
  };

  return {
    items: [],

    enqueue: ({ sessionId, direction, local, remote, label }) => {
      const id = crypto.randomUUID();
      set((s) => ({
        items: [
          ...s.items,
          {
            id,
            sessionId,
            direction,
            local,
            remote,
            label: label ?? (direction === "up" ? local : remote).split(/[/\\]/).pop() ?? "",
            transferred: 0,
            total: 0,
            status: "queued",
            error: null,
            at: Date.now(),
          },
        ],
      }));
      pump();
      return id;
    },

    pause: (id) => {
      const t = get().items.find((x) => x.id === id);
      if (!t) return;
      if (t.status === "queued") {
        patch(id, { status: "paused" });
        return;
      }
      // Em execução, quem para é o Rust; o status vem no evento de progresso.
      void api.sftpCancel(id).catch(() => {});
    },

    resume: (id) => {
      patch(id, { status: "queued", error: null });
      pump();
    },

    remove: (id) => {
      const t = get().items.find((x) => x.id === id);
      if (t?.status === "running") void api.sftpCancel(id).catch(() => {});
      set((s) => ({ items: s.items.filter((x) => x.id !== id) }));
      pump();
    },

    clearFinished: () =>
      set((s) => ({ items: s.items.filter((t) => t.status !== "done" && t.status !== "error") })),

    dropSession: (sessionId) => {
      for (const t of get().items) {
        if (t.sessionId === sessionId && t.status === "running") {
          void api.sftpCancel(t.id).catch(() => {});
        }
      }
      set((s) => ({ items: s.items.filter((t) => t.sessionId !== sessionId) }));
    },
  };
});
