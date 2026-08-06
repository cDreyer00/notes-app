import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createAutosave, createDeleteConfirm, createDiskQueue } from "./editor-core";
import {
  api,
  IS_DEV,
  matchesAccelerator,
  prettyAccelerator,
  type Config,
  type Note,
  type ResizeDirection,
} from "./shared";

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
    await closeSelf();
  },
);

/**
 * Salva, descarta se ficou em branco e fecha a janela de verdade — sempre
 * pelo id fixo da janela, não pelo `currentId` do autosave (que um descarte
 * já zerou a esta altura).
 */
async function closeSelf(): Promise<void> {
  await autosave.flushSave();
  await autosave.discardIfEmpty();
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

// ---------------------------------------------------------------------------
// Rodapé de dicas
// ---------------------------------------------------------------------------

function renderHints(): void {
  const { shortcuts } = config;
  hintsEl.replaceChildren();

  // Mesma marca que a principal usa: com o app instalado aberto ao lado, é o
  // que diz que esta janela também é da build de teste.
  if (IS_DEV) {
    const badge = document.createElement("span");
    badge.className = "hint-dev";
    badge.textContent = "dev";
    hintsEl.append(badge);
  }

  const entries: Array<[string, string]> = [
    [prettyAccelerator(shortcuts.deleteNote), "deletar"],
    [prettyAccelerator(shortcuts.closeWindow), "fechar"],
  ];
  for (const [keys, label] of entries) {
    const item = document.createElement("span");
    const kbd = document.createElement("kbd");
    kbd.textContent = keys;
    item.append(kbd, document.createTextNode(` ${label}`));
    hintsEl.append(item);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  if (!noteId) return; // não deveria acontecer: a janela sempre nasce com ?id=

  config = await api.getConfig();
  const notes = await api.listNotes();
  current = notes.find((note) => note.id === noteId) ?? null;
  editorEl.value = current?.content ?? "";
  editorEl.focus();
  editorEl.setSelectionRange(editorEl.value.length, editorEl.value.length);
  renderHints();

  editorEl.addEventListener("input", autosave.scheduleSave);
  document.addEventListener("keydown", handleKeyDown, true);

  // Mesmo mecanismo de arraste/redimensionamento da principal: o Rust marca
  // a interação primeiro pra o blur que ela provoca não ser tratado como
  // clique fora.
  for (const area of document.querySelectorAll<HTMLElement>("[data-drag]")) {
    area.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void api.beginDrag();
    });
  }

  for (const handle of document.querySelectorAll<HTMLElement>("[data-resize]")) {
    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const direction = handle.dataset.resize as ResizeDirection;
      void api
        .beginResize()
        .then(() => getCurrentWindow().startResizeDragging(direction));
    });
  }

  document
    .querySelector<HTMLButtonElement>("#note-close")!
    .addEventListener("click", () => void closeSelf());

  window.addEventListener("blur", () => void autosave.flushSave());
  await listen("app-hiding", () => void autosave.flushSave());
  await listen<Config>("config-changed", (event) => {
    config = event.payload;
    renderHints();
  });
}

void init();
