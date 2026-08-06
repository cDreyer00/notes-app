mod config;
mod notes;

use config::{Config, Shortcuts};
use notes::Note;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};
#[cfg(not(debug_assertions))]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Nome exibido no tray e no título das janelas. Com o app instalado rodando,
/// os dois ícones na bandeja são idênticos — o rótulo é o que diz qual é qual.
#[cfg(not(debug_assertions))]
const APP_LABEL: &str = "Notes";
#[cfg(debug_assertions)]
const APP_LABEL: &str = "Notes (dev)";

/// A chave de autostart no registro é uma só, com o nome do app. Mexer nela a
/// partir do binário de desenvolvimento faria o Windows subir o `target/debug`
/// no boot — ou, no `disable`, apagaria o autostart do app de verdade.
/// Em dev a preferência é gravada no settings, mas nunca aplicada no SO.
#[cfg(not(debug_assertions))]
fn apply_autostart(app: &AppHandle, enabled: bool) {
    let launcher = app.autolaunch();
    let _ = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
}

#[cfg(debug_assertions)]
fn apply_autostart(_app: &AppHandle, _enabled: bool) {}

/// Dois toques no atalho dentro desta janela de tempo significam "traga a
/// janela de volta para o centro" em vez de abrir e fechar em seguida.
const DOUBLE_PRESS_WINDOW: Duration = Duration::from_millis(350);

/// Instante do último acionamento do atalho global.
struct ShortcutTiming(Mutex<Option<Instant>>);

/// Arrastar a janela no Windows tira o foco do webview, o que seria confundido
/// com "clicou fora". Enquanto o arraste está fresco, o blur é ignorado.
struct DragState(Mutex<Option<Instant>>);

const DRAG_GRACE: Duration = Duration::from_millis(700);

fn mark_drag(app: &AppHandle) {
    if let Some(state) = app.try_state::<DragState>() {
        if let Ok(mut last) = state.0.lock() {
            *last = Some(Instant::now());
        }
    }
}

/// Janela fixada ignora o blur. Lido do disco a cada evento — o arquivo é
/// minúsculo e isso evita um segundo lugar onde o estado poderia divergir.
fn is_pinned(app: &AppHandle) -> bool {
    config::load(app).map(|cfg| cfg.pinned).unwrap_or(false)
}

fn is_dragging(app: &AppHandle) -> bool {
    app.try_state::<DragState>()
        .and_then(|state| state.0.lock().ok().and_then(|last| *last))
        .map(|instant| instant.elapsed() < DRAG_GRACE)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Posição da janela
// ---------------------------------------------------------------------------

/// O canto da janela cabe neste monitor? A folga de 8px para trás tolera o
/// desalinhamento de quem encostou a janela na borda; os 40px à frente garantem
/// que sobre faixa de arraste visível para trazê-la de volta.
fn corner_fits(origin: (i32, i32), size: (u32, u32), x: i32, y: i32) -> bool {
    x >= origin.0 - 8
        && y >= origin.1 - 8
        && x < origin.0 + size.0 as i32 - 40
        && y < origin.1 + size.1 as i32 - 40
}

/// Monitores mudam (notebook que desacopla, TV desligada). Uma posição salva
/// fora de qualquer tela deixaria a janela invisível para sempre.
fn position_is_visible(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };

    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        corner_fits((origin.x, origin.y), (size.width, size.height), x, y)
    })
}

fn restore_window_geometry(app: &AppHandle, window: &WebviewWindow) {
    let cfg = config::load(app).unwrap_or_default();

    // O tamanho vem antes da posição: redimensionar depois deslocaria a janela.
    if let Some((width, height)) = cfg.window_size {
        let _ = window.set_size(PhysicalSize::new(width, height));
    }

    if let Some((x, y)) = cfg.window_pos {
        if position_is_visible(window, x, y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    let _ = window.center();
}

fn save_window_geometry(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let Ok(mut cfg) = config::load(app) else {
        return;
    };

    let next_pos = Some((position.x, position.y));
    let next_size = Some((size.width, size.height));
    if cfg.window_pos == next_pos && cfg.window_size == next_size {
        return;
    }

    cfg.window_pos = next_pos;
    cfg.window_size = next_size;
    let _ = config::save(app, &cfg);
}

// ---------------------------------------------------------------------------
// Janelas
// ---------------------------------------------------------------------------

fn show_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Antes do `show` para a janela não piscar no lugar anterior.
    restore_window_geometry(app, &window);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("app-shown", ());
}

/// Recentraliza e mantém aberta. O gesto também redefine a posição salva —
/// caso contrário a próxima abertura voltaria para o canto de onde se fugiu.
fn center_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.center();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("app-shown", ());
    save_window_geometry(app);
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Dá ao frontend a chance de gravar o que ainda está no debounce.
        let _ = window.emit("app-hiding", ());
        save_window_geometry(app);
        let _ = window.hide();
    }
}

fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        hide_main(app);
    } else {
        show_main(app);
    }
}

fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        // A janela é reaproveitada; sem isto ela reabriria com dados velhos.
        let _ = window.emit("settings-shown", ());
    }
}

// ---------------------------------------------------------------------------
// Atalho global
// ---------------------------------------------------------------------------

/// Registra (e só ele) o atalho de abrir/ocultar. Os demais comandos são
/// tratados no frontend para não sequestrar combinações de outros programas.
fn register_toggle_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| format!("combinação inválida: {accelerator}"))?;

    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    manager
        .register(shortcut)
        .map_err(|_| format!("'{accelerator}' já está em uso por outro programa"))
}

// ---------------------------------------------------------------------------
// Comandos — configuração
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(app: AppHandle) -> Result<Config, String> {
    config::load(&app)
}

/// Salva atalhos e autostart. O registro do atalho global é validado **antes**
/// de gravar: se a combinação estiver tomada, nada muda e o erro sobe para a UI.
#[tauri::command]
fn save_config(
    app: AppHandle,
    shortcuts: Shortcuts,
    autostart: bool,
    trash_retention_days: u32,
) -> Result<Config, String> {
    let mut cfg = config::load(&app)?;
    let previous = cfg.shortcuts.toggle_app.clone();

    if shortcuts.toggle_app != previous {
        if let Err(err) = register_toggle_shortcut(&app, &shortcuts.toggle_app) {
            // Volta ao que funcionava para não deixar o app sem atalho nenhum.
            let _ = register_toggle_shortcut(&app, &previous);
            return Err(err);
        }
    }

    cfg.shortcuts = shortcuts;
    cfg.autostart = autostart;
    cfg.trash_retention_days = trash_retention_days;
    config::save(&app, &cfg)?;

    // Encurtar o prazo tem efeito imediato, não só no próximo boot.
    let _ = notes::purge_trash(&cfg.notes_dir, cfg.trash_retention_days);

    apply_autostart(&app, autostart);

    let _ = app.emit("config-changed", &cfg);
    Ok(cfg)
}

/// Troca a pasta de armazenamento. `move_existing` decide entre levar as notas
/// junto ou apenas passar a usar o novo local.
#[tauri::command]
fn set_notes_dir(app: AppHandle, path: PathBuf, move_existing: bool) -> Result<Config, String> {
    let mut cfg = config::load(&app)?;
    notes::ensure_dir(&path)?;

    // Grava um arquivo de teste: sem permissão de escrita, o app ficaria mudo.
    let probe = path.join(".notes-write-test");
    std::fs::write(&probe, b"")
        .map_err(|e| format!("sem permissão de escrita em {path:?}: {e}"))?;
    let _ = std::fs::remove_file(&probe);

    if move_existing {
        notes::move_all(&cfg.notes_dir, &path)?;
    }

    cfg.notes_dir = path;
    config::save(&app, &cfg)?;
    let _ = app.emit("config-changed", &cfg);
    Ok(cfg)
}

// ---------------------------------------------------------------------------
// Comandos — notas
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_notes(app: AppHandle) -> Result<Vec<Note>, String> {
    let cfg = config::load(&app)?;
    notes::list(&cfg.notes_dir)
}

#[tauri::command]
fn create_note(app: AppHandle) -> Result<Note, String> {
    let cfg = config::load(&app)?;
    notes::create(&cfg.notes_dir)
}

#[tauri::command]
fn save_note(app: AppHandle, id: String, content: String) -> Result<u128, String> {
    let cfg = config::load(&app)?;
    notes::save(&cfg.notes_dir, &id, &content)
}

#[tauri::command]
fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    let cfg = config::load(&app)?;
    notes::delete(&cfg.notes_dir, &id)
}

#[tauri::command]
fn restore_note(app: AppHandle, id: String) -> Result<(), String> {
    let cfg = config::load(&app)?;
    notes::restore(&cfg.notes_dir, &id)
}

/// Remove sem passar pela lixeira — usado para descartar notas deixadas vazias.
#[tauri::command]
fn purge_note(app: AppHandle, id: String) -> Result<(), String> {
    let cfg = config::load(&app)?;
    notes::purge(&cfg.notes_dir, &id)
}

#[tauri::command]
fn trash_count(app: AppHandle) -> Result<usize, String> {
    let cfg = config::load(&app)?;
    notes::trash_count(&cfg.notes_dir)
}

#[tauri::command]
fn empty_trash(app: AppHandle) -> Result<usize, String> {
    let cfg = config::load(&app)?;
    notes::empty_trash(&cfg.notes_dir)
}

// ---------------------------------------------------------------------------
// Comandos — janelas
// ---------------------------------------------------------------------------

#[tauri::command]
fn hide_app(app: AppHandle) {
    hide_main(&app);
}

/// Inicia o arraste da janela registrando que ele começou, para o blur que vem
/// logo em seguida não ser tratado como clique fora.
#[tauri::command]
fn begin_drag(app: AppHandle) {
    mark_drag(&app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.start_dragging();
    }
}

/// Mesmo motivo do `begin_drag`: as bordas nativas são tratadas pelo sistema e
/// nenhum evento chega ao webview a tempo de marcar que a interação começou.
/// O redimensionamento em si é disparado pelo frontend, que sabe qual borda foi
/// agarrada — `start_resize_dragging` não é exposto no `WebviewWindow` do Rust.
#[tauri::command]
fn begin_resize(app: AppHandle) {
    mark_drag(&app);
}

/// Fixa ou solta a janela. Fica na config porque é preferência, não estado
/// momentâneo: quem fixou espera continuar fixado depois de reabrir o app.
#[tauri::command]
fn set_pinned(app: AppHandle, pinned: bool) -> Result<Config, String> {
    let mut cfg = config::load(&app)?;
    cfg.pinned = pinned;
    config::save(&app, &cfg)?;
    let _ = app.emit("config-changed", &cfg);
    Ok(cfg)
}

/// Versão vinda do `Cargo.toml`, a única fonte do número no projeto. Com duas
/// cópias do app rodando (a instalada e a de dev), precisa dar para ver qual é
/// qual sem adivinhar.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings(&app);
}

#[tauri::command]
fn close_settings(app: AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    save_window_geometry(&app);
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
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
                save_window_geometry(app);
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
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }

                    let timing = app.state::<ShortcutTiming>();
                    let now = Instant::now();
                    let double_press = {
                        let mut last = timing.0.lock().unwrap();
                        let recent = last
                            .map(|previous| now.duration_since(previous) < DOUBLE_PRESS_WINDOW)
                            .unwrap_or(false);
                        *last = Some(now);
                        recent
                    };

                    if double_press {
                        center_main(app);
                    } else {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            set_notes_dir,
            list_notes,
            create_note,
            save_note,
            delete_note,
            restore_note,
            purge_note,
            trash_count,
            empty_trash,
            hide_app,
            begin_drag,
            begin_resize,
            set_pinned,
            app_version,
            open_settings,
            close_settings,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = config::load(&handle).unwrap_or_default();

            app.manage(ShortcutTiming(Mutex::new(None)));
            app.manage(DragState(Mutex::new(None)));

            notes::ensure_dir(&cfg.notes_dir).ok();
            // Lixeira vencida sai na abertura: é o único momento garantido em
            // que o app roda sem ninguém esperando por ele.
            let _ = notes::purge_trash(&cfg.notes_dir, cfg.trash_retention_days);
            build_tray(&handle)?;

            if let Err(err) = register_toggle_shortcut(&handle, &cfg.shortcuts.toggle_app) {
                // Sem atalho o app ainda abre pelo tray; não é motivo para abortar.
                eprintln!("[notes] atalho global não registrado: {err}");
            }

            apply_autostart(&handle, cfg.autostart);

            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.set_title(APP_LABEL);
                let win_handle = handle.clone();
                window.on_window_event(move |event| match event {
                    // Clicar fora esconde o app; o autosave garante que nada se perde.
                    WindowEvent::Focused(false) => {
                        if !is_dragging(&win_handle) && !is_pinned(&win_handle) {
                            hide_main(&win_handle);
                        }
                    }
                    // Cada movimento renova a carência: arrastar ou redimensionar
                    // por vários segundos não pode expirar no meio do caminho.
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        if is_dragging(&win_handle) {
                            mark_drag(&win_handle);
                        }
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        hide_main(&win_handle);
                    }
                    _ => {}
                });
            }

            // A janela de configurações fica escondida, nunca destruída: ela é
            // declarada na config e não seria recriada depois de fechada.
            if let Some(window) = handle.get_webview_window("settings") {
                let _ = window.set_title(&format!("{APP_LABEL} — Configurações"));
                let settings_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = settings_window.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::corner_fits;

    const PRIMARIO: ((i32, i32), (u32, u32)) = ((0, 0), (1920, 1080));
    /// Segundo monitor à esquerda: origem negativa, o caso que o Windows produz.
    const ESQUERDA: ((i32, i32), (u32, u32)) = ((-1920, 0), (1920, 1080));

    #[test]
    fn posicao_dentro_do_monitor_e_valida() {
        assert!(corner_fits(PRIMARIO.0, PRIMARIO.1, 0, 0));
        assert!(corner_fits(PRIMARIO.0, PRIMARIO.1, 900, 500));
        assert!(corner_fits(ESQUERDA.0, ESQUERDA.1, -1000, 300));
    }

    /// O monitor sumiu (notebook desacoplado): a posição salva do que era o
    /// segundo monitor não pode passar no teste do que sobrou.
    #[test]
    fn posicao_de_monitor_que_sumiu_e_recusada() {
        assert!(!corner_fits(PRIMARIO.0, PRIMARIO.1, -1000, 300));
        assert!(!corner_fits(PRIMARIO.0, PRIMARIO.1, 2400, 300));
        assert!(!corner_fits(PRIMARIO.0, PRIMARIO.1, 900, 2000));
    }

    /// Janela encostada na borda de baixo ou da direita não conta como visível:
    /// sem a faixa de arraste na tela não haveria como trazê-la de volta.
    #[test]
    fn canto_colado_na_borda_nao_conta_como_visivel() {
        assert!(corner_fits(PRIMARIO.0, PRIMARIO.1, 1879, 1039));
        assert!(!corner_fits(PRIMARIO.0, PRIMARIO.1, 1880, 1039));
        assert!(!corner_fits(PRIMARIO.0, PRIMARIO.1, 1879, 1040));
    }

    #[test]
    fn folga_pequena_para_fora_e_tolerada() {
        assert!(corner_fits(PRIMARIO.0, PRIMARIO.1, -8, -8));
        assert!(!corner_fits(PRIMARIO.0, PRIMARIO.1, -9, 0));
    }
}
