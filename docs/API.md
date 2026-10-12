# API de entrada de processos (`/api/v1`)

Sistemas externos (ERP jurídico, portal de escritório, automação de e-mail) enviam processos novos ao Praetor
por esta API. Cada processo recebido entra no **mesmo fluxo da entrada manual**: distribuição automática, análise
preliminar (simulação demonstrativa) e e-mail ao advogado (simulado). Pessoas só revisam e aprovam.

Contrato completo (OpenAPI 3.1, público, sem dados): `GET /api/v1/openapi.json`.

## Autenticação

- Crie a chave em **Administração, Integrações, API de entrada** (permissão `admin:organization`).
- A chave tem o formato `prt_` seguido de 43 caracteres e é mostrada **uma única vez**. O Praetor guarda só o
  SHA-256 dela e um prefixo para reconhecimento. Perdeu a chave? Revogue e crie outra.
- Envie em toda requisição: `Authorization: Bearer prt_...`.
- A **organização é sempre a da chave**. Qualquer campo de organização no corpo é ignorado.
- Permissões (escopos) da chave:

| Escopo | Libera |
|---|---|
| `intake:create` | `POST /api/v1/processos` |
| `process:read` | `GET /api/v1/processos/{numero}` |

- Chave ausente, inválida, revogada ou expirada: **401**. Chave sem o escopo: **403**.
- Limite: **60 requisições por minuto por chave** (em memória, por instância do servidor). Acima disso: **429**
  com `Retry-After` (segundos).
- As rotas `/api/v1/*` ficam fora do proxy de sessão (não usam cookie) e respondem sempre JSON com
  `Cache-Control: no-store`.

## `POST /api/v1/processos`

Corpo JSON (`Content-Type: application/json`):

| Campo | Obrigatório | Observação |
|---|---|---|
| `numero` | sim | Número CNJ, com ou sem pontuação (20 dígitos). Dígito verificador errado não bloqueia: o processo fica marcado para verificação. |
| `partes` | sim | Lista de `{ nome, polo, documento? }`; `polo` = `ativo`, `passivo`, `terceiro` ou `ministerio_publico`; `documento` = CPF (11) ou CNPJ (14 dígitos). Pelo menos uma parte no polo ativo. |
| `origem` | sim | `{ sistema, referencia? }`: quem enviou e o identificador no sistema de origem. |
| `tribunal`, `orgaoJulgador`, `cidade`, `uf`, `classe` (até 40 caracteres) | não | Sem `tribunal`, usa o DataJud ou o próprio número (ex.: `TRT10`). |
| `area` | não | Ids de `LEGAL_AREAS` (`labor`, `civil`...). Padrão: `labor` na Justiça do Trabalho, `other` nas demais. |
| `fase` | não | `knowledge` (conhecimento), `liquidation` (liquidação) ou `enforcement` (execução). Padrão: `knowledge`. Os valores antigos `pre_filing`, `appeal`, `settlement` e `closed` são recusados com **400** (desde a P0.5): recurso é a instância (`instancia`) e encerramento é a situação do processo, nunca a fase. |
| `instancia` | não | `first` (1º grau), `second` (2º grau) ou `superior` (3º grau). Padrão: `first`. |
| `ajuizadoEm` | não | `AAAA-MM-DD`. |
| `valorDaCausa` | não | Texto decimal com ponto: `"12345.67"`. É o valor da causa declarado; nunca é somado ao valor apurado. Entra no cadastro, mas não vira valor oficial no histórico de valores (valor oficial exige uma pessoa identificada). |
| `empresaCnpj` ou `empresaNome` | não | Empresa do grupo que é ré. Também é reconhecida pelo CNPJ ou pelo nome exato de uma parte do polo passivo. |
| `documentos` | não | Até **20** arquivos `{ titulo, categoria?, nomeArquivo, conteudoBase64 }`. Só **PDF, DOCX e TXT**, conferidos pelo conteúdo (assinatura do arquivo), e a extensão precisa bater com o conteúdo. Cada arquivo até `MAX_UPLOAD_MB` (padrão 20 MB); a soma até 5 vezes esse limite. `categoria` usa os ids de `DOCUMENT_CATEGORIES` (padrão `other`). |
| `observacao` | não | Texto livre (até 2.000 caracteres), vira a descrição do processo. |

Cabeçalho opcional, recomendado: `Idempotency-Key` (1 a 200 caracteres visíveis).

### O que acontece

1. Validação. Erros voltam em **400** com `fieldErrors` no caminho completo do campo (ex.: `partes.0.polo`).
2. **Número já cadastrado na organização (RN-01)**: o processo **não** é duplicado. Os documentos são anexados ao
   processo existente, uma nota é registrada na última entrada dele e nenhum dado do cadastro é alterado.
   Resposta **200** com `status: "updated_existing"`.
3. **Número novo**: se a coleta do DataJud estiver ativa e o enriquecimento ligado, o Praetor consulta o DataJud
   (até 20 s) e completa **só os campos que vieram vazios** (tribunal, vara, cidade/UF, classe, ajuizamento); depois
   registra a entrada com origem "Recebido por API" e o fluxo segue sozinho. As movimentações oficiais encontradas
   entram na linha do tempo do processo. Resposta **201** com `status: "accepted"`.
4. Tudo é auditado com o nome da chave (sem o conteúdo enviado). O corpo da requisição **nunca** é guardado: o
   registro de requisições tem só o resultado, os ids gerados e o SHA-256 do corpo.

### Idempotência

- Mesma chave de API + mesma `Idempotency-Key` + mesmo corpo: devolve **a mesma resposta** (mesmo `processId` e
  `intakeId`), com o cabeçalho `Idempotent-Replayed: true` e `replayed: true` no corpo. Nada é criado de novo.
- Mesma `Idempotency-Key` com outro corpo: **422** `idempotency_conflict`.
- Requisição ainda em processamento com a mesma chave: **409** `request_in_progress` (`Retry-After: 5`).
- Requisição recusada (400, 403...) libera a `Idempotency-Key`; falha interna (500) pode ser repetida com a mesma.

### Exemplo

Dados fictícios: o número tem dígito verificador válido, mas a unidade de origem 9999 não existe, então ele nunca
corresponde a um processo real no DataJud. Use sempre números assim em testes.

```bash
curl -X POST "http://localhost:3000/api/v1/processos" \
  -H "Authorization: Bearer prt_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: erp-pedido-000123" \
  -d '{
    "numero": "0001234-18.2025.5.10.9999",
    "tribunal": "TRT10",
    "cidade": "Brasília",
    "uf": "DF",
    "classe": "ATSum",
    "valorDaCausa": "45000.00",
    "partes": [
      { "nome": "Pessoa Reclamante Fictícia", "polo": "ativo" },
      { "nome": "EMPRESA MODELO TESTE LTDA", "polo": "passivo" }
    ],
    "documentos": [
      { "titulo": "Petição inicial", "categoria": "initial_petition", "nomeArquivo": "inicial.pdf",
        "conteudoBase64": "JVBERi0xLjQK..." }
    ],
    "origem": { "sistema": "ERP Jurídico", "referencia": "PED-000123" }
  }'
```

Resposta 201:

```json
{
  "processId": "6f1c...",
  "intakeId": "a93e...",
  "status": "accepted",
  "number": "0001234-18.2025.5.10.9999",
  "documents": 1,
  "datajud": "dados completados pelo DataJud (somente campos vazios)",
  "links": {
    "process": "http://localhost:3000/processos/6f1c...",
    "intake": "http://localhost:3000/entrada/a93e...",
    "status": "http://localhost:3000/api/v1/processos/00012341820255109999"
  }
}
```

Erro de validação (400):

```json
{
  "error": {
    "code": "validation",
    "message": "Verifique os campos informados.",
    "fieldErrors": { "partes.0.polo": ["Use um polo válido: ativo, passivo, terceiro ou ministerio_publico."] }
  }
}
```

Para gerar o base64 de um arquivo: `base64 -w0 inicial.pdf` (Linux) ou
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("inicial.pdf"))` (PowerShell).

## `GET /api/v1/processos/{numero}`

Situação resumida de um processo **recebido pela API desta organização** (os demais respondem 404, para a chave
não servir de consulta à carteira inteira). Número com ou sem pontuação.

```bash
curl "http://localhost:3000/api/v1/processos/00012341820255109999" -H "Authorization: Bearer prt_SUA_CHAVE"
```

```json
{
  "number": "0001234-18.2025.5.10.9999",
  "processId": "6f1c...",
  "status": "active",
  "statusLabel": "Ativo",
  "phase": "knowledge",
  "phaseLabel": "Conhecimento",
  "instance": "first",
  "instanceLabel": "1º grau",
  "responsibleName": "Laura Advogada",
  "intake": { "id": "a93e...", "status": "notified", "statusLabel": "Advogado notificado (e-mail simulado)", "receivedAt": "2026-10-11T22:00:00.000Z" },
  "preliminaryAnalysis": { "status": "ready_for_review", "statusLabel": "Pronta para revisão", "simulated": true },
  "links": { "process": "...", "intake": "...", "status": "..." }
}
```

A análise preliminar é sempre uma **simulação demonstrativa** nesta versão (`simulated: true`).

## Códigos de resposta

| HTTP | `error.code` | Quando |
|---|---|---|
| 200 | | Número já existia: documentos anexados (`updated_existing`), ou consulta de situação |
| 201 | | Processo registrado (`accepted`) |
| 400 | `validation`, `invalid_json`, `invalid_idempotency_key` | Dados inválidos |
| 401 | `unauthorized` | Chave ausente, inválida, revogada ou expirada |
| 403 | `forbidden` | Chave sem o escopo |
| 404 | `not_found` | Processo não recebido por API nesta organização |
| 409 | `request_in_progress` | Mesma `Idempotency-Key` ainda em processamento |
| 413 | `payload_too_large` | Corpo acima do limite |
| 415 | `unsupported_media_type` | Corpo que não é JSON |
| 422 | `idempotency_conflict` | `Idempotency-Key` reutilizada com outro conteúdo |
| 429 | `rate_limited` | Limite por minuto da chave |
| 500 | `internal` | Falha interna (pode repetir com a mesma `Idempotency-Key`) |

## Demonstração (sistema externo fictício)

`scripts/demo-api-push.ts` faz o papel de um sistema externo: monta um caso **fictício** (número CNJ com dígito
válido e unidade de origem 9999, que não existe; partes fictícias; uma petição inicial em PDF com a marca
"DOCUMENTO FICTÍCIO") e envia para o servidor local.

```bash
PRAETOR_API_KEY=prt_SUA_CHAVE npx tsx scripts/demo-api-push.ts           # envia
npx tsx scripts/demo-api-push.ts --dry-run                               # só mostra o resumo
```

Com o worker rodando (`npm run dev`), em poucos segundos o processo aparece em **Entrada de processos** com o
responsável definido, a análise preliminar (simulação) e o e-mail simulado.

## Acompanhamento no DataJud (CNJ)

A mesma frente liga a consulta à **API pública do DataJud**, que é oficial e somente leitura:

- requer `DATAJUD_API_KEY` (chave **pública** publicada pelo CNJ em
  `https://datajud-wiki.cnj.jus.br/api-publica/acesso`, que o CNJ pode trocar a qualquer momento). Sem ela tudo
  mostra "Coleta inativa: configure DATAJUD_API_KEY" e nada quebra;
- a rotina `court_sync` (de hora em hora, por padrão) consulta em lote por tribunal os processos da carteira ativa
  cujo intervalo entre consultas já passou (24 h por padrão), respeitando o limite por minuto de cada tribunal;
  depois de uma falha, o processo espera 1 h, 2 h, 4 h... antes de nova tentativa; números com dígito verificador
  inválido não são consultados (aparecem como "sem consulta"); o botão "Sincronizar agora" fica na ficha do
  processo; a consulta avulsa fica em `/consulta-datajud`; a saúde da coleta em **Administração, Integrações,
  DataJud**;
- o DataJud **não** informa partes, valores, documentos nem a data das audiências. Movimentações novas entram como
  importadas; campos só são preenchidos quando vazios; mudanças de fase só quando inequívocas e para frente;
  trânsito em julgado, baixa, arquivamento e extinção viram alerta e verificação, **nunca** encerramento automático
  (inclusive quando são a movimentação mais recente de um processo antigo);
- quando o cadastro diverge do tribunal (tribunal, órgão julgador, classe, cidade/UF, data de ajuizamento), o
  cadastro é mantido e a divergência vai para a nota de verificação **uma vez**: depois que alguém conclui a
  verificação, a mesma divergência não marca o processo de novo; só um valor novo informado pelo tribunal marca.
