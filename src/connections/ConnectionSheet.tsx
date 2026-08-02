import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";

import { ConfirmDialog } from "../components/Dialogs";
import { ConnIcon, ICON_GROUPS, iconLabel } from "../components/Icon";
import { Button } from "../components/ui/button";
import { Field, Label } from "../components/ui/label";
import { Input, Textarea } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { api } from "../lib/ipc";
import { terminals } from "../terminal/session";
import { FALLBACK_PALETTE, useAppStore } from "../store/useAppStore";
import type { AuthMethod, Connection } from "../lib/types";
import { ForwardsSection } from "./ForwardsSection";

const PRESET_COLORS = [
  "#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e", "#84cc16",
  "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7",
  "#8b5cf6", "#64748b",
];

export const EMPTY_CONNECTION: Connection = {
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "",
  authMethod: "auto",
  identityId: null,
  jumpHostId: null,
  folderId: null,
  color: "#3b82f6",
  icon: "server",
  themeId: null,
  isProduction: false,
  notes: "",
  createdAt: "",
  lastUsedAt: null,
  useCount: 0,
};

/** Valor-sentinela do Radix Select: ele não aceita item com value "". */
const NONE = "__none__";

/**
 * Edição de conexão em painel lateral (Sheet), não em modal.
 *
 * A diferença que importa: com o terminal e a sidebar visíveis ao lado, cor,
 * ícone e tema são aplicados **enquanto** se escolhe. O que não for salvo é
 * revertido ao fechar — a pré-visualização mexe só no estado em memória.
 */
export function ConnectionSheet({
  initial,
  onClose,
}: {
  initial: Connection;
  onClose: () => void;
}) {
  const [conn, setConn] = useState<Connection>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saved = useRef(false);

  const identities = useAppStore((s) => s.identities);
  const themes = useAppStore((s) => s.themes);
  const folders = useAppStore((s) => s.folders);
  const connections = useAppStore((s) => s.connections);
  const reload = useAppStore((s) => s.reloadConnections);

  const set = <K extends keyof Connection>(k: K, v: Connection[K]) =>
    setConn((c) => ({ ...c, [k]: v }));

  // Pré-visualização ao vivo: mexe no catálogo em memória (sidebar e paleta)
  // e nos painéis abertos desta conexão (aba, faixa e tema do terminal).
  useEffect(() => {
    if (!conn.id) return;
    const store = useAppStore.getState();
    store.previewConnection(conn);
    const palette =
      themes.find((t) => t.id === conn.themeId)?.json ?? FALLBACK_PALETTE;
    for (const tab of store.tabs) {
      for (const p of tab.panes) {
        if (p.connectionId !== conn.id) continue;
        terminals.get(p.id)?.setPalette(palette);
      }
    }
  }, [conn, themes]);

  // Fechar sem salvar desfaz tudo: recarrega o catálogo do banco e reaplica
  // as paletas reais.
  useEffect(
    () => () => {
      if (saved.current) return;
      void useAppStore
        .getState()
        .reloadConnections()
        .then(() => useAppStore.getState().applyPalettes());
    },
    [],
  );

  const save = async () => {
    if (!conn.name.trim() || !conn.host.trim() || !conn.username.trim()) {
      setError("Nome, host e usuário são obrigatórios.");
      return;
    }
    setSaving(true);
    try {
      await api.connSave(conn);
      saved.current = true;
      await reload();
      useAppStore.getState().applyPalettes();
      onClose();
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    saved.current = true;
    await api.connDelete(conn.id);
    await reload();
    onClose();
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent blockOutside={saving}>
        <SheetHeader>
          <SheetTitle>
            <ConnIcon name={conn.icon} color={conn.color} size={15} />
            {conn.id ? `Editar ${initial.name}` : "Nova conexão"}
          </SheetTitle>
          <SheetDescription>
            Cor, ícone e tema são aplicados na hora — feche sem salvar para desfazer.
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          {error && <div className="alert alert--danger">{error}</div>}

          <div className="flex gap-2.5">
            <Field label="Nome" className="flex-[2]">
              <Input
                value={conn.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="api-prod-01"
                autoFocus
              />
            </Field>
            <Field label="Host (IP ou DNS)" className="flex-[3]">
              <Input
                value={conn.host}
                onChange={(e) => set("host", e.target.value)}
                placeholder="10.0.0.12"
              />
            </Field>
            <Field label="Porta" className="w-[74px] flex-none">
              <Input
                type="number"
                value={conn.port}
                onChange={(e) => set("port", Number(e.target.value) || 22)}
              />
            </Field>
          </div>

          <div className="flex gap-2.5">
            <Field label="Usuário" className="flex-1">
              <Input
                value={conn.username}
                onChange={(e) => set("username", e.target.value)}
                placeholder="deploy"
              />
            </Field>
            <Field label="Autenticação" className="flex-1">
              <Select
                value={conn.authMethod}
                onValueChange={(v) => set("authMethod", v as AuthMethod)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Automática (agente → chave → senha)</SelectItem>
                  <SelectItem value="agent">Somente ssh-agent</SelectItem>
                  <SelectItem value="key">Somente chave</SelectItem>
                  <SelectItem value="password">Somente senha</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex gap-2.5">
            <Field label="Chave" className="flex-1">
              <Select
                value={conn.identityId ?? NONE}
                onValueChange={(v) => set("identityId", v === NONE ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Qualquer uma disponível</SelectItem>
                  {identities.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.label} · {i.keyType}
                      {i.inAgent ? " · no agente" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Jump host (bastion)" className="flex-1">
              <Select
                value={conn.jumpHostId ?? NONE}
                onValueChange={(v) => set("jumpHostId", v === NONE ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Conexão direta</SelectItem>
                  {connections
                    .filter((c) => c.id !== conn.id)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} ({c.host})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex gap-2.5">
            <Field label="Pasta" className="flex-1">
              <Select
                value={conn.folderId ?? NONE}
                onValueChange={(v) => set("folderId", v === NONE ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sem pasta</SelectItem>
                  {folders.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Tema do terminal" className="flex-1">
              <Select
                value={conn.themeId ?? NONE}
                onValueChange={(v) => set("themeId", v === NONE ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Padrão</SelectItem>
                  {themes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Cor">
            <div className="flex flex-wrap items-center gap-1.5">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  className="h-6 w-6 rounded-md border-2 transition-transform hover:scale-110"
                  style={{
                    background: c,
                    borderColor: conn.color === c ? "var(--text)" : "transparent",
                  }}
                  onClick={() => set("color", c)}
                />
              ))}
              <input
                type="color"
                value={conn.color}
                aria-label="Cor personalizada"
                onChange={(e) => set("color", e.target.value)}
                // Inline porque `styles.css` (fora de camada) vence os
                // utilitários e imporia `width: 100%` a todo input.
                style={{ width: 34, height: 24, padding: 0, border: "none", cursor: "pointer" }}
              />
            </div>
          </Field>

          <IconPicker value={conn.icon} onChange={(v) => set("icon", v)} />

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={conn.isProduction}
              onChange={(e) => set("isProduction", e.target.checked)}
              // Caixa de seleção, como no resto dos formulários do app: o
              // switch sugeria um efeito imediato, e isto só vale ao salvar.
              style={{ width: "auto", marginTop: 3 }}
            />
            <span className="min-w-0">
              <span className="block text-[13px]">Servidor de produção</span>
              <span className="block text-[11px] text-faint">
                Pede confirmação ao conectar e marca a sessão com faixa vermelha.
              </span>
            </span>
          </label>

          {conn.id ? (
            <ForwardsSection connectionId={conn.id} />
          ) : (
            <Field label="Port forwarding" hint="Salve a conexão para adicionar túneis." >
              <span />
            </Field>
          )}

          <Field label="Notas">
            <Textarea
              rows={2}
              value={conn.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Contexto, responsável, runbook…"
            />
          </Field>
        </SheetBody>

        <SheetFooter>
          {conn.id && (
            <Button variant="danger" size="icon" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} />
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            Salvar
          </Button>
        </SheetFooter>
      </SheetContent>

      {confirmDelete && (
        <ConfirmDialog
          title="Excluir conexão"
          danger
          confirmLabel="Excluir"
          message={
            <>
              Excluir <b>{conn.name || "esta conexão"}</b> ({conn.username}@{conn.host})?
              As sessões já abertas continuam funcionando.
            </>
          }
          onConfirm={() => {
            setConfirmDelete(false);
            void remove();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Sheet>
  );
}

/** Seletor de ícone com busca e agrupamento (OS, DevOps, bancos…). */
function IconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return ICON_GROUPS;
    return ICON_GROUPS.map((g) => ({
      ...g,
      names: g.names.filter(
        (n) => n.includes(query) || iconLabel(n).toLowerCase().includes(query),
      ),
    })).filter((g) => g.names.length > 0);
  }, [q]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>Ícone</Label>
        <div className="relative w-[150px]">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="buscar…"
            className="h-[26px] pl-6 text-xs"
          />
        </div>
      </div>

      <div className="flex max-h-[210px] flex-col gap-2 overflow-y-auto rounded-md border border-line p-2">
        {groups.map((g) => (
          <div key={g.label} className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-faint">
              {g.label}
            </span>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(32px,1fr))] gap-1">
              {g.names.map((name) => (
                <button
                  key={name}
                  title={iconLabel(name)}
                  onClick={() => onChange(name)}
                  className={`flex h-8 items-center justify-center rounded-md border transition-colors ${
                    value === name
                      ? "border-accent text-accent"
                      : "border-line text-dim hover:bg-hover hover:text-foreground"
                  }`}
                >
                  <ConnIcon name={name} size={16} />
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <span className="p-2 text-center text-[11px] text-faint">
            Nenhum ícone corresponde a "{q}".
          </span>
        )}
      </div>
    </div>
  );
}
