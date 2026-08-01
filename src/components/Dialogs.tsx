import { useEffect, useRef, useState } from "react";
import { AlertTriangle, KeyRound, ShieldQuestion } from "lucide-react";

import type { AuthPrompt, HostKeyPrompt } from "../lib/types";

export function Modal({
  title,
  icon,
  wide,
  tall,
  children,
  footer,
  onClose,
}: {
  title: string;
  icon?: React.ReactNode;
  wide?: boolean;
  /** Altura fixa — para modais com abas, evita o "pulo" ao trocar de aba. */
  tall?: boolean;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={[
          "modal",
          wide ? "modal--wide" : "",
          tall ? "modal--tall" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="modal__head">
          {icon}
          {title}
        </div>
        <div className="modal__body">{children}</div>
        <div className="modal__foot">{footer}</div>
      </div>
    </div>
  );
}

/**
 * Diálogo TOFU.
 *
 * Chave nova e chave alterada usam textos e cores diferentes de propósito: a
 * primeira é rotina, a segunda pode ser um ataque em andamento. Tratar as duas
 * com o mesmo "Aceitar?" ensinaria o usuário a ignorar o alerta que importa.
 */
export function HostKeyDialog({
  prompt,
  onTrust,
  onCancel,
}: {
  prompt: HostKeyPrompt;
  onTrust: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={prompt.changed ? "A host key mudou" : "Host desconhecido"}
      icon={
        prompt.changed ? (
          <AlertTriangle size={16} color="var(--danger)" />
        ) : (
          <ShieldQuestion size={16} color="var(--warn)" />
        )
      }
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className={prompt.changed ? "btn btn--danger" : "btn btn--primary"}
            onClick={onTrust}
          >
            {prompt.changed ? "Confio mesmo assim" : "Confiar e conectar"}
          </button>
        </>
      }
    >
      {prompt.changed ? (
        <div className="alert alert--danger">
          A chave de <b>{prompt.host}</b> não é a mesma registrada antes. Isso acontece
          quando o servidor foi reinstalado — ou quando alguém está interceptando a
          conexão. Confirme o fingerprint por um canal fora deste computador antes de
          continuar.
        </div>
      ) : (
        <div className="alert alert--warn">
          Primeira conexão com <b>{prompt.host}</b>. Confirme que o fingerprint abaixo é o
          do servidor (ex.: <code>ssh-keygen -lf /etc/ssh/ssh_host_{"{tipo}"}_key.pub</code>{" "}
          na máquina).
        </div>
      )}

      <div className="field">
        <label>Fingerprint apresentado ({prompt.algorithm})</label>
        <div className="fingerprint">{prompt.fingerprint}</div>
      </div>

      {prompt.changed && prompt.knownFingerprint && (
        <div className="field">
          <label>Fingerprint que estava registrado</label>
          <div className="fingerprint">{prompt.knownFingerprint}</div>
        </div>
      )}
    </Modal>
  );
}

export function AuthDialog({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: AuthPrompt;
  onSubmit: (secret: string) => void;
  onCancel: () => void;
}) {
  const [secret, setSecret] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => ref.current?.focus(), []);

  const base = prompt.authKind === "passphrase" ? "Passphrase da chave" : "Senha";
  return (
    <Modal
      title={prompt.forJump ? `${base} — jump host` : base}
      icon={<KeyRound size={16} color="var(--accent)" />}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={() => onSubmit(secret)}>
            Entrar
          </button>
        </>
      }
    >
      <div className="field">
        <label>{prompt.prompt}</label>
        <input
          ref={ref}
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit(secret)}
        />
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        O segredo é usado uma vez para autenticar e não fica guardado.
      </div>
    </Modal>
  );
}

/** Substituto do `window.prompt` com a cara do app. Enter confirma. */
export function InputDialog({
  title,
  label,
  initial = "",
  placeholder,
  confirmLabel = "OK",
  password = false,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  password?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
  };

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{label}</label>
        <input
          ref={ref}
          type={password ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
    </Modal>
  );
}

/** Indicador de atividade discreto (CSS puro, veja `.spinner`). */
export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirmar",
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      icon={danger ? <AlertTriangle size={16} color="var(--danger)" /> : undefined}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className={danger ? "btn btn--danger" : "btn btn--primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div>{message}</div>
    </Modal>
  );
}
