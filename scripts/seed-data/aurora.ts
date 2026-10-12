import type {
  ClosureReason,
  ContractStatus,
  ContractType,
  DeadlineKind,
  DeadlineStatus,
  DocumentCategory,
  ConfidentialityLevel,
  LegalArea,
  LossProbability,
  ObligationStatus,
  OccurrenceCategory,
  OccurrenceStatus,
  PartyRole,
  Priority,
  ProcessEventType,
  ProcessInstance,
  ProcessPhase,
  ProcessStatus,
  RenewalType,
  RiskLevel,
  TaskKind,
  TaskStatus,
} from "@/domain/enums";

/**
 * Fictional data of the demo organization "Grupo Aurora Exemplo S.A.".
 * Every person, company and process number is invented. Process numbers have
 * the CNJ shape but use "00" check digits and origin "0000" so they cannot be
 * mistaken for real lawsuits. Dates are offsets in days from the day the seed
 * runs (negative = past), so deadlines are always overdue/upcoming.
 */

export const AURORA_ORG = {
  name: "Grupo Aurora Exemplo S.A. (demonstração)",
  slug: "grupo-aurora-demo",
};

export type UnitKey = "sp" | "rec" | "cwb";
export const AURORA_UNITS: { key: UnitKey; name: string; code: string }[] = [
  { key: "sp", name: "Matriz São Paulo", code: "SP" },
  { key: "rec", name: "Filial Recife", code: "REC" },
  { key: "cwb", name: "Centro de Distribuição Curitiba", code: "CWB" },
];

export type UserKey = "admin" | "gestor" | "advogada" | "advogadoRecife" | "analista" | "executivo";

/** DEMO_ACCOUNTS e-mail → seed key, unit and job title (org 1 accounts). */
export const AURORA_USERS: Record<string, { key: UserKey; unit: UnitKey | null; jobTitle: string }> = {
  "admin@demo.praetor.local": { key: "admin", unit: null, jobTitle: "Administradora do sistema" },
  "gestor@demo.praetor.local": { key: "gestor", unit: null, jobTitle: "Gerente jurídico" },
  "advogada@demo.praetor.local": { key: "advogada", unit: "sp", jobTitle: "Advogada sênior" },
  "advogado.recife@demo.praetor.local": { key: "advogadoRecife", unit: "rec", jobTitle: "Advogado pleno" },
  "analista@demo.praetor.local": { key: "analista", unit: "sp", jobTitle: "Analista jurídica" },
  "executivo@demo.praetor.local": { key: "executivo", unit: null, jobTitle: "Diretor executivo" },
};

export const AURORA_TEAMS: { name: string; description: string; unit: UnitKey | null; leader: UserKey; members: UserKey[] }[] = [
  {
    name: "Contencioso Trabalhista",
    description: "Reclamações trabalhistas e apoio ao RH em desligamentos sensíveis.",
    unit: null,
    leader: "advogada",
    members: ["advogada", "advogadoRecife", "analista"],
  },
  {
    name: "Contencioso Cível e Consumidor",
    description: "Ações cíveis, consumeristas, Juizados Especiais e Procon.",
    unit: null,
    leader: "gestor",
    members: ["gestor", "advogada", "advogadoRecife"],
  },
  {
    name: "Consultivo e Contratos",
    description: "Elaboração e revisão de contratos, obrigações contratuais e pareceres.",
    unit: "sp",
    leader: "gestor",
    members: ["gestor", "analista", "advogada"],
  },
  {
    name: "Compliance e Privacidade",
    description: "Canal de denúncias, proteção de dados pessoais e programas de integridade.",
    unit: null,
    leader: "admin",
    members: ["admin", "gestor", "analista"],
  },
];

// ---------------------------------------------------------------------------
// Occurrences (jurídico preventivo)
// ---------------------------------------------------------------------------

export type OccurrenceKey =
  | "redeSocial"
  | "notificacaoEmbalagens"
  | "assedio"
  | "dadosPessoais"
  | "ambiental"
  | "rescisaoRecife"
  | "fornecedorCritico"
  | "procon";

export type OccurrenceSeed = {
  key: OccurrenceKey;
  createdBy: UserKey;
  title: string;
  facts: string;
  category: OccurrenceCategory;
  /** `converted_to_process` is reached by linking a process (see processes.fromOccurrence). */
  status: Exclude<OccurrenceStatus, "converted_to_process">;
  riskLevel: RiskLevel;
  riskRationale: string;
  areasInvolved: string[];
  involvedParties: string | null;
  missingInformation: string[];
  exposure: number | null;
  unit: UnitKey;
  responsible: UserKey;
  reportedBy: UserKey;
  occurredOn: number;
  reportedOn: number;
  isConfidential?: boolean;
};

export const AURORA_OCCURRENCES: OccurrenceSeed[] = [
  {
    key: "redeSocial",
    createdBy: "analista",
    title: "Reclamação de cliente em rede social sobre atraso na entrega",
    facts:
      "Cliente publicou em rede social relato de atraso de 20 dias na entrega de uma geladeira comprada no site, com grande repercussão nos comentários. O cliente afirma que registrará reclamação no Procon e pedirá indenização caso o produto não seja entregue em poucos dias. (dados fictícios)",
    category: "consumer_complaint",
    status: "under_analysis",
    riskLevel: "medium",
    riskRationale: "Risco reputacional relevante pela repercussão; exposição financeira individual baixa.",
    areasInvolved: ["Atendimento ao cliente", "Logística", "Marketing"],
    involvedParties: "Cliente Exemplo (pessoa fictícia)",
    missingInformation: ["Comprovante da data de entrega prometida no pedido", "Histórico completo de atendimentos"],
    exposure: 15000,
    unit: "sp",
    responsible: "analista",
    reportedBy: "analista",
    occurredOn: -7,
    reportedOn: -6,
  },
  {
    key: "notificacaoEmbalagens",
    createdBy: "advogada",
    title: "Notificação extrajudicial de fornecedor de embalagens",
    facts:
      "A Embalagens Modelo Ltda. notificou a empresa cobrando faturas em aberto e multa pelo cancelamento de pedidos já em produção, com ameaça de rescisão do contrato de fornecimento e protesto de títulos. Compras afirma que parte das faturas está em disputa por entregas com defeito. (dados fictícios)",
    category: "contractual",
    status: "action_plan",
    riskLevel: "high",
    riskRationale: "Valor relevante cobrado e risco de interrupção no fornecimento de embalagens.",
    areasInvolved: ["Compras", "Financeiro", "Jurídico"],
    involvedParties: "Embalagens Modelo Ltda. (empresa fictícia)",
    missingInformation: ["Laudos das entregas com defeito", "Comprovantes de pagamento das faturas contestadas"],
    exposure: 240000,
    unit: "sp",
    responsible: "advogada",
    reportedBy: "analista",
    occurredOn: -12,
    reportedOn: -11,
  },
  {
    key: "assedio",
    createdBy: "gestor",
    title: "Denúncia interna de assédio moral na área administrativa",
    facts:
      "Relato anônimo recebido pelo canal de denúncias aponta cobranças agressivas e mensagens fora do horário de trabalho por parte de um gestor da área administrativa da Matriz. O relato menciona testemunhas. Apuração reservada conduzida pelo Comitê de Ética. (dados fictícios)",
    category: "labor",
    status: "under_analysis",
    riskLevel: "critical",
    riskRationale: "Tema sensível, com potencial reclamação trabalhista e dano reputacional; exige sigilo.",
    areasInvolved: ["Recursos Humanos", "Compliance", "Comitê de Ética"],
    involvedParties: null,
    missingInformation: ["Datas exatas dos episódios", "Identificação das testemunhas"],
    exposure: null,
    unit: "sp",
    responsible: "gestor",
    reportedBy: "gestor",
    occurredOn: -20,
    reportedOn: -15,
    isConfidential: true,
  },
  {
    key: "dadosPessoais",
    createdBy: "advogada",
    title: "Incidente com dados pessoais: planilha de clientes enviada a destinatário externo",
    facts:
      "Colaborador da área comercial enviou por engano uma planilha com dados cadastrais de cerca de 1.200 clientes (nome, e-mail, telefone e cidade) a um destinatário de empresa parceira. Foi solicitada a exclusão do arquivo; a confirmação ainda não chegou. (dados fictícios)",
    category: "data_privacy",
    status: "action_plan",
    riskLevel: "high",
    riskRationale: "Envolve dados pessoais de clientes; avaliação de comunicação à autoridade e aos titulares em andamento.",
    areasInvolved: ["Tecnologia da Informação", "Comercial", "Privacidade"],
    involvedParties: "Empresa parceira destinatária (fictícia)",
    missingInformation: ["Confirmação de exclusão pelo destinatário", "Número exato de titulares afetados"],
    exposure: 80000,
    unit: "sp",
    responsible: "advogada",
    reportedBy: "advogada",
    occurredOn: -10,
    reportedOn: -9,
  },
  {
    key: "ambiental",
    createdBy: "gestor",
    title: "Autuação ambiental preliminar no Centro de Distribuição de Curitiba",
    facts:
      "A fiscalização municipal lavrou termo de constatação preliminar por armazenamento irregular de resíduos de embalagens no pátio externo do CD de Curitiba. O contrato com a empresa de coleta venceu e não foi renovado a tempo. (dados fictícios)",
    category: "environmental",
    status: "open",
    riskLevel: "high",
    riskRationale: "Possível multa administrativa e risco de questionamento da licença de operação.",
    areasInvolved: ["Operações do CD", "Meio Ambiente e Segurança"],
    involvedParties: "Fiscalização ambiental municipal (referência genérica)",
    missingInformation: ["Cópia integral do termo de constatação", "Comprovantes de coleta dos últimos 6 meses"],
    exposure: 500000,
    unit: "cwb",
    responsible: "gestor",
    reportedBy: "gestor",
    occurredOn: -6,
    reportedOn: -5,
  },
  {
    key: "rescisaoRecife",
    createdBy: "advogadoRecife",
    title: "Divergência no cálculo de verbas rescisórias (Filial Recife)",
    facts:
      "Ex-colaborador da Filial Recife contestou o cálculo das verbas rescisórias (férias proporcionais e horas extras do último mês). Sem acordo na conversa com o RH, o ex-colaborador ajuizou reclamação trabalhista. (dados fictícios)",
    category: "labor",
    status: "under_analysis",
    riskLevel: "medium",
    riskRationale: "Valor limitado; ponto de atenção é a conferência dos registros de ponto.",
    areasInvolved: ["Recursos Humanos", "Departamento Pessoal"],
    involvedParties: "Beltrano Exemplo Souza (pessoa fictícia)",
    missingInformation: ["Espelho de ponto do último mês trabalhado"],
    exposure: 48000,
    unit: "rec",
    responsible: "advogadoRecife",
    reportedBy: "advogadoRecife",
    occurredOn: -70,
    reportedOn: -65,
  },
  {
    key: "fornecedorCritico",
    createdBy: "gestor",
    title: "Atrasos recorrentes do fornecedor crítico de transporte (rota Sul)",
    facts:
      "A TransLog Exemplo Transportes Ltda. atrasou 18% das entregas da rota Sul no último mês, abaixo do nível de serviço contratado. O fornecedor pediu por e-mail que a multa contratual não seja aplicada. O contrato tem renovação automática se não houver aviso em breve. (dados fictícios)",
    category: "contractual",
    status: "monitoring",
    riskLevel: "high",
    riskRationale: "Fornecedor crítico para o abastecimento das lojas; janela de aviso de não renovação se aproximando.",
    areasInvolved: ["Logística", "Compras", "Jurídico"],
    involvedParties: "TransLog Exemplo Transportes Ltda. (empresa fictícia)",
    missingInformation: ["Relatório de entregas do último mês assinado pelo fornecedor"],
    exposure: 62400,
    unit: "cwb",
    responsible: "gestor",
    reportedBy: "gestor",
    occurredOn: -30,
    reportedOn: -4,
  },
  {
    key: "procon",
    createdBy: "advogadoRecife",
    title: "Reclamação no Procon sobre cobrança em duplicidade (Recife)",
    facts:
      "Consumidora registrou reclamação no Procon alegando cobrança em duplicidade no cartão de crédito. O financeiro confirmou o erro e estornou o valor; a resposta foi protocolada e a reclamação foi encerrada como atendida. (dados fictícios)",
    category: "consumer_complaint",
    status: "resolved",
    riskLevel: "low",
    riskRationale: "Valor baixo, erro reconhecido e corrigido.",
    areasInvolved: ["Financeiro", "Atendimento ao cliente"],
    involvedParties: "Consumidora Exemplo (pessoa fictícia)",
    missingInformation: [],
    exposure: 1290,
    unit: "rec",
    responsible: "advogadoRecife",
    reportedBy: "advogadoRecife",
    occurredOn: -45,
    reportedOn: -40,
  },
];

// ---------------------------------------------------------------------------
// Legal processes (contencioso)
// ---------------------------------------------------------------------------

export type ProcessKey =
  | "horasExtras"
  | "equiparacaoRecife"
  | "geladeiraJec"
  | "coletivaRecife"
  | "cobrancaDistribuidor"
  | "revisionalLocacao"
  | "execucaoFiscal"
  | "mandadoSeguranca"
  | "acpAmbiental"
  | "anulatoriaAnvisa"
  | "assedioConfidencial"
  | "rescisaoRecife"
  | "acidenteTransito"
  | "terceirizado"
  | "acordoEncerrado";

export type PartySeed = { name: string; role: PartyRole; isClient?: boolean; counselName?: string };
export type EventSeed = { days: number; type: ProcessEventType; title: string; description?: string };

export type ProcessSeed = {
  key: ProcessKey;
  createdBy: UserKey;
  number: string;
  title: string;
  court: string;
  courtDivision: string;
  jurisdiction: string;
  area: LegalArea;
  phase: ProcessPhase;
  /** Current instance (grau); omitted = not informed. "Em recurso" is the instance, never the phase (P0.5). */
  instance?: ProcessInstance;
  status: ProcessStatus;
  unit: UnitKey;
  responsible: UserKey;
  claim: number | null;
  riskLevel: RiskLevel;
  /**
   * Official risk classification, registered through the contingency service
   * (`addRiskAssessment`) with `riskRationale` as the opinion. Since v2 the
   * provision is not typed in: it is computed from the classification (RN-05).
   */
  lossProbability: LossProbability | null;
  riskRationale: string;
  filedAt: number;
  closedAt?: number;
  /** Required when the process is out of the active portfolio (RN-12). */
  closureReason?: ClosureReason;
  description: string;
  isConfidential?: boolean;
  fromOccurrence?: OccurrenceKey;
  /** Marks the process as loaded from the (fictional) migration spreadsheet. */
  imported?: { externalId: string; importedDaysAgo: number; events: EventSeed[] };
  parties: PartySeed[];
  events: EventSeed[];
};

const AURORA_CLIENT = "Grupo Aurora Exemplo S.A.";
export const IMPORT_SOURCE = "Planilha de migração (exemplo fictício)";

export const AURORA_PROCESSES: ProcessSeed[] = [
  {
    key: "horasExtras",
    createdBy: "advogada",
    number: "0001001-00.2025.5.02.0000",
    title: "Reclamação trabalhista: horas extras e adicional noturno",
    court: "TRT-2 (São Paulo)",
    courtDivision: "Vara do Trabalho fictícia nº 1",
    jurisdiction: "São Paulo/SP",
    area: "labor",
    phase: "knowledge",
    status: "active",
    unit: "sp",
    responsible: "advogada",
    claim: 185000,
    riskLevel: "high",
    lossProbability: "probable",
    riskRationale: "Cartões de ponto incompletos em dois meses do período; jornada noturna documentada parcialmente.",
    filedAt: -210,
    description:
      "Ex-operador de logística pede horas extras, adicional noturno e indenização por danos morais por jornada exaustiva. (dados fictícios)",
    parties: [
      { name: "Fulano Exemplo da Silva", role: "plaintiff", counselName: "Advogado Fictício do Reclamante" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Camila Rocha (jurídico interno)" },
    ],
    events: [
      { days: -210, type: "filing", title: "Distribuição da reclamação trabalhista" },
      { days: -190, type: "publication", title: "Notificação para audiência inicial recebida" },
      { days: -160, type: "hearing", title: "Audiência inicial: sem acordo", description: "Partes presentes; conciliação recusada. (dados fictícios)" },
      { days: -150, type: "petition", title: "Contestação protocolada com documentos" },
      { days: -95, type: "petition", title: "Réplica do reclamante juntada aos autos" },
      { days: -30, type: "publication", title: "Intimação: audiência de instrução designada" },
    ],
  },
  {
    key: "equiparacaoRecife",
    createdBy: "advogadoRecife",
    number: "0001002-00.2025.5.06.0000",
    title: "Reclamação trabalhista: equiparação salarial",
    court: "TRT-6 (Pernambuco)",
    courtDivision: "Vara do Trabalho fictícia nº 3",
    jurisdiction: "Recife/PE",
    area: "labor",
    phase: "knowledge",
    status: "active",
    unit: "rec",
    responsible: "advogadoRecife",
    claim: 96000,
    riskLevel: "medium",
    lossProbability: "possible",
    riskRationale: "Paradigma indicado exercia atividades parcialmente diferentes; prova testemunhal será decisiva.",
    filedAt: -140,
    description: "Analista comercial pede equiparação salarial com colega da mesma função na Filial Recife. (dados fictícios)",
    parties: [
      { name: "Sicrana Exemplo Lima", role: "plaintiff", counselName: "Advogada Fictícia da Reclamante" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Tiago Albuquerque (jurídico interno)" },
    ],
    events: [
      { days: -140, type: "filing", title: "Distribuição da reclamação trabalhista" },
      { days: -110, type: "hearing", title: "Audiência inicial: proposta de acordo recusada" },
      { days: -100, type: "petition", title: "Contestação protocolada" },
      { days: -12, type: "decision", title: "Despacho determinando a apresentação de contrarrazões" },
    ],
  },
  {
    key: "geladeiraJec",
    createdBy: "advogada",
    number: "0001003-00.2025.8.26.0000",
    title: "Ação indenizatória: produto entregue com defeito",
    court: "TJSP (Juizado Especial Cível)",
    courtDivision: "Juizado Especial Cível fictício",
    jurisdiction: "São Paulo/SP",
    area: "consumer",
    phase: "knowledge",
    status: "active",
    unit: "sp",
    responsible: "advogada",
    claim: 25000,
    riskLevel: "medium",
    lossProbability: "possible",
    riskRationale: "Laudo da assistência técnica confirma defeito de fábrica; discute-se apenas o dano moral.",
    filedAt: -90,
    description: "Consumidor pede troca do produto e indenização por danos morais por geladeira entregue com defeito. (dados fictícios)",
    parties: [
      { name: "Consumidor Exemplo Pereira", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Camila Rocha (jurídico interno)" },
    ],
    events: [
      { days: -90, type: "filing", title: "Distribuição no Juizado Especial Cível" },
      { days: -60, type: "hearing", title: "Audiência de conciliação sem acordo" },
      { days: -40, type: "petition", title: "Contestação apresentada" },
    ],
  },
  {
    key: "coletivaRecife",
    createdBy: "advogadoRecife",
    number: "0001004-00.2024.8.17.0000",
    title: "Ação coletiva de consumo: prazos de entrega no Nordeste",
    court: "TJPE",
    courtDivision: "Vara Cível fictícia nº 12",
    jurisdiction: "Recife/PE",
    area: "consumer",
    phase: "knowledge",
    instance: "second",
    status: "active",
    unit: "rec",
    responsible: "advogadoRecife",
    claim: 420000,
    riskLevel: "high",
    lossProbability: "possible",
    riskRationale: "Sentença parcialmente desfavorável; recurso pendente de julgamento.",
    filedAt: -520,
    description: "Associação de consumidores questiona atrasos nas entregas da região Nordeste. Recurso da empresa pendente. (dados fictícios)",
    parties: [
      { name: "Associação Fictícia de Defesa do Consumidor", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Tiago Albuquerque (jurídico interno)" },
    ],
    events: [
      { days: -520, type: "filing", title: "Distribuição da ação coletiva" },
      { days: -480, type: "petition", title: "Contestação apresentada" },
      { days: -300, type: "hearing", title: "Audiência de instrução" },
      { days: -120, type: "decision", title: "Sentença de parcial procedência" },
      { days: -100, type: "petition", title: "Recurso de apelação interposto" },
      { days: -20, type: "publication", title: "Intimação para manifestação sobre documentos novos" },
    ],
  },
  {
    key: "cobrancaDistribuidor",
    createdBy: "advogada",
    number: "0001005-00.2023.8.26.0000",
    title: "Ação de cobrança contra distribuidor inadimplente",
    court: "TJSP",
    courtDivision: "Vara Cível fictícia nº 7",
    jurisdiction: "Campinas/SP",
    area: "civil",
    phase: "enforcement",
    status: "active",
    unit: "sp",
    responsible: "advogada",
    claim: 310000,
    riskLevel: "low",
    lossProbability: "remote",
    riskRationale: "Empresa é autora; risco limitado à dificuldade de recuperar o crédito.",
    filedAt: -800,
    description: "Cobrança de duplicatas não pagas por distribuidor regional. Fase de cumprimento de sentença. (dados fictícios)",
    parties: [
      { name: AURORA_CLIENT, role: "plaintiff", isClient: true, counselName: "Camila Rocha (jurídico interno)" },
      { name: "Distribuidora Exemplo Paulista Ltda.", role: "defendant" },
    ],
    events: [
      { days: -800, type: "filing", title: "Distribuição da ação de cobrança" },
      { days: -500, type: "decision", title: "Sentença de procedência" },
      { days: -400, type: "petition", title: "Pedido de cumprimento de sentença" },
      { days: -90, type: "petition", title: "Pedido de pesquisa de bens do devedor" },
      { days: -25, type: "note", title: "Anotação interna: avaliar proposta de acordo parcelado" },
    ],
  },
  {
    key: "revisionalLocacao",
    createdBy: "gestor",
    number: "0001006-00.2025.8.16.0000",
    title: "Ação revisional de aluguel: Centro de Distribuição de Curitiba",
    court: "TJPR",
    courtDivision: "Vara Cível fictícia nº 2",
    jurisdiction: "Curitiba/PR",
    area: "civil",
    phase: "knowledge",
    status: "active",
    unit: "cwb",
    responsible: "gestor",
    claim: 150000,
    riskLevel: "medium",
    lossProbability: "possible",
    riskRationale: "Laudo de avaliação do imóvel ainda não produzido.",
    filedAt: -75,
    description: "Locador pede revisão do aluguel do galpão do CD de Curitiba. (dados fictícios)",
    parties: [
      { name: "Imobiliária Fictícia Paraná Ltda.", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Ricardo Menezes (jurídico interno)" },
    ],
    events: [
      { days: -75, type: "filing", title: "Distribuição da ação revisional" },
      { days: -50, type: "petition", title: "Contestação com proposta de valor" },
      { days: -15, type: "decision", title: "Decisão nomeando perito avaliador" },
    ],
  },
  {
    key: "execucaoFiscal",
    createdBy: "gestor",
    number: "0001007-00.2022.8.26.0000",
    title: "Execução fiscal: ICMS (auto de infração fictício)",
    court: "TJSP",
    courtDivision: "Vara de Execuções Fiscais fictícia",
    jurisdiction: "São Paulo/SP",
    area: "tax",
    phase: "enforcement",
    status: "active",
    unit: "sp",
    responsible: "gestor",
    claim: 1250000,
    riskLevel: "critical",
    lossProbability: "probable",
    riskRationale: "Defesa administrativa rejeitada; discussão restrita à multa e aos juros.",
    filedAt: -1100,
    description: "Execução de crédito de ICMS decorrente de auto de infração sobre transferências entre estabelecimentos. (dados fictícios)",
    parties: [
      { name: "Fazenda Pública Estadual (referência genérica)", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Escritório externo fictício" },
    ],
    events: [
      { days: -1100, type: "filing", title: "Distribuição da execução fiscal" },
      { days: -1050, type: "petition", title: "Oferecimento de seguro garantia" },
      { days: -900, type: "petition", title: "Embargos à execução apresentados" },
      { days: -200, type: "decision", title: "Sentença nos embargos: parcial procedência" },
      { days: -170, type: "petition", title: "Recurso interposto pela empresa" },
      { days: -10, type: "publication", title: "Intimação sobre renovação do seguro garantia" },
    ],
  },
  {
    key: "mandadoSeguranca",
    createdBy: "gestor",
    number: "0001008-00.2024.4.03.0000",
    title: "Mandado de segurança: base de cálculo de PIS/COFINS",
    court: "TRF-3",
    courtDivision: "Vara Federal fictícia nº 5",
    jurisdiction: "São Paulo/SP",
    area: "tax",
    phase: "knowledge",
    instance: "second",
    status: "suspended",
    unit: "sp",
    responsible: "gestor",
    claim: 780000,
    riskLevel: "low",
    lossProbability: "remote",
    riskRationale: "Empresa é impetrante; não há valores a provisionar.",
    filedAt: -600,
    description: "Discussão sobre a base de cálculo das contribuições. Processo suspenso por decisão do juízo. (dados fictícios)",
    parties: [
      { name: AURORA_CLIENT, role: "plaintiff", isClient: true, counselName: "Escritório externo fictício" },
      { name: "Autoridade fiscal federal (referência genérica)", role: "defendant" },
    ],
    events: [
      { days: -600, type: "filing", title: "Impetração do mandado de segurança" },
      { days: -560, type: "decision", title: "Liminar indeferida" },
      { days: -400, type: "decision", title: "Sentença denegatória" },
      { days: -380, type: "petition", title: "Apelação interposta" },
      { days: -90, type: "decision", title: "Decisão de suspensão do processo" },
    ],
  },
  {
    key: "acpAmbiental",
    createdBy: "gestor",
    number: "0001009-00.2025.8.16.0000",
    title: "Ação civil pública ambiental: descarte de resíduos no CD Curitiba",
    court: "TJPR",
    courtDivision: "Vara da Fazenda Pública fictícia",
    jurisdiction: "Curitiba/PR",
    area: "environmental",
    phase: "knowledge",
    status: "active",
    unit: "cwb",
    responsible: "gestor",
    claim: 2000000,
    riskLevel: "high",
    lossProbability: "possible",
    riskRationale: "Discussão técnica sobre o volume de resíduos; perícia ambiental pendente.",
    filedAt: -160,
    description: "Pedido de reparação ambiental por descarte irregular de resíduos em área vizinha ao CD de Curitiba. (dados fictícios)",
    parties: [
      { name: "Ministério Público Estadual (referência genérica)", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Ricardo Menezes (jurídico interno)" },
      { name: "Coletora Fictícia de Resíduos Ltda.", role: "third_party" },
    ],
    events: [
      { days: -160, type: "filing", title: "Distribuição da ação civil pública" },
      { days: -130, type: "petition", title: "Contestação com relatório técnico preliminar" },
      { days: -60, type: "hearing", title: "Audiência de conciliação: suspensa para tratativas" },
      { days: -18, type: "decision", title: "Decisão determinando perícia ambiental" },
    ],
  },
  {
    key: "anulatoriaAnvisa",
    createdBy: "advogada",
    number: "0001010-00.2025.4.03.0000",
    title: "Ação anulatória de auto de infração sanitária",
    court: "TRF-3",
    courtDivision: "Vara Federal fictícia nº 9",
    jurisdiction: "São Paulo/SP",
    area: "regulatory",
    phase: "knowledge",
    status: "active",
    unit: "sp",
    responsible: "advogada",
    claim: 180000,
    riskLevel: "medium",
    lossProbability: "possible",
    riskRationale: "Discute-se a rotulagem de produto importado; documentação técnica favorável.",
    filedAt: -120,
    description: "Anulação de auto de infração sanitária sobre rotulagem de produto importado. (dados fictícios)",
    parties: [
      { name: AURORA_CLIENT, role: "plaintiff", isClient: true, counselName: "Camila Rocha (jurídico interno)" },
      { name: "Agência reguladora federal (referência genérica)", role: "defendant" },
    ],
    events: [
      { days: -120, type: "filing", title: "Distribuição da ação anulatória" },
      { days: -70, type: "petition", title: "Contestação da ré juntada" },
      { days: -8, type: "publication", title: "Intimação para réplica" },
    ],
  },
  {
    key: "assedioConfidencial",
    createdBy: "gestor",
    number: "0001011-00.2025.5.02.0000",
    title: "Reclamação trabalhista: alegação de assédio moral (confidencial)",
    court: "TRT-2 (São Paulo)",
    courtDivision: "Vara do Trabalho fictícia nº 4",
    jurisdiction: "São Paulo/SP",
    area: "labor",
    phase: "knowledge",
    status: "active",
    unit: "sp",
    responsible: "advogada",
    claim: 350000,
    riskLevel: "high",
    lossProbability: "probable",
    riskRationale: "Mensagens juntadas pela reclamante indicam conduta inadequada de gestor.",
    filedAt: -50,
    description:
      "Ex-gerente alega assédio moral e pede indenização. Processo confidencial: visível apenas para administração, gestão jurídica e a advogada responsável. (dados fictícios)",
    isConfidential: true,
    parties: [
      { name: "Reclamante Confidencial Exemplo", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Camila Rocha (jurídico interno)" },
    ],
    events: [
      { days: -50, type: "filing", title: "Distribuição da reclamação trabalhista" },
      { days: -35, type: "publication", title: "Notificação para audiência recebida" },
      { days: -5, type: "note", title: "Anotação interna: alinhar estratégia com o RH e a diretoria" },
    ],
  },
  {
    key: "rescisaoRecife",
    createdBy: "advogadoRecife",
    number: "0001012-00.2025.5.06.0000",
    title: "Reclamação trabalhista: diferenças de verbas rescisórias",
    court: "TRT-6 (Pernambuco)",
    courtDivision: "Vara do Trabalho fictícia nº 8",
    jurisdiction: "Recife/PE",
    area: "labor",
    phase: "knowledge",
    status: "active",
    unit: "rec",
    responsible: "advogadoRecife",
    claim: 48000,
    riskLevel: "medium",
    lossProbability: "possible",
    riskRationale: "Divergência pontual no cálculo das férias proporcionais.",
    filedAt: -40,
    description: "Processo originado da ocorrência preventiva sobre divergência no cálculo das verbas rescisórias. (dados fictícios)",
    fromOccurrence: "rescisaoRecife",
    parties: [
      { name: "Beltrano Exemplo Souza", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Tiago Albuquerque (jurídico interno)" },
    ],
    events: [
      { days: -40, type: "filing", title: "Distribuição da reclamação trabalhista" },
      { days: -28, type: "publication", title: "Notificação para audiência inicial" },
      { days: -3, type: "hearing", title: "Audiência inicial: prazo para proposta de acordo" },
    ],
  },
  {
    key: "acidenteTransito",
    createdBy: "gestor",
    number: "0001013-00.2024.8.16.0000",
    title: "Ação indenizatória: colisão envolvendo veículo de entrega",
    court: "TJPR",
    courtDivision: "Vara Cível fictícia nº 5",
    jurisdiction: "Curitiba/PR",
    area: "civil",
    phase: "knowledge",
    status: "active",
    unit: "cwb",
    responsible: "gestor",
    claim: 95000,
    riskLevel: "medium",
    lossProbability: "possible",
    riskRationale: "Classificação importada da planilha; precisa ser revisada pela equipe.",
    filedAt: -330,
    description: "Pedido de indenização por danos materiais e morais após colisão com veículo terceirizado de entrega. (dados fictícios)",
    imported: {
      externalId: "LINHA-0013",
      importedDaysAgo: 30,
      events: [
        { days: -330, type: "filing", title: "Distribuição (dado importado)" },
        { days: -290, type: "petition", title: "Contestação apresentada (dado importado)" },
        { days: -180, type: "hearing", title: "Audiência de conciliação sem acordo (dado importado)" },
      ],
    },
    parties: [
      { name: "Motorista Exemplo Ferreira", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true },
      { name: "TransLog Exemplo Transportes Ltda.", role: "third_party" },
    ],
    events: [{ days: -12, type: "note", title: "Anotação interna: conferir os dados importados com a pasta física" }],
  },
  {
    key: "terceirizado",
    createdBy: "advogada",
    number: "0001014-00.2023.5.02.0000",
    title: "Reclamação trabalhista: ex-terceirizado (responsabilidade subsidiária)",
    court: "TRT-2 (São Paulo)",
    courtDivision: "Vara do Trabalho fictícia nº 6",
    jurisdiction: "São Paulo/SP",
    area: "labor",
    phase: "knowledge",
    instance: "second",
    status: "active",
    unit: "sp",
    responsible: "advogada",
    claim: 72000,
    riskLevel: "medium",
    lossProbability: "possible",
    riskRationale: "Classificação importada da planilha; responsabilidade subsidiária discutida em recurso.",
    filedAt: -700,
    description: "Ex-empregado de empresa de limpeza terceirizada pede verbas não pagas e responsabilidade subsidiária da tomadora. (dados fictícios)",
    imported: {
      externalId: "LINHA-0014",
      importedDaysAgo: 30,
      events: [
        { days: -700, type: "filing", title: "Distribuição (dado importado)" },
        { days: -560, type: "hearing", title: "Audiência de instrução (dado importado)" },
        { days: -420, type: "decision", title: "Sentença de parcial procedência (dado importado)" },
        { days: -400, type: "petition", title: "Recurso ordinário interposto (dado importado)" },
      ],
    },
    parties: [
      { name: "Reclamante Terceirizado Exemplo", role: "plaintiff" },
      { name: "Limpeza Exemplar Serviços Ltda.", role: "defendant" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true },
    ],
    events: [],
  },
  {
    key: "acordoEncerrado",
    createdBy: "advogada",
    number: "0001015-00.2024.8.26.0000",
    title: "Ação de consumo encerrada por acordo: troca de mercadoria",
    court: "TJSP (Juizado Especial Cível)",
    courtDivision: "Juizado Especial Cível fictício",
    jurisdiction: "Santo André/SP",
    area: "consumer",
    phase: "knowledge",
    status: "closed",
    unit: "sp",
    responsible: "advogada",
    claim: 12000,
    riskLevel: "low",
    lossProbability: "remote",
    riskRationale: "Encerrado com acordo cumprido.",
    filedAt: -260,
    closedAt: -150,
    closureReason: "settlement_fulfilled",
    description: "Pedido de troca de mercadoria e indenização, encerrado por acordo homologado e cumprido. (dados fictícios)",
    parties: [
      { name: "Consumidora Exemplo Andrade", role: "plaintiff" },
      { name: AURORA_CLIENT, role: "defendant", isClient: true, counselName: "Camila Rocha (jurídico interno)" },
    ],
    events: [
      { days: -260, type: "filing", title: "Distribuição no Juizado Especial Cível" },
      { days: -200, type: "hearing", title: "Audiência de conciliação" },
      { days: -195, type: "settlement", title: "Acordo celebrado e homologado" },
      { days: -150, type: "note", title: "Acordo cumprido; arquivamento" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type ContractKey =
  | "logistica"
  | "embalagens"
  | "locacaoCwb"
  | "ndaStartup"
  | "licencaErp"
  | "limpezaRecife"
  | "parceriaNordeste"
  | "consultoriaAmbiental";

export type ObligationSeed = {
  description: string;
  responsible: UserKey;
  dueDate: number | null;
  recurrence?: string;
  status: ObligationStatus;
};

export type ContractSeed = {
  key: ContractKey;
  createdBy: UserKey;
  title: string;
  counterparty: string;
  type: ContractType;
  status: ContractStatus;
  unit: UnitKey;
  responsible: UserKey;
  startDate: number | null;
  endDate: number | null;
  renewalType: RenewalType;
  renewalNoticeDays: number | null;
  value: number | null;
  riskLevel: RiskLevel;
  description: string;
  linkedProcess?: ProcessKey;
  linkedOccurrence?: OccurrenceKey;
  obligations: ObligationSeed[];
};

export const AURORA_CONTRACTS: ContractSeed[] = [
  {
    key: "logistica",
    createdBy: "gestor",
    title: "Prestação de serviços de transporte e logística: rota Sul e Sudeste",
    counterparty: "TransLog Exemplo Transportes Ltda.",
    type: "services",
    status: "active",
    unit: "cwb",
    responsible: "gestor",
    startDate: -300,
    endDate: 45,
    renewalType: "automatic",
    renewalNoticeDays: 30,
    value: 576000,
    riskLevel: "medium",
    description: "Transporte de mercadorias entre o CD de Curitiba e as lojas. Renovação automática salvo aviso com 30 dias. (dados fictícios)",
    linkedOccurrence: "fornecedorCritico",
    obligations: [
      { description: "Receber e conferir o relatório mensal de entregas do fornecedor", responsible: "gestor", dueDate: -5, recurrence: "mensal", status: "pending" },
      { description: "Exigir a apólice renovada do seguro de carga", responsible: "gestor", dueDate: 20, status: "pending" },
      { description: "Pagamento da fatura do mês anterior", responsible: "gestor", dueDate: -20, recurrence: "mensal", status: "fulfilled" },
    ],
  },
  {
    key: "embalagens",
    createdBy: "advogada",
    title: "Fornecimento de embalagens de papelão",
    counterparty: "Embalagens Modelo Ltda.",
    type: "supply",
    status: "active",
    unit: "sp",
    responsible: "advogada",
    startDate: -500,
    endDate: 230,
    renewalType: "manual",
    renewalNoticeDays: 60,
    value: 1450000,
    riskLevel: "high",
    description: "Fornecimento contínuo de embalagens para as lojas e o e-commerce. Em disputa por faturas contestadas. (dados fictícios)",
    linkedOccurrence: "notificacaoEmbalagens",
    obligations: [
      { description: "Apresentação do certificado de qualidade do lote trimestral pelo fornecedor", responsible: "analista", dueDate: -18, status: "overdue" },
      { description: "Negociar o reajuste anual de preços", responsible: "advogada", dueDate: 60, status: "pending" },
    ],
  },
  {
    key: "locacaoCwb",
    createdBy: "gestor",
    title: "Locação do galpão do Centro de Distribuição de Curitiba",
    counterparty: "Imobiliária Fictícia Paraná Ltda.",
    type: "lease",
    status: "active",
    unit: "cwb",
    responsible: "gestor",
    startDate: -1800,
    endDate: 25,
    renewalType: "manual",
    renewalNoticeDays: 90,
    value: 2160000,
    riskLevel: "high",
    description: "Locação não residencial do galpão do CD. Valor do aluguel em discussão judicial. (dados fictícios)",
    linkedProcess: "revisionalLocacao",
    obligations: [
      { description: "Notificar o locador sobre a intenção de renovar a locação", responsible: "gestor", dueDate: -65, status: "pending" },
      { description: "Pagamento do IPTU do exercício", responsible: "gestor", dueDate: -100, status: "fulfilled" },
    ],
  },
  {
    key: "ndaStartup",
    createdBy: "advogada",
    title: "Acordo de confidencialidade: projeto de roteirização",
    counterparty: "Startup Exemplo Tecnologia Ltda.",
    type: "nda",
    status: "active",
    unit: "sp",
    responsible: "advogada",
    startDate: -100,
    endDate: 265,
    renewalType: "none",
    renewalNoticeDays: null,
    value: null,
    riskLevel: "low",
    description: "Troca de informações confidenciais para avaliação de software de roteirização. (dados fictícios)",
    obligations: [
      { description: "Devolver ou destruir as informações confidenciais ao final da avaliação", responsible: "advogada", dueDate: 265, status: "pending" },
    ],
  },
  {
    key: "licencaErp",
    createdBy: "analista",
    title: "Licença de uso do sistema de gestão (ERP)",
    counterparty: "SoftExemplo Sistemas S.A.",
    type: "software_license",
    status: "active",
    unit: "sp",
    responsible: "analista",
    startDate: -380,
    endDate: -10,
    renewalType: "automatic",
    renewalNoticeDays: 30,
    value: 240000,
    riskLevel: "medium",
    description: "Licença anual do ERP. A vigência cadastrada terminou e a renovação ainda não foi formalizada. (dados fictícios)",
    obligations: [
      { description: "Formalizar a renovação da licença ou confirmar a renovação automática por escrito", responsible: "analista", dueDate: -15, status: "pending" },
    ],
  },
  {
    key: "limpezaRecife",
    createdBy: "advogadoRecife",
    title: "Prestação de serviços de limpeza e conservação: Filial Recife",
    counterparty: "Limpeza Exemplar Serviços Ltda.",
    type: "services",
    status: "active",
    unit: "rec",
    responsible: "advogadoRecife",
    startDate: -200,
    endDate: 165,
    renewalType: "automatic",
    renewalNoticeDays: 30,
    value: 312000,
    riskLevel: "medium",
    description: "Serviços terceirizados de limpeza. Exige comprovação mensal dos recolhimentos trabalhistas da contratada. (dados fictícios)",
    obligations: [
      { description: "Conferir a comprovação dos recolhimentos trabalhistas da contratada", responsible: "advogadoRecife", dueDate: 5, recurrence: "mensal", status: "pending" },
      { description: "Conferir as certidões negativas da contratada", responsible: "advogadoRecife", dueDate: -30, status: "fulfilled" },
    ],
  },
  {
    key: "parceriaNordeste",
    createdBy: "advogadoRecife",
    title: "Parceria comercial para distribuição no Nordeste (minuta)",
    counterparty: "Distribuidora Fictícia Nordeste Ltda.",
    type: "partnership",
    status: "under_review",
    unit: "rec",
    responsible: "advogadoRecife",
    startDate: 20,
    endDate: 385,
    renewalType: "manual",
    renewalNoticeDays: 60,
    value: 900000,
    riskLevel: "medium",
    description: "Minuta em negociação: exclusividade regional e metas mínimas de compra. (dados fictícios)",
    obligations: [],
  },
  {
    key: "consultoriaAmbiental",
    createdBy: "gestor",
    title: "Consultoria ambiental: licenciamento do CD Curitiba",
    counterparty: "Consultoria Verde Exemplo Ltda.",
    type: "services",
    status: "expired",
    unit: "cwb",
    responsible: "gestor",
    startDate: -425,
    endDate: -60,
    renewalType: "none",
    renewalNoticeDays: null,
    value: 85000,
    riskLevel: "low",
    description: "Consultoria para renovação da licença de operação do CD. Contrato encerrado pelo término do prazo. (dados fictícios)",
    obligations: [{ description: "Entrega do relatório final de licenciamento", responsible: "gestor", dueDate: -70, status: "fulfilled" }],
  },
];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentKey =
  | "contratoLogistica"
  | "notificacaoEmbalagens"
  | "resumoHorasExtras"
  | "emailCliente"
  | "memorandoDados"
  | "ataAmbiental"
  | "emailFornecedor"
  | "relatoDenuncia";

export type DocumentSeed = {
  key: DocumentKey;
  uploadedBy: UserKey;
  file: string;
  title: string;
  category: DocumentCategory;
  confidentiality: ConfidentialityLevel;
  description: string;
  process?: ProcessKey;
  occurrence?: OccurrenceKey;
  contract?: ContractKey;
};

export const AURORA_DOCUMENTS: DocumentSeed[] = [
  {
    key: "contratoLogistica",
    uploadedBy: "gestor",
    file: "contrato-logistica-v1.txt",
    title: "Contrato de transporte e logística: TransLog",
    category: "contract",
    confidentiality: "internal",
    description: "Instrumento assinado (texto fictício para demonstração).",
    contract: "logistica",
    occurrence: "fornecedorCritico",
  },
  {
    key: "notificacaoEmbalagens",
    uploadedBy: "advogada",
    file: "notificacao-extrajudicial-embalagens.txt",
    title: "Notificação extrajudicial: Embalagens Modelo",
    category: "correspondence",
    confidentiality: "internal",
    description: "Notificação recebida pela Matriz (texto fictício).",
    occurrence: "notificacaoEmbalagens",
    contract: "embalagens",
  },
  {
    key: "resumoHorasExtras",
    uploadedBy: "advogada",
    file: "resumo-reclamacao-trabalhista.txt",
    title: "Resumo interno da reclamação trabalhista: horas extras",
    category: "report",
    confidentiality: "internal",
    description: "Resumo preparado pela equipe para a audiência de instrução (texto fictício).",
    process: "horasExtras",
  },
  {
    key: "emailCliente",
    uploadedBy: "analista",
    file: "email-reclamacao-cliente.txt",
    title: "E-mail do cliente sobre atraso na entrega",
    category: "correspondence",
    confidentiality: "internal",
    description: "Mensagem recebida pelo atendimento (texto fictício).",
    occurrence: "redeSocial",
  },
  {
    key: "memorandoDados",
    uploadedBy: "advogada",
    file: "memorando-incidente-dados.txt",
    title: "Memorando da TI sobre o incidente com dados pessoais",
    category: "internal",
    confidentiality: "confidential",
    description: "Memorando interno classificado como confidencial (texto fictício).",
    occurrence: "dadosPessoais",
  },
  {
    key: "ataAmbiental",
    uploadedBy: "gestor",
    file: "ata-reuniao-comite-ambiental.txt",
    title: "Ata do comitê de meio ambiente: autuação preliminar",
    category: "internal",
    confidentiality: "internal",
    description: "Ata da reunião sobre a autuação no CD de Curitiba (texto fictício).",
    occurrence: "ambiental",
  },
  {
    key: "emailFornecedor",
    uploadedBy: "gestor",
    file: "email-fornecedor-atraso.txt",
    title: "E-mail da TransLog sobre os atrasos da rota Sul",
    category: "correspondence",
    confidentiality: "internal",
    description:
      "Contém uma tentativa fictícia de instrução dirigida à IA, usada para demonstrar que o conteúdo de documentos é tratado apenas como dado.",
    occurrence: "fornecedorCritico",
  },
  {
    key: "relatoDenuncia",
    uploadedBy: "gestor",
    file: "relato-canal-denuncias.txt",
    title: "Registro do canal de denúncias: relato EX-0007",
    category: "evidence",
    confidentiality: "restricted",
    description: "Relato sigiloso; acesso restrito (texto fictício).",
    occurrence: "assedio",
  },
];

// ---------------------------------------------------------------------------
// Deadlines & tasks
// ---------------------------------------------------------------------------

export type LinkSeed = { process?: ProcessKey; occurrence?: OccurrenceKey; contract?: ContractKey };

export type DeadlineSeed = LinkSeed & {
  createdBy: UserKey;
  title: string;
  description?: string;
  due: number;
  kind: DeadlineKind;
  priority: Priority;
  responsible: UserKey;
  status?: DeadlineStatus;
};

export const AURORA_DEADLINES: DeadlineSeed[] = [
  {
    createdBy: "advogada",
    title: "Manifestação sobre documentos juntados pelo reclamante",
    description: "Prazo informado pela advogada responsável a partir da intimação. (dados fictícios)",
    due: -2,
    kind: "procedural",
    priority: "high",
    responsible: "advogada",
    process: "horasExtras",
  },
  {
    createdBy: "advogada",
    title: "Audiência de instrução: reclamação de horas extras",
    due: 12,
    kind: "procedural",
    priority: "high",
    responsible: "advogada",
    process: "horasExtras",
  },
  {
    createdBy: "advogadoRecife",
    title: "Apresentar contrarrazões: equiparação salarial",
    due: 4,
    kind: "procedural",
    priority: "urgent",
    responsible: "advogadoRecife",
    process: "equiparacaoRecife",
  },
  {
    createdBy: "advogadoRecife",
    title: "Manifestação sobre documentos novos na ação coletiva",
    due: 6,
    kind: "procedural",
    priority: "high",
    responsible: "advogadoRecife",
    process: "coletivaRecife",
  },
  {
    createdBy: "gestor",
    title: "Comprovar renovação do seguro garantia na execução fiscal",
    due: 20,
    kind: "procedural",
    priority: "high",
    responsible: "gestor",
    process: "execucaoFiscal",
  },
  {
    createdBy: "gestor",
    title: "Indicar assistente técnico e quesitos para a perícia ambiental",
    due: -5,
    kind: "procedural",
    priority: "urgent",
    responsible: "gestor",
    process: "acpAmbiental",
  },
  {
    createdBy: "advogada",
    title: "Réplica na ação anulatória sanitária",
    due: 3,
    kind: "procedural",
    priority: "medium",
    responsible: "advogada",
    process: "anulatoriaAnvisa",
  },
  {
    createdBy: "gestor",
    title: "Enviar notificação de renovação ao locador do CD Curitiba",
    description: "Aviso com 90 dias de antecedência previsto no contrato; já em atraso. (dados fictícios)",
    due: -1,
    kind: "contractual",
    priority: "urgent",
    responsible: "gestor",
    contract: "locacaoCwb",
  },
  {
    createdBy: "gestor",
    title: "Decidir sobre a renovação automática do contrato de logística",
    description: "Último dia para aviso de não renovação, conforme a versão do contrato cadastrada. (dados fictícios)",
    due: 15,
    kind: "contractual",
    priority: "high",
    responsible: "gestor",
    contract: "logistica",
  },
  {
    createdBy: "advogada",
    title: "Concluir avaliação de risco do incidente de dados com o DPO",
    description: "Prazo interno definido pela equipe de privacidade. (dados fictícios)",
    due: 2,
    kind: "regulatory",
    priority: "urgent",
    responsible: "advogada",
    occurrence: "dadosPessoais",
  },
  {
    createdBy: "gestor",
    title: "Protocolar defesa à autuação ambiental preliminar",
    due: 9,
    kind: "regulatory",
    priority: "high",
    responsible: "gestor",
    occurrence: "ambiental",
  },
  {
    createdBy: "gestor",
    title: "Revisão trimestral das provisões do contencioso",
    due: 30,
    kind: "internal",
    priority: "medium",
    responsible: "gestor",
  },
  {
    createdBy: "analista",
    title: "Atualizar a política interna de privacidade",
    due: 40,
    kind: "internal",
    priority: "low",
    responsible: "analista",
  },
  {
    createdBy: "advogada",
    title: "Contestação na ação do Juizado Especial Cível",
    due: -45,
    kind: "procedural",
    priority: "high",
    responsible: "advogada",
    process: "geladeiraJec",
    status: "done",
  },
];

export type TaskSeed = LinkSeed & {
  createdBy: UserKey;
  title: string;
  description?: string;
  kind: TaskKind;
  priority: Priority;
  due: number | null;
  assignee: UserKey;
  status: TaskStatus;
};

export const AURORA_TASKS: TaskSeed[] = [
  // Action plans of occurrences
  { createdBy: "advogada", title: "Levantar histórico de pedidos e entregas do fornecedor", kind: "action_plan", priority: "high", due: -6, assignee: "analista", status: "done", occurrence: "notificacaoEmbalagens" },
  { createdBy: "advogada", title: "Preparar minuta de resposta à notificação extrajudicial", kind: "action_plan", priority: "urgent", due: 3, assignee: "advogada", status: "in_progress", occurrence: "notificacaoEmbalagens" },
  { createdBy: "advogada", title: "Reunião com Compras para avaliar fornecedor alternativo", kind: "action_plan", priority: "medium", due: -2, assignee: "analista", status: "todo", occurrence: "notificacaoEmbalagens" },
  { createdBy: "advogada", title: "Identificar os titulares afetados pelo envio indevido", kind: "action_plan", priority: "high", due: -5, assignee: "analista", status: "done", occurrence: "dadosPessoais" },
  { createdBy: "advogada", title: "Registrar o incidente no relatório interno de incidentes", kind: "action_plan", priority: "high", due: -1, assignee: "advogada", status: "in_progress", occurrence: "dadosPessoais" },
  { createdBy: "advogada", title: "Revisar com a TI as regras de envio de anexos externos", kind: "action_plan", priority: "medium", due: 10, assignee: "analista", status: "todo", occurrence: "dadosPessoais" },
  { createdBy: "gestor", title: "Contratar laudo técnico independente sobre os resíduos", kind: "action_plan", priority: "high", due: 7, assignee: "gestor", status: "todo", occurrence: "ambiental" },
  { createdBy: "gestor", title: "Reunir licenças ambientais e comprovantes de coleta do CD", kind: "action_plan", priority: "high", due: -3, assignee: "gestor", status: "blocked", occurrence: "ambiental", description: "Aguardando a gerência do CD localizar os comprovantes dos últimos 6 meses. (dados fictícios)" },
  { createdBy: "gestor", title: "Solicitar plano de recuperação de nível de serviço à TransLog", kind: "action_plan", priority: "high", due: 2, assignee: "gestor", status: "in_progress", occurrence: "fornecedorCritico" },
  { createdBy: "analista", title: "Responder ao cliente pelo canal oficial de atendimento", kind: "action_plan", priority: "medium", due: -4, assignee: "analista", status: "done", occurrence: "redeSocial" },
  // General / review / follow-up
  { createdBy: "advogada", title: "Reunir os cartões de ponto faltantes com o RH", kind: "general", priority: "high", due: -4, assignee: "analista", status: "todo", process: "horasExtras" },
  { createdBy: "advogada", title: "Orientar as testemunhas para a audiência de instrução", kind: "general", priority: "medium", due: 9, assignee: "advogada", status: "todo", process: "horasExtras" },
  { createdBy: "gestor", title: "Atualizar o cálculo do débito fiscal com a contabilidade", kind: "follow_up", priority: "high", due: 6, assignee: "gestor", status: "in_progress", process: "execucaoFiscal" },
  { createdBy: "analista", title: "Negociar a renovação da licença do ERP", kind: "follow_up", priority: "high", due: 5, assignee: "analista", status: "todo", contract: "licencaErp" },
  { createdBy: "gestor", title: "Conferir os dados importados da planilha de migração", kind: "review", priority: "medium", due: 10, assignee: "gestor", status: "todo", process: "acidenteTransito" },
  { createdBy: "advogada", title: "Validar as movimentações importadas com a pasta física", kind: "review", priority: "medium", due: -1, assignee: "advogada", status: "todo", process: "terceirizado" },
  { createdBy: "advogada", title: "Atualizar o modelo padrão de acordo de confidencialidade", kind: "general", priority: "low", due: 20, assignee: "advogada", status: "todo" },
  { createdBy: "advogadoRecife", title: "Solicitar ao RH Recife os documentos do paradigma", kind: "general", priority: "high", due: 2, assignee: "advogadoRecife", status: "in_progress", process: "equiparacaoRecife" },
  { createdBy: "advogadoRecife", title: "Arquivar as certidões da contratada de limpeza", kind: "general", priority: "low", due: -28, assignee: "advogadoRecife", status: "done", contract: "limpezaRecife" },
];

export type CommentSeed = { author: UserKey; body: string } & (
  | { process: ProcessKey }
  | { occurrence: OccurrenceKey }
  | { contract: ContractKey }
);

export const AURORA_COMMENTS: CommentSeed[] = [
  { author: "advogada", process: "horasExtras", body: "RH confirmou que os cartões de ponto de dezembro estão no arquivo físico da Matriz. Bruna vai buscar esta semana." },
  { author: "gestor", process: "horasExtras", body: "Após a audiência, revisar a provisão. Se a prova de jornada continuar incompleta, avaliar proposta de acordo." },
  { author: "analista", occurrence: "notificacaoEmbalagens", body: "Compras enviou a lista de entregas com defeito: 3 lotes nos últimos dois meses. Anexarei os laudos assim que chegarem." },
  { author: "advogada", occurrence: "notificacaoEmbalagens", body: "A resposta à notificação deve mencionar as faturas contestadas e propor reunião antes de qualquer pagamento." },
  { author: "gestor", contract: "logistica", body: "Atenção: a versão 2 do contrato (aditivo) prorrogou a vigência, mas o cadastro ainda mostra a data antiga. Confirmar antes de decidir sobre a renovação." },
  { author: "gestor", occurrence: "ambiental", body: "Consultoria ambiental anterior teve o contrato encerrado. Verificar se vale contratar a mesma empresa para o laudo." },
  { author: "advogadoRecife", process: "equiparacaoRecife", body: "Contrarrazões em elaboração; falta a descrição de cargos atualizada do RH Recife." },
];
