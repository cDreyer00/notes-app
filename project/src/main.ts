import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createAutosave, createDeleteConfirm, createDiskQueue } from "./editor-core";
import { createGrid } from "./grid";
import {
  api,
  matchesAccelerator,
  pickInitialNote,
  prettyAccelerator,
  type Config,
  type Note,
  type RemoteCommand,
} from "./shared";
import { hintItem, initWindowChrome, renderHints as renderHintsInto, type Hint } from "./window-chrome";

type View = "editor" | "grid";

const editorView = document.querySelector<HTMLElement>("#view-editor")!;
const gridView = document.querySelector<HTMLElement>("#view-grid")!;
const editorEl = document.querySelector<HTMLTextAreaElement>("#editor")!;
const searchEl = document.querySelector<HTMLInputElement>("#search")!;
const hintsEl = document.querySelector<HTMLElement>("#hints")!;
const confirmEl = document.querySelector<HTMLElement>("#confirm")!;
const toastEl = document.querySelector<HTMLElement>("#toast")!;

const UNDO_WINDOW_MS = 5000;

let config: Config;
let notes: Note[] = [];
let view: View = "editor";
let currentId: string | null = null;
let undoTimer: number | undefined;
/** Ids das notas atualmente abertas em janela própria. */
let detachedIds = new Set<string>();

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

const disk = createDiskQueue();

const autosave = createAutosave(editorEl, {
  getCurrentId: () => currentId,
  setCurrentId: (id) => {
    currentId = id;
  },
  getExisting: (id) => notes.find((note) => note.id === id),
  onSaved: (note) => {
    const existing = notes.find((item) => item.id === note.id);
    if (existing) {
      existing.content = note.content;
      existing.modified = note.modified;
    } else {
      notes.unshift(note);
    }
  },
  onDiscarded: (id) => {
    notes = notes.filter((note) => note.id !== id);
  },
  enqueue: disk.enqueue,
});

const { scheduleSave, flushSave, discardIfEmpty } = autosave;

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

const grid = createGrid(
  {
    grid: document.querySelector<HTMLElement>("#grid")!,
    empty: document.querySelector<HTMLElement>("#grid-empty")!,
    search: searchEl,
  },
  {
    getNotes: () => notes,
    isDetached: (id) => detachedIds.has(id),
    onOpen: (note) => openEditor(note),
    onUndetach: (id) => void api.undetachNote(id),
    onDetach: (id, x, y) => void api.detachNote(id, x, y),
  },
);

// ---------------------------------------------------------------------------
// Navegação entre as views
// ---------------------------------------------------------------------------

/** `null` abre o editor em branco — a nota correspondente ainda não existe. */
function openEditor(note: Note | null): void {
  currentId = note?.id ?? null;
  editorEl.value = note?.content ?? "";
  view = "editor";
  editorView.classList.remove("hidden");
  gridView.classList.add("hidden");
  editorEl.focus();
  editorEl.setSelectionRange(editorEl.value.length, editorEl.value.length);
  renderHints();
}

async function showGrid(): Promise<void> {
  await flushSave();
  await discardIfEmpty();

  view = "grid";
  editorView.classList.add("hidden");
  gridView.classList.remove("hidden");
  grid.reset();

  notes = await api.listNotes();
  grid.render();
  searchEl.focus();
  renderHints();
}

async function toggleView(): Promise<void> {
  if (view === "editor") {
    await showGrid();
    return;
  }

  // Uma nota destacada não pode ser reaberta aqui: seriam dois editores sobre
  // o mesmo arquivo, cada um com seu autosave, e o último a gravar apagaria o
  // texto do outro.
  const target = [
    notes.find((note) => note.id === currentId),
    grid.selected(),
  ].find((note) => note && !detachedIds.has(note.id));
  openEditor(target ?? null);
}

async function startNewNote(): Promise<void> {
  await flushSave();
  await discardIfEmpty();
  openEditor(null);
}

/** Destaca a nota em edição numa janela própria e volta pra grid. */
async function detachCurrent(): Promise<void> {
  if (view !== "editor") return;

  // Grava antes: uma nota recém-digitada ainda pode não ter arquivo, e sem
  // `id` não há o que destacar.
  await flushSave();
  const id = currentId;
  if (!id) return;

  await api.detachNote(id);
  // A nota passou a ser de outra janela: deixar o editor daqui apontando pra
  // ela faria um `toggleView` seguinte reabri-la em dose dupla.
  currentId = null;
  editorEl.value = "";
  await showGrid();
}

// ---------------------------------------------------------------------------
// Exclusão
// ---------------------------------------------------------------------------

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

    // Esvaziar o editor é obrigatório: com texto e sem `currentId`, o autosave
    // trataria o conteúdo como nota nova e recriaria a que acabou de ser deletada.
    if (currentId === id) {
      currentId = null;
      editorEl.value = "";
    }
    notes = notes.filter((note) => note.id !== id);
    await showGrid();
    showUndo(id);
  },
);

async function askDelete(): Promise<void> {
  // Grava antes de perguntar: uma nota recém-digitada ainda pode não ter
  // arquivo, e sem `id` não haveria o que deletar.
  if (view === "editor") await flushSave();

  const id = view === "editor" ? currentId : grid.selected()?.id;
  deleteConfirm.ask(id);
}

function showUndo(id: string): void {
  window.clearTimeout(undoTimer);
  toastEl.classList.remove("hidden");

  const undoButton = document.querySelector<HTMLButtonElement>("#undo")!;
  undoButton.onclick = async () => {
    window.clearTimeout(undoTimer);
    toastEl.classList.add("hidden");
    try {
      await disk.enqueue(() => api.restoreNote(id));
      notes = await api.listNotes();
      grid.render();
    } catch (error) {
      console.error("falha ao restaurar nota", error);
    }
  };

  undoTimer = window.setTimeout(() => {
    toastEl.classList.add("hidden");
  }, UNDO_WINDOW_MS);
}

// ---------------------------------------------------------------------------
// Teclado
// ---------------------------------------------------------------------------

function handleKeyDown(event: KeyboardEvent): void {
  if (deleteConfirm.handleKey(event)) return;

  const { shortcuts } = config;

  if (matchesAccelerator(event, shortcuts.newNote)) {
    event.preventDefault();
    void startNewNote();
    return;
  }

  if (matchesAccelerator(event, shortcuts.toggleView)) {
    event.preventDefault();
    void toggleView();
    return;
  }

  if (matchesAccelerator(event, shortcuts.deleteNote)) {
    event.preventDefault();
    void askDelete();
    return;
  }

  if (matchesAccelerator(event, shortcuts.togglePin)) {
    event.preventDefault();
    void togglePin();
    return;
  }

  if (matchesAccelerator(event, shortcuts.detachNote)) {
    event.preventDefault();
    void detachCurrent();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    if (view === "editor") void showGrid();
    else void api.hideApp();
    return;
  }

  if (view === "grid") grid.handleKeys(event);
}

// ---------------------------------------------------------------------------
// Rodapé de dicas
// ---------------------------------------------------------------------------

function renderHints(): void {
  const { shortcuts } = config;
  const hints: Hint[] =
    view === "grid"
      ? [
          // Navegar e abrir vêm primeiro: é o que se faz na grid, e sem a dica
          // ninguém descobre que as setas funcionam.
          ["↑↓←→", "navegar"],
          ["Enter", "abrir"],
          [prettyAccelerator(shortcuts.newNote), "nova"],
          ["Esc", "ocultar"],
        ]
      : [
          [prettyAccelerator(shortcuts.toggleView), "todas as notas"],
          [prettyAccelerator(shortcuts.newNote), "nova"],
          [prettyAccelerator(shortcuts.deleteNote), "deletar"],
        ];

  renderHintsInto(hintsEl, hints);

  // O pino precisa de sinal visível: sem ele, a janela que não some mais
  // parece defeito em vez de escolha.
  const pin = hintItem(
    prettyAccelerator(shortcuts.togglePin),
    config.pinned ? "fixada" : "fixar",
  );
  pin.className = config.pinned ? "hint-pin active" : "hint-pin";
  hintsEl.append(pin);
}

async function togglePin(): Promise<void> {
  try {
    config = await api.setPinned(!config.pinned);
    renderHints();
  } catch (error) {
    console.error("falha ao fixar a janela", error);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  initWindowChrome();

  config = await api.getConfig();
  detachedIds = new Set(config.detached.map((entry) => entry.noteId));
  notes = await api.listNotes();

  // Abre onde o usuário parou: o caso comum é querer continuar escrevendo.
  // Mas não a mesma nota que já está aberta numa janela destacada — nesse
  // caso a próxima mais recente entra no lugar, ou a grid se todas estiverem.
  if (notes.length === 0) {
    openEditor(null);
  } else {
    const initial = pickInitialNote(notes, detachedIds);
    if (initial) openEditor(initial);
    else await showGrid();
  }

  editorEl.addEventListener("input", scheduleSave);
  document.addEventListener("keydown", handleKeyDown, true);

  // A janela some ao perder o foco; grava antes que o debounce expire.
  window.addEventListener("blur", () => void flushSave());
  await listen("app-hiding", async () => {
    await flushSave();
    await discardIfEmpty();
  });
  await listen("app-shown", async () => {
    notes = await api.listNotes();
    if (view === "grid") grid.render();
    (view === "grid" ? searchEl : editorEl).focus();
  });
  await listen<Config>("config-changed", (event) => {
    config = event.payload;
    renderHints();
  });
  await listen<string[]>("detached-changed", (event) => {
    detachedIds = new Set(event.payload);
    if (view === "grid") grid.render();
  });
  // Os dois eventos abaixo são endereçados a esta janela (`emit_to` no Rust),
  // e um `listen` global se registra como alvo "qualquer um" — que não casa
  // com emissão endereçada. Por isso vão pelo listener da própria janela.
  const thisWindow = getCurrentWebviewWindow();

  // Nota deletada de dentro de uma janela destacada: lá não existe grid onde
  // pôr o "desfazer", e sem ele o Enter da confirmação seria irreversível na
  // prática. O toast é sempre desta janela.
  await thisWindow.listen<string>("note-deleted", (event) => {
    notes = notes.filter((note) => note.id !== event.payload);
    if (currentId === event.payload) {
      currentId = null;
      editorEl.value = "";
    }
    if (view === "grid") grid.render();
    showUndo(event.payload);
  });
  // Comando que uma janela de nota destacada não podia executar sozinha —
  // aqui é como se o atalho tivesse sido pressionado nesta janela mesmo.
  await thisWindow.listen<RemoteCommand>("remote-command", (event) => {
    if (event.payload === "newNote") void startNewNote();
    else if (event.payload === "toggleView") void toggleView();
    else if (event.payload === "togglePin") void togglePin();
  });
}

void init();
