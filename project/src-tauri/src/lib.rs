//! Montagem do app e a superfície de comandos que o frontend enxerga.
//!
//! O que é mecânica de janela mora em `window.rs`, o tray em `tray.rs`, e o
//! disco em `notes.rs`/`config.rs`. Aqui ficam só o `run()` que amarra tudo, o
//! atalho global e os `#[tauri::command]` — que são casca fina por decisão: um
//! comando lê a config, delega e emite o evento correspondente.

mod config;
mod notes;
mod tray;
mod window;

use config::{Config, DetachedWindow, Shortcuts};
use notes::Note;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent};
#[cfg(not(debug_assertions))]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tray::build_tray;
use window::{
    attach_notes_window_events, build_note_window, center_main, cleanup_detached,
    close_note_window, detached_ids, hide_all, mark_drag, prune_detached, save_all_geometry,
    saved_geometry, show_settings, toggle_app, DragState, HideGeneration,
};

/// Nome exibido no tray e no título das janelas. Com o app instalado rodando,
/// os dois ícones na bandeja são idênticos — o rótulo é o que diz qual é qual.
#[cfg(not(debug_assertions))]
pub(crate) const APP_LABEL: &str = "Notes";
#[cfg(debug_assertions)]
pub(crate) const APP_LABEL: &str = "Notes (dev)";

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

// ---------------------------------------------------------------------------
// Atalho global
// ---------------------------------------------------------------------------

/// Dois toques no atalho dentro desta janela de tempo significam "traga a
/// janela de volta para o centro" em vez de abrir e fechar em seguida.
const DOUBLE_PRESS_WINDOW: Duration = Duration::from_millis(350);

/// Instante do último acionamento do atalho global.
struct ShortcutTiming(Mutex<Option<Instant>>);

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

/// Deletar acontece de três lugares (editor da principal, card da grid,
/// janela destacada) e em todos eles a nota deixa de existir. Fechar aqui a
/// janela destacada dela, se houver, é o que impede o caso feio: uma janela
/// viva editando um arquivo que já foi para a lixeira — o primeiro autosave
/// dali recriaria a nota deletada.
#[tauri::command]
fn delete_note(window: WebviewWindow, app: AppHandle, id: String) -> Result<(), String> {
    let cfg = config::load(&app)?;
    notes::delete(&cfg.notes_dir, &id)?;
    close_note_window(&app, &id);

    // Quem deletou de dentro de uma janela destacada fica sem o "desfazer": a
    // janela morre no comando e o toast mora na grid. A principal exibe por
    // ela — é a rede de segurança que a exclusão promete em qualquer lugar.
    if window.label() != "main" {
        let _ = app.emit_to("main", "note-deleted", &id);
    }
    Ok(())
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
    hide_all(&app);
}

/// Inicia o arraste da janela que chamou o comando, registrando que ele
/// começou, para o blur que vem logo em seguida não ser tratado como clique
/// fora. `window` é injetado pelo Tauri como a própria janela chamadora — não
/// precisa mais ser sempre "main", agora que notas destacadas também arrastam.
#[tauri::command]
fn begin_drag(window: WebviewWindow) {
    mark_drag(window.app_handle(), window.label());
    let _ = window.start_dragging();
}

/// Mesmo motivo do `begin_drag`: as bordas nativas são tratadas pelo sistema e
/// nenhum evento chega ao webview a tempo de marcar que a interação começou.
/// O redimensionamento em si é disparado pelo frontend, que sabe qual borda foi
/// agarrada — `start_resize_dragging` não é exposto no `WebviewWindow` do Rust.
#[tauri::command]
fn begin_resize(window: WebviewWindow) {
    mark_drag(window.app_handle(), window.label());
}

/// Fixa ou solta o app inteiro. Fica na config porque é preferência, não
/// estado momentâneo: quem fixou espera continuar fixado depois de reabrir.
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
    save_all_geometry(&app);
    app.exit(0);
}

/// Destaca uma nota em janela própria. Se ela já estiver destacada, só foca a
/// janela existente em vez de duplicar. `x`/`y`, quando vêm de um arraste
/// solto fora da grid, centralizam a janela nova sob o ponto do drop; sem
/// eles (atalho de teclado, sem gesto de arrastar) ela nasce centralizada na
/// tela.
///
/// A criação em si (`.build()`) roda numa thread solta, fora do runtime do
/// Tauri — nem direto no handler síncrono, nem via `run_on_main_thread`.
/// As duas travam no Windows: `wry#583` documenta que criar uma `WebviewWindow`
/// em qualquer thread que o próprio Tauri já usa pra despachar comandos ou
/// pra rodar a fila de eventos impede a inicialização do WebView2 de
/// completar, porque ela mesma depende dessa fila pra terminar. Só depois de
/// pronta a janela volta pra thread principal via `run_on_main_thread` — aí
/// sim, porque posicionar/mostrar/focar (ao contrário de criar) não brigam
/// com a fila, e feitas fora da thread principal não têm efeito de verdade.
#[tauri::command]
async fn detach_note(
    app: AppHandle,
    id: String,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<(), String> {
    // O id vira label de janela, query string e chave no `settings.json`.
    // Chega pronto do nosso frontend, mas é a mesma validação que todo o
    // resto do app aplica antes de deixar um id virar caminho.
    notes::validate_id(&id)?;

    let label = format!("note-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    // Só a geometria é lida agora — a config volta a ser lida lá embaixo, na
    // hora de gravar, porque criar a janela leva tempo demais para confiar
    // nesta cópia.
    let (saved_pos, saved_size) = saved_geometry(&config::load(&app)?, &label);

    // Só a construção em si roda na thread solta. Posicionar, mostrar e
    // focar são operações leves que, feitas fora da thread principal, não
    // travam — mas também não fazem efeito de verdade (a janela nasce e
    // fica invisível). Voltam pra thread principal via `run_on_main_thread`.
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<WebviewWindow, String>>(1);
    let thread_app = app.clone();
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let outcome = build_note_window(&thread_app, &thread_id, saved_size)
            .map_err(|e| format!("não foi possível criar a janela: {e}"));
        let _ = tx.blocking_send(outcome);
    });

    let window = rx
        .recv()
        .await
        .ok_or_else(|| "a criação da janela não respondeu".to_string())??;

    let main_thread_app = app.clone();
    app.run_on_main_thread(move || {
        match saved_pos {
            Some((px, py)) => {
                let _ = window.set_position(PhysicalPosition::new(px, py));
            }
            None => match (x, y) {
                (Some(px), Some(py)) => {
                    if let Ok(size) = window.outer_size() {
                        let nx = px - size.width as i32 / 2;
                        let ny = py - size.height as i32 / 2;
                        let _ = window.set_position(PhysicalPosition::new(nx, ny));
                    }
                }
                _ => {
                    let _ = window.center();
                }
            },
        }

        attach_notes_window_events(&main_thread_app, &window);
        let _ = window.show();
        let _ = window.set_focus();
    })
    .map_err(|e| format!("não foi possível exibir a janela: {e}"))?;

    // Relida só agora: entre o começo deste comando e aqui passaram-se as
    // centenas de milissegundos da criação da janela, e gravar por cima de
    // uma cópia daquela idade desfaria o que outra janela salvou no meio —
    // a posição da principal ao ser movida, o pino, outra nota destacada.
    let mut cfg = config::load(&app)?;
    if !cfg.detached.iter().any(|entry| entry.note_id == id) {
        cfg.detached.push(DetachedWindow {
            note_id: id,
            pos: None,
            size: None,
        });
        config::save(&app, &cfg)?;
        let _ = app.emit("detached-changed", detached_ids(&cfg));
    }
    Ok(())
}

/// Foca a principal e pede que ela execute um comando por conta própria.
/// Usado pelas janelas de nota destacada: lá, só deletar é local — nova
/// nota, alternar visão e fixar sempre acontecem na principal.
///
/// `emit_to` e não `emit`: no Tauri v2 o `emit` de uma janela é broadcast
/// para todas, então o comando chegaria também às destacadas. Hoje nenhuma
/// escuta, mas elas compartilham o resto da fiação com a principal — e o dia
/// em que uma copiasse este listener, o comando rodaria N vezes.
#[tauri::command]
fn focus_main(app: AppHandle, action: String) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        let _ = app.emit_to("main", "remote-command", action);
    }
}

/// Fecha a janela de uma nota destacada. A limpeza da composição salva
/// acontece no `CloseRequested` de `attach_notes_window_events`, disparado
/// por este `close()` — um único caminho, seja o fechamento pedido daqui
/// (clique no card da grid) ou de dentro da própria janela destacada.
///
/// Sem janela, a entrada salva está órfã: a criação falhou, ou a nota sumiu
/// do disco por fora do app. Aí a limpeza é feita direto, senão o card
/// ficaria tracejado para sempre e o clique nele não teria efeito nenhum —
/// sem janela não há `CloseRequested` para disparar.
#[tauri::command]
fn undetach_note(app: AppHandle, id: String) -> Result<(), String> {
    notes::validate_id(&id)?;
    if !close_note_window(&app, &id) {
        cleanup_detached(&app, &id);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

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
                        toggle_app(app);
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
            quit_app,
            detach_note,
            undetach_note,
            focus_main
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let mut cfg = config::load(&handle).unwrap_or_default();

            app.manage(ShortcutTiming(Mutex::new(None)));
            app.manage(DragState(Mutex::new(HashMap::new())));
            app.manage(HideGeneration(Mutex::new(0)));

            notes::ensure_dir(&cfg.notes_dir).ok();
            // Lixeira vencida sai na abertura: é o único momento garantido em
            // que o app roda sem ninguém esperando por ele.
            let _ = notes::purge_trash(&cfg.notes_dir, cfg.trash_retention_days);

            // Mesma oportunidade para a composição salva: nota que sumiu do
            // disco enquanto o app estava fechado não vira janela fantasma.
            if let Ok(on_disk) = notes::list(&cfg.notes_dir) {
                let ids: HashSet<String> = on_disk.into_iter().map(|note| note.id).collect();
                let before = cfg.detached.len();
                cfg.detached = prune_detached(std::mem::take(&mut cfg.detached), &ids);
                if cfg.detached.len() != before {
                    let _ = config::save(&handle, &cfg);
                }
            }
            build_tray(&handle)?;

            if let Err(err) = register_toggle_shortcut(&handle, &cfg.shortcuts.toggle_app) {
                // Sem atalho o app ainda abre pelo tray; não é motivo para abortar.
                eprintln!("[notes] atalho global não registrado: {err}");
            }

            apply_autostart(&handle, cfg.autostart);

            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.set_title(APP_LABEL);
                attach_notes_window_events(&handle, &window);
            }

            // Recria, ainda escondida, cada janela de nota que estava
            // destacada da última vez que o app rodou — é o que dá a
            // composição de janelas restaurada ao reabrir.
            for entry in &cfg.detached {
                if let Ok(window) = build_note_window(&handle, &entry.note_id, entry.size) {
                    if let Some((x, y)) = entry.pos {
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                    }
                    attach_notes_window_events(&handle, &window);
                }
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
