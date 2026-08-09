//! Ícone na área de notificação e seu menu de contexto.
//!
//! É a única porta de entrada do app que não depende de atalho: se o registro
//! do atalho global falhar (outro programa já tem a combinação), é por aqui
//! que o usuário ainda consegue abrir e fechar o Notes.

use crate::window::{save_all_geometry, show_all, show_settings};
use crate::APP_LABEL;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

pub(crate) fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings_item = MenuItem::with_id(app, "settings", "Configurações", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Fechar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("notes-tray")
        .tooltip(APP_LABEL)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => show_settings(app),
            "quit" => {
                save_all_geometry(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_all(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}
