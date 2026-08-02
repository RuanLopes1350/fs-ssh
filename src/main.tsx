import React from "react";
import ReactDOM from "react-dom/client";

import "@xterm/xterm/css/xterm.css";
import "./tailwind.css";
import "./styles.css";
import App from "./App";

/**
 * Desliga o menu de contexto nativo do WKWebView.
 *
 * Num app de desktop ele só oferece "Recarregar"/"Inspecionar" e disputa espaço
 * com os menus da própria aplicação. Campos de texto ficam de fora — ali o menu
 * do sistema (copiar, colar, corrigir) é o comportamento certo.
 */
document.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement | null;
  if (el?.closest("input, textarea, [contenteditable='true'], .xterm")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
