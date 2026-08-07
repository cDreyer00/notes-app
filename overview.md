# Overview

**Notes** é um app desktop Windows para anotações rápidas, operado primariamente por **atalhos de teclado**. Ele roda sempre em segundo plano e aparece na tela apenas quando chamado.

O princípio que guia todas as decisões: **o usuário só se preocupa em escrever**. Nada de organizar, nomear, salvar ou arquivar.

## Comportamento geral

- Roda em segundo plano, sem janela visível, com ícone na **área de notificação** (system tray, canto direito da barra de tarefas).
- É invocado por um **atalho global** configurável.
- Alternativa secundária: **duplo clique** no ícone da bandeja abre o app.
- **Clique direito no ícone** abre um menu de contexto com:
  - **Configurações** — abre a janela de configurações
  - **Fechar** — encerra o app definitivamente (não apenas esconde)
- Salvamento é **automático e contínuo**. Não existe ação de salvar.
- UI minimalista, dark mode por padrão.

## Comandos e atalhos

Todos os atalhos são editáveis pelo usuário nas configurações. Eles se dividem em dois escopos:

**Escopo global** (funciona com qualquer app em foco, registrado no SO):

| Comando | Descrição |
|---|---|
| Abrir/ocultar o app | Alterna a visibilidade da janela. Não encerra o app. |

**Escopo local** (só funciona com a janela do Notes em foco):

| Comando | Descrição |
|---|---|
| Alternar visão | Alterna entre a **grid de notas** e a **última nota em edição**. |
| Nova nota | Cria uma nota vazia e foca o cursor nela. |
| Deletar nota atual | Pede confirmação; ao confirmar, volta para a grid. |
| Fixar janela | Liga/desliga o modo fixado (ver abaixo). |
| Destacar nota | Abre a nota em edição numa **janela própria** (ver "Múltiplas janelas de nota"). |

> Numa janela de nota destacada, só **deletar** é local. Os demais comandos acima
> focam a janela principal e executam lá — não faz sentido, por exemplo, "alternar
> visão" numa janela que não tem grid.

> **Por que só um atalho global:** registrar todos no SO faria o Notes sequestrar combinações de outros programas. Apenas a invocação precisa funcionar de fora do app.

## Janela de nota

- Área de texto única, sem título, sem formatação obrigatória.
- Notas **não têm título** — o foco é velocidade, e boa parte delas é temporária.
- Salvamento automático enquanto digita.
- Nota criada e deixada vazia é **descartada automaticamente** (não polui a grid).

## Múltiplas janelas de nota

Qualquer nota pode ser **destacada** para uma janela própria, independente da
principal — útil pra consultar uma nota enquanto se escreve outra, ou enquanto se
usa outro programa.

- **Como destacar:** com a nota aberta na principal, o atalho "Destacar nota" a
  abre em janela própria e a principal volta para a grid. Também dá pra **arrastar
  um card da grid pra fora** dos limites da janela e soltar — mesmo efeito, com um
  indicador visual acompanhando o cursor durante o arraste.
- **Na grid**, o card de uma nota destacada tem visual diferente (borda
  tracejada). Clicar nele — ou abrir com `Enter` — **recolhe** a nota de volta,
  fechando a janela destacada. Uma nota nunca está aberta em dois editores ao
  mesmo tempo: seriam dois salvamentos automáticos sobre o mesmo arquivo, e o
  último a gravar apagaria o que foi escrito no outro.
- **A janela destacada só tem a nota** — sem grid, sem busca. O único comando
  local ali é **deletar**; os demais (nova nota, alternar visão, fixar) focam a
  principal e executam lá. Tem um **botão de fechar** no canto superior direito, e
  o atalho **"Fechar janela extra"** faz o mesmo — os dois, junto com `Esc`, valem
  só dentro de uma janela destacada, nunca na principal.
- **Fica sempre por cima e fora da barra de tarefas**, no mesmo perfil da janela
  principal — senão outro programa em foco cobriria a nota que se queria consultar.
- **Deletar ali some com a janela**, e o "desfazer" aparece na principal — a
  janela que confirmou a exclusão deixa de existir, mas a rede de segurança
  vale em qualquer lugar do app. Deletar uma nota destacada pela grid fecha a
  janela dela do mesmo jeito.
- **A composição persiste**: quais notas estão destacadas, e a posição/tamanho de
  cada janela, voltam exatamente iguais ao reabrir o app. Nota que sumiu do disco
  enquanto o app estava fechado sai da composição em vez de virar janela vazia.
- **Nota destacada deixada em branco é descartada** quando o app esconde, igual
  à principal — e a janela dela fecha junto, já que ficaria sem nota nenhuma.
- **Perder o foco esconde tudo junto** — a principal e todas as destacadas. Trocar
  o foco entre janelas do próprio Notes nunca esconde nada; só sair do app esconde
  o conjunto inteiro (ver "Clicar fora da janela" abaixo).

## Janela de notas salvas (grid)

- Notas exibidas como **cards em grid**, estilo post-it, com **scroll vertical**.
- Cada card mostra as **primeiras linhas** do conteúdo e uma marcação de tempo discreta (ex.: "há 5 min", "ontem").
- Ordenação padrão: **modificadas mais recentemente primeiro**.
- Navegável por teclado: as **setas** movem a seleção pelos cards e **Enter** abre.
  - Com o foco na busca, ← e → percorrem o texto digitado; ao chegar na ponta, voltam a
    navegar pela grid. Sem isso, andar de lado seria impossível — o foco começa sempre na
    busca.
- **Barra de pesquisa no topo:** busca no conteúdo completo de todas as notas e reordena a grid por relevância, em tempo real.
  - Ignora acentuação e maiúsculas/minúsculas.
  - Ranking: match nas primeiras linhas pesa mais que no corpo; recência desempata.

## Confirmação de exclusão

- Janela de confirmação simples.
- **Enter** confirma (tecla padrão), **Esc** cancela.
- Ao confirmar, retorna para a grid.
- Rede de segurança: a nota vai para uma **lixeira interna** e a grid oferece **desfazer por alguns segundos**. Enter é uma tecla reflexiva demais para uma ação irreversível.
- A lixeira é limpa sozinha na abertura do app, segundo o **prazo de retenção** definido nas
  configurações. Sem isso, "deletar" nunca deletaria de fato: o texto seguiria legível em disco
  (e sincronizado, se a pasta for do OneDrive/Drive).

## Janela de configurações

Duas seções, nada além disso:

**Atalhos**
- Um campo por comando; o usuário atribui qualquer combinação de teclas.
- Deve **avisar quando um atalho global já está em uso** por outro app — caso contrário o registro falha em silêncio e o app parece quebrado.

**Lixeira**
- Prazo de permanência das notas deletadas: 1 dia, 1 semana, 1 mês (padrão), 1 ano ou nunca
  apagar.
- Encurtar o prazo vale na hora, não só na próxima abertura.
- Mostra **quantas notas estão guardadas** e oferece **esvaziar agora**, com confirmação
  explícita. É a única ação sem volta do app — sem a contagem, seria um botão sobre uma
  caixa fechada.

**Local de armazenamento**
- Campo com seletor de pasta para definir onde as notas `.md` são salvas.
- Padrão: pasta de dados do app no perfil do usuário.
- Permite apontar para uma pasta sincronizada (OneDrive, Drive) e obter sincronização sem o app implementar nada.
- Ao trocar o caminho com notas já existentes, o app **pergunta explicitamente** se deve mover as notas para o novo local ou apenas passar a usá-lo. Mover em silêncio é arriscado; só apontar faz as notas parecerem perdidas.
- Validar permissão de escrita antes de aceitar o caminho.

## Stack

- **Tauri v2** (série 2.11.x), Rust + frontend web sobre o WebView2 já presente no Windows 11. Requer Rust ≥ 1.77.2.
- Tray icon e menu de contexto: **nativos do core** do Tauri v2, sem plugin.
- Atalho global: **`tauri-plugin-global-shortcut`** (oficial).
- Atalhos locais: tratados no **frontend**, via evento de teclado — não passam pelo SO, então não conflitam com outros apps.
- Preferências de atalhos persistidas em arquivo próprio no diretório de config do app.

## Armazenamento

- Cada nota é um **arquivo `.md`** em uma pasta única. Sem banco de dados.
- Portável, sincronizável (Drive/OneDrive) e legível por qualquer editor — sem lock-in.
- A busca lê os arquivos em memória; irrelevante em performance até a casa dos milhares de notas.
- Lixeira: subpasta dedicada, para onde a nota deletada vai antes de sumir de vez.

## Comportamento de janela e edição

- **Posição da janela:** o usuário pode arrastá-la (pela faixa do topo ou pelo rodapé) e a
  posição é salva, reaparecendo sempre no mesmo lugar.
  - Se a posição salva cair fora de todos os monitores atuais, a janela volta ao centro em vez
    de reaparecer invisível.
- **Duplo acionamento do atalho:** dois toques rápidos no atalho de abrir/ocultar recentralizam
  a janela em vez de abrir e fechar. O gesto também redefine a posição salva.
- **Tamanho da janela:** redimensionável pelas bordas e cantos; o tamanho é salvo junto com a
  posição.
- **Clicar fora esconde o app inteiro:** a principal e toda janela de nota destacada juntas,
  não uma de cada vez. O que importa é o foco sair do Notes por completo — trocar de janela
  entre a principal e uma destacada, ou entre duas destacadas, nunca esconde nada. O autosave
  garante que nada se perde.
- **Janela fixada:** enquanto fixada, perder o foco **não** esconde o app — dá para consultar
  uma nota trabalhando em outro programa. `Esc` e o atalho de abrir/ocultar continuam
  escondendo: o pino desliga só o gesto implícito, nunca o comando explícito. É uma
  preferência **única para o app inteiro**, não por janela.
  - O estado é **preferência, não estado momentâneo**: sobrevive a esconder, reabrir e
    reiniciar o app.
  - O rodapé mostra o pino aceso. Sem sinal visível, uma janela que não some mais parece
    defeito em vez de escolha.
- **`Esc`:** sempre "um passo atrás" — na nota, volta para a grid; na grid, esconde o app.
- **Iniciar junto com o Windows:** ligado por padrão. Um app que só existe se estiver rodando não pode depender do usuário lembrar de abri-lo.
- **Markdown:** as notas são salvas em `.md` pelo formato aberto, mas a edição é **texto puro**, sem renderização. Preview e parser adicionariam modos e decisões de estilo que brigam com a proposta de velocidade.
