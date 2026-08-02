import { useState } from "react";
import { DatabaseBackup, Settings as SettingsIcon } from "lucide-react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";

import { Modal, Spinner } from "./Dialogs";
import { api, asAppError } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";

/** Preferências do app (⌘,). Tudo persiste localmente entre sessões. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
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
    <Modal
      title="Configurações"
      icon={<SettingsIcon size={16} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <button className="btn btn--primary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <div className="row">
        <div className="field" style={{ maxWidth: 180 }}>
          <label>Tamanho da fonte do terminal (⌘+ / ⌘−)</label>
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
            placeholder="vazio = $SHELL do sistema"
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
        "autoRecord",
        "Gravar todas as sessões automaticamente",
        "Salva a saída do terminal em arquivos de texto (0600) na pasta de gravações. Cuidado: registra tudo que aparece na tela, inclusive segredos. As gravações ficam no painel de gestão → Gravações.",
      )}

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
    </Modal>
  );
}
