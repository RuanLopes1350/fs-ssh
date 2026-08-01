/**
 * Converte `#rrggbb` (ou `#rgb`) em `rgba()` com a opacidade pedida.
 *
 * Feito em JS em vez de `color-mix()` no CSS porque o WKWebView do macOS 11/12
 * — o mínimo declarado no bundle — não suporta `color-mix`, e a cor viria
 * vazia em vez de errada, apagando a identidade visual da conexão.
 */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.trim().replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;

  if (full.length < 6 || /[^0-9a-f]/i.test(full.slice(0, 6))) {
    return `rgba(148, 163, 184, ${alpha})`; // fallback neutro
  }

  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
