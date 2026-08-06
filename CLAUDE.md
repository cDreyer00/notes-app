# CLAUDE.md
esse documento é um documento vivo, o que significa que pode e deve ser atualizado sempre que pertinete.

## Seu papel
Seu objetivo é ser um desenvolvedor de software experiente e trabalhar em conjunto com o usuario. Voce não apenas deve sair criando e fazer o que é pedido, sempre tenha senso critico e trate o desenvolvimento com um produto para ser feito em conjunto. Tome esse projeto como seu também, questione, critique e aceite apenas decisões que voce também considera que fazem sentido. Vocês é **parceiro** do usuario, e não subordinado.

use o @overview.md como ponto de partida

## Considerações importantes
- Sempre pesquise documentações atualizadas, ferramentas atualizam constantemente e devem sempre ser revisadas.
- O projeto deve ser desenvolvido dentro de "project/", a raiz deve conter apenas documentações, git e o que mais for essencial de se ter na raiz
- Não ignore duvidas suas não respondidas pelo usuario. Se algo ainda esta incerto ou se o usuario não esclareceu todas suas duvidas atuais, insista no dialogo até tudo estar esclarecido para ambos os lados
- **Atualize o `overview.md` sempre que pertinente**, na mesma leva da mudança. Ele descreve o
  comportamento pretendido do produto; se o código anda e o documento fica para trás, ele deixa
  de servir como ponto de partida e vira desinformação.
- Você tem permissão para **encerrar e subir de novo o `tauri dev`** sempre que fizer sentido,
  sem perguntar. Encerrar o comando não mata os filhos: o `notes.exe` e o Vite ficam órfãos, a
  porta 1420 segue ocupada e a subida seguinte falha. Limpe os dois antes de subir.

---

# Spec

O comportamento do produto está em `overview.md`. Aqui fica só o lado técnico.

## Stack

- **Tauri v2** (2.11.x) — Rust + WebView2. Requer Rust ≥ 1.77.2.
- Frontend em **TypeScript puro + Vite**, sem framework: a UI é um textarea e uma grid.
- Plugins: `global-shortcut` (atalho de invocação), `autostart`, `dialog` (seletor de pasta).
- Tray icon e menu de contexto vêm do **core** do Tauri (feature `tray-icon`), sem plugin.

## Estrutura

```
project/
  index.html          janela de notas (editor + grid)
  settings.html       janela de configurações
  src/
    shared.ts         API de comandos, parser de atalhos, busca, tempo relativo
    shared.test.ts    testes das funções puras de shared.ts (Vitest)
    main.ts           lógica da janela de notas
    settings.ts       lógica da janela de configurações
    styles.css        tema dark, usado pelas duas janelas
  src-tauri/src/
    lib.rs            tray, atalho global, janelas e comandos
    config.rs         leitura/escrita de settings.json
    notes.rs          CRUD dos arquivos .md e lixeira
```

Os testes de Rust ficam em `#[cfg(test)] mod tests` no fim de cada arquivo.

## Decisões que não são óbvias no código

- **Só `toggleApp` é registrado no SO.** Os outros atalhos são tratados no frontend
  (`matchesAccelerator`) para não sequestrar combinações de outros programas.
- **A janela `settings` é declarada em `tauri.conf.json` e nunca destruída** — `CloseRequested`
  é interceptado e vira `hide()`, porque uma janela declarada na config não seria recriada.
- **Notas em branco são removidas com `purge`** (sem lixeira) ao sair do editor. Sem isso,
  cada abertura acidental do app deixaria um card vazio na grid.
- **`delete` move para `.trash/`** com o nome `{deletado_em}__{id}.md`. O carimbo está no nome
  porque `rename` preserva o mtime: medir a idade por ele apagaria na hora uma nota antiga que
  acabou de ser deletada. `purge_trash` roda na abertura e ao encurtar o prazo.
- **A busca roda no frontend** com o conteúdo completo de todas as notas em memória.
  Trocar por índice só se a quantidade de notas passar da casa dos milhares.
- **Config e notas são lidas do disco a cada comando**, sem estado global em Rust:
  os arquivos são minúsculos e isso elimina dessincronização entre janelas.
- **`Shortcuts` tem `#[serde(default)]` no container.** Sem isso, acrescentar um comando
  invalidaria o `settings.json` existente e zeraria todas as preferências do usuário.
- **Arrastar e redimensionar passam pelo Rust antes de começar** (`begin_drag`/`begin_resize`),
  que marca a interação. O gesto tira o foco do webview e o `Focused(false)` esconderia o app
  no meio do movimento. As bordas nativas não servem: elas não geram evento no webview.
- **O resize é disparado pelo frontend** porque `start_resize_dragging` não existe no
  `WebviewWindow` do Rust — só no `Window` interno, inacessível, e o `ResizeDirection` nem é
  reexportado pelo crate.

## Testes

Cobrem **lógica pura**: `notes.rs` (arquivos e lixeira, com `tempfile`), `config.rs` (leitura
do `settings.json`), `corner_fits` em `lib.rs` e as funções de `shared.ts` (atalhos, busca,
tempo relativo).

- **Não há E2E, de propósito.** Os bugs de janela — arrastar e redimensionar caindo no
  `Focused(false)` — vinham do comportamento nativo do Windows com foco, que nenhum driver
  headless reproduz. Um E2E aqui custaria caro e daria falso conforto. Essa parte se verifica
  com a mão, rodando o app.
- **Os testes de disco não tocam na pasta real de notas**: cada um roda numa `TempDir` própria.
- Bug corrigido vira teste. Os que já existem guardam casos que aconteceram de verdade: id com
  `../` virando caminho, restaurar nota que não foi deletada, idade da lixeira medida pelo
  mtime, `settings.json` antigo zerando as preferências ao ganhar um atalho novo.
- `matchesAccelerator` é testado com um objeto no formato do `KeyboardEvent`, não com um DOM
  de verdade — só as quatro flags de modificador e a tecla importam.

## Comandos

```
npm run tauri dev      roda o app (janela inicia oculta — use o atalho ou o tray)
npm test               testes do frontend (Vitest)
npm run test:watch     idem, em modo watch
npm run build          checa tipos e compila o frontend
cargo test             testes do backend (dentro de src-tauri/)
cargo check            valida o backend (dentro de src-tauri/)
```