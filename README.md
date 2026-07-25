# Warp Clone

Um terminal no estilo do [Warp](https://warp.dev), feito com **Tauri 2 + Rust** no backend e
**React + TypeScript + xterm.js** no frontend. Shells reais via PTY nativo (ConPTY no Windows,
`openpty` no Linux/macOS).

## O que dá para fazer

- **Abrir um projeto** — escolhe uma pasta, o app abre uma aba já com o shell naquele diretório
  e mostra o nome do projeto e a branch do git na barra de título. Projetos recentes ficam
  guardados.
- **Vários terminais na mesma página** — divide qualquer painel para a direita, esquerda, cima ou
  baixo, quantas vezes quiser. Cada painel é um shell independente.
- **Arrastar e organizar como quiser** — pega na barrinha de cima de um painel e arrasta:
  - solta perto de uma **borda** de outro painel → o terminal passa a ocupar aquele lado;
  - solta no **centro** de outro painel → os dois trocam de lugar;
  - solta numa **aba** → o terminal muda de aba;
  - solta no **`+`** da barra de abas → o terminal vira uma aba nova.
- **Redimensionar** — arrasta as divisórias entre painéis; duplo-clique iguala os dois vizinhos.
- **Abas** — criar, fechar, renomear (duplo-clique) e reordenar arrastando.
- **Zoom de painel** — um painel ocupa a aba inteira sem perder os outros.
- **Paleta de comandos** (`Ctrl+Shift+P`) — todas as ações, os shells disponíveis, os projetos
  recentes e navegação direta para qualquer aba ou painel.
- **Busca no scrollback** (`Ctrl+Shift+F`) com destaque dos resultados.
- **Escolha de shell** — o app detecta o que existe na máquina (PowerShell 7, Windows PowerShell,
  cmd, Git Bash, WSL, Nushell; zsh/bash/fish no Unix) e deixa escolher por aba.
- **O layout é lembrado** entre execuções — a arrumação dos painéis volta igual (com shells novos,
  processos nunca são "restaurados").

## Atalhos

| Atalho | Ação |
| --- | --- |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | dividir à direita / abaixo |
| `Ctrl+Shift+W` | fechar painel |
| `Ctrl+Shift+Z` | zoom do painel |
| `Ctrl+Shift+B` | igualar todos os painéis |
| `F11` | fullscreen |
| `Alt+←↑↓→` | mover o foco entre painéis |
| `Ctrl+Shift+[` / `]` | painel anterior / seguinte |
| `Ctrl+Shift+T` / `Ctrl+Shift+Q` | nova aba / fechar aba |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | ciclar abas |
| `Ctrl+1` … `Ctrl+9` | ir para a aba N |
| `Ctrl+Shift+O` | abrir projeto |
| `Ctrl+Shift+P` | paleta de comandos |
| `Ctrl+Shift+F` | buscar no terminal |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | copiar / colar |
| `Ctrl+Shift+K` | limpar o painel |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | tamanho da fonte |

Clique direito no terminal copia a seleção; sem seleção, cola.

## Rodar

```bash
bun install
bun run app          # tauri dev
bun run app:build    # instalador (NSIS no Windows)
```

Checagens:

```bash
bun run typecheck
cd src-tauri && cargo check
```

O ícone é gerado por código (sem dependências de imagem): `bun run gen:icon`.

## Como está montado

```
src-tauri/src/
  main.rs      comandos IPC (pty_spawn/write/resize/kill, list_shells, project_info)
  pty.rs       uma sessão PTY por painel; saída vai para o webview em base64
  shells.rs    descoberta dos shells instalados
  project.rs   nome do projeto + branch lida direto de .git/HEAD
src/
  lib/layout.ts     árvore de splits (inserir ao lado, remover colapsando, trocar, redimensionar)
  lib/terminals.ts  registro global de instâncias xterm que sobrevive a re-renders do React
  hooks/useDragPane.ts  drag-and-drop com zonas de drop calculadas por geometria
  components/       TitleBar, TabStrip, PaneTree, TerminalPane, SearchBar, CommandPalette, StatusBar
```

Três detalhes que fazem a coisa funcionar:

1. **Os terminais vivem fora do React.** `lib/terminals.ts` guarda cada instância xterm num
   registro global e move o elemento DOM entre painéis. Quando o layout muda, o React remonta os
   painéis mas o scrollback, a seleção e o processo continuam intactos — sem isso, arrastar um
   painel apagaria o terminal.
2. **A saída do PTY viaja como base64.** Um chunk de bytes pode cortar um caractere UTF-8 no meio;
   mandar bytes e deixar o xterm decodificar evita texto corrompido em saídas grandes.
3. **O tamanho dos painéis nunca depende do conteúdo deles.** Cada célula recebe um
   `flex-basis` explícito com `flex-grow`/`flex-shrink` zerados, e a grid raiz usa
   `minmax(0, 1fr)` nos dois eixos. Sem isso, o `min-content` dos terminais empurra o app
   para além da janela: com 3+ painéis o layout estoura e os botões da janela saem da tela.

## O que não tem

Os "blocks" do Warp (agrupar cada comando e a sua saída num cartão, com histórico navegável)
dependem de integração com o shell via sequências OSC 133 e de um hook no prompt de cada shell —
isso não está implementado. O resto da experiência de painéis, abas e projeto está.
