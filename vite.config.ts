import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A porta é fixa porque `tauri.conf.json` aponta para ela; se o Vite escolher
// outra ao encontrar a porta ocupada, a janela abre em branco.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "safari15",
    sourcemap: true,
  },
});
