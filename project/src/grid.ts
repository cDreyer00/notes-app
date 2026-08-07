import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isOutsideBounds,
  relativeTime,
  searchNotes,
  toPhysicalPoint,
  type Note,
  type WindowBounds,
} from "./shared";

/**
 * A grid de notas: renderização dos cards, busca, navegação por teclado e o
 * arraste de um card pra fora da janela.
 *
 * Ela não sabe o que é um editor nem chama comandos do backend — o que fazer
 * ao abrir, recolher ou destacar uma nota chega por `GridHooks`. É o que
 * permite a mesma grid servir a quem a hospeda sem carregar junto o ciclo de
 * vida da nota em edição.
 */

export interface GridElements {
  grid: HTMLElement;
  empty: HTMLElement;
  search: HTMLInputElement;
}

export interface GridHooks {
  /** Fonte da verdade das notas; relida a cada render. */
  getNotes: () => Note[];
  /** A nota está aberta em janela própria? Muda o visual e o clique. */
  isDetached: (id: string) => boolean;
  /** Abrir a nota (card comum). */
  onOpen: (note: Note) => void;
  /** Recolher a janela destacada de volta (card tracejado). */
  onUndetach: (id: string) => void;
  /** Card solto fora dos limites da janela, em pixels físicos. */
  onDetach: (id: string, x: number, y: number) => void;
}

export interface Grid {
  render(): void;
  /** Limpa busca e seleção — não renderiza; quem chama decide quando. */
  reset(): void;
  selected(): Note | undefined;
  visible(): Note[];
  /** Teclas da grid. Só faz sentido com a grid em tela. */
  handleKeys(event: KeyboardEvent): void;
}

/** Abaixo disso é clique; acima, arraste. */
const DRAG_THRESHOLD_PX = 6;

export function createGrid(elements: GridElements, hooks: GridHooks): Grid {
  const { grid: gridEl, empty: gridEmptyEl, search: searchEl } = elements;

  let visibleNotes: Note[] = [];
  let selectedIndex = 0;

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

  // -------------------------------------------------------------------------
  // Renderização
  // -------------------------------------------------------------------------

  function render(): void {
    visibleNotes = searchNotes(hooks.getNotes(), searchEl.value);
    gridEl.replaceChildren();

    for (const note of visibleNotes) {
      const isDetached = hooks.isDetached(note.id);

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
        activate(note);
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

  /** Clique no card e `Enter` sobre ele são a mesma ação, inclusive recolher. */
  function activate(note: Note): void {
    if (hooks.isDetached(note.id)) hooks.onUndetach(note.id);
    else hooks.onOpen(note);
  }

  function updateSelection(): void {
    const cards = Array.from(gridEl.children) as HTMLElement[];
    cards.forEach((card, index) => {
      card.classList.toggle("selected", index === selectedIndex);
    });
    cards[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  // -------------------------------------------------------------------------
  // Arrastar um card pra fora vira janela destacada
  // -------------------------------------------------------------------------

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
      hooks.onDetach(note.id, drop.x, drop.y);
    }
  }

  // -------------------------------------------------------------------------
  // Teclado
  // -------------------------------------------------------------------------

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

  function handleKeys(event: KeyboardEvent): void {
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
      case "Enter": {
        event.preventDefault();
        const note = visibleNotes[selectedIndex];
        if (note) activate(note);
        break;
      }
      default:
        // Qualquer digitação volta para a busca, que é o uso principal da grid.
        // O caractere é inserido na mão porque o foco muda depois do evento.
        if (!inSearch && event.key.length === 1 && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          searchEl.focus();
          searchEl.value += event.key;
          selectedIndex = 0;
          render();
        }
    }
  }

  // -------------------------------------------------------------------------
  // Fiação própria
  // -------------------------------------------------------------------------

  searchEl.addEventListener("input", () => {
    selectedIndex = 0;
    render();
  });

  // Todo clique novo na grid começa com a supressão desarmada — ver a nota
  // em `suppressNextClick`. Em captura, para vir antes do handler do card.
  gridEl.addEventListener(
    "mousedown",
    () => {
      suppressNextClick = false;
    },
    true,
  );

  return {
    render,
    reset() {
      searchEl.value = "";
      selectedIndex = 0;
    },
    selected: () => visibleNotes[selectedIndex],
    visible: () => visibleNotes,
    handleKeys,
  };
}
