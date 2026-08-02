import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";

import { api, Channel } from "../lib/ipc";
import type { AppError, SessionInfo, TerminalPalette } from "../lib/types";

const encoder = new TextEncoder();

/**
 * Um terminal vivo.
 *
 * O objeto sobrevive à desmontagem do componente React: trocar de aba só
 * desanexa o DOM, mantendo scrollback, cursor e a sessão SSH intactos. Recriar o
 * `Terminal` a cada render perderia tudo isso.
 */
export class TerminalSession {
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  readonly serialize = new SerializeAddon();

  private webgl: WebglAddon | null = null;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private lastSize = { cols: 0, rows: 0 };

  info: SessionInfo | null = null;
  closed = false;
  /** `connect` pode ser chamado de novo após o diálogo de senha; os listeners de
   *  input só podem ser registrados uma vez, senão cada tecla é enviada N vezes. */
  private inputWired = false;

  constructor(
    readonly connectionId: string,
    palette: TerminalPalette,
    fontSize: number,
  ) {
    this.term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 20000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: palette,
      // O xterm precisa saber a largura real de emoji/CJK para não desalinhar
      // molduras de TUI (htop, tmux).
      allowTransparency: false,
    });

    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(this.serialize);

    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";

    this.term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        void openUrl(uri);
      }),
    );
  }

  /** Conecta ao servidor e começa a receber bytes. */
  async connect(secret?: string, jumpSecret?: string): Promise<SessionInfo> {
    const onOutput = new Channel<ArrayBuffer>();
    onOutput.onmessage = (buf) => {
      // Uint8Array direto: o xterm decodifica UTF-8 internamente e evita o
      // custo de montar uma string intermediária no JS.
      this.term.write(new Uint8Array(buf));
    };

    const { cols, rows } = this.currentSize();
    const info = await api.sshConnect(
      { connectionId: this.connectionId, cols, rows, secret, jumpSecret },
      onOutput,
    );
    this.info = info;
    this.closed = false;

    // Entre pedir a conexão e o handshake terminar, o terminal já foi montado
    // e medido — o PTY foi aberto com o tamanho de antes (tipicamente 80x24) e
    // o `fit` daquele intervalo não tinha `info` para avisar o servidor. Sem
    // reenviar aqui, um TUI (vim, htop) desenha numa janela 80x24 dentro de um
    // painel grande.
    const size = this.currentSize();
    if (size.cols !== cols || size.rows !== rows) {
      this.lastSize = size;
      void api.sshResize(info.sessionId, size.cols, size.rows).catch(() => {});
    }
    // Remede depois do layout assentar (a aba pode ter acabado de aparecer).
    this.fitSoon();

    if (!this.inputWired) {
      this.inputWired = true;

      this.term.onData((data) => {
        this.send(Array.from(encoder.encode(data)));
      });

      // Sequências binárias (respostas a DA/DSR) chegam como latin-1, um byte
      // por code unit — não passam pelo TextEncoder.
      this.term.onBinary((data) => {
        this.send(Array.from(data, (c) => c.charCodeAt(0) & 0xff));
      });
    }

    return info;
  }

  private send(bytes: number[]) {
    if (!this.info || this.closed) return;
    const route = inputRouter;
    if (route) {
      route(this.info.sessionId, bytes);
      return;
    }
    void api
      .sshWrite(this.info.sessionId, bytes)
      .catch(() => this.markClosed("conexão perdida"));
  }

  attach(container: HTMLElement) {
    if (this.container === container) {
      this.fitSoon();
      return;
    }
    this.container = container;

    if (this.term.element) {
      // O xterm só aceita `open()` uma vez. Quando o painel muda de posição na
      // árvore de splits, o React recria o container — mover o elemento
      // existente preserva scrollback e renderer; reabrir deixaria o terminal
      // em branco.
      container.appendChild(this.term.element);
    } else {
      this.term.open(container);
      this.enableWebgl();
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.fitSoon());
    this.resizeObserver.observe(container);
    this.fitSoon();
    this.term.focus();
  }

  detach() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.container = null;
  }

  /**
   * O renderer WebGL é o que sustenta `cat` de arquivo grande sem travar. Se o
   * contexto for perdido (troca de GPU, suspensão do Mac), cai para o renderer
   * DOM em vez de deixar a tela congelada.
   */
  private enableWebgl() {
    if (this.webgl) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      // Sem WebGL o xterm usa o renderer DOM automaticamente.
    }
  }

  private currentSize() {
    return { cols: this.term.cols || 80, rows: this.term.rows || 24 };
  }

  /**
   * Debounce no resize: arrastar a borda da janela dispara dezenas de eventos, e
   * cada `window_change` é um pacote SSH que faz o shell redesenhar a tela.
   */
  private fitSoon() {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;

      // Container ainda sem layout (aba oculta, primeiro paint): medir agora
      // daria 1x1 e mandaria esse tamanho ao servidor, embaralhando a tela.
      const box = this.container?.getBoundingClientRect();
      if (!box || box.width < 40 || box.height < 40) return;

      try {
        this.fit.fit();
      } catch {
        return;
      }
      const { cols, rows } = this.currentSize();
      if (cols < 8 || rows < 3) return;
      const unchanged = cols === this.lastSize.cols && rows === this.lastSize.rows;
      // Só registra como "já enviado" quando havia sessão para receber: medir
      // antes de conectar não pode marcar o tamanho como sincronizado.
      if (this.info && !this.closed) {
        if (unchanged) return;
        this.lastSize = { cols, rows };
        void api.sshResize(this.info.sessionId, cols, rows).catch(() => {});
      }
    }, 80);
  }

  setPalette(palette: TerminalPalette) {
    this.term.options.theme = palette;
  }

  setFontSize(size: number) {
    this.term.options.fontSize = size;
    this.fitSoon();
  }

  markClosed(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.term.write(`\r\n\x1b[2m── ${reason} ──\x1b[0m\r\n`);
  }

  async disconnect() {
    if (this.info && !this.closed) {
      await api.sshDisconnect(this.info.sessionId).catch(() => {});
    }
  }

  dispose() {
    this.detach();
    this.webgl?.dispose();
    this.term.dispose();
  }
}

/** Terminais vivos, indexados pelo id da aba. */
export const terminals = new Map<string, TerminalSession>();

/**
 * Desvio do input, usado pelo modo broadcast.
 *
 * Fica como variável de módulo em vez de prop porque o `TerminalSession` vive
 * fora da árvore React — um `useState` não chegaria até ele sem recriar o
 * terminal a cada toggle.
 */
let inputRouter: ((sessionId: string, bytes: number[]) => void) | null = null;

export function setInputRouter(fn: typeof inputRouter) {
  inputRouter = fn;
}

export function isAuthPrompt(e: AppError) {
  return e.kind === "auth_required";
}
export function isHostKeyPrompt(e: AppError) {
  return e.kind === "host_key_unknown" || e.kind === "host_key_changed";
}
