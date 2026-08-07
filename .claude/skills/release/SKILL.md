---
name: release
description: >
  Publica uma nova versão do Notes: roda a suíte de testes, decide e aplica o bump de versão,
  gera o instalador NSIS, cria a tag e publica o Release no GitHub com o binário anexado.
  Use esta skill sempre que o usuário pedir para "fazer uma build", "gerar o instalador",
  "publicar uma versão", "lançar a 0.2", "criar o release" ou equivalente. Específica deste
  projeto (Tauri v2 + Windows). Não escreve código de produto — se algo precisar ser corrigido
  no meio do caminho, pare e trate como trabalho separado antes de retomar.
---

# /release — Publicação de uma versão do Notes

## Princípio

Um release é uma afirmação verificável: **este instalador foi gerado a partir deste commit**.
Tudo aqui existe para que essa frase seja verdade. Se em qualquer ponto ela deixar de ser
(build a partir de árvore suja, tag no commit errado, instalador de bundle antigo), pare e
conserte antes de seguir.

Nunca pule fases. Nunca publique sem ter olhado o artefato.

---

## Fase 1 — Pré-voo

0. **`main` em dia com `develop`.** Gitflow: `main` só recebe merge de `develop`, na hora de
   lançar uma versão — nunca commit direto. Faça esse merge primeiro, antes do resto do
   pré-voo, pra árvore limpa e os testes valerem pro código que de fato vai ser taggeado:
   ```
   git checkout develop && git pull
   git checkout main && git pull
   git merge develop --no-edit
   git push origin main
   ```
   Da fase 2 em diante, tudo roda em cima de `main` já atualizada.
1. **Árvore limpa.** `git status --short` precisa vir vazio. Mudança pendente ou entra no
   release (commit antes) ou fica de fora (stash) — mas não pode ficar solta, ou o instalador
   deixa de corresponder ao commit.
2. **Testes.** Os dois lados:
   ```
   cd project/src-tauri && cargo test
   cd project && npm test
   ```
   Falhou algum, o release para aqui.
3. **Encerre o `tauri dev`.** Ele não só ocupa a porta 1420: o `cargo` mantém lock sobre
   `target/`, e a build de release fica esperando em silêncio. Encerrar o comando **não** mata
   os filhos — verifique e mate os órfãos:
   ```powershell
   Get-Process notes -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
   $c = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
   if ($c) { Stop-Process -Id $c.OwningProcess -Force -Confirm:$false }
   ```

---

## Fase 2 — Versão

A versão vive **só em `project/src-tauri/Cargo.toml`**. Não existe em `tauri.conf.json` nem
em `package.json`, e não deve voltar a existir.

Decida o dígito pelo que a mudança faz **com o que já está no disco do usuário**:

- **MAJOR** — quebra o que existe: formato do `.md`, layout da pasta de notas, chave do
  `settings.json` que não migra sozinha. Exige ação do usuário.
- **MINOR** — comando novo, feature, mudança visível de comportamento.
- **PATCH** — correção que não muda o que o app faz de propósito.

Na dúvida entre MINOR e PATCH, pergunte ao usuário: a diferença é o que ele vai comunicar,
não o que o código faz.

Aplique o bump e **commite antes de buildar** — o nome do instalador carrega a versão, então
bumpar depois produz um arquivo que mente.

---

## Fase 3 — Build

```
cd project && npm run release
```

Isso roda `tauri build` (que por sua vez roda `tsc && vite build`) e depois copia o instalador
para `project/release/`, porque o Tauri não tem opção de diretório de saída e o bundle nasce
enterrado em `src-tauri/target/release/bundle/nsis/`.

A build de release compila do zero e otimizada: **conte alguns minutos**. Rode em background e
espere com um `until` sobre o log — não fique repetindo `sleep`.

O script avisa se o nome do instalador não bate com a versão do `Cargo.toml`. Esse aviso quase
sempre significa que a build não rodou e o que foi copiado é bundle velho. Não ignore.

---

## Fase 4 — Verificação

Antes de publicar qualquer coisa, olhe o que foi produzido:

1. **Nome e tamanho.** `Notes_<versão>_x64-setup.exe`, na casa de 2 MB (o binário, ~10 MB).
   Uma variação grande de tamanho merece explicação antes de publicar.
2. **A versão no nome bate** com o `Cargo.toml`.
3. Se a mudança mexeu em algo visível, peça ao usuário para instalar e conferir antes da
   publicação — desfazer um Release publicado é pior do que atrasá-lo.

---

## Fase 5 — Tag e publicação

1. **Tag anotada no commit da build** (não em um posterior):
   ```
   git tag -a v<versão> -m "Notes <versão>\n\n<uma linha sobre o que mudou>"
   ```
2. **Push** dos commits e da tag:
   ```
   git push origin main && git push origin v<versão>
   ```
3. **Release no GitHub com o instalador anexado.** Release sem binário não serve para nada —
   o ponto é justamente guardar o artefato:
   ```
   gh release create v<versão> --title "Notes <versão>" --notes-file <arquivo> \
     "project/release/Notes_<versão>_x64-setup.exe"
   ```
   Escreva as notas em arquivo, não inline: elas têm várias seções e o escape na linha de
   comando é fonte de erro. Estrutura que já funcionou:
   - o que é / uma linha
   - **Instalação** — incluindo o aviso do SmartScreen (binário não assinado) e o requisito
     do WebView2
   - **O que tem nesta versão** — em linguagem de usuário, não de commit
   - **Notas técnicas** — tamanho, e que não há atualização automática
4. Confirme que o asset subiu: `gh release view v<versão> --json assets`.

O repositório é privado, então o Release também é. Isso é esperado — ele funciona como backup
versionado do binário.

---

## Depois de instalar

O app instalado e o `tauri dev` convivem como dois apps separados (pastas, atalho e rótulo
próprios — ver `CLAUDE.md`). Duas coisas valem conferir na primeira execução da versão nova:

- **A chave de autostart** em `HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` passa a
  apontar para o app instalado. Se estiver apontando para `target\debug\notes.exe`, é porque o
  app instalado ainda não foi aberto nenhuma vez.
- **As notas continuam lá.** Elas vivem em `%APPDATA%\com.cris.notes`, que o instalador não
  toca — o NSIS faz upgrade in-place.

---

## Armadilhas conhecidas

- **`tauri dev` rodando durante a build** — segura o lock do `target/`; a build espera sem dizer
  por quê.
- **Instalar com o dev aberto derruba o dev.** O NSIS encerra processos com o mesmo nome de
  imagem antes de copiar os arquivos, e o binário de desenvolvimento também se chama
  `notes.exe`. O `tauri dev` morre com exit 1 e nenhuma mensagem de erro — o que parece crash e
  não é. Feche o dev antes de instalar.
- **Bump depois da build** — instalador com nome de versão errada.
- **Tag em commit posterior ao da build** — quebra a única garantia que o release oferece.
- **Regenerar o ícone** (`npm run tauri icon`) cria pastas `ios/` e `android/` em
  `src-tauri/icons/`. Apague — o app é só Windows.
- **`bundle.targets`** está fixo em `["nsis"]`. Se aparecer um MSI no bundle, alguém mexeu na
  config: o MSI exige admin e não faz instalação por usuário.
