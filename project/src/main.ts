import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api,
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

const SAVE_DEBOUNCE_MS = 400;
const UNDO_WINDOW_MS = 5000;

let config: Config;
let notes: Note[] = [];
let visibleNotes: Note[] = [];
let view: View = "editor";
let currentId: string | null = null;
let selectedIndex = 0;
let pendingDeleteId: string | null = null;
let saveTimer: number | undefined;
let undoTimer: number | undefined;

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
}

/**
 * Gravação, exclusão e restauração passam por uma fila única. Sem isso, um
 * autosave em voo terminaria depois do delete e recriaria o arquivo que acabou
 * de ir para a lixeira.
 */
let diskQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = diskQueue.then(task, task);
  diskQueue = result.catch(() => undefined);
  return result;
}

/**
 * O arquivo só nasce quando existe texto. Criar antes deixaria um `.md` vazio
 * no disco toda vez que o app fosse aberto e fechado sem se escrever nada.
 */
async function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer);

  // Alvo e conteúdo são fixados agora; a fila pode executar isto depois de o
  // usuário já ter trocado de nota.
  const content = editorEl.value;
  let targetId = currentId;

  await enqueue(async () => {
    try {
      if (!targetId) {
        if (content.trim() === "") return;
        const created = await api.createNote();
        targetId = created.id;
        notes.unshift(created);
        if (currentId === null) currentId = created.id;
      }

      const note = notes.find((item) => item.id === targetId);
      if (note && note.content === content) return;

      const modified = await api.saveNote(targetId, content);
      if (note) {
        note.content = content;
        note.modified = Number(modified);
      }
    } catch (error) {
      console.error("falha ao salvar a nota", error);
    }
  });
}

/** Nota existente que foi esvaziada some da grid em vez de virar card em branco. */
async function discardIfEmpty(): Promise<void> {
  if (!currentId) return;
  if (editorEl.value.trim() !== "") return;

  const id = currentId;
  currentId = null;
  notes = notes.filter((note) => note.id !== id);
  try {
    await enqueue(() => api.purgeNote(id));
  } catch (error) {
    console.error("falha ao descartar nota vazia", error);
  }
}

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
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = note.id;

    const body = document.createElement("p");
    body.className = "card-body";
    body.textContent = note.content.trim() || "(vazia)";

    const time = document.createElement("span");
    time.className = "card-time";
    time.textContent = relativeTime(note.modified);

    card.append(body, time);
    card.addEventListener("click", () => openEditor(note));
    gridEl.append(card);
  }

  if (selectedIndex >= visibleNotes.length) {
    selectedIndex = Math.max(0, visibleNotes.length - 1);
  }

  gridEmptyEl.classList.toggle("hidden", visibleNotes.length > 0);
  updateSelection();
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

async function askDelete(): Promise<void> {
  // Grava antes de perguntar: uma nota recém-digitada ainda pode não ter
  // arquivo, e sem `id` não haveria o que deletar.
  if (view === "editor") await flushSave();

  const id = view === "editor" ? currentId : visibleNotes[selectedIndex]?.id;
  if (!id) return;

  pendingDeleteId = id;
  confirmEl.classList.remove("hidden");
  document.querySelector<HTMLButtonElement>("#confirm-ok")!.focus();
}

function closeConfirm(): void {
  pendingDeleteId = null;
  confirmEl.classList.add("hidden");
}

async function confirmDelete(): Promise<void> {
  const id = pendingDeleteId;
  if (!id) return;

  window.clearTimeout(saveTimer);
  closeConfirm();

  try {
    await enqueue(() => api.deleteNote(id));
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
}

function showUndo(id: string): void {
  window.clearTimeout(undoTimer);
  toastEl.classList.remove("hidden");

  const undoButton = document.querySelector<HTMLButtonElement>("#undo")!;
  undoButton.onclick = async () => {
    window.clearTimeout(undoTimer);
    toastEl.classList.add("hidden");
    try {
      await enqueue(() => api.restoreNote(id));
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
  if (pendingDeleteId) {
    if (event.key === "Enter") {
      event.preventDefault();
      void confirmDelete();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeConfirm();
    }
    return;
  }

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
  notes = await api.listNotes();

  // Abre onde o usuário parou: o caso comum é querer continuar escrevendo.
  openEditor(notes[0] ?? null);

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

  document
    .querySelector<HTMLButtonElement>("#confirm-ok")!
    .addEventListener("click", () => void confirmDelete());
  document
    .querySelector<HTMLButtonElement>("#confirm-cancel")!
    .addEventListener("click", closeConfirm);

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
}

void init();
