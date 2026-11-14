import { useState } from "react";
import { DatabaseBackup } from "lucide-react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";

import { Spinner } from "./Dialogs";
import { api, asAppError } from "../lib/ipc";
import { defaultShellPlaceholder, isWindows, modKey, modShiftKey } from "../lib/platform";
import { useAppStore } from "../store/useAppStore";

/**
 * Preferências do app — a primeira aba da tela de configurações (⌘,).
 *
 * Era um diálogo separado do painel de chaves/temas/gravações, e a divisão não
 * se sustentava: as duas telas respondem à mesma pergunta ("onde eu mudo isso?").
 * Tudo persiste localmente entre sessões.
 */
export function PreferencesTab() {
  const settings = useAppStore((s) => s.settings);
  const fontSize = useAppStore((s) => s.fontSize);
  const setSettings = useAppStore((s) => s.setSettings);
  const setFontSize = useAppStore((s) => s.setFontSize);

  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupErr, setBackupErr] = useState<string | null>(null);

  const backup = async () => {
    setBackupMsg(null);
    setBackupErr(null);
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = await saveFileDialog({
      defaultPath: `fs-ssh-backup-${stamp}.db`,
      filters: [{ name: "SQLite", extensions: ["db"] }],
    });
    if (!dest) return;
    setBackupBusy(true);
    try {
      await api.dbBackup(dest);
      setBackupMsg(`Backup salvo em ${dest}`);
    } catch (e) {
      setBackupErr(asAppError(e).message);
    } finally {
      setBackupBusy(false);
    }
  };

  type BoolSetting = {
    [K in keyof typeof settings]: (typeof settings)[K] extends boolean ? K : never;
  }[keyof typeof settings];

  const check = (key: BoolSetting, label: string, hint: string) => (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={settings[key]}
        onChange={(e) => setSettings({ [key]: e.target.checked })}
        style={{ width: "auto", marginTop: 2 }}
      />
      <span>
        {label}
        <br />
        <span className="muted" style={{ fontSize: 11 }}>
          {hint}
        </span>
      </span>
    </label>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row">
        <div className="field" style={{ maxWidth: 180 }}>
          <label>
            Tamanho da fonte do terminal ({modKey("+")} / {modKey("−")})
          </label>
          <input
            type="number"
            min={9}
            max={24}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value) || 13)}
          />
        </div>
        <div className="field">
          <label>Shell do terminal local</label>
          <input
            value={settings.localShell}
            placeholder={
              isWindows
                ? `vazio = PowerShell (${defaultShellPlaceholder()})`
                : `vazio = $SHELL (${defaultShellPlaceholder()})`
            }
            onChange={(e) => setSettings({ localShell: e.target.value })}
          />
        </div>
      </div>

      {check(
        "restoreTabs",
        "Oferecer restauração das abas ao abrir",
        "Ao iniciar, pergunta se quer reconectar aos servidores que estavam abertos.",
      )}
      {check(
        "autoReconnect",
        "Reconectar automaticamente",
        "Quando a conexão cai (rede, VPN), tenta de novo com intervalo crescente — até 5 tentativas.",
      )}
      {check(
        "broadcastSkipProd",
        "Broadcast ignora abas de produção",
        "Com o modo broadcast ligado, o que você digita não é enviado para abas marcadas como PROD.",
      )}
      {check(
        "dimInactivePanes",
        "Escurecer painéis sem foco",
        "Numa aba dividida, o painel que não recebe o teclado fica levemente escurecido (passar o mouse já clareia). O painel em foco mostra uma etiqueta com o nome do servidor, que some sozinha.",
      )}
      {check(
        "recordHistory",
        "Guardar o histórico de comandos",
        `Registra as linhas digitadas no prompt para reexecutar pelo painel de histórico (${modShiftKey("H")}). Fica salvo neste computador; senhas não entram (só é guardado o que o servidor ecoou na tela). Use o ícone de lixeira do painel para apagar.`,
      )}
      {check(
        "autoRecord",
        "Gravar todas as sessões automaticamente",
        "Salva a saída do terminal em arquivos (0600) na pasta de gravações. Cuidado: registra tudo que aparece na tela, inclusive segredos. As gravações ficam no painel de gestão → Gravações.",
      )}

      <div className="field" style={{ maxWidth: 260 }}>
        <label>Formato da gravação</label>
        <select
          value={settings.recordFormat}
          onChange={(e) =>
            setSettings({ recordFormat: e.target.value as "text" | "cast" })
          }
        >
          <option value="text">Texto legível (.log)</option>
          <option value="cast">asciicast com replay (.cast)</option>
        </select>
        <span className="muted" style={{ fontSize: 11 }}>
          O texto sai sem códigos de cor, bom para ler e pesquisar. O asciicast guarda o
          tempo de cada saída e é reproduzível no player embutido (e em qualquer player
          de asciinema) — é o formato para auditoria.
        </span>
      </div>

      <div
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {backupMsg && <div className="alert alert--warn">{backupMsg}</div>}
        {backupErr && <div className="alert alert--danger">{backupErr}</div>}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn" onClick={() => void backup()} disabled={backupBusy}>
            <DatabaseBackup size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            Backup do banco de dados…
          </button>
          {backupBusy && <Spinner />}
        </div>
        <span className="muted" style={{ fontSize: 11 }}>
          Salva uma cópia do catálogo (conexões, pastas, temas, snippets e hosts
          confirmados). Senhas nunca ficam no banco. Para restaurar, substitua o{" "}
          <code>app.db</code> no diretório de dados do app com o app fechado.
        </span>
      </div>
    </div>
  );
}
