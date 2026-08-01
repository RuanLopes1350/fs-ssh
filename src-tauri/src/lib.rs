pub mod cmd;
pub mod error;
pub mod keys;
pub mod ssh;
pub mod store;

use std::sync::Arc;

use tauri::Manager;

use cmd::AppState;
use ssh::SessionManager;
use store::Db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "fs_ssh_lib=info,russh=warn".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Sobras de crash de execuções anteriores podem conter segredos
            // (askpass, arquivos do "editar localmente").
            cmd::sftp::sweep_stale_temp_files();

            let dir = app.path().app_data_dir()?;
            let db = Arc::new(Db::open(&dir)?);
            app.manage(AppState {
                db,
                sessions: Arc::new(SessionManager::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // conexões, tags, temas, snippets
            cmd::conn::conn_list,
            cmd::conn::conn_get,
            cmd::conn::conn_save,
            cmd::conn::conn_delete,
            cmd::conn::db_backup,
            cmd::conn::folder_list,
            cmd::conn::folder_save,
            cmd::conn::folder_delete,
            cmd::conn::tag_list,
            cmd::conn::tag_save,
            cmd::conn::tag_delete,
            cmd::conn::theme_list,
            cmd::conn::theme_save,
            cmd::conn::theme_delete,
            cmd::conn::snippet_list,
            cmd::conn::snippet_save,
            cmd::conn::snippet_delete,
            cmd::conn::known_hosts_list,
            cmd::conn::known_hosts_forget,
            cmd::conn::host_key_trust,
            cmd::conn::sshconfig_read,
            cmd::conn::sshconfig_import,
            // sessões ssh
            cmd::ssh::ssh_connect,
            cmd::ssh::ssh_write,
            cmd::ssh::ssh_resize,
            cmd::ssh::ssh_disconnect,
            cmd::ssh::ssh_sessions,
            cmd::ssh::ssh_broadcast,
            cmd::ssh::ssh_ping,
            cmd::ssh::ssh_exec,
            cmd::ssh::docker_ps,
            // port forwarding
            cmd::forward::forward_list,
            cmd::forward::forward_save,
            cmd::forward::forward_delete,
            cmd::forward::forward_start,
            cmd::forward::forward_stop,
            cmd::forward::forward_active,
            cmd::forward::forward_autostart,
            // sftp
            cmd::sftp::sftp_list,
            cmd::sftp::sftp_home,
            cmd::sftp::sftp_download,
            cmd::sftp::sftp_upload,
            cmd::sftp::sftp_mkdir,
            cmd::sftp::sftp_rename,
            cmd::sftp::sftp_remove,
            cmd::sftp::sftp_chmod,
            cmd::sftp::sftp_edit_local,
            cmd::sftp::local_list,
            cmd::sftp::local_home,
            cmd::sftp::local_parent,
            cmd::sftp::local_read_text,
            // chaves
            cmd::keys::keys_list,
            cmd::keys::keys_generate,
            cmd::keys::keys_add_to_agent,
            cmd::keys::keys_install_on_host,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar a aplicação");
}
