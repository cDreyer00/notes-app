mod config;
mod notes;

use config::{Config, DetachedWindow, Shortcuts};
use notes::Note;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Theme, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
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

/// Arrastar uma janela tira o foco do webview dela, o que seria confundido
/// com "clicou fora". Enquanto o arraste está fresco, o blur é ignorado.
/// Chaveado por label porque várias janelas do app podem existir ao mesmo
/// tempo — arrastar uma nota destacada não pode afetar a principal.
struct DragState(Mutex<HashMap<String, Instant>>);

const DRAG_GRACE: Duration = Duration::from_millis(700);

/// Perder o foco agenda esconder o app inteiro depois desta folga. Trocar o
/// foco entre duas janelas do próprio Notes gera um blur seguido de um focus
/// quase imediato — a checagem, feita só quando o prazo vence, não depende da
/// ordem de chegada dos dois eventos.
const HIDE_DEBOUNCE: Duration = Duration::from_millis(150);

/// Tamanho padrão de uma janela de nota destacada, usado quando ela nasce sem
/// tamanho salvo (primeira vez que aquela nota é destacada).
const DEFAULT_NOTE_SIZE: (u32, u32) = (560, 460);

fn mark_drag(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<DragState>() {
        if let Ok(mut map) = state.0.lock() {
            map.insert(label.to_string(), Instant::now());
        }
    }
}

fn is_dragging(app: &AppHandle, label: &str) -> bool {
    app.try_state::<DragState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .and_then(|map| map.get(label).copied())
        })
        .map(|instant| instant.elapsed() < DRAG_GRACE)
        .unwrap_or(false)
}

/// Janela fixada ignora o blur. Lido do disco a cada evento — o arquivo é
/// minúsculo e isso evita um segundo lugar onde o estado poderia divergir.
/// Vale pra principal e todas as destacadas juntas, não é preferência por
/// janela.
fn is_pinned(app: &AppHandle) -> bool {
    config::load(app).map(|cfg| cfg.pinned).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Identificação de janelas
// ---------------------------------------------------------------------------

/// A principal e qualquer nota destacada participam do ciclo esconder/mostrar
/// em conjunto. A janela de configurações fica de fora — sempre teve seu
/// próprio ciclo de vida, independente.
fn is_notes_window(label: &str) -> bool {
    label == "main" || label.starts_with("note-")
}

fn window_note_id(label: &str) -> Option<&str> {
    label.strip_prefix("note-")
}

fn any_notes_window_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .iter()
        .any(|(label, window)| is_notes_window(label) && window.is_focused().unwrap_or(false))
}

// ---------------------------------------------------------------------------
// Posição e tamanho
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

/// Geometria salva de uma janela: da principal (`window_pos`/`window_size`) ou
/// da entrada correspondente em `detached`, pelo id embutido no label.
fn saved_geometry(cfg: &Config, label: &str) -> (Option<(i32, i32)>, Option<(u32, u32)>) {
    match window_note_id(label) {
        Some(note_id) => cfg
            .detached
            .iter()
            .find(|d| d.note_id == note_id)
            .map(|d| (d.pos, d.size))
            .unwrap_or((None, None)),
        None => (cfg.window_pos, cfg.window_size),
    }
}

fn restore_geometry(app: &AppHandle, window: &WebviewWindow) {
    let cfg = config::load(app).unwrap_or_default();
    let (pos, size) = saved_geometry(&cfg, window.label());

    // O tamanho vem antes da posição: redimensionar depois deslocaria a janela.
    if let Some((width, height)) = size {
        let _ = window.set_size(PhysicalSize::new(width, height));
    }

    if let Some((x, y)) = pos {
        if position_is_visible(window, x, y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    let _ = window.center();
}

fn save_geometry(app: &AppHandle, window: &WebviewWindow) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let Ok(mut cfg) = config::load(app) else {
        return;
    };

    let next_pos = Some((position.x, position.y));
    let next_size = Some((size.width, size.height));

    match window_note_id(window.label()) {
        Some(note_id) => {
            let Some(entry) = cfg.detached.iter_mut().find(|d| d.note_id == note_id) else {
                // A nota já não está mais destacada (undetach concorrente);
                // não há entrada pra atualizar.
                return;
            };
            if entry.pos == next_pos && entry.size == next_size {
                return;
            }
            entry.pos = next_pos;
            entry.size = next_size;
        }
        None => {
            if cfg.window_pos == next_pos && cfg.window_size == next_size {
                return;
            }
            cfg.window_pos = next_pos;
            cfg.window_size = next_size;
        }
    }

    let _ = config::save(app, &cfg);
}

fn save_all_geometry(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if is_notes_window(&label) {
            save_geometry(app, &window);
        }
    }
}

// ---------------------------------------------------------------------------
// Esconder / mostrar o app inteiro
// ---------------------------------------------------------------------------

/// Esconde a principal e todas as destacadas juntas — nenhuma é destruída,
/// só ficam invisíveis até o próximo `show_all`. Um único emit global evita
/// disparar o mesmo evento uma vez por janela.
fn hide_all(app: &AppHandle) {
    let _ = app.emit("app-hiding", ());
    for (label, window) in app.webview_windows() {
        if is_notes_window(&label) {
            save_geometry(app, &window);
            let _ = window.hide();
        }
    }
}

fn show_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if is_notes_window(&label) {
            restore_geometry(app, &window);
            let _ = window.unminimize();
            let _ = window.show();
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    let _ = app.emit("app-shown", ());
}

/// Perder o foco agenda esta checagem depois de uma folga: se, no momento em
/// que ela dispara, nenhuma janela do Notes estiver focada, o app inteiro
/// esconde. Não depende de saber qual janela ganhou o foco a seguir — só do
/// estado no fim do prazo, o que também cobre trocar de janela dentro do
/// próprio app sem esconder nada.
fn schedule_hide_check(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HIDE_DEBOUNCE);
        if !any_notes_window_focused(&handle) && !is_pinned(&handle) {
            hide_all(&handle);
        }
    });
}

/// Recentraliza a principal e mantém tudo aberto — o duplo toque é "traga o
/// app de volta por completo", não só a janela principal. O gesto também
/// redefine a posição salva da principal, senão a próxima abertura voltaria
/// para o canto de onde se fugiu.
fn center_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.center();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    save_geometry(app, &window);

    for (label, other) in app.webview_windows() {
        if label != "main" && is_notes_window(&label) {
            restore_geometry(app, &other);
            let _ = other.unminimize();
            let _ = other.show();
        }
    }
    let _ = app.emit("app-shown", ());
}

fn toggle_app(app: &AppHandle) {
    if app.get_webview_window("main").is_none() {
        return;
    }
    if any_notes_window_focused(app) {
        hide_all(app);
    } else {
        show_all(app);
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
// Janelas de nota destacada
// ---------------------------------------------------------------------------

fn detached_ids(cfg: &Config) -> Vec<String> {
    cfg.detached.iter().map(|d| d.note_id.clone()).collect()
}

/// Constrói (sem mostrar) a janela de uma nota destacada, no mesmo perfil da
/// principal: sem decoração nativa (o app inteiro é frameless), sempre por
/// cima e fora da barra de tarefas, pra continuar visível enquanto se usa
/// outro programa — o próprio motivo de existir do destacar.
fn build_note_window(
    app: &AppHandle,
    note_id: &str,
    size: Option<(u32, u32)>,
) -> tauri::Result<WebviewWindow> {
    let label = format!("note-{note_id}");
    let (width, height) = size.unwrap_or(DEFAULT_NOTE_SIZE);
    WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("note.html?id={note_id}").into()),
    )
    .title(APP_LABEL)
    .inner_size(width as f64, height as f64)
    .min_inner_size(320.0, 240.0)
    .decorations(false)
    .resizable(true)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .theme(Some(Theme::Dark))
    .build()
}

/// Remove a nota da composição salva e avisa a principal a re-estilizar o
/// card. Não destrói a janela — quem chama já está fechando ela de verdade
/// (evento nativo de close) ou nunca chegou a criar uma.
fn cleanup_detached(app: &AppHandle, note_id: &str) {
    let Ok(mut cfg) = config::load(app) else {
        return;
    };
    cfg.detached.retain(|d| d.note_id != note_id);
    if config::save(app, &cfg).is_ok() {
        let _ = app.emit("detached-changed", detached_ids(&cfg));
    }
}

/// Registra os eventos comuns a qualquer janela do app (principal ou nota
/// destacada). O que muda por tipo é só o fechamento: a principal nunca fecha
/// de fato (vira esconder o app inteiro); a destacada fecha de verdade, e o
/// que precisa sobreviver a isso é a composição salva.
fn attach_notes_window_events(app: &AppHandle, window: &WebviewWindow) {
    let handle = app.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            if !is_dragging(&handle, &label) {
                schedule_hide_check(&handle);
            }
        }
        // Cada movimento renova a carência: arrastar ou redimensionar por
        // vários segundos não pode expirar no meio do caminho.
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if is_dragging(&handle, &label) {
                mark_drag(&handle, &label);
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            if let Some(note_id) = window_note_id(&label) {
                // Deixa fechar de verdade — só atualiza o que precisa
                // sobreviver ao fechamento antes que a janela suma.
                cleanup_detached(&handle, note_id);
            } else {
                api.prevent_close();
                hide_all(&handle);
            }
        }
        _ => {}
    });
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
    let label = format!("note-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let mut cfg = config::load(&app)?;
    let existing = cfg.detached.iter().find(|d| d.note_id == id).cloned();
    let saved_pos = existing.as_ref().and_then(|e| e.pos);
    let saved_size = existing.as_ref().and_then(|e| e.size);

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

    if existing.is_none() {
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
#[tauri::command]
fn focus_main(app: AppHandle, action: String) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        let _ = main.emit("remote-command", action);
    }
}

/// Fecha a janela de uma nota destacada. A limpeza da composição salva
/// acontece no `CloseRequested` de `attach_notes_window_events`, disparado
/// por este `close()` — um único caminho, seja o fechamento pedido daqui
/// (clique no card da grid) ou de dentro da própria janela destacada.
#[tauri::command]
fn undetach_note(app: AppHandle, id: String) {
    if let Some(window) = app.get_webview_window(&format!("note-{id}")) {
        let _ = window.close();
    }
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
            let cfg = config::load(&handle).unwrap_or_default();

            app.manage(ShortcutTiming(Mutex::new(None)));
            app.manage(DragState(Mutex::new(HashMap::new())));

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

#[cfg(test)]
mod tests {
    use super::*;

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

    // -----------------------------------------------------------------------
    // Identificação de janelas
    // -----------------------------------------------------------------------

    #[test]
    fn reconhece_a_principal_e_as_destacadas() {
        assert!(is_notes_window("main"));
        assert!(is_notes_window("note-n123"));
        assert!(!is_notes_window("settings"));
        assert!(!is_notes_window("note")); // sem o hífen, não é uma nota
    }

    #[test]
    fn extrai_o_id_da_nota_do_label_da_janela() {
        assert_eq!(window_note_id("note-n123"), Some("n123"));
        assert_eq!(window_note_id("main"), None);
        assert_eq!(window_note_id("settings"), None);
    }

    // -----------------------------------------------------------------------
    // Geometria salva por janela
    // -----------------------------------------------------------------------

    #[test]
    fn geometria_da_principal_vem_dos_campos_proprios() {
        let mut cfg = Config::default();
        cfg.window_pos = Some((10, 20));
        cfg.window_size = Some((300, 200));
        cfg.detached.push(DetachedWindow {
            note_id: "n1".into(),
            pos: Some((999, 999)),
            size: None,
        });

        assert_eq!(
            saved_geometry(&cfg, "main"),
            (Some((10, 20)), Some((300, 200)))
        );
    }

    #[test]
    fn geometria_de_destacada_vem_da_entrada_correspondente() {
        let mut cfg = Config::default();
        cfg.detached.push(DetachedWindow {
            note_id: "n1".into(),
            pos: Some((10, 20)),
            size: Some((300, 200)),
        });
        cfg.detached.push(DetachedWindow {
            note_id: "n2".into(),
            pos: None,
            size: None,
        });

        assert_eq!(
            saved_geometry(&cfg, "note-n1"),
            (Some((10, 20)), Some((300, 200)))
        );
        assert_eq!(saved_geometry(&cfg, "note-n2"), (None, None));
        // Nota nunca destacada, sem entrada nenhuma: não inventa geometria.
        assert_eq!(saved_geometry(&cfg, "note-n3"), (None, None));
    }
}
