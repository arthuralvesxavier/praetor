# Guia de retomada

Atualizado em 12/10/2026, no commit `7aa9461`. Este guia permite continuar o trabalho em qualquer máquina, de onde ele
parou. Não contém senhas nem chaves.

Para retomar com o Claude Code, abra a pasta do projeto e peça: "Leia docs/RETOMADA.md e continue de onde parou."

## 1. Preparar uma máquina nova

1. Instale o Node.js (versão 20.9 ou mais nova; esta máquina usa a 24) e o Git.
2. Baixe o projeto e as dependências:
   ```
   git clone https://github.com/arthuralvesxavier/praetor.git
   cd praetor
   npm install
   ```
3. Crie o arquivo `.env` a partir do `.env.example`. As chaves **não** estão no repositório:
   - `DATAJUD_API_KEY`: chave pública do DataJud, publicada na wiki do CNJ (só a chave, sem o prefixo "APIKey ").
   - `POWERBI_TENANT_ID`, `POWERBI_CLIENT_ID`, `POWERBI_CLIENT_SECRET`, `POWERBI_WORKSPACE_ID`: dados do aplicativo
     no Entra ID (ver `docs/POWER_BI.md`). O segredo usado nos testes deve ser trocado por um novo antes de copiar.
   - Sem essas chaves o sistema funciona; só a coleta no DataJud e os painéis do Power BI ficam desligados.
4. Em um terminal, suba o banco local e deixe aberto: `npm run db:dev`.
5. Em outro terminal, crie o banco com a demonstração e suba o sistema:
   ```
   npm run db:setup
   npm run dev
   ```
6. Acesse http://localhost:3000. As contas e a senha da demonstração estão em `src/domain/demo.ts`.

O banco local fica em `.data/postgres`, fora do Git. Uma máquina nova começa com a carga de demonstração (dados
fictícios). Para levar o banco de uma máquina para outra, gere um backup (`npm run db:backup -- --label copia`),
copie a pasta criada em `.data/backups/` e restaure (`npm run db:restore -- <pasta> --yes`).

## 2. Onde o trabalho parou

Concluído e no repositório:

- v2.1 completa: carteira, contingências, entrada de processos com análise preliminar e e-mail simulados,
  distribuição, importação, preventivo, painel executivo em 3 blocos, ficha do processo em 6 abas.
- Itens P0 (faixa de decisão, cobertura, gráfico único, fase separada de instância, desinche) e P1 (pedidos,
  índices do Banco Central, exposição líquida, bloqueio do fechamento, memória de cálculo).
- Automação: coleta no DataJud, API de entrada de processos com chaves, Power BI (visões no schema `bi`, painéis
  embutidos).
- Relatório jurídico R1 (Relatório de Processo em PDF) e seus ajustes: marca de simulação na síntese, lacuna da
  vara, parecer de risco completo, contabilidade vê o R1 sem prazos e sem análise.

Detalhes do que está implementado, simulado ou pendente: `docs/STATUS.md` e `docs/RASTREABILIDADE.md`.

## 3. Próximos passos, na ordem

Regras de trabalho combinadas: um item por vez, cada um funcionando e testado antes do próximo; no máximo 2 agentes
em paralelo (a máquina fica pesada); ao fim de cada item, um resumo de 3 linhas com o que mudou e o que conferir na
tela; sem travessão nos textos do sistema; nenhuma dependência nova sem perguntar.

### 3.1 Terminar o ajuste do R1 (pendência da verificação)

Em `src/modules/legal-reports/process-report.ts`, `recordTopicsOf` reconhece lacunas do cadastro por palavra-chave.
Uma lacuna editada pelo advogado que cita o cadastro e menciona um dado que o R1 não lê (exemplo: "Data de
ajuizamento e data de admissão do reclamante não informadas no cadastro") é descartada, e a metodologia dá um motivo
falso para isso. Correção já iniciada: tratar como "o mesmo dado" só os textos exatos da simulação
(`SIMULATED_RECORD_GAP_TEXTS` em `src/domain/case-brief.ts`); qualquer outro texto vira uma lacuna própria do
relatório. Incluir um teste com a edição feita pelo editor real da análise (`saveCaseBriefSection`).

### 3.2 R2: Relatório de Provisão por Competência

Para a contabilidade e a auditoria independente, sobre o motor de PDF e a memória de cálculo
(`src/modules/provision-memo`).

- Só competência **fechada** pode ser emitida; competência em prévia aparece na tela como "Prévia, não emitível".
- Tudo é lido do fechamento (`portfolio_snapshots`, `portfolio_snapshot_items` e a justificativa do fechamento),
  nunca recalculado com os dados atuais.
- Por processo: base aplicável e o tipo, classificação de risco, percentual, provisão apurada e estimada em colunas
  separadas (nunca somadas num total sem rótulo), garantias abatidas, parecer e responsável pela classificação.
- Totais por empresa, por tribunal e por classificação.
- Movimentação contra a competência anterior: constituição, reversão, pagamento (só quando houver registro de
  pagamento, quitação ou acordo cumprido; se não der para saber, classificar como reversão e dizer isso) e
  atualização monetária (ou a frase "valores na data-base, sem atualização monetária").
- Fecha com a memória de cálculo e a lista de processos sem classificação.
- Origem de cada item: dado do fechamento = cadastro; totais e movimentos = inferência; parecer = análise;
  dado ausente = lacuna, mostrada como "[DADO NÃO LOCALIZADO]".
- Planilha XLSX com os mesmos números do PDF (abas Processos, Totais, Movimentação, Sem classificação).
- Aprovação: gestão jurídica ou contabilidade.
- Automação: ao fechar a competência, gerar o R2 sozinho (pendente de revisão) e avisar os aprovadores (e-mail
  simulado ou alerta). Botão "Gerar R2" em `/contingencias/provisao` e em `/relatorios-juridicos`.
- Testes em `tests/legal-reports/r2/`: item sem origem bloqueia a emissão; lacuna nunca vira zero; causa e apurado
  nunca somados; aprovado não muda (só nova versão); mudar dados depois do fechamento não muda o R2; prévia não é
  emitível; PDF e XLSX com números iguais; visibilidade por perfil (escritório externo sem acesso).
- Gerar um PDF de exemplo com duas competências fechadas e conferir página por página.

### 3.3 R3: Relatório Executivo da Carteira

Para a diretoria; aprovação pela gestão jurídica. Mesmas regras de origem, lacuna, rodapé com data-base e leitura do
fechamento quando a competência estiver fechada.

### 3.4 R4: Caderno por Responsável

Um caderno por advogado responsável, semanal, com envio por e-mail simulado. Aprovação pela gestão jurídica ou pelo
advogado responsável.

### 3.5 Depois dos relatórios

- Documentar cada relatório em `docs/STATUS.md`, `docs/SECURITY.md` e `docs/dev/MODULE_CONTRACTS.md`.
- Conferir se as rotinas novas (por exemplo `legal_reports_refresh`) existem no banco de cada organização.
- Rodar `npm run validate` e abrir as telas com mais de um perfil de demonstração.

## 4. Decisões que dependem do dono do produto

1. **Nuvem:** (a) usar este repositório privado no GitHub como origem do deploy; (b) escolher entre Azure e
   Render/Railway; (c) autorizar a biblioteca de armazenamento de arquivos da Azure (`@azure/storage-blob`).
2. **R1 reduzido:** criar uma versão do R1 para Diretoria e Contabilidade, que hoje não veem o R1 quando ele traz
   conteúdo da análise preliminar ou de prazos.
3. **Power BI:** trocar o segredo do aplicativo usado nos testes.
4. **Decisões tomadas sem confirmação, aguardando aprovação:**
   - A provisão estimada (base = valor da causa) continua **sem abater garantias**. É a principal decisão a confirmar.
   - Pedido sem valor nunca vale zero; com pedidos com e sem valor misturados, o risco derivado usa o percentual da
     organização e o processo fica marcado para revisão.
   - A provisão oficial usa a base aplicável vezes o percentual do processo, e o percentual vem dos pedidos; o painel
     de pedidos mostra também a soma pelos pedidos quando ela é diferente.
   - O risco derivado dos pedidos vale a partir da data de vigência das avaliações dos pedidos.
   - O fechamento mensal da demonstração, com processos sem classificação, foi feito com justificativa registrada.
   - Audiências de processos fora da carteira ativa não geram alerta nem lembrete.
   - A troca de índice de correção é recusada quando outra instância tem valor oficial na mesma data-base.

## 5. O que nunca vai para o repositório

- `.env` (chaves e segredos).
- `.data/` (banco local, backups, capturas de tela, anotações de trabalho, chave de API da demonstração).
- `storage/` (arquivos enviados ao sistema).
- Planilhas com dados reais de clientes. A importação de exemplo usa só
  `scripts/seed-data/files/Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx`.
