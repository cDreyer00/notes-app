---
name: dev
description: >
  Sobe o Notes em modo de desenvolvimento (`tauri dev`) para o usuário testar na mão.
  Use esta skill sempre que ele pedir para "rodar o app", "subir o app pra eu testar",
  "roda aí", "abre o app", "reinicia o dev" ou equivalente — inclusive quando o pedido vier
  no fim de uma implementação ("agora roda pra eu ver"). Específica deste projeto
  (Tauri v2 + Windows). Não faz smoke test: quem verifica na tela é o usuário.
---

# /dev — Subir o Notes para teste manual

## Princípio

O usuário está esperando na frente da tela. O único tempo aceitável aqui é o da compilação
do Rust (~1m30s a frio, segundos a quente). Todo o resto — diretório errado, porta ocupada,
processo órfão, um segundo dev por cima de um que já rodava — é tempo desperdiçado e é
exatamente o que esta skill existe para evitar.

Não peça permissão para encerrar e subir o dev de novo: o `CLAUDE.md` já autoriza.

---

## Passo 1 — O diretório

**O `package.json` está em `project/`, não na raiz.** Rodar `npm` na raiz falha na hora com
`ENOENT ... package.json`. Como o shell não mantém `cd` entre chamadas, o `Set-Location` vai
junto no mesmo comando:

```powershell
Set-Location C:\Users\cris\Work\Lab\Notes\project; npm run tauri dev
```

---

## Passo 2 — Limpar o caminho (mas só o que é seu)

Encerrar o `tauri dev` **não** mata os filhos: o `notes.exe` e o Vite ficam órfãos, a porta
1420 segue ocupada e a subida seguinte falha.

**Cuidado:** o app instalado costuma estar rodando e se chama `notes.exe` também. Matar todo
processo com esse nome derruba o app de verdade do usuário, com as notas de verdade abertas.
Filtre pelo caminho — só morre quem está em `target\debug`:

```powershell
Get-Process notes -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*\target\debug\notes.exe' } |
  Stop-Process -Force -Confirm:$false
$c = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force -Confirm:$false }
```

| Caminho do processo | O que é | O que fazer |
|---|---|---|
| `...\Work\Lab\Notes\project\src-tauri\target\debug\notes.exe` | a build de dev | matar antes de subir |
| `C:\Users\cris\AppData\Local\Notes\notes.exe` | o app instalado | **não tocar** |

---

## Passo 3 — Subir em background e esperar direito

O comando não termina — ele fica servindo. Rode em background e espere com um `until` sobre
o log, nunca com `sleep` repetido nem relendo o arquivo de minuto em minuto.

O sinal de que subiu é a linha `Running \`target\debug\notes.exe\``. O `until` também precisa
casar com erro de compilação, ou uma falha vira espera silenciosa até o timeout:

```bash
LOG="<caminho do .output do job>"
until grep -qE "Running .target|error\[|error:|panicked" "$LOG" 2>/dev/null; do sleep 3; done
tail -n 25 "$LOG"
```

(O Bash aqui é Git Bash: use barras normais no caminho.)

O `warning: linker stdout: Criando biblioteca ...` que aparece perto do fim é normal, não é
falha.

---

## Passo 4 — Dizer ao usuário como abrir

**A janela inicia oculta** — se você só disser "está rodando", ele vai olhar para uma tela
onde nada aconteceu. Informe sempre:

- Atalho da build de dev: **`Ctrl+Alt+Shift+F`** (o instalado fica com `Ctrl+Alt+F`).
- Ou duplo clique no ícone **`Notes (dev)`** na bandeja.
- O rodapé traz o selo `dev`, e as notas vão para `%APPDATA%\com.cris.notes-dev` — as notas
  reais não entram em jogo.

E pare por aí: **o smoke test é do usuário**. Você subiu o app; quem clica é ele. Fique com o
job vivo para ler o log quando ele relatar algo.

---

## Enquanto está no ar

- **Mudança no frontend** (`.ts`, `.html`, `.css`) recarrega sozinha pelo Vite — não precisa
  reiniciar nada.
- **Mudança no Rust** faz o `tauri dev` recompilar e reabrir o app sozinho. A janela some e
  volta oculta: avise o usuário para chamá-la de novo pelo atalho.
- **Erro em runtime** aparece no log do job. Antes de teorizar sobre o que houve, leia o
  arquivo `.output`.

---

## Armadilhas conhecidas

- **`npm` na raiz** — `ENOENT: package.json`. O projeto vive em `project/`.
- **Matar `notes.exe` sem filtrar o caminho** — derruba o app instalado do usuário.
- **Subir um segundo dev com um já rodando** — a porta 1420 está ocupada e o Vite falha.
  Confira antes; se já houver um vivo e a mudança foi só de frontend, não suba nada: o hot
  reload já cobriu.
- **Instalar (`/release`) com o dev aberto derruba o dev** — o NSIS encerra processos pelo nome
  da imagem, e o binário de dev também é `notes.exe`. Exit 1 sem mensagem; parece crash, não é.
