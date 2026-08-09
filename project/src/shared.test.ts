import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySavedNote,
  firstLine,
  hasModifier,
  isOutsideBounds,
  matchesAccelerator,
  normalizeKey,
  normalizeText,
  parseAccelerator,
  pickInitialNote,
  prettyAccelerator,
  relativeTime,
  searchNotes,
  toPhysicalPoint,
  type Note,
} from "./shared";

/**
 * `KeyboardEvent` é do DOM e os testes rodam em Node. Só as propriedades lidas
 * por `matchesAccelerator` importam — montar o objeto evita arrastar um DOM
 * inteiro para dentro da suíte.
 */
function keyEvent(
  key: string,
  modifiers: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false,
  } as KeyboardEvent;
}

function note(id: string, content: string, modified = 0): Note {
  return { id, content, modified };
}

// ---------------------------------------------------------------------------
// Atalhos
// ---------------------------------------------------------------------------

describe("parseAccelerator", () => {
  it("entende os apelidos de cada modificador", () => {
    const esperado = { ctrl: true, alt: false, shift: false, meta: false, key: "F" };
    for (const alias of ["Control", "Ctrl", "CommandOrControl", "cmdOrCtrl"]) {
      expect(parseAccelerator(`${alias}+F`)).toEqual(esperado);
    }
    expect(parseAccelerator("Super+K")?.meta).toBe(true);
    expect(parseAccelerator("Win+K")?.meta).toBe(true);
    expect(parseAccelerator("Option+K")?.alt).toBe(true);
  });

  it("normaliza caixa e espaços", () => {
    expect(parseAccelerator(" control + alt + f ")).toEqual(
      parseAccelerator("Control+Alt+F"),
    );
  });

  /** Combinação só de modificadores não é atalho — seria disparada ao segurar Ctrl. */
  it("recusa combinação sem tecla", () => {
    expect(parseAccelerator("Control+Alt")).toBeNull();
    expect(parseAccelerator("")).toBeNull();
  });
});

describe("normalizeKey", () => {
  it("traduz setas e espaço para o vocabulário dos accelerators", () => {
    expect(normalizeKey("ArrowUp")).toBe("Up");
    expect(normalizeKey("ArrowLeft")).toBe("Left");
    expect(normalizeKey(" ")).toBe("Space");
  });

  it("padroniza a caixa das demais teclas", () => {
    expect(normalizeKey("a")).toBe("A");
    expect(normalizeKey("tab")).toBe("Tab");
    expect(normalizeKey("Escape")).toBe("Escape");
  });
});

describe("matchesAccelerator", () => {
  it("casa a combinação exata", () => {
    expect(matchesAccelerator(keyEvent("f", { ctrl: true, alt: true }), "Control+Alt+F"))
      .toBe(true);
    expect(matchesAccelerator(keyEvent("Tab", { ctrl: true }), "Control+Tab")).toBe(true);
  });

  /**
   * Modificador sobrando precisa falhar: Ctrl+Shift+D é um comando de outro
   * app e não pode acionar o delete do Notes.
   */
  it("recusa modificador a mais ou a menos", () => {
    expect(matchesAccelerator(keyEvent("d", { ctrl: true, shift: true }), "Control+D"))
      .toBe(false);
    expect(matchesAccelerator(keyEvent("d"), "Control+D")).toBe(false);
    expect(matchesAccelerator(keyEvent("f", { ctrl: true }), "Control+Alt+F")).toBe(false);
  });

  it("ignora a caixa da tecla", () => {
    expect(matchesAccelerator(keyEvent("E", { ctrl: true }), "Control+E")).toBe(true);
    expect(matchesAccelerator(keyEvent("e", { ctrl: true }), "control+e")).toBe(true);
  });

  it("não casa com accelerator inválido", () => {
    expect(matchesAccelerator(keyEvent("f", { ctrl: true }), "Control")).toBe(false);
  });
});

describe("hasModifier", () => {
  /** Atalho sem modificador engoliria a digitação normal no editor. */
  it("exige modificador, salvo teclas de função", () => {
    expect(hasModifier("Control+E")).toBe(true);
    expect(hasModifier("Alt+Space")).toBe(true);
    expect(hasModifier("Super+N")).toBe(true);
    expect(hasModifier("F2")).toBe(true);
    expect(hasModifier("F12")).toBe(true);

    expect(hasModifier("E")).toBe(false);
    expect(hasModifier("Shift+E")).toBe(false);
    expect(hasModifier("Escape")).toBe(false);
    expect(hasModifier("")).toBe(false);
  });
});

describe("prettyAccelerator", () => {
  it("mostra o nome curto que o usuário reconhece no teclado", () => {
    expect(prettyAccelerator("Control+Alt+F")).toBe("Ctrl + Alt + F");
    expect(prettyAccelerator("CommandOrControl+E")).toBe("Ctrl + E");
    expect(prettyAccelerator("Super+K")).toBe("Win + K");
  });
});

// ---------------------------------------------------------------------------
// Texto e busca
// ---------------------------------------------------------------------------

describe("normalizeText", () => {
  it("tira acento e caixa", () => {
    expect(normalizeText("Café à Ação")).toBe("cafe a acao");
    expect(normalizeText("ÇÃOÜ")).toBe("caou");
  });
});

describe("firstLine", () => {
  it("devolve a primeira linha com conteúdo", () => {
    expect(firstLine("\n\n   \nprimeira de verdade\nsegunda")).toBe(
      "primeira de verdade",
    );
    expect(firstLine("   com espaço   ")).toBe("com espaço");
    expect(firstLine("")).toBe("");
    expect(firstLine("\n \n")).toBe("");
  });
});

describe("searchNotes", () => {
  it("sem busca, devolve tudo na ordem recebida", () => {
    const todas = [note("a", "uma"), note("b", "outra")];
    const resultado = searchNotes(todas, "   ");

    expect(resultado).toEqual(todas);
    // Cópia, não a mesma lista: a grid reordena o resultado sem mexer no cache.
    expect(resultado).not.toBe(todas);
  });

  it("acha ignorando acento e caixa", () => {
    const resultado = searchNotes([note("a", "Comprar Café")], "cafe");
    expect(resultado.map((n) => n.id)).toEqual(["a"]);
  });

  it("exige que todos os termos apareçam", () => {
    const notas = [note("a", "café com leite"), note("b", "café puro")];
    expect(searchNotes(notas, "cafe leite").map((n) => n.id)).toEqual(["a"]);
    expect(searchNotes(notas, "cafe inexistente")).toEqual([]);
  });

  it("põe na frente o match das primeiras linhas", () => {
    const corpo = note("corpo", "outra coisa qualquer\nreunião no fim");
    const cabeca = note("cabeca", "reunião de segunda\ntexto qualquer");

    expect(searchNotes([corpo, cabeca], "reuniao").map((n) => n.id)).toEqual([
      "cabeca",
      "corpo",
    ]);
  });

  it("desempata pela nota modificada mais recentemente", () => {
    const antiga = note("antiga", "compras", 1_000);
    const recente = note("recente", "compras", 9_000);

    expect(searchNotes([antiga, recente], "compras").map((n) => n.id)).toEqual([
      "recente",
      "antiga",
    ]);
  });

  it("não confunde termo repetido com nota irrelevante", () => {
    const muitas = note("muitas", "erro\nerro de novo\nmais um erro");
    const uma = note("uma", "erro\nresto do texto");

    expect(searchNotes([uma, muitas], "erro")[0].id).toBe("muitas");
  });
});

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

describe("relativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function agoraEm(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    return new Date(iso).getTime();
  }

  it("descreve as janelas curtas em minutos e horas", () => {
    const agora = agoraEm("2026-08-05T12:00:00");

    expect(relativeTime(agora)).toBe("agora");
    expect(relativeTime(agora - 59_000)).toBe("agora");
    expect(relativeTime(agora - 60_000)).toBe("há 1 min");
    expect(relativeTime(agora - 59 * 60_000)).toBe("há 59 min");
    expect(relativeTime(agora - 60 * 60_000)).toBe("há 1 h");
    expect(relativeTime(agora - 23 * 3_600_000)).toBe("há 23 h");
  });

  it("usa palavras para os primeiros dias", () => {
    const agora = agoraEm("2026-08-05T12:00:00");

    expect(relativeTime(agora - 24 * 3_600_000)).toBe("ontem");
    expect(relativeTime(agora - 3 * 24 * 3_600_000)).toBe("há 3 dias");
    expect(relativeTime(agora - 6 * 24 * 3_600_000)).toBe("há 6 dias");
  });

  it("passa a mostrar a data a partir de uma semana", () => {
    const agora = agoraEm("2026-08-05T12:00:00");
    expect(relativeTime(agora - 7 * 24 * 3_600_000)).toBe("29/07");
  });

  /** Relógio atrasado ou nota vinda de outra máquina não pode virar "há -3 min". */
  it("trata data no futuro como agora", () => {
    const agora = agoraEm("2026-08-05T12:00:00");
    expect(relativeTime(agora + 60_000)).toBe("agora");
  });
});

// ---------------------------------------------------------------------------
// Arrastar um card para fora da janela
// ---------------------------------------------------------------------------

describe("isOutsideBounds", () => {
  const janela = { x: 100, y: 100, width: 500, height: 400 };

  it("reconhece um ponto dentro da janela", () => {
    expect(isOutsideBounds({ x: 350, y: 300 }, janela)).toBe(false);
    expect(isOutsideBounds({ x: 100, y: 100 }, janela)).toBe(false);
    expect(isOutsideBounds({ x: 600, y: 500 }, janela)).toBe(false);
  });

  it("reconhece um ponto fora por qualquer um dos quatro lados", () => {
    expect(isOutsideBounds({ x: 99, y: 300 }, janela)).toBe(true);
    expect(isOutsideBounds({ x: 601, y: 300 }, janela)).toBe(true);
    expect(isOutsideBounds({ x: 350, y: 99 }, janela)).toBe(true);
    expect(isOutsideBounds({ x: 350, y: 501 }, janela)).toBe(true);
  });

  /**
   * O caso que motivou separar a conversão: num monitor a 150%, o mouse
   * reporta 400 CSS px onde a janela começa em 600 físicos. Sem converter, um
   * ponto no meio da janela seria lido como "à esquerda dela" e cada arraste
   * curto viraria uma janela nova.
   */
  it("só decide certo depois de converter o ponto para pixels físicos", () => {
    const pontoCss = { x: 400, y: 300 };
    expect(isOutsideBounds(pontoCss, { x: 600, y: 200, width: 800, height: 600 })).toBe(true);

    const fisico = toPhysicalPoint(pontoCss, 1.5);
    expect(fisico).toEqual({ x: 600, y: 450 });
    expect(isOutsideBounds(fisico, { x: 600, y: 200, width: 800, height: 600 })).toBe(false);
  });

  it("mantém o ponto inalterado sem escala", () => {
    expect(toPhysicalPoint({ x: 120, y: 80 }, 1)).toEqual({ x: 120, y: 80 });
  });
});

// ---------------------------------------------------------------------------
// Nota inicial da janela principal
// ---------------------------------------------------------------------------

describe("pickInitialNote", () => {
  const notas = [
    note("a", "primeira", 3),
    note("b", "segunda", 2),
    note("c", "terceira", 1),
  ];

  it("abre a mais recente quando nenhuma está destacada", () => {
    expect(pickInitialNote(notas, new Set())?.id).toBe("a");
  });

  /** Abrir aqui a nota que já está em janela própria daria dois editores
   *  sobre o mesmo arquivo — o último a salvar apagaria o texto do outro. */
  it("pula as que já estão em janela própria", () => {
    expect(pickInitialNote(notas, new Set(["a"]))?.id).toBe("b");
    expect(pickInitialNote(notas, new Set(["a", "b"]))?.id).toBe("c");
  });

  it("devolve null quando todas estão destacadas", () => {
    expect(pickInitialNote(notas, new Set(["a", "b", "c"]))).toBeNull();
  });

  it("devolve null sem notas", () => {
    expect(pickInitialNote([], new Set())).toBeNull();
  });
});

/**
 * Nota editada numa janela destacada precisa alcançar a lista da principal.
 * Sem isso a grid exibia o texto anterior e — o caso feio — abrir a nota por
 * aquele card levava a versão velha para o editor, que a regravava por cima do
 * que tinha sido escrito na outra janela.
 */
describe("applySavedNote", () => {
  it("atualiza conteúdo e horário da nota que já está na lista", () => {
    const notas = [note("a", "antigo", 1), note("b", "outra", 2)];

    applySavedNote(notas, note("a", "novo", 99));

    expect(notas).toHaveLength(2);
    expect(notas[0].content).toBe("novo");
    expect(notas[0].modified).toBe(99);
  });

  /** A mesma referência precisa sobreviver: a grid guarda os objetos da lista
   *  até o próximo render, e trocá-los deixaria cards apontando para a versão
   *  velha. */
  it("mantém o objeto original em vez de substituí-lo", () => {
    const alvo = note("a", "antigo", 1);
    const notas = [alvo];

    applySavedNote(notas, note("a", "novo", 99));

    expect(notas[0]).toBe(alvo);
  });

  /** Nota criada em outra janela ainda não existe aqui. */
  it("insere no topo a nota que a lista não conhecia", () => {
    const notas = [note("a", "primeira", 1)];

    applySavedNote(notas, note("z", "recém-criada", 99));

    expect(notas.map((n) => n.id)).toEqual(["z", "a"]);
  });

  /** A ordem não se refaz aqui: reordenar moveria cards sob o cursor enquanto
   *  se digita na outra janela. Ela se acerta na próxima relistagem. */
  it("não reordena a lista pelo horário novo", () => {
    const notas = [note("a", "mais recente", 10), note("b", "antiga", 5)];

    applySavedNote(notas, note("b", "editada agora", 99));

    expect(notas.map((n) => n.id)).toEqual(["a", "b"]);
  });
});
