use serde_json::json;

use super::models::Theme;

/// Paletas embutidas. O formato é exatamente o objeto `ITheme` do xterm.js, então
/// o frontend joga direto em `term.options.theme` sem conversão.
pub fn builtin() -> Vec<Theme> {
    vec![
        theme(
            "builtin-nord",
            "Nord",
            "#2e3440",
            "#d8dee9",
            "#d8dee9",
            "#434c5ecc",
            [
                "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0",
                "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead",
                "#8fbcbb", "#eceff4",
            ],
        ),
        theme(
            "builtin-dracula",
            "Dracula",
            "#282a36",
            "#f8f8f2",
            "#f8f8f2",
            "#44475abb",
            [
                "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd",
                "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df",
                "#a4ffff", "#ffffff",
            ],
        ),
        theme(
            "builtin-solarized-dark",
            "Solarized Dark",
            "#002b36",
            "#93a1a1",
            "#93a1a1",
            "#073642cc",
            [
                "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198",
                "#eee8d5", "#586e75", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4",
                "#93a1a1", "#fdf6e3",
            ],
        ),
        theme(
            "builtin-gruvbox-dark",
            "Gruvbox Dark",
            "#282828",
            "#ebdbb2",
            "#ebdbb2",
            "#504945cc",
            [
                "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a",
                "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b",
                "#8ec07c", "#ebdbb2",
            ],
        ),
        theme(
            "builtin-github-light",
            "GitHub Light",
            "#ffffff",
            "#24292f",
            "#24292f",
            "#0969da33",
            [
                "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83",
                "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9",
                "#3192aa", "#8c959f",
            ],
        ),
        // Vermelha, para marcar produção: o tema em si já é um aviso.
        theme(
            "builtin-prod-red",
            "Produção (vermelho)",
            "#1a0d0d",
            "#f5d0d0",
            "#ff6b6b",
            "#7f1d1dcc",
            [
                "#2d1414", "#ff5f5f", "#a3be8c", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff",
                "#f5d0d0", "#5c2e2e", "#ff8787", "#b9d4a0", "#f0c07a", "#9ab8f9", "#cdb0f9",
                "#a0dcff", "#ffffff",
            ],
        ),
    ]
}

fn theme(
    id: &str,
    name: &str,
    bg: &str,
    fg: &str,
    cursor: &str,
    selection: &str,
    ansi: [&str; 16],
) -> Theme {
    Theme {
        id: id.into(),
        name: name.into(),
        is_builtin: true,
        json: json!({
            "background": bg,
            "foreground": fg,
            "cursor": cursor,
            "cursorAccent": bg,
            "selectionBackground": selection,
            "black": ansi[0],
            "red": ansi[1],
            "green": ansi[2],
            "yellow": ansi[3],
            "blue": ansi[4],
            "magenta": ansi[5],
            "cyan": ansi[6],
            "white": ansi[7],
            "brightBlack": ansi[8],
            "brightRed": ansi[9],
            "brightGreen": ansi[10],
            "brightYellow": ansi[11],
            "brightBlue": ansi[12],
            "brightMagenta": ansi[13],
            "brightCyan": ansi[14],
            "brightWhite": ansi[15],
        }),
    }
}
