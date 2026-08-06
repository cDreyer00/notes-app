# CLAUDE.md
esse documento é um documento vivo, o que significa que pode e deve ser atualizado sempre que pertinete.

## Seu papel
Seu objetivo é ser um desenvolvedor de software experiente e trabalhar em conjunto com o usuario. Voce não apenas deve sair criando e fazer o que é pedido, sempre tenha senso critico e trate o desenvolvimento com um produto para ser feito em conjunto. Tome esse projeto como seu também, questione, critique e aceite apenas decisões que voce também considera que fazem sentido. Vocês é **parceiro** do usuario, e não subordinado.

use o @overview.md como ponto de partida

## Considerações importantes
- Sempre pesquise documentações atualizadas, ferramentas atualizam constantemente e devem sempre ser revisadas.
- O projeto deve ser desenvolvido dentro de "project/", a raiz deve conter apenas documentações, git e o que mais for essencial de se ter na raiz
- Não ignore duvidas suas não respondidas pelo usuario. Se algo ainda esta incerto ou se o usuario não esclareceu todas suas duvidas atuais, insista no dialogo até tudo estar esclarecido para ambos os lados
- **Atualize o `overview.md` sempre que pertinente**, na mesma leva da mudança. Ele descreve o comportamento pretendido do produto; se o código anda e o documento fica para trás, ele deixa de servir como ponto de partida e vira desinformação.
- Você tem permissão para **encerrar e subir de novo o `tauri dev`** sempre que fizer sentido, sem perguntar. Encerrar o comando não mata os filhos: o `notes.exe` e o Vite ficam órfãos, a porta 1420 segue ocupada e a subida seguinte falha. Limpe os dois antes de subir.

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
  index.html          janela principal (editor + grid)
  note.html           janela de uma nota destacada (só editor)
  settings.html       janela de configurações
  src/
    shared.ts         API de comandos, parser de atalhos, busca, tempo relativo
    shared.test.ts    testes das funções puras de shared.ts (Vitest)
    editor-core.ts    mecânica de editor compartilhada entre main.ts e note.ts
                       (fila de disco, autosave, confirmação de exclusão)
    main.ts           lógica da janela principal
    note.ts           lógica de uma janela de nota destacada
    settings.ts       lógica da janela de configurações
    styles.css        tema dark, usado pelas três janelas
  src-tauri/src/
    lib.rs            tray, atalho global, janelas (principal, destacadas,
                       configurações) e comandos
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
- **`DragState` é um `HashMap<label, Instant>`, não um valor único.** Com janelas de nota
  destacada existindo ao mesmo tempo da principal, arrastar uma não pode marcar a outra como
  "em interação" — cada label tem sua própria carência.
- **Esconder no blur passa por um debounce de 150ms num thread separado** (`schedule_hide_check`
  em `lib.rs`), em vez de agir na hora do `Focused(false)`. Trocar o foco entre duas janelas do
  próprio Notes gera um blur seguido de um focus quase imediato, e a ordem de chegada dos dois
  eventos não é garantida — a checagem, feita só quando o prazo vence, olha pro estado final
  (`any_notes_window_focused`) em vez de depender de qual evento chegou primeiro.
- **`hide_all`/`show_all` operam sobre a principal e toda janela `note-*` juntas, nunca uma de
  cada vez** — é o que faz "esconder o app" ser uma operação do conjunto, não da janela que
  perdeu o foco.
- **Uma janela de nota destacada nunca é destruída por `.destroy()` a partir de outro
  comando.** Tanto o botão de fechar (chama `undetach_note`) quanto o clique no card da grid
  passam por `window.close()`, que dispara `CloseRequested` — a limpeza da composição salva
  (`cleanup_detached`) mora só ali, um único caminho, em vez de duplicada entre o comando e o
  handler do evento.
- **A janela `settings` fica de fora do `is_notes_window`** — nunca fez parte do ciclo
  esconder/mostrar da principal, e a generalização pro multi-janela não mudou isso: focar as
  configurações ainda esconde a principal, como sempre esteve.

## Dev e instalado convivem como dois apps

O `tauri dev` e o app instalado são o mesmo programa com o mesmo identifier, então por padrão
dividiriam tudo: config, notas, lixeira, atalho global e a chave de autostart. Testar uma
mudança mexeria nas notas de verdade. A separação é por `cfg!(debug_assertions)` no Rust e
`import.meta.env.DEV` no frontend — as duas metades sempre concordam, porque `tauri dev` é
compilação de debug servida pelo Vite em modo dev.

| | Instalado | `tauri dev` |
|---|---|---|
| Config e notas | `%APPDATA%\com.cris.notes` | `%APPDATA%\com.cris.notes-dev` |
| Atalho global padrão | `Ctrl+Alt+F` | `Ctrl+Alt+Shift+F` |
| Autostart | aplica no registro | **nunca toca** |
| Tray e título | `Notes` | `Notes (dev)` |
| Rodapé | — | selo `dev` |

- A pasta de dev é **irmã** da real, não subpasta: dentro dela, um `list` da pasta real
  enxergaria as notas de teste.
- **O atalho global padrão precisa ser outro.** O registro é no SO: quem chega primeiro fica com
  a combinação e o segundo falha em silêncio — com o app instalado aberto, o dev nunca abriria
  pelo teclado.
- **O autostart nunca é tocado em dev**, nem para desligar. A chave de registro é uma só e é do
  app instalado: `enable` faria o Windows subir o `target/debug` no boot, e `disable` apagaria o
  autostart do app de verdade. Por isso o checkbox aparece desabilitado na janela de
  configurações do dev — controle que não faz nada é pior que controle desligado.
- **O que a separação não cobre: instalar com o dev aberto o derruba.** O instalador NSIS
  encerra processos com o mesmo nome de imagem, e o binário de dev também é `notes.exe`. O
  `tauri dev` morre com exit 1 sem mensagem — parece crash, não é. Separar exigiria renomear o
  crate, o que não compensa por um efeito que só aparece na hora de instalar.

## Ícone

Fica em `src-tauri/icons/`, gerado por `npm run tauri icon <arquivo.png>` a partir de um PNG
quadrado de 1024px. **O comando também cria pastas `ios/` e `android/`** — apague-as, o app é
só Windows.

O desenho é validado a **16px**, não a 1024: é o tamanho da bandeja, onde o ícone realmente
vive. Aí só sobrevive silhueta simples com poucos elementos — uma versão com três linhas de
texto virou mancha listrada e foi descartada em favor de duas. O `.ico` é referenciado pelo
`tauri.conf.json` e o tray puxa dele via `default_window_icon()`.

## Branches

Gitflow: `main` só recebe merge de `develop`, na hora de lançar uma versão (junto com a tag
`vX.Y.Z`, ver Versionamento abaixo). Toda feature nasce em `feature/<nome>` a partir de
`develop` e volta pra lá via merge — nunca direto em `main`.

## Versionamento

A versão vive **só no `Cargo.toml`**. O `tauri.conf.json` não declara `version` (o Tauri cai
no Cargo por padrão) e o `package.json` também não — ele é `private` e npm não exige. Dos três
lugares onde o número já esteve, o do Cargo é o único obrigatório, então é o único que sobra:
sem cópias, não há como bumpar uma e esquecer as outras.

Como não existe API pública aqui, o SemVer se lê assim:

- **MAJOR** — quebra o que já está no disco do usuário: formato do `.md`, layout da pasta,
  chave do `settings.json` que não migra sozinha. Exige que ele faça algo.
- **MINOR** — comando novo, feature, mudança visível de comportamento.
- **PATCH** — correção que não muda o que o app faz de propósito.

O `#[serde(default)]` da config e o `find_in_trash` aceitando o formato antigo existem
justamente para que mudanças assim não precisem de um MAJOR.

Cada build vira **tag `vX.Y.Z`** no commit exato, com Release no GitHub e o instalador
anexado — é o que liga o app rodando na máquina ao código que o gerou. A versão aparece no
rodapé das configurações (comando `app_version`), com `(dev)` quando é a build de
desenvolvimento.

Sem updater por ora: atualizar é rodar o instalador novo por cima, e o NSIS faz upgrade
in-place sem tocar nas notas, que vivem em `%APPDATA%`. O `tauri-plugin-updater` exige par de
chaves, assinatura por release e um manifesto hospedado — vale quando houver alguém além do
autor usando.

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