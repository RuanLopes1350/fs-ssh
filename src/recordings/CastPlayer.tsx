import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Pause, Play, RotateCcw } from "lucide-react";

/** Um evento do asciicast: `[tempo, "o", texto]`. */
interface CastEvent {
  at: number;
  data: string;
}

interface Cast {
  width: number;
  height: number;
  events: CastEvent[];
  duration: number;
}

const SPEEDS = [1, 2, 4, 8];
/** Pausa máxima respeitada entre dois eventos — ninguém quer rever 40 min de ócio. */
const MAX_GAP = 2;

/**
 * Lê um arquivo `.cast` (asciinema v2).
 *
 * Tolerante de propósito: a leitura pode vir truncada pelo início (arquivo
 * grande), então linha que não é JSON válido é ignorada em vez de derrubar tudo,
 * e o primeiro evento vira o tempo zero.
 */
export function parseCast(text: string): Cast {
  let width = 80;
  let height = 24;
  const events: CastEvent[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      const [at, kind, data] = parsed as [number, string, string];
      if (kind === "o" && typeof at === "number" && typeof data === "string") {
        events.push({ at, data });
      }
    } else if (parsed && typeof parsed === "object") {
      const header = parsed as { width?: number; height?: number };
      if (header.width) width = header.width;
      if (header.height) height = header.height;
    }
  }

  const base = events[0]?.at ?? 0;
  for (const e of events) e.at -= base;
  return { width, height, events, duration: events[events.length - 1]?.at ?? 0 };
}

/**
 * Player de gravação asciicast: reproduz a sessão com o timing original, no
 * mesmo xterm.js que o app já usa para o terminal ao vivo.
 */
export function CastPlayer({ text }: { text: string }) {
  const cast = useMemo(() => parseCast(text), [text]);
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  /** Índice do próximo evento a escrever. */
  const cursor = useRef(0);
  /** O relógio vive num ref para o loop não reiniciar a cada frame renderizado. */
  const elapsedRef = useRef(0);

  useEffect(() => {
    if (!boxRef.current) return;
    const term = new Terminal({
      cols: cast.width,
      rows: cast.height,
      fontSize: 12,
      fontFamily: "ui-monospace, monospace",
      convertEol: false,
      disableStdin: true,
      scrollback: 5000,
      theme: { background: "#0b0e14", foreground: "#dbe1ea" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
    };
  }, [cast.width, cast.height]);

  /** Escreve tudo até `t` de uma vez — usado no seek e no reinício. */
  const seek = useCallback(
    (t: number) => {
      const term = termRef.current;
      if (!term) return;
      term.reset();
      let i = 0;
      let buf = "";
      while (i < cast.events.length && cast.events[i].at <= t) {
        buf += cast.events[i].data;
        i++;
      }
      if (buf) term.write(buf);
      cursor.current = i;
      setElapsed(t);
    },
    [cast.events],
  );

  // Relógio da reprodução. Os intervalos longos são comprimidos: uma sessão de
  // uma hora com dois comandos não deve levar uma hora para ser revista.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const term = termRef.current;
      if (!term) return;
      const dt = ((now - last) / 1000) * speed;
      last = now;

      let t = elapsedRef.current + dt;
      const next = cast.events[cursor.current];
      if (next && next.at - elapsedRef.current > MAX_GAP) {
        t = next.at;
      }

      let buf = "";
      while (cursor.current < cast.events.length && cast.events[cursor.current].at <= t) {
        buf += cast.events[cursor.current].data;
        cursor.current++;
      }
      if (buf) term.write(buf);

      elapsedRef.current = t;
      setElapsed(t);

      if (cursor.current >= cast.events.length) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, cast.events]);

  if (cast.events.length === 0) {
    return <div className="muted">Arquivo sem eventos para reproduzir.</div>;
  }

  return (
    <div className="cast">
      <div className="cast__screen" ref={boxRef} />
      <div className="cast__bar">
        <button
          className="icon-btn"
          title={playing ? "Pausar" : "Reproduzir"}
          onClick={() => setPlaying((v) => !v)}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          className="icon-btn"
          title="Voltar ao início"
          onClick={() => {
            elapsedRef.current = 0;
            seek(0);
            setPlaying(true);
          }}
        >
          <RotateCcw size={14} />
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(cast.duration, 0.1)}
          step={0.1}
          value={Math.min(elapsed, cast.duration)}
          onChange={(e) => {
            const t = Number(e.target.value);
            elapsedRef.current = t;
            seek(t);
          }}
          style={{ flex: 1 }}
        />
        <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
          {clock(elapsed)} / {clock(cast.duration)}
        </span>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          title="Velocidade"
          style={{ width: "auto", fontSize: 11 }}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
