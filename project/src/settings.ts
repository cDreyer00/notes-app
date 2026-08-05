import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  api,
  eventToAccelerator,
  hasModifier,
  prettyAccelerator,
  type Config,
  type Shortcuts,
} from "./shared";

type ShortcutKey = keyof Shortcuts;

const SHORTCUT_KEYS: ShortcutKey[] = [
  "toggleApp",
  "toggleView",
  "newNote",
  "deleteNote",
];

const dirInput = document.querySelector<HTMLInputElement>("#notes-dir")!;
const autostartInput = document.querySelector<HTMLInputElement>("#autostart")!;
const retentionSelect =
  document.querySelector<HTMLSelectElement>("#trash-retention")!;
const errorEl = document.querySelector<HTMLElement>("#settings-error")!;
const trashCountEl = document.querySelector<HTMLElement>("#trash-count")!;
const emptyButton = document.querySelector<HTMLButtonElement>("#empty-trash")!;
const emptyDialog = document.querySelector<HTMLElement>("#empty-dialog")!;
const emptyDetail = document.querySelector<HTMLElement>("#empty-detail")!;
const moveDialog = document.querySelector<HTMLElement>("#move-dialog")!;
const moveDetail = document.querySelector<HTMLElement>("#move-detail")!;

let config: Config;
let draft: Shortcuts;
let capturing: ShortcutKey | null = null;

function button(key: ShortcutKey): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`#sc-${key}`)!;
}

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError(): void {
  errorEl.classList.add("hidden");
}

function renderShortcuts(): void {
  for (const key of SHORTCUT_KEYS) {
    const element = button(key);
    element.textContent =
      capturing === key ? "Pressione as teclas…" : prettyAccelerator(draft[key]);
    element.classList.toggle("capturing", capturing === key);
  }
}

function startCapture(key: ShortcutKey): void {
  capturing = key;
  clearError();
  renderShortcuts();
}

function stopCapture(): void {
  capturing = null;
  renderShortcuts();
}

function onCaptureKey(event: KeyboardEvent): void {
  if (!capturing) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === "Escape") {
    stopCapture();
    return;
  }

  const accelerator = eventToAccelerator(event);
  if (!accelerator) return;

  if (!hasModifier(accelerator)) {
    showError("Use pelo menos Ctrl, Alt ou Shift — ou uma tecla F.");
    return;
  }

  const duplicate = SHORTCUT_KEYS.find(
    (key) => key !== capturing && draft[key] === accelerator,
  );
  if (duplicate) {
    showError("Essa combinação já está em uso por outro comando.");
    return;
  }

  draft[capturing] = accelerator;
  stopCapture();
}

/** Sem a contagem, "esvaziar" seria um botão sobre uma caixa fechada. */
async function refreshTrashCount(): Promise<number> {
  let count = 0;
  try {
    count = await api.trashCount();
  } catch (error) {
    console.error("falha ao ler a lixeira", error);
  }

  trashCountEl.textContent =
    count === 0
      ? "A lixeira está vazia."
      : count === 1
        ? "1 nota deletada guardada."
        : `${count} notas deletadas guardadas.`;
  emptyButton.disabled = count === 0;
  return count;
}

function askEmptyTrash(count: number): void {
  emptyDetail.textContent =
    count === 1
      ? "1 nota some para sempre. Não dá para desfazer."
      : `${count} notas somem para sempre. Não dá para desfazer.`;
  emptyDialog.classList.remove("hidden");
}

async function confirmEmptyTrash(): Promise<void> {
  emptyDialog.classList.add("hidden");
  try {
    await api.emptyTrash();
  } catch (error) {
    showError(String(error));
  }
  await refreshTrashCount();
}

async function saveAll(): Promise<void> {
  clearError();
  try {
    config = await api.saveConfig(
      draft,
      autostartInput.checked,
      Number(retentionSelect.value),
    );
    draft = { ...config.shortcuts };
    renderShortcuts();
    await api.closeSettings();
  } catch (error) {
    // O erro mais provável é o atalho global estar tomado por outro programa.
    showError(String(error));
  }
}

async function pickDirectory(): Promise<void> {
  clearError();
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: config.notesDir,
  });
  if (typeof selected !== "string" || selected === config.notesDir) return;

  moveDetail.textContent = `De ${config.notesDir} para ${selected}`;
  moveDialog.classList.remove("hidden");

  const decide = async (moveExisting: boolean) => {
    moveDialog.classList.add("hidden");
    try {
      config = await api.setNotesDir(selected, moveExisting);
      dirInput.value = config.notesDir;
    } catch (error) {
      showError(String(error));
    }
  };

  document.querySelector<HTMLButtonElement>("#move-yes")!.onclick = () =>
    void decide(true);
  document.querySelector<HTMLButtonElement>("#move-no")!.onclick = () =>
    void decide(false);
  document.querySelector<HTMLButtonElement>("#move-cancel")!.onclick = () => {
    moveDialog.classList.add("hidden");
  };
}

/**
 * A janela é escondida, nunca destruída — então o estado precisa ser relido a
 * cada abertura, ou ela reapareceria mostrando dados de horas atrás.
 */
async function loadState(): Promise<void> {
  config = await api.getConfig();
  draft = { ...config.shortcuts };
  dirInput.value = config.notesDir;
  autostartInput.checked = config.autostart;
  retentionSelect.value = String(config.trashRetentionDays);
  capturing = null;
  clearError();
  renderShortcuts();
  await refreshTrashCount();
}

async function init(): Promise<void> {
  await loadState();

  for (const key of SHORTCUT_KEYS) {
    button(key).addEventListener("click", () => startCapture(key));
  }

  document.addEventListener("keydown", onCaptureKey, true);
  document
    .querySelector<HTMLButtonElement>("#pick-dir")!
    .addEventListener("click", () => void pickDirectory());
  document
    .querySelector<HTMLButtonElement>("#save")!
    .addEventListener("click", () => void saveAll());
  document
    .querySelector<HTMLButtonElement>("#close")!
    .addEventListener("click", () => void api.closeSettings());

  emptyButton.addEventListener("click", () => {
    void refreshTrashCount().then((count) => {
      if (count > 0) askEmptyTrash(count);
    });
  });
  document
    .querySelector<HTMLButtonElement>("#empty-confirm")!
    .addEventListener("click", () => void confirmEmptyTrash());
  document
    .querySelector<HTMLButtonElement>("#empty-cancel")!
    .addEventListener("click", () => emptyDialog.classList.add("hidden"));

  await listen("settings-shown", () => void loadState());
}

void init();
