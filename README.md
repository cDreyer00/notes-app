# Notes

App desktop para Windows feito para anotações rápidas, operado por **atalhos de teclado**. Fica em segundo plano e aparece na tela só quando chamado.

O princípio que guia todas as decisões: **o usuário só se preocupa em escrever**. Não existe organizar, nomear, salvar ou arquivar.

## Como funciona

Você aperta `Ctrl+Alt+F` de qualquer lugar do sistema, a janela aparece, você escreve, e aperta `Esc`. Pronto — está salvo. Não há botão de salvar, campo de título nem escolha de pasta.

Uma nota aberta e deixada em branco é descartada sozinha, então abrir o app por engano não deixa rastro.

## Atalhos

Todos são editáveis nas configurações.

| Ação | Padrão | Escopo |
|---|---|---|
| Abrir/ocultar o app | `Ctrl+Alt+F` | global |
| Alternar entre a grid e a nota atual | `Ctrl+Tab` | no app |
| Nova nota | `Ctrl+E` | no app |
| Deletar a nota atual | `Ctrl+D` | no app |
| Fixar a janela | `Ctrl+F` | no app |

`Esc` é fixo e significa sempre "um passo atrás": na nota, volta para a grid; na grid, esconde o app.

**Só o atalho de abrir/ocultar é registrado no sistema operacional.** Registrar todos faria o Notes sequestrar combinações de outros programas — os demais só funcionam com a janela em foco.

## Recursos

- **Bandeja do sistema** — duplo clique abre; clique direito dá acesso a *Configurações* e *Fechar*.
- **Grid de notas** em cards estilo post-it, com as primeiras linhas e uma marca de tempo ("há 5 min", "ontem"), navegável pelas setas.
- **Busca em tempo real** no conteúdo completo de todas as notas, ignorando acentos e maiúsculas. Match nas primeiras linhas pesa mais que no corpo; a nota mais recente desempata.
- **Lixeira** — deletar pede confirmação e ainda oferece *desfazer* por 5 segundos. A nota vai para `.trash/` e é apagada de vez quando vence o prazo de retenção (1 dia a 1 ano, ou nunca).
- **A janela lembra onde você a deixou**, em posição e tamanho. Dois toques rápidos no atalho recentralizam. Clicar fora esconde o app.
- **Fixar** desliga o "esconder ao perder o foco", para consultar uma nota trabalhando em outra janela. `Esc` e o atalho de abrir/ocultar continuam funcionando — o pino desliga só o gesto implícito.
- **Inicia junto com o Windows**, ligado por padrão.

## Onde ficam as notas

Cada nota é um arquivo `.md` numa pasta única — sem banco de dados, sem formato proprietário. Por padrão em `%APPDATA%\com.cris.notes\notes`, e a pasta é configurável.

Apontar o armazenamento para uma pasta do OneDrive ou do Google Drive dá sincronização entre máquinas sem o app implementar nada. Ao trocar o caminho com notas existentes, o app pergunta se deve movê-las ou apenas passar a usar o novo local.

As notas são salvas em `.md` pelo formato aberto, mas a edição é **texto puro**: sem preview, sem barra de formatação. Um parser de Markdown adicionaria modos e decisões de estilo que brigam com a proposta de velocidade.

## Stack

- **[Tauri v2](https://v2.tauri.app/)** (2.11.x) — Rust + WebView2, que já vem no Windows 11.
- Frontend em **TypeScript puro + Vite**, sem framework. A interface é um `textarea` e uma grid; um framework só somaria peso.
- Plugins oficiais: `global-shortcut`, `autostart` e `dialog`. Tray icon e menu de contexto vêm do core do Tauri.

## Desenvolvimento

Requisitos: **Rust ≥ 1.77.2**, **Node.js**, **WebView2 Runtime** e as **Build Tools do Visual Studio** com o Windows SDK (o linker MSVC).

```bash
cd project
npm install

npm run tauri dev      # roda o app (a janela inicia oculta — use o atalho ou a bandeja)
npm run tauri build    # gera o instalador
npm run build          # checa tipos e compila o frontend
cd src-tauri && cargo check   # valida o backend
```

### Estrutura

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

O comportamento pretendido do produto está em [`overview.md`](overview.md); as decisões técnicas que não são óbvias no código estão em [`CLAUDE.md`](CLAUDE.md).
