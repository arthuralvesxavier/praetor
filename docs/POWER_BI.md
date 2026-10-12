# Painéis Power BI no Praetor

Guia passo a passo para quem administra o Praetor, escrito para quem não é da área técnica. Onde houver
um comando, ele deve ser executado pela pessoa ou empresa que mantém o servidor do Praetor.

> **Situação nesta versão.** A integração está implementada e coberta por testes automáticos, mas os
> testes usam um Power BI **simulado**: ainda não foi feita uma conexão com um Power BI real, porque as
> credenciais da empresa não estão disponíveis. As fórmulas DAX deste guia também não foram executadas num
> Power BI real. O primeiro uso real deve ser acompanhado por quem mantém o sistema.

## 1. Como funciona, em uma página

1. O Praetor mantém no banco de dados uma **camada de leitura governada**: o schema `bi`, só com visões
   (views) prontas para relatório. Ela não tem nomes de partes, CPF/CNPJ de pessoas nem texto de documentos,
   e segue as regras da carteira:
   - valor da causa e valor apurado ficam em colunas separadas e **nunca se somam**;
   - vazio (nulo) significa **não apurado**, nunca zero;
   - exposição e provisão **apuradas** ficam separadas das **estimadas**;
   - competências mensais aparecem **somente depois de fechadas**, exatamente como foram gravadas, inclusive
     com os processos excluídos depois do fechamento.
2. O Power BI Desktop lê essas visões com um **usuário de banco somente leitura** (`praetor_bi`). Ele não lê
   as tabelas do sistema, e as visões devolvem a ele só as linhas da **organização registrada para ele**
   (cada usuário de leitura serve a uma única organização). As visões são **barreiras de segurança**: nem uma
   consulta ou função escrita pelo próprio usuário de leitura consegue alcançar linhas de outra organização.
   Os limites desse isolamento em banco compartilhado estão na seção 5.
3. O relatório é publicado em um **workspace** do Power BI. O Praetor o exibe na tela **Painéis Power BI**,
   usando um aplicativo registrado no Microsoft Entra ID (o "service principal"). As pessoas não precisam
   de licença nem de conta no Power BI para ver os painéis dentro do Praetor (veja a seção 2).
4. **Cada pessoa vê só o que já vê no Praetor.** O Praetor calcula, com as mesmas regras de acesso das
   telas, a lista de processos de cada usuário (visão `bi.acesso`). Ao abrir um painel, o Praetor pede ao
   Power BI um token de curta duração (20 minutos, renovado automaticamente), **somente para leitura**, em
   nome daquele usuário, e o papel de segurança do relatório filtra os dados por ele. Diretoria,
   contabilidade, auditoria, advogados e escritórios externos veem no painel a carteira que veem no sistema.
   Como o Power BI guarda uma cópia dos dados, uma mudança de acesso só chega ao painel depois da próxima
   atualização dessa cópia (seção 4).
5. **Atualização automática.** A cada hora a rotina "Acessos e atualização dos painéis Power BI" recalcula
   os acessos e, quando houve importação de planilha confirmada ou desfeita, competência fechada, coleta
   nos tribunais com novidades ou **mudança nos acessos** (ou uma vez por dia, mesmo sem novidades), pede ao
   Power BI a atualização do conjunto de dados. Falhas ficam registradas em
   **Administração > Integrações > Power BI**.

O segredo do aplicativo fica **somente** nas variáveis de ambiente do servidor. Ele nunca é digitado em
tela, gravado no banco, exibido ou registrado em log.

## 2. Pro ou Premium/Fabric: o que muda

A forma de incorporação usada pelo Praetor é a que a Microsoft chama de "inserir para seus clientes"
(o aplicativo é dono dos dados). Ela depende do tipo de licença:

| Situação da empresa | O que funciona | Observações |
|---|---|---|
| Só licenças **Power BI Pro** | Montar o relatório, publicar, testar a incorporação no Praetor | A Microsoft limita a quantidade de tokens de incorporação gerados sem capacidade dedicada: serve para **desenvolvimento e testes**, não para uso diário de toda a equipe. Atualização do conjunto de dados: até **8 por dia**. |
| **Premium por usuário (PPU)** | Mesmo caso do Pro para a incorporação | PPU não é capacidade para "inserir para seus clientes" em produção. |
| Capacidade **Power BI Embedded (A)**, **Premium (P)** ou **Fabric (F)** | Uso em produção, para todos os usuários do Praetor | O workspace precisa estar atribuído à capacidade. O limite de atualizações por dia é bem maior. |

Os limites e nomes comerciais mudam com frequência: confirme a situação atual na documentação da Microsoft
("Power BI Embedded", "capacidade", "tokens de inserção") antes de contratar.

O Praetor vem configurado para **no máximo 8 atualizações por dia** e **no mínimo 60 minutos entre duas
atualizações automáticas**, o que respeita o limite do Pro. Com capacidade dedicada, quem mantém o sistema
pode aumentar esses valores na configuração da rotina (`maxRefreshesPerDay` e `minIntervalMinutes`), o que
também encurta o tempo para uma mudança de acesso chegar ao painel.

**Importar ou DirectQuery?** Recomendamos o modo **Importar**: o Power BI guarda uma cópia e o Praetor pede
a atualização quando há novidades. No modo DirectQuery o Power BI consulta o banco a cada clique (sem
precisar de atualização, e as mudanças de acesso valem assim que a rotina horária recalcula a lista), mas
fica mais lento e depende do gateway estar sempre disponível.

## 3. Passo a passo

### Passo 1: registrar o aplicativo no Microsoft Entra ID

1. Entre em <https://portal.azure.com> com uma conta de administrador do Microsoft 365 da empresa.
2. Abra **Microsoft Entra ID > Registros de aplicativo > Novo registro**.
3. Nome: por exemplo `Praetor Power BI`. Tipo de conta: **somente este diretório**. Não informe URL de
   redirecionamento. Clique em **Registrar**.
4. Na página do aplicativo, copie:
   - **ID do aplicativo (cliente)**: será o `POWERBI_CLIENT_ID`;
   - **ID do diretório (locatário)**: será o `POWERBI_TENANT_ID`.
5. Abra **Certificados e segredos > Novo segredo do cliente**, escolha a validade (por exemplo 12 meses) e
   copie o **Valor** na hora (ele só aparece uma vez): será o `POWERBI_CLIENT_SECRET`. Anote a data de
   validade e combine a troca antes de vencer; com o segredo vencido, os painéis param de abrir.
6. Não é preciso conceder permissões de API do Power BI ao aplicativo.
7. Em **Microsoft Entra ID > Grupos**, crie um grupo de segurança (por exemplo `Praetor Power BI`) e
   adicione o aplicativo como membro. Esse grupo é usado no passo 2.

### Passo 2: liberar o aplicativo no Power BI

1. Entre em <https://app.powerbi.com> com uma conta de administrador do Power BI.
2. Abra **Configurações (engrenagem) > Portal de administração > Configurações do locatário**.
3. Em **Configurações do desenvolvedor**:
   - habilite **"Entidades de serviço podem usar APIs do Fabric"** (o nome antigo é "Permitir que entidades
     de serviço usem as APIs do Power BI") e restrinja ao grupo criado no passo 1;
   - confirme que **"Inserir conteúdo em aplicativos"** está habilitado.
4. As mudanças podem levar até 15 minutos para valer.

### Passo 3: criar o workspace

1. No Power BI, crie um workspace (por exemplo `Praetor`).
2. Em **Gerenciar acesso**, adicione o aplicativo `Praetor Power BI` como **Membro** ou **Administrador**.
3. Se houver capacidade Embedded, Premium ou Fabric, atribua o workspace a ela (configurações do workspace,
   seção Licença).
4. Dê acesso ao workspace somente a quem monta os relatórios. As demais pessoas veem os painéis pelo Praetor.
   Atenção: quem é Administrador, Membro ou Colaborador do workspace **não** passa pelo filtro de segurança
   ao abrir o relatório direto no Power BI.

### Passo 4: informar as credenciais ao Praetor

Quem mantém o servidor acrescenta ao arquivo `.env` (ou às variáveis do serviço de hospedagem):

```
POWERBI_TENANT_ID=<id do diretório>
POWERBI_CLIENT_ID=<id do aplicativo>
POWERBI_CLIENT_SECRET=<valor do segredo>
```

e reinicia o Praetor (site e processamento em segundo plano). Em **Administração > Integrações > Power BI**,
o cartão "Credenciais no servidor" passa a mostrar "Configuradas". `POWERBI_API_URL` e
`POWERBI_AUTHORITY_URL` só mudam em nuvens governamentais da Microsoft.

### Passo 5: criar o usuário de banco somente leitura

Com as migrações aplicadas (`npm run db:migrate`), quem mantém o servidor executa:

```
BI_DB_PASSWORD='uma-senha-forte-com-12-ou-mais-caracteres' npx tsx scripts/bi-setup.ts
```

**Cada usuário de leitura serve a uma única organização.** Se o banco tiver mais de uma organização, o script
pede para escolher qual o usuário vai ler (ele lista as organizações), e cada organização precisa de um usuário
próprio, com nome `praetor_bi_<nome curto>` (letras minúsculas sem acento, números e `_`):

```
BI_DB_PASSWORD='senha-da-organizacao-a' npx tsx scripts/bi-setup.ts --org=<id da organização A>
BI_DB_PASSWORD='senha-da-organizacao-b' npx tsx scripts/bi-setup.ts --org=<id da organização B> --role=praetor_bi_b
```

O id da organização aparece em **Administração > Integrações > Power BI** ("Id desta organização"), junto com
o nome do usuário de leitura já registrado para ela.

O script **recusa** trocar a organização de um usuário que já existe. Motivo: o conjunto de dados do Power BI
que já usa esse usuário passaria a importar a carteira da outra organização na próxima atualização, e quem é
Administrador, Membro ou Colaborador do workspace (que não passa pelo filtro de segurança do relatório) veria
essa carteira. Para trocar de propósito (por exemplo, o usuário foi registrado na organização errada e nenhum
relatório o usa ainda), acrescente `--reassign`.

O script, que pode ser executado de novo sem problema:

- cria (ou atualiza a senha de) o usuário de leitura, com permissão **apenas** de leitura das visões do
  schema `bi`, e registra a organização que ele lê. As visões devolvem a esse usuário só as linhas dessa
  organização; sem organização registrada, não devolvem nada;
- confere se o usuário conseguiria criar tabelas ou schemas, ou ler as tabelas do sistema. A criação de
  objetos acontece no PostgreSQL **anterior à versão 15**, em que todos os usuários herdam a permissão de criar
  objetos no schema `public`. Nesses casos o script desfaz tudo e mostra o comando que o administrador do banco
  precisa executar antes (por exemplo `REVOKE CREATE ON SCHEMA public FROM PUBLIC`, mantendo a permissão do
  usuário do Praetor);
- avisa (sem impedir) que o usuário pode criar objetos temporários da própria sessão, o que o PostgreSQL
  permite a todos por padrão (seção 5);
- copia os nomes em português dos códigos (fase, instância, situação) para a visão `bi.rotulos`;
- calcula a lista de acessos (`bi.acesso`) de todas as organizações.

**Rode o script de novo depois de cada atualização do Praetor**, uma vez para cada usuário de leitura (com o
mesmo `--org` e `--role` de antes): quando uma migração recria as visões, é o script que devolve ao usuário a
permissão de lê-las.

Em banco gerenciado (por exemplo Azure Database, Amazon RDS ou Cloud SQL), a criação de usuário pode exigir o
administrador do banco. Ele pode ver os comandos com `npx tsx scripts/bi-setup.ts --print` (com os mesmos
`--org` e `--role`, inclusive as consultas de conferência do item acima) e executá-los com a senha escolhida.

### Passo 6: gateway (quando o banco não está na internet)

O serviço do Power BI fica na nuvem da Microsoft. Se o banco do Praetor está na rede da empresa, o Power BI
só consegue atualizar os dados por um **gateway de dados local**:

1. Em um servidor da empresa que alcance o banco do Praetor, instale o **gateway de dados local** (modo
   padrão) e entre com uma conta da empresa. Deixe o computador sempre ligado.
2. No Power BI, abra **Configurações > Gerenciar conexões e gateways > Nova conexão**: tipo
   **PostgreSQL**, servidor `endereço:porta` do banco, nome do banco e o usuário de leitura da organização
   (`praetor_bi`, ou o `praetor_bi_<nome curto>` criado para ela) com a senha do passo 5.
3. Depois de publicar o relatório (passo 10), associe o modelo semântico a essa conexão em **Configurações do
   modelo semântico > Conexão de gateway**.

Versões recentes do Power BI Desktop e do gateway já trazem o driver do PostgreSQL. Se for pedido um driver,
siga a orientação da própria Microsoft (Npgsql).

### Passo 7: montar o relatório no Power BI Desktop

1. **Obter dados > Banco de dados PostgreSQL**. Servidor: `endereço:porta`. Banco: o nome do banco do
   Praetor. Modo: **Importar**.
2. Credenciais: aba **Banco de dados**, o usuário de leitura da organização (passo 5) e a senha dele.
3. Selecione as visões do schema `bi`:

| Visão | Conteúdo |
|---|---|
| `bi.processos` | Um registro por processo (posição atual): empresa, unidade, tribunal, instância, fase, cidade, UF, classe, situação, responsável, escritório, sigilo, valores e cálculos. Traz também os processos **excluídos** que constam de competência fechada (`excluido` = verdadeiro), só para essas competências não perderem linhas. A coluna `em_carteira_ativa` marca a carteira que o Praetor usa nos totais (situação ativa ou suspensa, processo não excluído). |
| `bi.competencias` | Posição de cada processo em cada competência mensal **fechada**, lida como foi gravada no fechamento. |
| `bi.valoracoes` | Histórico de valores (causa, apurado, acordo, depósito...) dos processos não excluídos, com situação, origem, se é simulação e quem conferiu. |
| `bi.pendencias` | Quantidade por processo não excluído de alertas abertos (por tipo), prazos sugeridos aguardando validação e valores aguardando conferência. |
| `bi.acesso` | Quais processos cada usuário do Praetor pode ver (`user_key`, `process_id`). Base da segurança. |
| `bi.rotulos` | Nome em português de cada código. As visões já trazem colunas `*_rotulo` prontas. |
| `bi.atualizacao` | Quando a lista de acessos foi recalculada e quando mudou pela última vez. |

4. Não é preciso filtrar a organização: o usuário de leitura só recebe as linhas da organização registrada
   para ele no passo 5. Use sempre o usuário da própria organização: o relatório de uma organização nunca deve
   usar o usuário de outra.
5. No Power Query, **não substitua vazios por zero** nas colunas de valor. Vazio é "não apurado".

### Passo 8: relacionamentos e segurança por linha (RLS)

Relacionamentos (Exibição de modelo):

| De | Para | Cardinalidade | Direção do filtro |
|---|---|---|---|
| `acesso[process_id]` | `processos[process_id]` | muitos para um | **Ambas**, com **"Aplicar filtro de segurança em ambas as direções"** marcado |
| `processos[process_id]` | `competencias[process_id]` | um para muitos | única |
| `processos[process_id]` | `valoracoes[process_id]` | um para muitos | única |
| `processos[process_id]` | `pendencias[process_id]` | um para muitos | única |

Papel de segurança:

1. **Modelagem > Gerenciar funções > Nova função**. Nome: `AcessoPraetor` (o mesmo nome cadastrado no
   Praetor).
2. Tabela `acesso`, filtro DAX:

```
[user_key] = USERNAME()
```

3. As visões `rotulos` e `atualizacao` não têm dados de processos e não precisam de filtro.
4. Teste com **Modelagem > Exibir como > Outro usuário**: informe a sua chave de usuário (mostrada em
   **Administração > Integrações > Power BI**, "Sua chave de usuário") e marque a função `AcessoPraetor`.

O Praetor sempre abre o painel com esse papel e com a chave do usuário. Um relatório **sem** esse papel não
é exibido (o Power BI recusa o token), o que evita mostrar a carteira inteira por engano.

**Quando os números batem com o Praetor (e quando não):**

- **Posição atual**: as medidas do passo 9 usam `em_carteira_ativa`, a mesma carteira dos totais do Praetor
  (processos ativos e suspensos que a pessoa vê). Somar todos os registros de `processos` daria um total
  maior, porque inclui processos encerrados e os excluídos que só estão lá por causa das competências
  fechadas.
- **Competências fechadas**: no painel, cada pessoa soma só os processos que vê. No Praetor, a
  **contabilidade** (que fecha as competências) vê o **total gravado da organização**, que inclui processos
  sigilosos de forma agregada. Para a contabilidade, o total da competência no painel pode ser menor que o do
  Praetor; a diferença são os processos sigilosos. Administração e gestão jurídica veem tudo nos dois lugares;
  os demais perfis veem nos dois lugares só os processos que podem ver.
- **Atualização**: o painel mostra os dados da última atualização do conjunto de dados (seção 4), não do
  momento.

### Passo 9: medidas recomendadas (DAX)

Use medidas, não colunas somadas soltas. Estas respeitam as regras da carteira e usam a mesma carteira dos
totais do Praetor:

```
Processos na carteira ativa =
    CALCULATE ( COUNTROWS ( processos ), processos[em_carteira_ativa] = TRUE () )

Processos com valor apurado =
    CALCULATE ( [Processos na carteira ativa], NOT ISBLANK ( processos[valor_apurado] ) )

Processos não apurados =
    CALCULATE ( [Processos na carteira ativa], ISBLANK ( processos[valor_apurado] ) )

Cobertura de apuração = DIVIDE ( [Processos com valor apurado], [Processos na carteira ativa] )

Valor da causa (declarado) =
    CALCULATE ( SUM ( processos[valor_da_causa] ), processos[em_carteira_ativa] = TRUE () )

Valor apurado =
    CALCULATE ( SUM ( processos[valor_apurado] ), processos[em_carteira_ativa] = TRUE () )

Exposição apurada =
    CALCULATE ( SUM ( processos[exposicao_apurada] ), processos[em_carteira_ativa] = TRUE () )

Exposição estimada =
    CALCULATE ( SUM ( processos[exposicao_estimada] ), processos[em_carteira_ativa] = TRUE () )

Provisão apurada =
    CALCULATE ( SUM ( processos[provisao_apurada] ), processos[em_carteira_ativa] = TRUE () )

Provisão estimada =
    CALCULATE ( SUM ( processos[provisao_estimada] ), processos[em_carteira_ativa] = TRUE () )

Processos cadastrados (todas as situações) =
    CALCULATE ( COUNTROWS ( processos ), processos[excluido] = FALSE () )

Alertas abertos =
    CALCULATE ( SUM ( pendencias[quantidade] ), pendencias[categoria] = "alerta" )

Valores aguardando conferência =
    CALCULATE ( SUM ( pendencias[quantidade] ), pendencias[categoria] = "valor" )

Exposição apurada da competência = SUM ( competencias[exposicao_apurada] )

Exposição estimada da competência = SUM ( competencias[exposicao_estimada] )
```

As medidas de competência **não** usam `em_carteira_ativa`: a carteira de cada competência é a que foi
gravada no fechamento.

Regras para quem monta os visuais:

- **Nunca** crie `[Valor da causa (declarado)] + [Valor apurado]`: são grandezas diferentes (exposição
  declarada e dívida apurada). Mostre lado a lado, com o nome de cada uma.
- **Vazio é vazio.** `SUM` de uma coluna toda vazia devolve BLANK, que é o correto. Não use `+ 0`,
  `COALESCE ( ..., 0 )` nem "mostrar zero para vazio" nas medidas de valor. Para falar da falta de apuração,
  use `Processos não apurados` e `Cobertura de apuração`.
- Exposição e provisão **estimadas** ficam em medidas próprias, com "estimada" no título do visual. Se a
  diretoria pedir um total único, o título precisa dizer que inclui estimativas.
- Para totais da posição atual, use as medidas acima (ou filtre `em_carteira_ativa`). Contar ou somar a
  tabela `processos` inteira mistura encerrados e excluídos.
- Cada competência é uma fotografia: use um segmentador de competência com **seleção única** e não some
  competências diferentes.
- Em `bi.valoracoes`, valores de tipos diferentes nunca se somam, e só a situação "Oficial" vale como
  posição. Linhas com `simulacao = verdadeiro` são extrações simuladas (demonstração) e devem aparecer
  identificadas como tal.

### Passo 10: publicar e cadastrar no Praetor

1. **Publicar** o relatório no workspace do passo 3.
2. No Power BI, abra o modelo semântico publicado e informe a credencial da fonte de dados (o usuário de
   leitura desta organização, do passo 5), pelo gateway do passo 6 se o banco estiver na rede da empresa.
3. No Praetor, em **Administração > Integrações > Power BI**:
   - informe o **id do workspace** e salve;
   - clique em **Testar conexão**: o Praetor lista os relatórios do workspace com o id do relatório e o id do
     conjunto de dados;
   - cadastre cada painel (nome que aparecerá no Praetor, id do relatório, id do conjunto de dados);
   - confirme o nome do **papel de segurança** (`AcessoPraetor`) e se a **atualização automática** fica
     ligada; salve.
4. Abra **Painéis Power BI** (menu Contingências) com perfis diferentes e confira que cada um vê a sua
   carteira.

Os ids também aparecem no endereço do Power BI: `app.powerbi.com/groups/<id do workspace>/reports/<id do
relatório>` e, nas configurações do modelo semântico, `.../datasets/<id do conjunto de dados>`.

## 4. Atualização automática

- A rotina roda a cada 60 minutos (ajustável em **Administração > Configurações > Rotinas**).
- Em cada execução ela atualiza a lista de acessos, confere no Power BI como terminaram as atualizações já
  pedidas e, se houver motivo, coloca na fila uma nova atualização:
  - importação de planilha confirmada ou desfeita;
  - competência mensal fechada;
  - coleta nos tribunais que trouxe movimentações ou mudança de fase;
  - **mudança nos acessos**: alguém ganhou ou perdeu um processo (processo marcado como sigiloso,
    redistribuído ou trocado de unidade, usuário que mudou de unidade ou de papel, usuário desativado);
  - agenda periódica (uma vez a cada 24 horas, mesmo sem novidades).
- Respeita o intervalo mínimo (60 minutos) e o limite diário (8 por conjunto de dados). Um motivo adiado por
  esses limites fica pendente e é atendido na primeira execução permitida; ele não se perde.
- O botão **Atualizar agora** faz o mesmo na hora, sem esperar a rotina e sem o intervalo mínimo (o Power BI
  ainda aplica o próprio limite diário). Uma atualização pedida pelo botão já cobre as novidades até aquele
  momento, e a rotina não pede outra pelo mesmo motivo.
- O **Histórico de atualizações** mostra cada solicitação: solicitada, concluída, falhou (com o motivo em
  português) ou não executada (configuração incompleta). Sem credenciais, nada quebra: os acessos continuam
  sendo recalculados e nenhuma chamada ao Power BI é feita.

**Quanto tempo uma mudança de acesso leva para chegar ao painel (modo Importar).** O Power BI usa a lista de
acessos da última atualização do conjunto de dados. Até ela terminar, quem perdeu o acesso a um processo
ainda o vê no painel (no Praetor, o efeito é imediato). Na prática:

- normalmente, até a próxima execução da rotina (no máximo 1 hora) mais o tempo da atualização no Power BI
  (alguns minutos);
- se houve outra atualização há menos de 60 minutos, mais o tempo que falta para completar esse intervalo;
- se o limite diário já foi usado (8 no Pro), a atualização espera a janela de 24 horas liberar: **no pior
  caso, cerca de 24 horas**.

Para retirar um acesso na hora: use **Atualizar agora** depois da mudança. Para cortar de imediato todo o
acesso de uma pessoa, desative o usuário no Praetor: usuários desativados não entram no Praetor e,
portanto, não abrem os painéis. No modo DirectQuery a espera é só a da rotina (no máximo 1 hora).

## 5. Segurança e auditoria

- Somente quem tem a permissão **Consultar e exportar relatórios** vê o menu e abre os painéis. Escritórios
  externos não têm essa permissão nesta versão.
- O navegador recebe apenas o token de incorporação do relatório escolhido, válido por 20 minutos e preso à
  identidade do usuário. O token é **somente para leitura**: não permite editar o relatório, salvar cópias,
  criar relatórios no workspace nem consultar o modelo por XMLA. O segredo e o token do Entra ID nunca saem
  do servidor.
- A abertura de painel é registrada na auditoria ("Painel Power BI exibido"), no máximo uma vez por usuário e
  painel a cada hora. Alterações de configuração, testes de conexão e pedidos de atualização também são
  registrados. Nenhum dado da carteira vai para a auditoria.
- O usuário de leitura (`praetor_bi`) lê somente o schema `bi` e, nele, somente as linhas da organização
  registrada para ele. Ele não lê as tabelas do sistema, não altera dados do Praetor e não consegue criar
  tabelas nem schemas: o bi-setup confere essas três coisas e desfaz tudo se alguma falhar.
- O que ele **ainda pode** fazer: criar objetos temporários que só existem na própria conexão (permissão
  TEMPORARY, que o PostgreSQL dá a todos os usuários por padrão). Isso **não** dá acesso a linhas de outra
  organização, porque as visões do schema `bi` são barreiras de segurança (`security_barrier`): uma condição
  ou função escrita por ele só é avaliada depois do filtro de organização da visão (há teste automático que
  tenta exatamente isso). Como proteção adicional, o administrador do banco pode executar
  `REVOKE TEMPORARY ON DATABASE <banco> FROM PUBLIC` (o Praetor não usa tabelas temporárias); o bi-setup
  mostra esse aviso enquanto a permissão existir.
- Banco com várias organizações: cada usuário de leitura serve a uma única organização (passo 5), e o
  isolamento vale para as **linhas**. Informações gerais que o PostgreSQL mostra a qualquer usuário conectado
  continuam visíveis, como nomes de tabelas e a quantidade aproximada de linhas do banco inteiro (estatísticas
  do próprio PostgreSQL). Para isolamento completo, use um banco para cada organização.

## 6. Problemas comuns

| Mensagem no Praetor | Causa provável | O que fazer |
|---|---|---|
| "credenciais do aplicativo recusadas" (código AADSTS...) | Id ou segredo errado, ou segredo vencido | Conferir o passo 1 e as variáveis do passo 4; gerar novo segredo. |
| "O Power BI negou o acesso" | Entidades de serviço não liberadas, ou aplicativo fora do workspace | Passos 2 e 3. |
| "Workspace, relatório ou conjunto de dados não encontrado" | Id digitado errado | Usar **Testar conexão** e copiar os ids. |
| "O Power BI recusou a solicitação" ao abrir o painel | Papel de segurança com outro nome, ou relatório sem papel | Conferir o nome no Power BI Desktop e no Praetor; publicar de novo. |
| "O Power BI não conseguiu abrir o painel (código ...)" | Erro do próprio Power BI ao carregar o relatório | Ler a mensagem do Power BI no quadro abaixo do aviso; conferir publicação e credenciais do modelo semântico. |
| "conjunto de dados cadastrado não é o usado pelo relatório" | Id do conjunto de dados trocado | Corrigir o cadastro do painel. |
| "excesso de solicitações" | Limite diário do Pro atingido ou limite de tokens sem capacidade | Aguardar; avaliar capacidade dedicada (seção 2). |
| "atualização não foi concluída" no histórico | Gateway desligado ou credencial da fonte errada no Power BI | Passo 6 e credenciais do modelo semântico. |
| Painel ou Power BI Desktop sem nenhuma linha | Usuário de leitura sem organização registrada, ou visões recriadas por uma atualização do Praetor | Rodar o bi-setup de novo (passo 5), com o mesmo `--org` e `--role`. |
| bi-setup: "O usuário ... já lê a organização ..." | O usuário de leitura escolhido já serve a outra organização | Criar um usuário para esta organização com `--role=praetor_bi_<nome curto>` (passo 5). Use `--reassign` só se nenhum relatório usa o usuário. |
| Painel abre vazio para uma pessoa | Papel de segurança testado com chave errada, ou relacionamento de `acesso` sem filtro em ambas as direções | Passo 8. |

## 7. Desfazer

Antes de desfazer qualquer migração do Power BI, **remova os usuários de leitura** (veja o comando no fim desta
seção). Enquanto um usuário de leitura existir, desfazer só parte das migrações pode deixá-lo enxergar dados de
outra organização: sem a barreira de segurança (0011) ou com as visões antigas, sem filtro por organização (0006),
e o bi-setup concede leitura automática a visões recriadas no schema `bi`.

Com os usuários de leitura removidos, desfaça na ordem inversa:

1. `drizzle/down/0011_bi_views_security_barrier.sql` retira a opção de barreira de segurança das visões;
2. `drizzle/down/0006_bi_reporting_views_v2.sql` volta as visões para a versão anterior;
3. `drizzle/down/0005_bi_access_scope.sql` remove o registro de organização dos usuários de leitura e a data da
   última mudança de acessos;
4. `drizzle/down/0004_bi_reporting_views.sql` remove o schema `bi` (só visões);
5. `drizzle/down/0003_bi_tables.sql` remove as tabelas de apoio (configuração dos painéis, lista de acessos,
   histórico de atualizações e rótulos).

Não pare no meio da sequência com um usuário de leitura ativo. Para voltar a usar o Power BI depois, aplique as
migrações de novo e rode o bi-setup (passo 5).

Nenhum dado da carteira é apagado. Um usuário de leitura pode ser removido, no banco do Praetor, com
`DROP OWNED BY praetor_bi; DROP ROLE praetor_bi;` (troque pelo nome do usuário, se for outro).
