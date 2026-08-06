use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Notas deletadas ficam aqui até serem descartadas de vez, para viabilizar o
/// "desfazer" logo após a exclusão.
const TRASH_DIR: &str = ".trash";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub content: String,
    /// Epoch em milissegundos, usado para ordenar a grid.
    pub modified: u128,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Ids são gerados por nós e viram nome de arquivo, então qualquer coisa fora
/// deste alfabeto veio adulterada e não pode virar caminho.
fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("id de nota inválido: {id}"))
    }
}

fn note_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(dir.join(format!("{id}.md")))
}

fn trash_dir(dir: &Path) -> PathBuf {
    dir.join(TRASH_DIR)
}

/// Na lixeira o arquivo vira `{deletado_em}__{id}.md`. O carimbo precisa estar
/// no nome porque `rename` preserva o mtime da nota — usá-lo para medir a idade
/// apagaria na hora uma nota antiga que acabou de ser deletada.
fn trash_path(dir: &Path, id: &str, deleted_at: u128) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(trash_dir(dir).join(format!("{deleted_at}__{id}.md")))
}

/// Procura na lixeira pelo id, aceitando também o formato antigo sem carimbo.
fn find_in_trash(dir: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    validate_id(id)?;
    let trash = trash_dir(dir);
    if !trash.exists() {
        return Ok(None);
    }

    let legacy = format!("{id}.md");
    let suffix = format!("__{id}.md");
    let entries =
        fs::read_dir(&trash).map_err(|e| format!("não foi possível ler {trash:?}: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name == legacy || name.ends_with(&suffix) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("não foi possível criar {dir:?}: {e}"))
}

fn modified_millis(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Todas as notas, com o conteúdo completo — a busca acontece no frontend e
/// precisa do texto inteiro. Ordenadas da mais recente para a mais antiga.
pub fn list(dir: &Path) -> Result<Vec<Note>, String> {
    ensure_dir(dir)?;
    let entries = fs::read_dir(dir).map_err(|e| format!("não foi possível ler {dir:?}: {e}"))?;

    let mut notes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        notes.push(Note {
            id: id.to_string(),
            content,
            modified: modified_millis(&path),
        });
    }

    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(notes)
}

pub fn create(dir: &Path) -> Result<Note, String> {
    ensure_dir(dir)?;
    let now = now_millis();

    // Colisão só aconteceria com duas notas no mesmo milissegundo; o sufixo
    // incremental resolve sem depender de um gerador aleatório.
    let mut id = format!("n{now}");
    let mut suffix = 0;
    while note_path(dir, &id)?.exists() {
        suffix += 1;
        id = format!("n{now}-{suffix}");
    }

    let path = note_path(dir, &id)?;
    fs::write(&path, "").map_err(|e| format!("não foi possível criar {path:?}: {e}"))?;
    Ok(Note {
        id,
        content: String::new(),
        modified: now,
    })
}

pub fn save(dir: &Path, id: &str, content: &str) -> Result<u128, String> {
    ensure_dir(dir)?;
    let path = note_path(dir, id)?;
    fs::write(&path, content).map_err(|e| format!("não foi possível gravar {path:?}: {e}"))?;
    Ok(modified_millis(&path))
}

/// Move a nota para a lixeira, onde ela fica até o prazo de retenção vencer.
pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let from = note_path(dir, id)?;
    if !from.exists() {
        return Ok(());
    }
    let to = trash_path(dir, id, now_millis())?;
    ensure_dir(&trash_dir(dir))?;
    fs::rename(&from, &to).map_err(|e| format!("não foi possível mover para a lixeira: {e}"))
}

pub fn restore(dir: &Path, id: &str) -> Result<(), String> {
    let Some(from) = find_in_trash(dir, id)? else {
        return Err(format!("nota {id} não está na lixeira"));
    };
    let to = note_path(dir, id)?;
    fs::rename(&from, &to).map_err(|e| format!("não foi possível restaurar a nota: {e}"))
}

fn trash_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let trash = trash_dir(dir);
    if !trash.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&trash).map_err(|e| format!("não foi possível ler {trash:?}: {e}"))?;
    Ok(entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md"))
        .collect())
}

pub fn trash_count(dir: &Path) -> Result<usize, String> {
    Ok(trash_files(dir)?.len())
}

/// Apaga de vez o que passou do prazo. `retention_days == 0` mantém tudo.
/// Arquivos sem carimbo (formato antigo) caem no mtime como aproximação.
pub fn purge_trash(dir: &Path, retention_days: u32) -> Result<usize, String> {
    if retention_days == 0 {
        return Ok(0);
    }

    let cutoff = now_millis().saturating_sub(retention_days as u128 * 86_400_000);
    let mut removed = 0;

    for path in trash_files(dir)? {
        let deleted_at = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.split_once("__"))
            .and_then(|(stamp, _)| stamp.parse::<u128>().ok())
            .unwrap_or_else(|| modified_millis(&path));

        if deleted_at < cutoff && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Descarta a lixeira inteira. É a única ação sem volta do app.
pub fn empty_trash(dir: &Path) -> Result<usize, String> {
    let mut removed = 0;
    for path in trash_files(dir)? {
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Remove sem passar pela lixeira. Usado para descartar notas deixadas em branco.
pub fn purge(dir: &Path, id: &str) -> Result<(), String> {
    let path = note_path(dir, id)?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|e| format!("não foi possível remover {path:?}: {e}"))
}

/// Move os `.md` de uma pasta para outra ao trocar o local de armazenamento.
/// A lixeira fica para trás de propósito — só notas ativas acompanham a mudança.
/// Conflito de nome preserva o arquivo de destino.
pub fn move_all(from: &Path, to: &Path) -> Result<usize, String> {
    if from == to || !from.exists() {
        return Ok(0);
    }
    ensure_dir(to)?;

    let entries = fs::read_dir(from).map_err(|e| format!("não foi possível ler {from:?}: {e}"))?;
    let mut moved = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        let target = to.join(name);
        if target.exists() {
            continue;
        }
        if fs::rename(&path, &target).is_err() {
            // Pastas em volumes diferentes não aceitam rename; copiar resolve.
            fs::copy(&path, &target)
                .map_err(|e| format!("não foi possível copiar {path:?}: {e}"))?;
            let _ = fs::remove_file(&path);
        }
        moved += 1;
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const DAY: u128 = 86_400_000;

    fn workspace() -> (TempDir, PathBuf) {
        let temp = TempDir::new().expect("pasta temporária");
        let dir = temp.path().join("notes");
        ensure_dir(&dir).expect("criar pasta de notas");
        (temp, dir)
    }

    /// Cria a nota já com conteúdo, que é o estado normal fora do editor.
    fn note_with(dir: &Path, content: &str) -> String {
        let note = create(dir).expect("criar nota");
        save(dir, &note.id, content).expect("gravar nota");
        note.id
    }

    fn ids(dir: &Path) -> Vec<String> {
        list(dir)
            .expect("listar")
            .into_iter()
            .map(|note| note.id)
            .collect()
    }

    // -----------------------------------------------------------------------
    // Ids
    // -----------------------------------------------------------------------

    /// O id vem do frontend em todo comando; um caminho relativo aqui daria
    /// escrita fora da pasta de notas.
    #[test]
    fn id_fora_do_alfabeto_e_recusado() {
        let (_temp, dir) = workspace();

        for id in ["../evil", "sub/nota", "..", "nota.md", "a b", "", "n1\\x"] {
            assert!(save(&dir, id, "x").is_err(), "aceitou o id {id:?}");
            assert!(delete(&dir, id).is_err(), "aceitou o id {id:?}");
            assert!(purge(&dir, id).is_err(), "aceitou o id {id:?}");
        }

        assert!(save(&dir, &"n".repeat(65), "x").is_err());
        assert!(save(&dir, &"n".repeat(64), "x").is_ok());
    }

    #[test]
    fn create_nao_repete_id() {
        let (_temp, dir) = workspace();
        let mut vistos = std::collections::HashSet::new();

        for _ in 0..50 {
            let note = create(&dir).expect("criar nota");
            assert!(vistos.insert(note.id.clone()), "id repetido: {}", note.id);
        }
        assert_eq!(list(&dir).expect("listar").len(), 50);
    }

    // -----------------------------------------------------------------------
    // Listagem
    // -----------------------------------------------------------------------

    #[test]
    fn list_ignora_o_que_nao_e_nota() {
        let (_temp, dir) = workspace();
        let id = note_with(&dir, "conteúdo");

        fs::write(dir.join("leia-me.txt"), "não é nota").expect("gravar txt");
        fs::write(dir.join("nota com espaço.md"), "id inválido").expect("gravar md torto");
        ensure_dir(&dir.join("sub.md")).expect("criar pasta");
        delete(&dir, &note_with(&dir, "deletada")).expect("deletar");

        assert_eq!(ids(&dir), vec![id]);
    }

    #[test]
    fn list_traz_a_mais_recente_primeiro() {
        let (_temp, dir) = workspace();
        let antiga = note_with(&dir, "antiga");
        std::thread::sleep(std::time::Duration::from_millis(20));
        let nova = note_with(&dir, "nova");

        assert_eq!(ids(&dir), vec![nova, antiga]);
    }

    // -----------------------------------------------------------------------
    // Lixeira
    // -----------------------------------------------------------------------

    #[test]
    fn delete_move_para_a_lixeira_e_restore_traz_de_volta() {
        let (_temp, dir) = workspace();
        let id = note_with(&dir, "texto importante");

        delete(&dir, &id).expect("deletar");
        assert!(ids(&dir).is_empty());
        assert_eq!(trash_count(&dir).expect("contar"), 1);

        restore(&dir, &id).expect("restaurar");
        assert_eq!(ids(&dir), vec![id.clone()]);
        assert_eq!(trash_count(&dir).expect("contar"), 0);
        assert_eq!(
            fs::read_to_string(note_path(&dir, &id).unwrap()).unwrap(),
            "texto importante"
        );
    }

    /// O undo duplicava a nota quando o delete não tinha acontecido de fato.
    /// Deletar o que não existe é um no-op, e restaurar o que não está na
    /// lixeira precisa falhar em vez de inventar um arquivo.
    #[test]
    fn delete_e_restore_de_nota_ausente() {
        let (_temp, dir) = workspace();

        assert!(delete(&dir, "n404").is_ok());
        assert!(restore(&dir, "n404").is_err());
        assert!(ids(&dir).is_empty());
    }

    #[test]
    fn restore_aceita_o_formato_antigo_sem_carimbo() {
        let (_temp, dir) = workspace();
        ensure_dir(&trash_dir(&dir)).expect("criar lixeira");
        fs::write(trash_dir(&dir).join("n123.md"), "legado").expect("gravar legado");

        restore(&dir, "n123").expect("restaurar legado");
        assert_eq!(ids(&dir), vec!["n123".to_string()]);
    }

    /// `rename` preserva o mtime: medir a idade por ele apagaria na hora uma
    /// nota antiga recém-deletada. Aqui os dois arquivos acabaram de ser
    /// escritos — só o carimbo do nome distingue um do outro.
    #[test]
    fn purge_trash_usa_o_carimbo_do_nome_e_nao_o_mtime() {
        let (_temp, dir) = workspace();
        let trash = trash_dir(&dir);
        ensure_dir(&trash).expect("criar lixeira");

        let agora = now_millis();
        let velha = trash.join(format!("{}__nvelha.md", agora - 3 * DAY));
        let recente = trash.join(format!("{}__nrecente.md", agora - 3600_000));
        fs::write(&velha, "velha").expect("gravar velha");
        fs::write(&recente, "recente").expect("gravar recente");

        assert_eq!(purge_trash(&dir, 1).expect("limpar"), 1);
        assert!(!velha.exists());
        assert!(recente.exists());
    }

    #[test]
    fn purge_trash_com_retencao_zero_nunca_apaga() {
        let (_temp, dir) = workspace();
        let trash = trash_dir(&dir);
        ensure_dir(&trash).expect("criar lixeira");
        fs::write(trash.join("1__nantiga.md"), "de 1970").expect("gravar");

        assert_eq!(purge_trash(&dir, 0).expect("limpar"), 0);
        assert_eq!(trash_count(&dir).expect("contar"), 1);
    }

    #[test]
    fn empty_trash_esvazia_e_nao_toca_nas_notas_ativas() {
        let (_temp, dir) = workspace();
        let viva = note_with(&dir, "viva");
        delete(&dir, &note_with(&dir, "morta")).expect("deletar");

        assert_eq!(empty_trash(&dir).expect("esvaziar"), 1);
        assert_eq!(trash_count(&dir).expect("contar"), 0);
        assert_eq!(ids(&dir), vec![viva]);
    }

    #[test]
    fn purge_remove_sem_passar_pela_lixeira() {
        let (_temp, dir) = workspace();
        let id = create(&dir).expect("criar").id;

        purge(&dir, &id).expect("descartar");
        assert!(ids(&dir).is_empty());
        assert_eq!(trash_count(&dir).expect("contar"), 0);
        assert!(purge(&dir, &id).is_ok(), "descartar duas vezes é no-op");
    }

    // -----------------------------------------------------------------------
    // Troca de pasta
    // -----------------------------------------------------------------------

    #[test]
    fn move_all_leva_as_notas_e_deixa_a_lixeira_para_tras() {
        let temp = TempDir::new().expect("pasta temporária");
        let origem = temp.path().join("antiga");
        let destino = temp.path().join("nova");
        ensure_dir(&origem).expect("criar origem");

        let id = note_with(&origem, "vai junto");
        delete(&origem, &note_with(&origem, "fica na lixeira")).expect("deletar");

        assert_eq!(move_all(&origem, &destino).expect("mover"), 1);
        assert_eq!(ids(&destino), vec![id]);
        assert!(ids(&origem).is_empty());
        assert_eq!(trash_count(&origem).expect("contar"), 1);
        assert_eq!(trash_count(&destino).expect("contar"), 0);
    }

    #[test]
    fn move_all_preserva_o_arquivo_do_destino_em_caso_de_conflito() {
        let temp = TempDir::new().expect("pasta temporária");
        let origem = temp.path().join("antiga");
        let destino = temp.path().join("nova");
        ensure_dir(&origem).expect("criar origem");
        ensure_dir(&destino).expect("criar destino");

        fs::write(origem.join("n1.md"), "origem").expect("gravar origem");
        fs::write(destino.join("n1.md"), "destino").expect("gravar destino");

        assert_eq!(move_all(&origem, &destino).expect("mover"), 0);
        assert_eq!(
            fs::read_to_string(destino.join("n1.md")).unwrap(),
            "destino"
        );
        assert_eq!(fs::read_to_string(origem.join("n1.md")).unwrap(), "origem");
    }

    #[test]
    fn move_all_para_a_mesma_pasta_e_no_op() {
        let (_temp, dir) = workspace();
        let id = note_with(&dir, "parada");

        assert_eq!(move_all(&dir, &dir).expect("mover"), 0);
        assert_eq!(ids(&dir), vec![id]);
    }
}
