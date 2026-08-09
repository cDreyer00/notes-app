import { invoke } from "@tauri-apps/api/core";

/**
 * Roda a partir do `tauri dev`, não da build instalada. O backend decide o
 * mesmo por `cfg!(debug_assertions)`; as duas metades sempre concordam porque
 * `tauri dev` é justamente compilação de debug servida pelo Vite em modo dev.
 */
export const IS_DEV = import.meta.env.DEV;

export interface Note {
  id: string;
  content: string;
  /** Epoch em milissegundos. */
  modified: number;
}

export interface Shortcuts {
  toggleApp: string;
  toggleView: string;
  newNote: string;
  deleteNote: string;
  togglePin: string;
  detachNote: string;
  /** Só vale dentro de uma janela de nota destacada — na principal é ignorado. */
  closeWindow: string;
}

/** Uma janela de nota destacada da grid, com sua posição e tamanho próprios. */
export interface DetachedWindow {
  noteId: string;
  pos: [number, number] | null;
  size: [number, number] | null;
}

export interface Config {
  notesDir: string;
  shortcuts: Shortcuts;
  autostart: boolean;
  /** Posição salva da janela; `null` até ela ser movida pela primeira vez. */
  windowPos: [number, number] | null;
  /** Tamanho salvo da janela; `null` até ela ser redimensionada. */
  windowSize: [number, number] | null;
  /** Dias de permanência na lixeira; `0` significa "nunca limpar". */
  trashRetentionDays: number;
  /** Janela fixada: perder o foco deixa de esconder o app inteiro. */
  pinned: boolean;
  /** Notas atualmente destacadas em janela própria. */
  detached: DetachedWindow[];
}

/** Bordas aceitas por `startResizeDragging`; o tipo não é exportado pela API. */
export type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

export const api = {
  getConfig: () => invoke<Config>("get_config"),
  saveConfig: (
    shortcuts: Shortcuts,
    autostart: boolean,
    trashRetentionDays: number,
  ) =>
    invoke<Config>("save_config", { shortcuts, autostart, trashRetentionDays }),
  setNotesDir: (path: string, moveExisting: boolean) =>
    invoke<Config>("set_notes_dir", { path, moveExisting }),
  listNotes: () => invoke<Note[]>("list_notes"),
  createNote: () => invoke<Note>("create_note"),
  saveNote: (id: string, content: string) =>
    invoke<number>("save_note", { id, content }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),
  restoreNote: (id: string) => invoke<void>("restore_note", { id }),
  purgeNote: (id: string) => invoke<void>("purge_note", { id }),
  trashCount: () => invoke<number>("trash_count"),
  emptyTrash: () => invoke<number>("empty_trash"),
  hideApp: () => invoke<void>("hide_app"),
  beginDrag: () => invoke<void>("begin_drag"),
  beginResize: () => invoke<void>("begin_resize"),
  setPinned: (pinned: boolean) => invoke<Config>("set_pinned", { pinned }),
  appVersion: () => invoke<string>("app_version"),
  openSettings: () => invoke<void>("open_settings"),
  closeSettings: () => invoke<void>("close_settings"),
  quitApp: () => invoke<void>("quit_app"),
  /** `x`/`y` vêm de um drop fora da grid; sem eles a janela nasce centralizada. */
  detachNote: (id: string, x?: number, y?: number) =>
    invoke<void>("detach_note", { id, x, y }),
  undetachNote: (id: string) => invoke<void>("undetach_note", { id }),
  /** Foca a principal e pede que ela execute `action` por conta própria —
   * usado pelas janelas de nota destacada, onde só deletar é local. */
  focusMain: (action: RemoteCommand) => invoke<void>("focus_main", { action }),
};

/** Comandos que uma janela de nota destacada redireciona pra principal. */
export type RemoteCommand = "newNote" | "toggleView" | "togglePin";

// ---------------------------------------------------------------------------
// Janelas
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * O ponto caiu fora da janela? Usado pelo arraste de um card para decidir se
 * ele vira janela própria.
 *
 * **Os dois lados precisam estar em pixels físicos.** Um `MouseEvent` reporta
 * `screenX/screenY` em pixels CSS, enquanto a API de janela do Tauri devolve
 * físicos: num monitor a 150% os dois diferem por um terço, e a comparação
 * crua diria "fora" para um ponto bem no meio da janela.
 */
export function isOutsideBounds(point: Point, bounds: WindowBounds): boolean {
  return (
    point.x < bounds.x ||
    point.y < bounds.y ||
    point.x > bounds.x + bounds.width ||
    point.y > bounds.y + bounds.height
  );
}

/** Converte um ponto de tela em pixels CSS para pixels físicos. */
export function toPhysicalPoint(point: Point, scale: number): Point {
  return { x: Math.round(point.x * scale), y: Math.round(point.y * scale) };
}

/**
 * A nota em que a janela principal abre: a mais recente que ainda não está
 * numa janela própria. `null` quando não sobra nenhuma — abrir ali seria
 * editar a mesma nota em dois lugares, cada um com seu autosave.
 */
export function pickInitialNote(
  notes: Note[],
  detached: ReadonlySet<string>,
): Note | null {
  return notes.find((note) => !detached.has(note.id)) ?? null;
}

/**
 * Aplica na lista uma gravação feita em outra janela. Muda a nota **no lugar**,
 * em vez de trocá-la por um objeto novo: a grid guarda referências aos mesmos
 * objetos até o próximo render, e substituir deixaria essas referências
 * apontando para a versão velha.
 *
 * A ordem não é refeita aqui de propósito — a grid se reordena na próxima
 * relistagem, e mover cards enquanto se digita na outra janela seria pior do
 * que a ordem ficar um instante atrás.
 */
export function applySavedNote(notes: Note[], saved: Note): void {
  const existing = notes.find((note) => note.id === saved.id);
  if (!existing) {
    notes.unshift(saved);
    return;
  }
  existing.content = saved.content;
  existing.modified = saved.modified;
}

// ---------------------------------------------------------------------------
// Atalhos
// ---------------------------------------------------------------------------

interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const CTRL_ALIASES = ["control", "ctrl", "commandorcontrol", "cmdorctrl"];
const META_ALIASES = ["super", "meta", "command", "cmd", "win"];

const KEY_NAMES: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "Space",
  Spacebar: "Space",
};

/** Converte a tecla de um KeyboardEvent para o vocabulário dos accelerators. */
export function normalizeKey(key: string): string {
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function parseAccelerator(accelerator: string): Combo | null {
  const combo: Combo = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: "",
  };

  for (const raw of accelerator.split("+")) {
    const part = raw.trim();
    if (!part) continue;
    const lower = part.toLowerCase();
    if (CTRL_ALIASES.includes(lower)) combo.ctrl = true;
    else if (lower === "alt" || lower === "option") combo.alt = true;
    else if (lower === "shift") combo.shift = true;
    else if (META_ALIASES.includes(lower)) combo.meta = true;
    else combo.key = normalizeKey(part);
  }

  return combo.key ? combo : null;
}

/** Monta um accelerator a partir de um evento. Retorna null se só houver modificadores. */
export function eventToAccelerator(event: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(normalizeKey(event.key));
  return parts.join("+");
}

export function matchesAccelerator(
  event: KeyboardEvent,
  accelerator: string,
): boolean {
  const combo = parseAccelerator(accelerator);
  if (!combo) return false;
  return (
    event.ctrlKey === combo.ctrl &&
    event.altKey === combo.alt &&
    event.shiftKey === combo.shift &&
    event.metaKey === combo.meta &&
    normalizeKey(event.key) === combo.key
  );
}

/** Atalho sem modificador engoliria a digitação normal. */
export function hasModifier(accelerator: string): boolean {
  const combo = parseAccelerator(accelerator);
  if (!combo) return false;
  if (combo.ctrl || combo.alt || combo.meta) return true;
  return /^F\d{1,2}$/.test(combo.key);
}

export function prettyAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => {
      const lower = part.trim().toLowerCase();
      if (CTRL_ALIASES.includes(lower)) return "Ctrl";
      if (META_ALIASES.includes(lower)) return "Win";
      if (lower === "alt") return "Alt";
      if (lower === "shift") return "Shift";
      return part.trim();
    })
    .join(" + ");
}

// ---------------------------------------------------------------------------
// Texto e busca
// ---------------------------------------------------------------------------

/** Sem acento e sem caixa: a busca precisa achar "cafe" em "Café". */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function firstLine(content: string): string {
  for (const line of content.split("\n")) {
    if (line.trim()) return line.trim();
  }
  return "";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 20) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Filtra e ordena por relevância. Todos os termos precisam aparecer; match nas
 * primeiras linhas pesa mais que no corpo e a nota mais recente desempata.
 */
export function searchNotes(notes: Note[], query: string): Note[] {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...notes];

  const scored: Array<{ note: Note; score: number }> = [];

  for (const note of notes) {
    const body = normalizeText(note.content);
    const head = normalizeText(firstLine(note.content));
    let score = 0;
    let matchesAll = true;

    for (const term of terms) {
      const position = body.indexOf(term);
      if (position === -1) {
        matchesAll = false;
        break;
      }
      score += head.includes(term) ? 100 : 10;
      score += countOccurrences(body, term);
      score += Math.max(0, 10 - Math.floor(position / 40));
    }

    if (matchesAll) scored.push({ note, score });
  }

  scored.sort((a, b) => b.score - a.score || b.note.modified - a.note.modified);
  return scored.map((entry) => entry.note);
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

export function relativeTime(millis: number): string {
  const diff = Date.now() - millis;
  const minutes = Math.floor(diff / 60_000);

  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "ontem";
  if (days < 7) return `há ${days} dias`;

  return new Date(millis).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
}
