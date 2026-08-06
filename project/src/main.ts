import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createAutosave, createDeleteConfirm, createDiskQueue } from "./editor-core";
import {
  api,
  IS_DEV,
  matchesAccelerator,
  prettyAccelerator,
  relativeTime,
  searchNotes,
  type Config,
  type Note,
  type ResizeDirection,
} from "./shared";

type View = "editor" | "grid";

const editorView = document.querySelector<HTMLElement>("#view-editor")!;
const gridView = document.querySelector<HTMLElement>("#view-grid")!;
const editorEl = document.querySelector<HTMLTextAreaElement>("#editor")!;
const searchEl = document.querySelector<HTMLInputElement>("#search")!;
const gridEl = document.querySelector<HTMLElement>("#grid")!;
const gridEmptyEl = document.querySelector<HTMLElement>("#grid-empty")!;
const hintsEl = document.querySelector<HTMLElement>("#hints")!;
const confirmEl = document.querySelector<HTMLElement>("#confirm")!;
const toastEl = document.querySelector<HTMLElement>("#toast")!;

const UNDO_WINDOW_MS = 5000;

let config: Config;
let notes: Note[] = [];
let visibleNotes: Note[] = [];
let view: View = "editor";
let currentId: string | null = null;
let selectedIndex = 0;
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
  searchEl.value = "";
  selectedIndex = 0;

  notes = await api.listNotes();
  renderGrid();
  searchEl.focus();
  renderHints();
}

async function toggleView(): Promise<void> {
  if (view === "editor") {
    await showGrid();
    return;
  }

  const target =
    notes.find((note) => note.id === currentId) ?? visibleNotes[selectedIndex];
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
  await showGrid();
}

async function openSelected(): Promise<void> {
  const note = visibleNotes[selectedIndex];
  if (note) openEditor(note);
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

function renderGrid(): void {
  visibleNotes = searchNotes(notes, searchEl.value);
  gridEl.replaceChildren();

  for (const note of visibleNotes) {
    const isDetached = detachedIds.has(note.id);

    const card = document.createElement("div");
    card.className = isDetached ? "card card-detached" : "card";
    card.dataset.id = note.id;

    const body = document.createElement("p");
    body.className = "card-body";
    body.textContent = note.content.trim() || "(vazia)";

    const time = document.createElement("span");
    time.className = "card-time";
    time.textContent = isDetached ? "em outra janela" : relativeTime(note.modified);

    card.append(body, time);
    // Nota destacada já está aberta em janela própria: clicar aqui recolhe
    // ela de volta, em vez de abrir mais uma vez dentro da principal.
    card.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (isDetached) void api.undetachNote(note.id);
      else openEditor(note);
    });
    // Uma nota já destacada não arrasta pra virar outra janela — ela já é uma.
    if (!isDetached) {
      card.addEventListener("mousedown", (event) => beginCardDrag(note, event));
    }
    gridEl.append(card);
  }

  if (selectedIndex >= visibleNotes.length) {
    selectedIndex = Math.max(0, visibleNotes.length - 1);
  }

  gridEmptyEl.classList.toggle("hidden", visibleNotes.length > 0);
  updateSelection();
}

// ---------------------------------------------------------------------------
// Arrastar um card pra fora vira janela destacada
// ---------------------------------------------------------------------------

/** Abaixo disso é clique; acima, arraste. */
const DRAG_THRESHOLD_PX = 6;

let dragNote: Note | null = null;
let dragStartX = 0;
let dragStartY = 0;
let dragActive = false;
let dragBounds: { x: number; y: number; width: number; height: number } | null = null;
let ghostEl: HTMLElement | null = null;
/** Um arraste que terminou não pode também disparar o `click` nativo do mouseup. */
let suppressNextClick = false;

function positionGhost(x: number, y: number): void {
  if (!ghostEl) return;
  ghostEl.style.left = `${x}px`;
  ghostEl.style.top = `${y}px`;
}

function createGhost(note: Note, x: number, y: number): void {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.textContent = note.content.trim() || "(vazia)";
  document.body.append(ghost);
  ghostEl = ghost;
  positionGhost(x, y);
}

function beginCardDrag(note: Note, event: MouseEvent): void {
  if (event.button !== 0) return;
  dragNote = note;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragActive = false;
  window.addEventListener("mousemove", onCardDragMove);
  window.addEventListener("mouseup", onCardDragEnd);
}

async function onCardDragMove(event: MouseEvent): Promise<void> {
  const note = dragNote;
  if (!note) return;

  if (!dragActive) {
    const moved = Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY);
    if (moved < DRAG_THRESHOLD_PX) return;

    dragActive = true;
    const win = getCurrentWindow();
    const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    // O arraste não move a janela principal; os limites capturados agora
    // continuam valendo até o mouseup.
    dragBounds = { x: position.x, y: position.y, width: size.width, height: size.height };
    createGhost(note, event.clientX, event.clientY);
  }

  positionGhost(event.clientX, event.clientY);
}

function onCardDragEnd(event: MouseEvent): void {
  window.removeEventListener("mousemove", onCardDragMove);
  window.removeEventListener("mouseup", onCardDragEnd);

  const note = dragNote;
  const wasActive = dragActive;
  const bounds = dragBounds;
  ghostEl?.remove();
  ghostEl = null;
  dragNote = null;
  dragActive = false;
  dragBounds = null;

  if (!note || !wasActive) return;
  suppressNextClick = true;

  const outside =
    bounds !== null &&
    (event.screenX < bounds.x ||
      event.screenY < bounds.y ||
      event.screenX > bounds.x + bounds.width ||
      event.screenY > bounds.y + bounds.height);

  if (outside) void api.detachNote(note.id, event.screenX, event.screenY);
}

function updateSelection(): void {
  const cards = Array.from(gridEl.children) as HTMLElement[];
  cards.forEach((card, index) => {
    card.classList.toggle("selected", index === selectedIndex);
  });
  cards[selectedIndex]?.scrollIntoView({ block: "nearest" });
}

/** Quantos cards cabem numa linha, lido do próprio layout. */
function columnCount(): number {
  const cards = Array.from(gridEl.children) as HTMLElement[];
  if (cards.length < 2) return 1;

  const firstTop = cards[0].offsetTop;
  let columns = 0;
  for (const card of cards) {
    if (card.offsetTop !== firstTop) break;
    columns += 1;
  }
  return Math.max(1, columns);
}

function moveSelection(delta: number): void {
  if (visibleNotes.length === 0) return;
  selectedIndex = Math.min(
    Math.max(selectedIndex + delta, 0),
    visibleNotes.length - 1,
  );
  updateSelection();
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

  const id = view === "editor" ? currentId : visibleNotes[selectedIndex]?.id;
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
      renderGrid();
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

/**
 * No campo de busca as setas laterais pertencem ao cursor de texto — mas só
 * enquanto houver texto para percorrer. Na ponta elas voltam a navegar pela
 * grid, senão andar de lado entre os cards seria impossível com o foco na
 * busca, que é onde ele sempre começa.
 */
function sideArrowNavigates(toRight: boolean): boolean {
  if (document.activeElement !== searchEl) return true;

  const { selectionStart, selectionEnd, value } = searchEl;
  if (selectionStart === null || selectionEnd === null) return true;
  if (selectionStart !== selectionEnd) return false;

  return toRight ? selectionStart >= value.length : selectionStart <= 0;
}

function handleGridKeys(event: KeyboardEvent): void {
  const inSearch = document.activeElement === searchEl;

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveSelection(columnCount());
      break;
    case "ArrowUp":
      event.preventDefault();
      moveSelection(-columnCount());
      break;
    case "ArrowRight":
      if (!sideArrowNavigates(true)) return;
      event.preventDefault();
      moveSelection(1);
      break;
    case "ArrowLeft":
      if (!sideArrowNavigates(false)) return;
      event.preventDefault();
      moveSelection(-1);
      break;
    case "Enter":
      event.preventDefault();
      void openSelected();
      break;
    default:
      // Qualquer digitação volta para a busca, que é o uso principal da grid.
      // O caractere é inserido na mão porque o foco muda depois do evento.
      if (!inSearch && event.key.length === 1 && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        searchEl.focus();
        searchEl.value += event.key;
        selectedIndex = 0;
        renderGrid();
      }
  }
}

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

  if (view === "grid") handleGridKeys(event);
}

// ---------------------------------------------------------------------------
// Rodapé de dicas
// ---------------------------------------------------------------------------

function renderHints(): void {
  const { shortcuts } = config;
  const entries: Array<[string, string]> =
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

  hintsEl.replaceChildren();

  // Com o app instalado aberto ao lado, as duas janelas são idênticas. Sem
  // esta marca, dá para editar as notas de teste achando que são as de verdade.
  if (IS_DEV) {
    const badge = document.createElement("span");
    badge.className = "hint-dev";
    badge.textContent = "dev";
    hintsEl.append(badge);
  }

  for (const [keys, label] of entries) {
    const item = document.createElement("span");
    const kbd = document.createElement("kbd");
    kbd.textContent = keys;
    item.append(kbd, document.createTextNode(` ${label}`));
    hintsEl.append(item);
  }

  // O pino precisa de sinal visível: sem ele, a janela que não some mais
  // parece defeito em vez de escolha.
  const pin = document.createElement("span");
  pin.className = config.pinned ? "hint-pin active" : "hint-pin";
  const pinKey = document.createElement("kbd");
  pinKey.textContent = prettyAccelerator(shortcuts.togglePin);
  pin.append(
    pinKey,
    document.createTextNode(config.pinned ? " fixada" : " fixar"),
  );
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
  config = await api.getConfig();
  detachedIds = new Set(config.detached.map((entry) => entry.noteId));
  notes = await api.listNotes();

  // Abre onde o usuário parou: o caso comum é querer continuar escrevendo.
  // Mas não a mesma nota que já está aberta numa janela destacada — nesse
  // caso a próxima mais recente entra no lugar, ou a grid se todas estiverem.
  if (notes.length === 0) {
    openEditor(null);
  } else {
    const initial = notes.find((note) => !detachedIds.has(note.id));
    if (initial) openEditor(initial);
    else await showGrid();
  }

  editorEl.addEventListener("input", scheduleSave);
  searchEl.addEventListener("input", () => {
    selectedIndex = 0;
    renderGrid();
  });

  document.addEventListener("keydown", handleKeyDown, true);

  // O arraste passa pelo Rust para que o blur que ele provoca não seja
  // confundido com "clicou fora" e esconda a janela no meio do movimento.
  for (const area of document.querySelectorAll<HTMLElement>("[data-drag]")) {
    area.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void api.beginDrag();
    });
  }

  // Mesma história para as bordas: as nativas são tratadas pelo sistema e a
  // janela sumiria ao começar o redimensionamento. O Rust marca a interação
  // primeiro; só depois o resize começa de fato.
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

  // A janela some ao perder o foco; grava antes que o debounce expire.
  window.addEventListener("blur", () => void flushSave());
  await listen("app-hiding", async () => {
    await flushSave();
    await discardIfEmpty();
  });
  await listen("app-shown", async () => {
    notes = await api.listNotes();
    if (view === "grid") renderGrid();
    (view === "grid" ? searchEl : editorEl).focus();
  });
  await listen<Config>("config-changed", (event) => {
    config = event.payload;
    renderHints();
  });
  await listen<string[]>("detached-changed", (event) => {
    detachedIds = new Set(event.payload);
    if (view === "grid") renderGrid();
  });
  // Comando que uma janela de nota destacada não podia executar sozinha —
  // aqui é como se o atalho tivesse sido pressionado nesta janela mesmo.
  await listen<"newNote" | "toggleView" | "togglePin">(
    "remote-command",
    (event) => {
      if (event.payload === "newNote") void startNewNote();
      else if (event.payload === "toggleView") void toggleView();
      else if (event.payload === "togglePin") void togglePin();
    },
  );
}

void init();
