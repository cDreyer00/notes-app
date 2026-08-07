import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createAutosave, createDeleteConfirm, createDiskQueue } from "./editor-core";
import {
  api,
  isOutsideBounds,
  matchesAccelerator,
  pickInitialNote,
  prettyAccelerator,
  relativeTime,
  searchNotes,
  toPhysicalPoint,
  type Config,
  type Note,
  type RemoteCommand,
  type WindowBounds,
} from "./shared";
import { hintItem, initWindowChrome, renderHints as renderHintsInto, type Hint } from "./window-chrome";

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

  // Uma nota destacada não pode ser reaberta aqui: seriam dois editores sobre
  // o mesmo arquivo, cada um com seu autosave, e o último a gravar apagaria o
  // texto do outro.
  const target = [
    notes.find((note) => note.id === currentId),
    visibleNotes[selectedIndex],
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

/** Enter na grid: mesmo efeito do clique no card, inclusive o de recolher. */
async function openSelected(): Promise<void> {
  const note = visibleNotes[selectedIndex];
  if (!note) return;
  if (detachedIds.has(note.id)) await api.undetachNote(note.id);
  else openEditor(note);
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
      if (suppressNextClick) return;
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
/** Limites da janela em pixels físicos, congelados no início do arraste. */
let dragBounds: WindowBounds | null = null;
/** Pixels físicos por pixel CSS; o evento do mouse reporta em CSS. */
let dragScale = 1;
let ghostEl: HTMLElement | null = null;
/**
 * Um arraste que terminou não pode também disparar o `click` nativo do
 * mouseup. A flag é desarmada no `mousedown` seguinte, e não no clique que
 * ela cancela: soltar fora da janela (o caso mais comum aqui) ou em cima da
 * busca não gera clique nenhum em card, e a flag ficaria armada engolindo o
 * próximo clique de verdade.
 */
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
    const [position, size, scale] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      win.scaleFactor(),
    ]);
    // O arraste não move a janela principal; os limites capturados agora
    // continuam valendo até o mouseup.
    dragBounds = { x: position.x, y: position.y, width: size.width, height: size.height };
    dragScale = scale;
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
  const scale = dragScale;
  ghostEl?.remove();
  ghostEl = null;
  dragNote = null;
  dragActive = false;
  dragBounds = null;

  if (!note || !wasActive || !bounds) return;
  suppressNextClick = true;

  // O ponto do drop vira físico antes de qualquer conta: os limites da janela
  // vêm em físico, e o Rust também trata `x`/`y` assim ao posicionar a janela
  // nova sob o cursor.
  const drop = toPhysicalPoint({ x: event.screenX, y: event.screenY }, scale);
  if (isOutsideBounds(drop, bounds)) {
    void api.detachNote(note.id, drop.x, drop.y);
  }
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
  searchEl.addEventListener("input", () => {
    selectedIndex = 0;
    renderGrid();
  });

  document.addEventListener("keydown", handleKeyDown, true);

  // Todo clique novo na grid começa com a supressão desarmada — ver a nota
  // em `suppressNextClick`. Em captura, para vir antes do handler do card.
  gridEl.addEventListener(
    "mousedown",
    () => {
      suppressNextClick = false;
    },
    true,
  );

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
    if (view === "grid") renderGrid();
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
