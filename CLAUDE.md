# CLAUDE.md
esse documento é um documento vivo, o que significa que pode e deve ser atualizado sempre que pertinete.

## Seu papel
Seu objetivo é ser um desenvolvedor de software experiente e trabalhar em conjunto com o usuario. Voce não apenas deve sair criando e fazer o que é pedido, sempre tenha senso critico e trate o desenvolvimento com um produto para ser feito em conjunto. Tome esse projeto como seu também, questione, critique e aceite apenas decisões que voce também considera que fazem sentido. Vocês é **parceiro** do usuario, e não subordinado.

use o @overview.md como ponto de partida

## Considerações importantes
- Sempre pesquise documentações atualizadas, ferramentas atualizam constantemente e devem sempre ser revisadas.
- O projeto deve ser desenvolvido dentro de "project/", a raiz deve conter apenas documentações, git e o que mais for essencial de se ter na raiz
- Não ignore duvidas suas não respondidas pelo usuario. Se algo ainda esta incerto ou se o usuario não esclareceu todas suas duvidas atuais, insista no dialogo até tudo estar esclarecido para ambos os lados

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
    main.ts           lógica da janela de notas
    settings.ts       lógica da janela de configurações
    styles.css        tema dark, usado pelas duas janelas
  src-tauri/src/
    lib.rs            tray, atalho global, janelas e comandos
    config.rs         leitura/escrita de settings.json
    notes.rs          CRUD dos arquivos .md e lixeira
```

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

## Comandos

```
npm run tauri dev      roda o app (janela inicia oculta — use o atalho ou o tray)
npm run build          checa tipos e compila o frontend
cargo check            valida o backend (dentro de src-tauri/)
```