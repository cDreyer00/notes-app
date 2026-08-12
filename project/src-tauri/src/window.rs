//! Tudo que é janela: identificar, posicionar, esconder/mostrar em conjunto e
//! o ciclo de vida das notas destacadas.
//!
//! O app tem três tipos de janela e só dois ciclos de vida. A principal e as
//! destacadas aparecem e somem **juntas** (`is_notes_window`); a de
//! configurações tem vida própria e não participa disso. Quase toda a
//! complexidade daqui vem dessa distinção e do fato de que arrastar uma janela
//! no Windows tira o foco dela.

use crate::config::{self, Config, DetachedWindow};
use crate::APP_LABEL;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

/// Arrastar uma janela tira o foco do webview dela, o que seria confundido
/// com "clicou fora". Enquanto o arraste está fresco, o blur é ignorado.
/// Chaveado por label porque várias janelas do app podem existir ao mesmo
/// tempo — arrastar uma nota destacada não pode afetar a principal.
pub(crate) struct DragState(pub(crate) Mutex<HashMap<String, Instant>>);

const DRAG_GRACE: Duration = Duration::from_millis(700);

/// Perder o foco agenda esconder o app inteiro depois desta folga. Trocar o
/// foco entre duas janelas do próprio Notes gera um blur seguido de um focus
/// quase imediato — a checagem, feita só quando o prazo vence, não depende da
/// ordem de chegada dos dois eventos.
const HIDE_DEBOUNCE: Duration = Duration::from_millis(150);

/// Cada blur agenda uma checagem; trocar o foco entre janelas do app agenda
/// várias em sequência. O contador faz valer só a última: sem ele, duas
/// checagens vencendo juntas rodariam `hide_all` duas vezes — e com ela o
/// `app-hiding`, que o frontend responde salvando e descartando nota vazia.
pub(crate) struct HideGeneration(pub(crate) Mutex<u64>);

/// Gravar a geometria a cada pixel de um arraste seria uma rajada de escritas
/// no `settings.json`. Cada movimento agenda a gravação e invalida a anterior:
/// só a última, quando o gesto para, chega ao disco.
const GEOMETRY_DEBOUNCE: Duration = Duration::from_millis(400);

/// Geração da última gravação agendada, **por janela**: mover uma destacada
/// não pode cancelar a gravação pendente da principal.
pub(crate) struct GeometryGeneration(pub(crate) Mutex<HashMap<String, u64>>);

/// Tamanho padrão de uma janela de nota destacada, usado quando ela nasce sem
/// tamanho salvo (primeira vez que aquela nota é destacada).
const DEFAULT_NOTE_SIZE: (u32, u32) = (560, 460);

pub(crate) fn mark_drag(app: &AppHandle, label: &str) {
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
pub(crate) fn saved_geometry(
    cfg: &Config,
    label: &str,
) -> (Option<(i32, i32)>, Option<(u32, u32)>) {
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
    // Janela escondida ou minimizada não tem geometria que valha guardar: o
    // Windows reporta a minimizada em (-32000, -32000), e esconder e mostrar
    // gera eventos de movimento. Gravar isso trocaria a posição real por lixo
    // que a próxima abertura obedeceria. Quem esconde já salvou antes de
    // esconder, então nada se perde aqui.
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }

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

/// Grava a geometria depois que o movimento para. Sem isto, a gravação só
/// aconteceria ao esconder o app — e com a janela fixada, que é justamente a
/// que nunca esconde, arrastar ou redimensionar não deixaria rastro: o
/// `settings.json` guardaria a posição de antes e o próximo `restore_geometry`
/// puxaria a janela de volta pra ela.
fn schedule_geometry_save(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<GeometryGeneration>() else {
        return;
    };
    let Ok(mut generations) = state.0.lock() else {
        return;
    };
    let counter = generations.entry(label.to_string()).or_insert(0);
    *counter += 1;
    let generation = *counter;
    drop(generations);

    let handle = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(GEOMETRY_DEBOUNCE);
        // Outro movimento chegou depois deste: quem grava é o agendamento dele.
        let current = handle.try_state::<GeometryGeneration>().and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .and_then(|generations| generations.get(&label).copied())
        });
        if current != Some(generation) {
            return;
        }
        if let Some(window) = handle.get_webview_window(&label) {
            save_geometry(&handle, &window);
        }
    });
}

pub(crate) fn save_all_geometry(app: &AppHandle) {
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
pub(crate) fn hide_all(app: &AppHandle) {
    let _ = app.emit("app-hiding", ());
    for (label, window) in app.webview_windows() {
        if is_notes_window(&label) {
            save_geometry(app, &window);
            let _ = window.hide();
        }
    }
}

pub(crate) fn show_all(app: &AppHandle) {
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
    let Some(state) = app.try_state::<HideGeneration>() else {
        return;
    };
    let Ok(mut counter) = state.0.lock() else {
        return;
    };
    *counter += 1;
    let generation = *counter;
    drop(counter);

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HIDE_DEBOUNCE);
        // Outro blur chegou depois deste: quem decide é a checagem dele.
        let current = handle
            .try_state::<HideGeneration>()
            .and_then(|state| state.0.lock().ok().map(|counter| *counter));
        if current != Some(generation) {
            return;
        }
        if !any_notes_window_focused(&handle) && !is_pinned(&handle) {
            hide_all(&handle);
        }
    });
}

/// Tamanho declarado para a principal no `tauri.conf.json`, em pixel lógico.
/// Lido de lá em vez de copiado pra cá: com dois números pra manter iguais,
/// mudar o tamanho da janela deixaria o "voltar ao original" apontando pro
/// valor antigo.
fn default_main_size(app: &AppHandle) -> Option<LogicalSize<f64>> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .map(|window| LogicalSize::new(window.width, window.height))
}

/// Recentraliza a principal e mantém tudo aberto — o duplo toque é "traga o
/// app de volta por completo", não só a janela principal. O gesto também
/// redefine a posição salva da principal, senão a próxima abertura voltaria
/// para o canto de onde se fugiu.
pub(crate) fn center_main(app: &AppHandle) {
    reveal_main(app, false);
}

/// O triplo toque acrescenta ao duplo o tamanho de fábrica: é a saída para a
/// janela que ficou grande ou minúscula demais pra ser consertada no mouse.
/// Só a principal — as destacadas têm o tamanho que cada nota ganhou.
pub(crate) fn reset_main(app: &AppHandle) {
    reveal_main(app, true);
}

fn reveal_main(app: &AppHandle, reset_size: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // O tamanho vem antes do centro, mesma razão de `restore_geometry`:
    // redimensionar depois deslocaria a janela do lugar onde acabou de parar.
    if reset_size {
        if let Some(size) = default_main_size(app) {
            let _ = window.set_size(size);
        }
    }
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

pub(crate) fn toggle_app(app: &AppHandle) {
    if app.get_webview_window("main").is_none() {
        return;
    }
    if any_notes_window_focused(app) {
        hide_all(app);
    } else {
        show_all(app);
    }
}

pub(crate) fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        // A janela é reaproveitada; sem isto ela reabriria com dados velhos.
        // Endereçado, não broadcast — ver a nota em `focus_main`.
        let _ = app.emit_to("settings", "settings-shown", ());
    }
}

// ---------------------------------------------------------------------------
// Janelas de nota destacada
// ---------------------------------------------------------------------------

pub(crate) fn detached_ids(cfg: &Config) -> Vec<String> {
    cfg.detached.iter().map(|d| d.note_id.clone()).collect()
}

/// Descarta as entradas cuja nota não existe mais no disco. Sem isto, a
/// abertura seguinte criaria uma janela para um `.md` que sumiu — e o card
/// correspondente ficaria tracejado na grid sem nada por trás.
pub(crate) fn prune_detached(
    detached: Vec<DetachedWindow>,
    on_disk: &HashSet<String>,
) -> Vec<DetachedWindow> {
    detached
        .into_iter()
        .filter(|entry| on_disk.contains(&entry.note_id))
        .collect()
}

/// Fecha a janela de uma nota, se ela estiver destacada. Sempre por
/// `close()`, nunca `destroy()`: é o `CloseRequested` que limpa a composição
/// salva, e ele precisa acontecer venha o fechamento de onde vier.
pub(crate) fn close_note_window(app: &AppHandle, note_id: &str) -> bool {
    match app.get_webview_window(&format!("note-{note_id}")) {
        Some(window) => {
            let _ = window.close();
            true
        }
        None => false,
    }
}

/// Constrói (sem mostrar) a janela de uma nota destacada, no mesmo perfil da
/// principal: sem decoração nativa (o app inteiro é frameless), sempre por
/// cima e fora da barra de tarefas, pra continuar visível enquanto se usa
/// outro programa — o próprio motivo de existir do destacar.
pub(crate) fn build_note_window(
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
pub(crate) fn cleanup_detached(app: &AppHandle, note_id: &str) {
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
pub(crate) fn attach_notes_window_events(app: &AppHandle, window: &WebviewWindow) {
    let handle = app.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            if !is_dragging(&handle, &label) {
                schedule_hide_check(&handle);
            }
        }
        // Cada movimento renova a carência: arrastar ou redimensionar por
        // vários segundos não pode expirar no meio do caminho. E, quando o
        // gesto para, a geometria nova vai pro disco — é aqui que ela muda, e
        // não em esconder o app.
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if is_dragging(&handle, &label) {
                mark_drag(&handle, &label);
            }
            schedule_geometry_save(&handle, &label);
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

    // -----------------------------------------------------------------------
    // Composição salva
    // -----------------------------------------------------------------------

    fn entry(note_id: &str) -> DetachedWindow {
        DetachedWindow {
            note_id: note_id.into(),
            pos: None,
            size: None,
        }
    }

    /// A nota some do disco (deletada por fora, pasta trocada) e a entrada
    /// fica para trás: sem a poda, o boot criaria uma janela vazia e o card
    /// na grid nasceria tracejado sem nada por trás.
    #[test]
    fn poda_as_notas_destacadas_que_sumiram_do_disco() {
        let salvas = vec![entry("n1"), entry("n2"), entry("n3")];
        let no_disco: HashSet<String> = ["n1", "n3"].iter().map(|id| id.to_string()).collect();

        let restou = prune_detached(salvas, &no_disco);

        assert_eq!(restou.len(), 2);
        assert_eq!(restou[0].note_id, "n1");
        assert_eq!(restou[1].note_id, "n3");
    }

    #[test]
    fn poda_preserva_a_geometria_de_quem_fica() {
        let salvas = vec![DetachedWindow {
            note_id: "n1".into(),
            pos: Some((10, 20)),
            size: Some((300, 200)),
        }];
        let no_disco: HashSet<String> = ["n1"].iter().map(|id| id.to_string()).collect();

        let restou = prune_detached(salvas, &no_disco);

        assert_eq!(restou[0].pos, Some((10, 20)));
        assert_eq!(restou[0].size, Some((300, 200)));
    }

    /// Disco ilegível não pode ser lido como "nenhuma nota existe" — quem
    /// chama só poda quando o `list` deu certo, e aqui fica registrado que
    /// uma lista vazia realmente zera tudo.
    #[test]
    fn sem_nota_nenhuma_no_disco_nao_sobra_composicao() {
        let restou = prune_detached(vec![entry("n1")], &HashSet::new());
        assert!(restou.is_empty());
    }
}
