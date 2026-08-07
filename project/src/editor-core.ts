/**
 * Mecânica de editor compartilhada entre a janela principal (main.ts) e uma
 * janela de nota destacada (note.ts): fila de disco, autosave com debounce e
 * a UI do diálogo de confirmação de exclusão. O que cada janela faz *depois*
 * de salvar, descartar ou deletar difere (a principal atualiza a grid; uma
 * destacada fecha a própria janela) e por isso fica de fora daqui, como
 * callbacks.
 */
import { api, type Note } from "./shared";

const SAVE_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Fila de disco
// ---------------------------------------------------------------------------

/**
 * Gravação, exclusão e restauração passam por uma fila única. Sem isso, um
 * autosave em voo terminaria depois do delete e recriaria o arquivo que acabou
 * de ir para a lixeira.
 */
export function createDiskQueue() {
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }

  return { enqueue };
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

export interface AutosaveHandlers {
  getCurrentId: () => string | null;
  setCurrentId: (id: string | null) => void;
  /** Estado em memória da nota, pra não regravar um conteúdo que não mudou. */
  getExisting: (id: string) => Note | undefined;
  onSaved: (note: Note) => void;
  onDiscarded: (id: string) => void;
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createAutosave(editorEl: HTMLTextAreaElement, handlers: AutosaveHandlers) {
  let saveTimer: number | undefined;

  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
  }

  function clearScheduled(): void {
    window.clearTimeout(saveTimer);
  }

  /**
   * O arquivo só nasce quando existe texto. Criar antes deixaria um `.md`
   * vazio no disco toda vez que a janela fosse aberta e fechada sem se
   * escrever nada.
   */
  async function flushSave(): Promise<void> {
    window.clearTimeout(saveTimer);

    // Alvo e conteúdo são fixados agora; a fila pode executar isto depois de
    // o usuário já ter trocado de nota.
    const content = editorEl.value;
    let targetId = handlers.getCurrentId();

    await handlers.enqueue(async () => {
      try {
        let isNew = false;
        if (!targetId) {
          if (content.trim() === "") return;
          const created = await api.createNote();
          targetId = created.id;
          isNew = true;
          if (handlers.getCurrentId() === null) handlers.setCurrentId(created.id);
        }

        if (!isNew) {
          const existing = handlers.getExisting(targetId);
          if (existing && existing.content === content) return;
        }

        const modified = await api.saveNote(targetId, content);
        handlers.onSaved({ id: targetId, content, modified: Number(modified) });
      } catch (error) {
        console.error("falha ao salvar a nota", error);
      }
    });
  }

  /** Nota existente que foi esvaziada some em vez de virar arquivo em branco. */
  async function discardIfEmpty(): Promise<void> {
    const id = handlers.getCurrentId();
    if (!id) return;
    if (editorEl.value.trim() !== "") return;

    handlers.setCurrentId(null);
    try {
      await handlers.enqueue(() => api.purgeNote(id));
      handlers.onDiscarded(id);
    } catch (error) {
      console.error("falha ao descartar nota vazia", error);
    }
  }

  return { scheduleSave, flushSave, discardIfEmpty, clearScheduled };
}

// ---------------------------------------------------------------------------
// Confirmação de exclusão
// ---------------------------------------------------------------------------

export interface DeleteConfirmElements {
  overlay: HTMLElement;
  confirmButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
}

export function createDeleteConfirm(
  elements: DeleteConfirmElements,
  onConfirm: (id: string) => void | Promise<void>,
) {
  let pendingId: string | null = null;

  function ask(id: string | null | undefined): void {
    if (!id) return;
    pendingId = id;
    elements.overlay.classList.remove("hidden");
    elements.confirmButton.focus();
  }

  function close(): void {
    pendingId = null;
    elements.overlay.classList.add("hidden");
  }

  function confirm(): void {
    const id = pendingId;
    if (!id) return;
    close();
    void onConfirm(id);
  }

  function isPending(): boolean {
    return pendingId !== null;
  }

  /**
   * Enter confirma, Esc cancela — só enquanto o diálogo está aberto. Retorna
   * se tratou o evento, pra quem chama saber que não precisa seguir tratando
   * a tecla como atalho.
   */
  function handleKey(event: KeyboardEvent): boolean {
    if (!isPending()) return false;
    if (event.key === "Enter") {
      event.preventDefault();
      confirm();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    return true;
  }

  elements.confirmButton.addEventListener("click", confirm);
  elements.cancelButton.addEventListener("click", close);

  return { ask, close, isPending, handleKey };
}
