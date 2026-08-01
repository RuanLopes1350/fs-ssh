// Evita abrir um console extra no Windows em release. Inofensivo no macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fs_ssh_lib::run()
}
