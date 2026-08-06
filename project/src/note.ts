import { listen } from "@tauri-apps/api/event";
import { createAutosave, createDeleteConfirm, createDiskQueue } from "./editor-core";
import {
  api,
  matchesAccelerator,
  prettyAccelerator,
  type Config,
  type Note,
} from "./shared";
import { initWindowChrome, renderHints } from "./window-chrome";

const editorEl = document.querySelector<HTMLTextAreaElement>("#editor")!;
const hintsEl = document.querySelector<HTMLElement>("#hints")!;
const confirmEl = document.querySelector<HTMLElement>("#confirm")!;

/**
 * Id fixo desde a criação da janela — nunca muda, ao contrário de `currentId`
 * do autosave, que a fila zera ao descartar uma nota esvaziada. Fechar a
 * janela precisa dele mesmo depois de um descarte, pra tirar a entrada certa
 * da composição salva.
 */
const noteId = new URLSearchParams(window.location.search).get("id");

let config: Config;
let current: Note | null = null;
/**
 * A nota já foi para a lixeira. Fechar em seguida não pode salvar nem
 * descartar: `flushSave` compara o texto da tela com o último conteúdo
 * conhecido, veria diferença e **recriaria o arquivo recém-deletado**.
 */
let deleted = false;

const disk = createDiskQueue();

const autosave = createAutosave(editorEl, {
  getCurrentId: () => current?.id ?? noteId,
  setCurrentId: () => {
    // Uma nota destacada sempre tem id: só se destaca o que já existe no
    // disco. O autosave nunca precisa inventar um id novo aqui.
  },
  getExisting: (id) => (current && current.id === id ? current : undefined),
  onSaved: (note) => {
    current = note;
  },
  onDiscarded: () => {
    current = null;
  },
  enqueue: disk.enqueue,
});

const deleteConfirm = createDeleteConfirm(
  {
    overlay: confirmEl,
    confirmButton: document.querySelector<HTMLButtonElement>("#confirm-ok")!,
    cancelButton: document.querySelector<HTMLButtonElement>("#confirm-cancel")!,
  },
  async (id) => {
    autosave.clearScheduled();
    try {
      await disk.enqueue(() => api.deleteNote(id));
    } catch (error) {
      console.error("falha ao deletar nota", error);
      return;
    }
    // O próprio `delete_note` fecha esta janela; o `closeSelf` cobre o caso
    // de ela sobreviver por algum motivo, e é idempotente.
    deleted = true;
    await closeSelf();
  },
);

/**
 * Salva, descarta se ficou em branco e fecha a janela de verdade — sempre
 * pelo id fixo da janela, não pelo `currentId` do autosave (que um descarte
 * já zerou a esta altura).
 */
async function closeSelf(): Promise<void> {
  if (!deleted) {
    await autosave.flushSave();
    await autosave.discardIfEmpty();
  }
  if (noteId) await api.undetachNote(noteId);
}

function askDelete(): void {
  deleteConfirm.ask(current?.id ?? noteId);
}

// ---------------------------------------------------------------------------
// Teclado
// ---------------------------------------------------------------------------

function handleKeyDown(event: KeyboardEvent): void {
  if (deleteConfirm.handleKey(event)) return;

  const { shortcuts } = config;

  if (matchesAccelerator(event, shortcuts.deleteNote)) {
    event.preventDefault();
    askDelete();
    return;
  }

  // Esc se comporta como fechar: não há grid pra "voltar" dentro desta janela.
  if (matchesAccelerator(event, shortcuts.closeWindow) || event.key === "Escape") {
    event.preventDefault();
    void closeSelf();
    return;
  }

  // Os demais comandos locais só existem na principal — aqui só focam ela e
  // pedem que execute lá.
  if (matchesAccelerator(event, shortcuts.newNote)) {
    event.preventDefault();
    void autosave.flushSave().then(() => api.focusMain("newNote"));
    return;
  }

  if (matchesAccelerator(event, shortcuts.toggleView)) {
    event.preventDefault();
    void autosave.flushSave().then(() => api.focusMain("toggleView"));
    return;
  }

  if (matchesAccelerator(event, shortcuts.togglePin)) {
    event.preventDefault();
    void api.focusMain("togglePin");
    return;
  }
}

/** Sem grid e sem pino aqui: o rodapé lista só o que é local desta janela. */
function showHints(): void {
  renderHints(hintsEl, [
    [prettyAccelerator(config.shortcuts.deleteNote), "deletar"],
    [prettyAccelerator(config.shortcuts.closeWindow), "fechar"],
  ]);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  if (!noteId) return; // não deveria acontecer: a janela sempre nasce com ?id=

  initWindowChrome();

  config = await api.getConfig();
  const notes = await api.listNotes();
  current = notes.find((note) => note.id === noteId) ?? null;
  editorEl.value = current?.content ?? "";
  editorEl.focus();
  editorEl.setSelectionRange(editorEl.value.length, editorEl.value.length);
  showHints();

  editorEl.addEventListener("input", autosave.scheduleSave);
  document.addEventListener("keydown", handleKeyDown, true);

  document
    .querySelector<HTMLButtonElement>("#note-close")!
    .addEventListener("click", () => void closeSelf());

  window.addEventListener("blur", () => void autosave.flushSave());
  await listen("app-hiding", async () => {
    if (deleted) return;
    await autosave.flushSave();
    await autosave.discardIfEmpty();
    // Nota esvaziada é descartada igual à principal. Sem nota, esta janela
    // não teria o que mostrar quando o app voltasse — fecha junto.
    if (!current && noteId) await api.undetachNote(noteId);
  });
  await listen<Config>("config-changed", (event) => {
    config = event.payload;
    showHints();
  });
}

void init();
