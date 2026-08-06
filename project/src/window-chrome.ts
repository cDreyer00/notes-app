/**
 * O que toda janela do app tem em comum por ser frameless: as alças de
 * redimensionamento, as áreas de arraste e o rodapé de dicas. A principal e
 * uma nota destacada tinham isto duplicado linha por linha — e duplicado é
 * onde uma correção pega só metade do app.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, IS_DEV, type ResizeDirection } from "./shared";

/** Sufixo da classe CSS e a borda correspondente, nesta ordem. */
const RESIZE_HANDLES = [
  ["n", "North"],
  ["s", "South"],
  ["w", "West"],
  ["e", "East"],
  ["nw", "NorthWest"],
  ["ne", "NorthEast"],
  ["sw", "SouthWest"],
  ["se", "SouthEast"],
] as const satisfies ReadonlyArray<readonly [string, ResizeDirection]>;

/**
 * As alças são `position: fixed` e invisíveis (só mudam o cursor), então
 * nascer por script no fim do body não muda nada na tela — e evita repetir
 * oito divs em cada página.
 *
 * O resize passa pelo Rust antes de começar: o gesto tira o foco do webview
 * e o blur seria confundido com "clicou fora", escondendo a janela no meio do
 * movimento. Quem dispara o resize é daqui porque `startResizeDragging` não
 * existe no `WebviewWindow` do Rust.
 */
function mountResizeHandles(): void {
  for (const [suffix, direction] of RESIZE_HANDLES) {
    const handle = document.createElement("div");
    handle.className = `rz rz-${suffix}`;
    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void api
        .beginResize()
        .then(() => getCurrentWindow().startResizeDragging(direction));
    });
    document.body.append(handle);
  }
}

/** Mesma história do resize, para a faixa do topo e o rodapé. */
function wireDragAreas(): void {
  for (const area of document.querySelectorAll<HTMLElement>("[data-drag]")) {
    area.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void api.beginDrag();
    });
  }
}

export function initWindowChrome(): void {
  mountResizeHandles();
  wireDragAreas();
}

// ---------------------------------------------------------------------------
// Rodapé de dicas
// ---------------------------------------------------------------------------

export type Hint = readonly [keys: string, label: string];

export function hintItem(keys: string, label: string): HTMLElement {
  const item = document.createElement("span");
  const kbd = document.createElement("kbd");
  kbd.textContent = keys;
  item.append(kbd, document.createTextNode(` ${label}`));
  return item;
}

/**
 * Substitui o conteúdo do rodapé. O selo `dev` vem primeiro porque, com o app
 * instalado aberto ao lado, as janelas são idênticas — sem ele dá para editar
 * as notas de teste achando que são as de verdade.
 */
export function renderHints(el: HTMLElement, hints: readonly Hint[]): void {
  el.replaceChildren();

  if (IS_DEV) {
    const badge = document.createElement("span");
    badge.className = "hint-dev";
    badge.textContent = "dev";
    el.append(badge);
  }

  for (const [keys, label] of hints) {
    el.append(hintItem(keys, label));
  }
}
