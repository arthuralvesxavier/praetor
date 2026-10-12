# ADR-0010 — Integrações simuladas atrás de interfaces: análise preliminar e e-mail

- **Status**: aceita
- **Data**: 2026-10

## Contexto

O fluxo central da v2 é: chega um processo → é distribuído → os documentos são lidos e uma análise preliminar é preparada → o advogado recebe um e-mail com o resumo → revisa e aprova. Duas etapas dependeriam de serviços externos:

- **leitura e análise dos documentos** por um modelo de IA, que receberia peças processuais com dados pessoais (inclusive sensíveis, como atestados e laudos);
- **envio de e-mail** por SMTP ou API.

Nesta versão não havia contrato de tratamento de dados com fornecedor de IA para documentos reais, nem credenciais de envio, nem avaliação de custos e de LGPD. Ao mesmo tempo, o cliente precisava ver o fluxo completo funcionando, com dados fictícios, e os testes precisavam ser determinísticos e sem rede. O risco a evitar é o mesmo do caderno de requisitos (RK-05 e RJ-13): conteúdo gerado automaticamente apresentado como fato ou valor oficial, ou uma demonstração confundida com envio real.

## Decisão

- Cada integração fica atrás de uma **interface de provedor**, e os módulos só conhecem a interface:
  - `CaseBriefProvider` (`src/server/integrations/ai/case-brief/provider.ts`), obtido por `getCaseBriefProvider()`;
  - `EmailProvider` (`src/server/integrations/email/provider.ts`), obtido por `getEmailProvider()`.
- A única implementação **ativa** de cada uma é **simulada**:
  - `SimulatedCaseBriefProvider`: regras determinísticas sobre o cadastro e o texto extraído (sem IA, sem rede), `mode = "demo"`;
  - `SimulatedEmailProvider`: não abre conexão; registra a mensagem e devolve um id `sim-…`; recusa mensagens sem o prefixo "[Simulação]".
- Os seletores **não leem nenhuma variável de ambiente**: não é possível ligar uma integração real por configuração nesta versão. O adaptador real da análise preliminar (`LiveCaseBriefProvider`, `live.ts`) existe para documentar e tipar o contrato, mas não é selecionável.
- O contrato de saída é o mesmo para qualquer implementação (`caseBriefSchema`, `src/domain/case-brief.ts`), com **proveniência por item** (extraído com documento, página e trecho; cadastro; ilustrativo; lacuna; revisor). O serviço valida e saneia tudo o que qualquer provedor devolve (`sanitizeGeneratedBrief`) e acrescenta os avisos fixos.
- **Rotulagem obrigatória** de toda saída simulada: aviso `CASE_BRIEF_DEMO_NOTICE`, selos de proveniência, "Extração simulada (demonstração)" nos valores, faixa e prefixo "[Simulação]" nos e-mails, remetente de domínio reservado, selo "E-mail simulado" no cabeçalho e situação "Simulação demonstrativa"/"Simulado" em Administração → Integrações.
- Nada gerado pela simulação altera registros sozinho: prazos ficam pendentes de validação, tarefas nascem como sugeridas e valores entram como propostos na fila de conferência.
- O mesmo vale para a origem dos processos: "Simular chegada de processo" só existe em organizações de demonstração e cria dados fictícios rotulados; nenhum tribunal é consultado.

## Consequências

- O fluxo completo pode ser demonstrado e testado sem rede, sem custo e sem enviar dados pessoais a terceiros.
- Trocar por uma implementação real é localizado: implementar a interface, adicionar a seleção explícita por variável de ambiente e rever os pontos que hoje presumem simulação. O passo a passo está em [AI.md → Como ativar a IA real na análise preliminar](../AI.md#como-ativar-a-ia-real-na-análise-preliminar) e [AI.md → Como trocar o e-mail simulado por envio real](../AI.md#como-trocar-o-e-mail-simulado-por-envio-real).
- Antes de ativar qualquer integração real é obrigatório: revisão de custos (a análise preliminar ainda não passa pelo orçamento mensal), contrato de tratamento de dados e avaliação LGPD, cofre de segredos para credenciais e revisão de **todos** os rótulos que hoje dizem "simulação" de forma fixa.
- As regras do simulador foram ajustadas aos documentos fictícios de demonstração; com documentos reais ele extrai menos e mostra lacunas. Isso é aceitável porque o objetivo é demonstrar o fluxo e o contrato, não a qualidade de uma IA.
- Risco residual: um usuário confundir a demonstração com análise real. Mitigado pelos avisos em todas as telas, nos e-mails e na faixa de demonstração.

## Alternativas consideradas

- **Ligar a IA real (Anthropic) já na v2**, como na Central de IA: sem contrato de tratamento de dados e sem controle de custo para a análise preliminar, enviaria peças com dados sensíveis a terceiros. Adiada.
- **Usar o `DemoProvider` da Central de IA**: o contrato de saída é outro (sem proveniência por item, sem página); misturaria duas funcionalidades.
- **Enviar e-mails reais para endereços de teste**: exigiria credenciais e criaria risco de envio acidental a pessoas reais; a simulação com registro na Central de e-mails mostra o mesmo conteúdo.
- **Seleção por variável de ambiente desde já**: facilitaria ligar por engano em produção antes das revisões; preferiu-se exigir mudança de código.
