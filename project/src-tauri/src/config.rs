use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Combinações de teclas, no formato de accelerator do Tauri ("Control+Alt+N").
/// Apenas `toggle_app` é registrado no sistema operacional; os demais são
/// tratados no frontend e só valem com a janela em foco.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    pub toggle_app: String,
    pub toggle_view: String,
    pub new_note: String,
    pub delete_note: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle_app: "Control+Alt+N".into(),
            toggle_view: "Control+Tab".into(),
            new_note: "Control+M".into(),
            delete_note: "Control+Delete".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Vazio no arquivo significa "usar a pasta padrão do app".
    pub notes_dir: PathBuf,
    pub shortcuts: Shortcuts,
    pub autostart: bool,
    /// Canto superior esquerdo, em pixels físicos. `None` até a janela ser movida.
    pub window_pos: Option<(i32, i32)>,
    /// Largura e altura, em pixels físicos. `None` até a janela ser redimensionada.
    pub window_size: Option<(u32, u32)>,
    /// Dias que uma nota deletada permanece na lixeira. `0` significa "nunca limpar".
    pub trash_retention_days: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            notes_dir: PathBuf::new(),
            shortcuts: Shortcuts::default(),
            autostart: true,
            window_pos: None,
            window_size: None,
            trash_retention_days: 30,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("não foi possível localizar a pasta de configuração: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("não foi possível criar {dir:?}: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn default_notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("não foi possível localizar a pasta de dados: {e}"))?;
    Ok(dir.join("notes"))
}

/// Lê a configuração do disco. Configuração corrompida ou ausente cai no padrão
/// em vez de derrubar o app — perder preferências é aceitável, não abrir não é.
pub fn load(app: &AppHandle) -> Result<Config, String> {
    let path = config_path(app)?;
    let mut cfg = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<Config>(&raw).unwrap_or_default(),
        Err(_) => Config::default(),
    };
    if cfg.notes_dir.as_os_str().is_empty() {
        cfg.notes_dir = default_notes_dir(app)?;
    }
    Ok(cfg)
}

pub fn save(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("não foi possível gravar {path:?}: {e}"))
}
