/**
 * Detecção de plataforma no frontend e formatação de atalhos de teclado.
 * Mantém a UI fiel às convenções de macOS (⌘/⌥/⇧), Windows e Linux (Ctrl/Alt/Shift).
 */

export type Platform = "mac" | "windows" | "linux";

function detectPlatform(): Platform {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const raw = (
    nav.userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ""
  ).toLowerCase();

  if (raw.includes("win")) return "windows";
  if (raw.includes("mac") || raw.includes("darwin")) return "mac";
  return "linux";
}

export const PLATFORM: Platform = detectPlatform();
export const isMac = PLATFORM === "mac";
export const isWindows = PLATFORM === "windows";
export const isLinux = PLATFORM === "linux";

export const modSymbol = isMac ? "⌘" : "Ctrl";
export const altSymbol = isMac ? "⌥" : "Alt";
export const shiftSymbol = isMac ? "⇧" : "Shift";

export function modKey(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

export function modShiftKey(key: string): string {
  return isMac ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

export function modAltKey(key: string): string {
  return isMac ? `⌘⌥${key}` : `Ctrl+Alt+${key}`;
}

export function altKey(key: string): string {
  return isMac ? `⌥${key}` : `Alt+${key}`;
}

export function defaultShellPlaceholder(): string {
  if (isWindows) return "powershell.exe";
  if (isMac) return "/bin/zsh";
  return "/bin/bash";
}
