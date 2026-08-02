import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, RefreshCw, Trash2, TriangleAlert } from "lucide-react";

import { ConfirmDialog, Spinner } from "../components/Dialogs";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/label";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { api, asAppError } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";
import type { LogEntry } from "../lib/types";

const ALL = "__all__";

/** `YYYY-MM-DD` de hoje deslocado por `days` — usado nos atalhos de período. */
function isoDay(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Eventos da aplicação (conexões, túneis, gravações) com filtro por período e
 * conexão. Vem da tabela `app_logs`, não do arquivo de texto do tracing — é o
 * que permite filtrar sem varrer o arquivo inteiro.
 */
export function LogsView() {
  const connections = useAppStore((s) => s.connections);

  const [from, setFrom] = useState(isoDay(-7));
  const [to, setTo] = useState(isoDay());
  const [connectionId, setConnectionId] = useState(ALL);
  const [level, setLevel] = useState(ALL);
  const [search, setSearch] = useState("");

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(
        await api.logList({
          from,
          to,
          connectionId: connectionId === ALL ? undefined : connectionId,
          level: level === ALL ? undefined : level,
          search: search.trim() || undefined,
          limit: 2000,
        }),
      );
      setError(null);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setLoading(false);
    }
  }, [from, to, connectionId, level, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const errors = entries.filter((e) => e.level === "error").length;
    const warns = entries.filter((e) => e.level === "warn").length;
    return { errors, warns };
  }, [entries]);

  return (
    <>
      <div className="text-[11px] text-faint">
        Eventos registrados pelo app: conexões abertas e recusadas, túneis, gravações.
        Senhas e conteúdo de terminal nunca entram aqui.
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="De" className="w-[128px] flex-none">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Até" className="w-[128px] flex-none">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Conexão" className="min-w-[150px] flex-1">
          <Select value={connectionId} onValueChange={setConnectionId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas</SelectItem>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Nível" className="w-[110px] flex-none">
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warn">Aviso</SelectItem>
              <SelectItem value="error">Erro</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Buscar" className="min-w-[130px] flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="texto do evento…"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["Hoje", isoDay(), isoDay()],
            ["7 dias", isoDay(-7), isoDay()],
            ["30 dias", isoDay(-30), isoDay()],
          ] as [string, string, string][]
        ).map(([label, f, t]) => (
          <Button
            key={label}
            size="sm"
            variant={from === f && to === t ? "default" : "outline"}
            onClick={() => {
              setFrom(f);
              setTo(t);
            }}
          >
            {label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw size={12} /> Atualizar
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setClearing(true)}>
          <Trash2 size={12} /> Limpar tudo
        </Button>
        {loading && <Spinner />}
        <span className="ml-auto text-[11px] text-faint">
          {entries.length} evento(s)
          {counts.errors > 0 && ` · ${counts.errors} erro(s)`}
          {counts.warns > 0 && ` · ${counts.warns} aviso(s)`}
        </span>
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      <div className="flex min-h-[180px] flex-1 flex-col overflow-y-auto rounded-lg border border-line-strong bg-background">
        {entries.map((e) => (
          <div
            key={e.id}
            className="flex items-start gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0"
          >
            <LevelIcon level={e.level} />
            <span className="w-[118px] flex-none font-mono text-[10px] text-faint">
              {new Date(e.ts).toLocaleString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
            {e.connection && (
              <span className="w-[110px] flex-none truncate text-[11px] text-dim">
                {e.connection}
              </span>
            )}
            <span className="min-w-0 flex-1 break-words text-[11px]">{e.message}</span>
            <span className="flex-none text-[10px] uppercase tracking-wide text-faint">
              {e.kind}
            </span>
          </div>
        ))}

        {!loading && entries.length === 0 && (
          <div className="p-6 text-center text-[12px] text-faint">
            Nenhum evento no período selecionado.
          </div>
        )}
      </div>

      {clearing && (
        <ConfirmDialog
          title="Limpar logs"
          danger
          confirmLabel="Limpar"
          message="Apagar todos os eventos registrados? As gravações de sessão não são afetadas."
          onConfirm={() => {
            setClearing(false);
            void (async () => {
              await api.logClear();
              await load();
            })();
          }}
          onCancel={() => setClearing(false)}
        />
      )}
    </>
  );
}

function LevelIcon({ level }: { level: string }) {
  if (level === "error") {
    return <AlertTriangle size={12} className="mt-0.5 flex-none text-danger" />;
  }
  if (level === "warn") {
    return <TriangleAlert size={12} className="mt-0.5 flex-none text-warn" />;
  }
  return <Info size={12} className="mt-0.5 flex-none text-faint" />;
}
