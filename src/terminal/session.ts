import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";

import { api, Channel } from "../lib/ipc";
import { isLocalConnection, wslDistroName } from "../lib/types";
import type { AppError, SessionInfo, TerminalPalette } from "../lib/types";

const encoder = new TextEncoder();

/** Marcadores do bracketed paste, que o xterm põe em volta do texto colado. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Folga para o eco do comando chegar e o xterm desenhá-lo antes da conferência. */
const ECHO_GRACE_MS = 250;

/** Fins de prompt conhecidos, usados até a sessão revelar o dela. */
const PROMPT_ENDS = ["❯ ", "➜ ", "$ ", "% ", "# ", "> "];

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

  /** Linha sendo digitada, remontada a partir do que sai do teclado. */
  private line = "";
  /** A linha sofreu uma edição que não sabemos reproduzir (setas, ⇥, ⌃R). */
  private lineDirty = false;
  /** Fim do prompt desta sessão, aprendido com as linhas digitadas inteiras. */
  private promptEnd: string | null = null;

  constructor(
    readonly connectionId: string,
    palette: TerminalPalette,
    fontSize: number,
    /** Shell a usar no terminal local (vazio = `$SHELL`). */
    readonly localShell?: string,
  ) {
    this.term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", "Courier New", monospace',
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
    // O terminal local é uma "conexão" sintética: mesmo canal de saída, mas o
    // backend abre um PTY em vez de uma sessão SSH.
    const info = isLocalConnection(this.connectionId)
      ? await api.localOpen(
          {
            cols,
            rows,
            shell: this.localShell,
            wslDistro: wslDistroName(this.connectionId),
          },
          onOutput,
        )
      : await api.sshConnect(
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
        this.trackInput(data);
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

  /**
   * Reconstrói a linha digitada para alimentar o histórico de comandos.
   *
   * O que o servidor recebe é tecla a tecla; o eco vem de volta pelo shell.
   * Montar a linha aqui dá o texto exato quando ela é só digitada. Edição que
   * só o shell sabe fazer — ↑, ⇥, ⌃R — marca a linha como "suja": o texto certo
   * passa a ser o da tela, e é de lá que ele é recuperado no `commitLine`.
   */
  private trackInput(data: string) {
    // Colagem entre marcadores (bracketed paste): o texto vai para a linha como
    // se tivesse sido digitado. Com quebra de linha no meio o shell mostra tudo
    // junto e só executa no Enter — aí o buffer daqui não valeria.
    if (data.startsWith(PASTE_START)) {
      const text = data.slice(PASTE_START.length).replace(PASTE_END, "");
      if (/[\r\n]/.test(text)) this.lineDirty = true;
      else this.line += text;
      return;
    }
    // Sequência de escape (setas, F-keys, histórico do shell): a linha real
    // passa a ser a do shell, não a daqui.
    if (data.charCodeAt(0) === 0x1b) {
      this.lineDirty = true;
      return;
    }
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") {
        this.commitLine();
      } else if (code === 0x7f || ch === "\b") {
        this.line = this.line.slice(0, -1);
      } else if (ch === "\x03" || ch === "\x15") {
        // ⌃C e ⌃U jogam a linha fora — inclusive o que já não sabíamos seguir.
        this.line = "";
        this.lineDirty = false;
      } else if (code < 0x20) {
        // ⇥ completa, ⌃R busca, ⌃W apaga palavra: tudo muda a linha no shell.
        this.lineDirty = true;
      } else {
        this.line += ch;
      }
    }
  }

  /** Enter: manda a linha para o histórico, se ela for confiável. */
  private commitLine() {
    const typed = this.line.trim();
    const dirty = this.lineDirty;
    this.line = "";
    this.lineDirty = false;
    if (!commandSink) return;
    // Dentro de um TUI (vim, htop, less) o Enter não é um comando de shell.
    if (this.term.buffer.active.type === "alternate") return;
    if (!dirty && !typed) return;

    // A linha submetida fica onde está: o Enter só move o cursor para a de
    // baixo. Guardamos o índice absoluto dela (vale mesmo depois de rolar) e
    // lemos a tela daqui a pouco — no instante da tecla ela ainda não tem o
    // texto, porque o eco vem do servidor e o xterm ainda processa a escrita
    // em lote. Era isso que fazia comando curto (`ls`) não entrar.
    const buf = this.term.buffer.active;
    const row = buf.baseY + buf.cursorY;
    window.setTimeout(() => {
      if (this.closed || !commandSink) return;
      const shown = this.lineAt(row);
      const command = dirty ? this.afterPrompt(shown) : this.confirmTyped(shown, typed);
      if (!command || command.length > 400) return;
      commandSink(this.connectionId, command);
    }, ECHO_GRACE_MS);
  }

  /** Texto da linha lógica que termina em `row`, juntando o que quebrou. */
  private lineAt(row: number): string {
    // Buffer normal e não o ativo: o comando pode ter aberto um TUI, e aí a
    // tela ativa é a alternativa — a linha digitada continua na de baixo.
    const buf = this.term.buffer.normal;
    let start = row;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let text = "";
    for (let y = start; y <= row; y++) {
      // Só a última corta o espaço à direita: as de cima vão até a borda, e
      // aparar ali comeria um espaço do próprio comando na dobra da linha.
      text += buf.getLine(y)?.translateToString(y === row) ?? "";
    }
    return text;
  }

  /**
   * Linha digitada do começo ao fim: o texto é o que remontamos das teclas, e a
   * tela só confirma que ele foi ecoado. Prompt de senha não ecoa nada — é essa
   * conferência que impede a senha do sudo de cair no histórico.
   *
   * De quebra, aprende onde o prompt deste servidor termina, para conseguir
   * recortar as linhas que não dá para remontar.
   */
  private confirmTyped(shown: string, typed: string): string | null {
    const at = shown.indexOf(typed);
    if (at < 0) return null;
    const prompt = shown.slice(0, at);
    this.promptEnd = PROMPT_ENDS.find((end) => prompt.endsWith(end)) ?? this.promptEnd;
    return typed;
  }

  /**
   * Linha que o shell editou por conta própria (↑ do histórico, ⇥, ⌃R): as
   * teclas não dizem o que ficou nela, então o comando é o que está na tela
   * depois do fim do prompt.
   *
   * Sem um fim de prompt reconhecível não registra nada — e é o que mantém a
   * senha fora daqui, porque "Password:" e "[sudo] password for x:" não têm um.
   */
  private afterPrompt(shown: string): string | null {
    const ends = this.promptEnd ? [this.promptEnd] : PROMPT_ENDS;
    let cut = -1;
    for (const end of ends) {
      const at = shown.indexOf(end);
      if (at >= 0 && (cut < 0 || at + end.length < cut)) cut = at + end.length;
    }
    return cut < 0 ? null : shown.slice(cut).trim() || null;
  }

  /**
   * Modo somente leitura: o backend recusa a escrita de qualquer jeito, mas
   * barrar aqui evita uma ida à IPC (e um erro na tela) a cada tecla.
   */
  readOnly = false;

  private send(bytes: number[]) {
    if (!this.info || this.closed || this.readOnly) return;
    const route = inputRouter;
    if (route) {
      route(this.info.sessionId, bytes);
      return;
    }
    void api
      .sshWrite(this.info.sessionId, bytes)
      .catch(() => this.markClosed("conexão perdida"));
  }

  /**
   * Scrollback em HTML, com as cores como estão na tela.
   *
   * Sai do `SerializeAddon`, então é o mesmo conteúdo que o usuário vê — o que
   * serve para anexar em ticket ou relatório de incidente.
   */
  exportHtml(title: string) {
    const body = this.serialize.serializeAsHTML({ includeGlobalBackground: true });
    const when = new Date().toLocaleString("pt-BR");
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — ${escapeHtml(when)}</title>
<style>body{margin:0;padding:16px;background:#0b0e14;color:#dbe1ea;font-family:ui-monospace,monospace}h1{font:600 13px system-ui;color:#8b95a7;margin:0 0 12px}</style>
</head>
<body>
<h1>${escapeHtml(title)} — sessão exportada em ${escapeHtml(when)}</h1>
${body}
</body>
</html>`;
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

/**
 * Destino dos comandos digitados (o histórico). Módulo, pelo mesmo motivo do
 * `inputRouter`: o terminal vive fora da árvore React.
 */
let commandSink: ((connectionId: string, command: string) => void) | null = null;

export function setCommandSink(fn: typeof commandSink) {
  commandSink = fn;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function isAuthPrompt(e: AppError) {
  return e.kind === "auth_required";
}
export function isHostKeyPrompt(e: AppError) {
  return e.kind === "host_key_unknown" || e.kind === "host_key_changed";
}
