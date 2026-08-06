use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Combinações de teclas, no formato de accelerator do Tauri ("Control+Alt+F").
/// Apenas `toggle_app` é registrado no sistema operacional; os demais são
/// tratados no frontend e só valem com a janela em foco.
/// `default` no container é o que permite acrescentar comandos sem invalidar o
/// settings.json de quem já usa o app: campo ausente cai no padrão em vez de
/// derrubar a leitura inteira e zerar as preferências.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcuts {
    pub toggle_app: String,
    pub toggle_view: String,
    pub new_note: String,
    pub delete_note: String,
    pub toggle_pin: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        // Mnemônicos em português: Escrever, Deletar, Fixar.
        Self {
            toggle_app: "Control+Alt+F".into(),
            toggle_view: "Control+Tab".into(),
            new_note: "Control+E".into(),
            delete_note: "Control+D".into(),
            toggle_pin: "Control+F".into(),
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
    /// Janela fixada: perder o foco deixa de esconder o app.
    pub pinned: bool,
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
            pinned: false,
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

/// Configuração corrompida cai no padrão em vez de derrubar o app — perder
/// preferências é aceitável, não abrir não é.
fn parse(raw: &str) -> Config {
    serde_json::from_str::<Config>(raw).unwrap_or_default()
}

/// Lê a configuração do disco. Arquivo ausente também cai no padrão: é o caso
/// da primeira execução.
pub fn load(app: &AppHandle) -> Result<Config, String> {
    let path = config_path(app)?;
    let mut cfg = match fs::read_to_string(&path) {
        Ok(raw) => parse(&raw),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// O caso que motivou o `#[serde(default)]` no container: acrescentar um
    /// comando não pode invalidar o settings.json de quem já usa o app.
    #[test]
    fn atalho_novo_nao_apaga_os_atalhos_ja_configurados() {
        let antigo = r#"{
            "notesDir": "D:/notas",
            "shortcuts": {
                "toggleApp": "Control+Alt+N",
                "toggleView": "Control+Tab",
                "newNote": "Control+E",
                "deleteNote": "Control+D"
            },
            "autostart": false,
            "trashRetentionDays": 7
        }"#;

        let cfg = parse(antigo);
        assert_eq!(cfg.shortcuts.toggle_app, "Control+Alt+N");
        assert_eq!(cfg.shortcuts.new_note, "Control+E");
        assert_eq!(cfg.autostart, false);
        assert_eq!(cfg.trash_retention_days, 7);
        assert_eq!(cfg.notes_dir, PathBuf::from("D:/notas"));
        // O campo que ainda não existia no arquivo assume o padrão.
        assert_eq!(cfg.shortcuts.toggle_pin, Shortcuts::default().toggle_pin);
        assert_eq!(cfg.pinned, false);
    }

    #[test]
    fn arquivo_corrompido_cai_no_padrao_em_vez_de_falhar() {
        for raw in ["", "{", "null", r#"{"autostart": "talvez"}"#] {
            let cfg = parse(raw);
            assert_eq!(cfg.autostart, Config::default().autostart, "raw: {raw:?}");
            assert_eq!(cfg.trash_retention_days, 30);
        }
    }

    #[test]
    fn campo_desconhecido_nao_derruba_a_leitura() {
        let cfg = parse(r#"{"autostart": false, "featureQueNaoExisteMais": 3}"#);
        assert_eq!(cfg.autostart, false);
    }

    /// O frontend recebe a config em camelCase; o roundtrip garante que gravar
    /// e ler de volta não perde nada.
    #[test]
    fn roundtrip_preserva_a_configuracao() {
        let mut cfg = Config::default();
        cfg.notes_dir = PathBuf::from("C:/notas");
        cfg.window_pos = Some((120, -40));
        cfg.window_size = Some((640, 480));
        cfg.pinned = true;
        cfg.trash_retention_days = 0;

        let raw = serde_json::to_string(&cfg).expect("serializar");
        assert!(raw.contains("trashRetentionDays"), "esperado camelCase: {raw}");

        let lido = parse(&raw);
        assert_eq!(lido.window_pos, Some((120, -40)));
        assert_eq!(lido.window_size, Some((640, 480)));
        assert_eq!(lido.pinned, true);
        assert_eq!(lido.trash_retention_days, 0);
        assert_eq!(lido.notes_dir, PathBuf::from("C:/notas"));
    }
}
