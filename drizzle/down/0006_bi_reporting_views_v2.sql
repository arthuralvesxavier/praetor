-- Reversao de drizzle/0006_bi_reporting_views_v2.sql: volta as views do schema "bi" para a versao de
-- drizzle/0004_bi_reporting_views.sql (sem o escopo por organizacao de bi_reader_roles, sem os processos
-- excluidos de competencia fechada em bi.processos e com as contagens em bi.atualizacao).
-- So views sao trocadas. Nenhuma tabela e apagada e nenhum dado da carteira e perdido.
-- Aplique ANTES de drizzle/down/0005_bi_access_scope.sql (ordem inversa das migracoes), manualmente (psql),
-- e remova a entrada 0006 de drizzle.__drizzle_migrations (created_at = 1791774486095) se quiser reaplicar.
DROP VIEW IF EXISTS "bi"."processos";
DROP VIEW IF EXISTS "bi"."competencias";
DROP VIEW IF EXISTS "bi"."valoracoes";
DROP VIEW IF EXISTS "bi"."pendencias";
DROP VIEW IF EXISTS "bi"."acesso";
DROP VIEW IF EXISTS "bi"."atualizacao";
CREATE VIEW "bi"."processos" AS
WITH garantias AS (
  SELECT g.process_id, GREATEST(COALESCE(SUM(g.amount_cents), 0), 0) AS cents
  FROM public.process_guarantees g
  WHERE g.status = 'linked' AND g.deleted_at IS NULL
  GROUP BY g.process_id
),
base AS (
  SELECT
    p.id, p.organization_id, p.number, p.company_id, p.unit_id, p.area, p.court, p.court_division,
    p.instance, p.phase, p.city, p.state, p.process_class, p.status, p.closure_reason,
    p.responsible_id, p.law_firm_id, p.is_confidential, p.needs_verification,
    p.claim_amount_cents, p.liquidated_amount_cents, p.loss_probability,
    p.filed_at, p.closed_at, p.last_movement_at,
    COALESCE(gr.cents, 0) AS garantias_cents,
    -- Percentual vigente: o espelho da classificacao oficial; sem ele, o percentual da
    -- classificacao nos parametros da organizacao (mesma regra de recordRiskBp).
    COALESCE(
      p.risk_percentage_bp,
      CASE p.loss_probability
        WHEN 'remote' THEN round(COALESCE((o.settings #>> '{contingency,riskPercentages,remote}')::numeric, 0) * 100)
        WHEN 'possible' THEN round(COALESCE((o.settings #>> '{contingency,riskPercentages,possible}')::numeric, 50) * 100)
        WHEN 'probable' THEN round(COALESCE((o.settings #>> '{contingency,riskPercentages,probable}')::numeric, 100) * 100)
      END
    )::integer AS percentual_bp
  FROM public.legal_processes p
  JOIN public.organizations o ON o.id = p.organization_id
  LEFT JOIN garantias gr ON gr.process_id = p.id
  WHERE p.deleted_at IS NULL
)
SELECT
  b.id AS process_id,
  b.organization_id,
  b.number AS numero_cnj,
  b.company_id AS empresa_id,
  c.name AS empresa,
  b.unit_id AS unidade_id,
  u.name AS unidade,
  b.area,
  l_area.label AS area_rotulo,
  b.court AS tribunal,
  b.court_division AS orgao_julgador,
  b.instance AS instancia,
  l_inst.label AS instancia_rotulo,
  b.phase AS fase,
  l_fase.label AS fase_rotulo,
  b.city AS cidade,
  b.state AS uf,
  b.process_class AS classe,
  b.status AS situacao,
  l_sit.label AS situacao_rotulo,
  (b.status IN ('active', 'suspended')) AS em_carteira_ativa,
  b.closure_reason AS motivo_encerramento,
  l_mot.label AS motivo_encerramento_rotulo,
  b.responsible_id AS responsavel_id,
  r.name AS responsavel,
  b.law_firm_id AS escritorio_id,
  lf.name AS escritorio,
  b.is_confidential AS sigiloso,
  b.needs_verification AS requer_verificacao,
  (b.claim_amount_cents / 100.0)::numeric(18, 2) AS valor_da_causa,
  (b.liquidated_amount_cents / 100.0)::numeric(18, 2) AS valor_apurado,
  (b.garantias_cents / 100.0)::numeric(18, 2) AS garantias_vinculadas,
  b.loss_probability AS classificacao,
  l_cls.label AS classificacao_rotulo,
  (b.percentual_bp / 100.0)::numeric(7, 2) AS percentual,
  CASE
    WHEN b.liquidated_amount_cents IS NOT NULL
      THEN (GREATEST(b.liquidated_amount_cents - b.garantias_cents, 0) / 100.0)::numeric(18, 2)
  END AS exposicao_apurada,
  CASE
    WHEN b.liquidated_amount_cents IS NULL AND b.claim_amount_cents IS NOT NULL AND b.percentual_bp IS NOT NULL
      THEN (GREATEST(round(b.claim_amount_cents::numeric * b.percentual_bp / 10000) - b.garantias_cents, 0) / 100.0)::numeric(18, 2)
  END AS exposicao_estimada,
  CASE
    WHEN b.percentual_bp IS NOT NULL AND b.liquidated_amount_cents IS NOT NULL
      THEN (round(GREATEST(b.liquidated_amount_cents - b.garantias_cents, 0)::numeric * b.percentual_bp / 10000) / 100.0)::numeric(18, 2)
  END AS provisao_apurada,
  CASE
    WHEN b.percentual_bp IS NOT NULL AND b.liquidated_amount_cents IS NULL AND b.claim_amount_cents IS NOT NULL
      THEN (round(b.claim_amount_cents::numeric * b.percentual_bp / 10000) / 100.0)::numeric(18, 2)
  END AS provisao_estimada,
  b.filed_at AS data_ajuizamento,
  b.closed_at AS data_encerramento,
  b.last_movement_at AS ultima_movimentacao
FROM base b
LEFT JOIN public.companies c ON c.id = b.company_id
LEFT JOIN public.units u ON u.id = b.unit_id
LEFT JOIN public.users r ON r.id = b.responsible_id
LEFT JOIN public.law_firms lf ON lf.id = b.law_firm_id
LEFT JOIN public.bi_labels l_area ON l_area.domain = 'legal_area' AND l_area.code = b.area
LEFT JOIN public.bi_labels l_inst ON l_inst.domain = 'process_instance' AND l_inst.code = b.instance
LEFT JOIN public.bi_labels l_fase ON l_fase.domain = 'process_phase' AND l_fase.code = b.phase
LEFT JOIN public.bi_labels l_sit ON l_sit.domain = 'process_status' AND l_sit.code = b.status
LEFT JOIN public.bi_labels l_mot ON l_mot.domain = 'closure_reason' AND l_mot.code = b.closure_reason
LEFT JOIN public.bi_labels l_cls ON l_cls.domain = 'loss_probability' AND l_cls.code = b.loss_probability;
COMMENT ON VIEW "bi"."processos" IS 'Um registro por processo não excluído (posição atual). Sem nomes de partes, CPF/CNPJ ou texto de documentos. Filtrado no Power BI pelo papel RLS via bi.acesso.';
COMMENT ON COLUMN "bi"."processos"."valor_da_causa" IS 'Valor da causa (exposição declarada). NULL = não informado. Não somar com valor_apurado.';
COMMENT ON COLUMN "bi"."processos"."valor_apurado" IS 'Valor liquidado/apurado oficial vigente. NULL = não apurado (não é zero). Não somar com valor_da_causa.';
COMMENT ON COLUMN "bi"."processos"."garantias_vinculadas" IS 'Soma das garantias com situação vinculada (abatem a exposição).';
COMMENT ON COLUMN "bi"."processos"."exposicao_apurada" IS 'Valor apurado menos garantias vinculadas, nunca negativo. NULL quando não há valor apurado.';
COMMENT ON COLUMN "bi"."processos"."exposicao_estimada" IS 'ESTIMATIVA: valor da causa x percentual de risco menos garantias, somente quando não há valor apurado. Não somar com exposicao_apurada sem ressalva.';
COMMENT ON COLUMN "bi"."processos"."provisao_apurada" IS 'Provisão sobre a base apurada líquida (valor apurado menos garantias) x percentual.';
COMMENT ON COLUMN "bi"."processos"."provisao_estimada" IS 'ESTIMATIVA: provisão sobre o valor da causa x percentual, somente quando não há valor apurado.';
COMMENT ON COLUMN "bi"."processos"."percentual" IS 'Percentual de risco vigente (0 a 100). NULL = sem classificação.';
CREATE VIEW "bi"."competencias" AS
SELECT
  s.organization_id,
  s.id AS competencia_id,
  s.period AS competencia,
  s.reference_date AS data_base,
  s.closed_at AS fechada_em,
  (s.params ->> 'rulesVersion')::integer AS versao_regras,
  i.process_id,
  i.number AS numero_cnj,
  i.company_id AS empresa_id,
  c.name AS empresa,
  i.unit_id AS unidade_id,
  u.name AS unidade,
  i.court AS tribunal,
  i.instance AS instancia,
  l_inst.label AS instancia_rotulo,
  i.phase AS fase,
  l_fase.label AS fase_rotulo,
  i.city AS cidade,
  i.is_confidential AS sigiloso,
  i.classification AS classificacao,
  l_cls.label AS classificacao_rotulo,
  (i.percentage_bp / 100.0)::numeric(7, 2) AS percentual,
  (i.claim_amount_cents / 100.0)::numeric(18, 2) AS valor_da_causa,
  (i.liquidated_amount_cents / 100.0)::numeric(18, 2) AS valor_apurado,
  (i.guarantees_cents / 100.0)::numeric(18, 2) AS garantias_vinculadas,
  CASE WHEN NOT i.exposure_is_estimate THEN (i.exposure_cents / 100.0)::numeric(18, 2) END AS exposicao_apurada,
  CASE WHEN i.exposure_is_estimate THEN (i.exposure_cents / 100.0)::numeric(18, 2) END AS exposicao_estimada,
  CASE WHEN NOT i.provision_is_estimate THEN (i.provision_cents / 100.0)::numeric(18, 2) END AS provisao_apurada,
  CASE WHEN i.provision_is_estimate THEN (i.provision_cents / 100.0)::numeric(18, 2) END AS provisao_estimada
FROM public.portfolio_snapshots s
JOIN public.portfolio_snapshot_items i ON i.snapshot_id = s.id AND i.organization_id = s.organization_id
LEFT JOIN public.companies c ON c.id = i.company_id
LEFT JOIN public.units u ON u.id = i.unit_id
LEFT JOIN public.bi_labels l_inst ON l_inst.domain = 'process_instance' AND l_inst.code = i.instance
LEFT JOIN public.bi_labels l_fase ON l_fase.domain = 'process_phase' AND l_fase.code = i.phase
LEFT JOIN public.bi_labels l_cls ON l_cls.domain = 'loss_probability' AND l_cls.code = i.classification
WHERE s.status = 'closed';
COMMENT ON VIEW "bi"."competencias" IS 'Posição de cada processo nas competências mensais FECHADAS (RN-10), lida como foi gravada no fechamento. Prévias não aparecem.';
COMMENT ON COLUMN "bi"."competencias"."valor_apurado" IS 'Valor apurado na data-base da competência. NULL = não apurado (não é zero). Não somar com valor_da_causa.';
CREATE VIEW "bi"."valoracoes" AS
SELECT
  v.organization_id,
  v.id AS valoracao_id,
  v.process_id,
  v.kind AS tipo,
  l_tipo.label AS tipo_rotulo,
  (v.amount_cents / 100.0)::numeric(18, 2) AS valor,
  v.base_date AS data_base,
  v.instance AS instancia,
  v.status AS situacao,
  l_sit.label AS situacao_rotulo,
  v.source AS origem,
  l_orig.label AS origem_rotulo,
  (v.source = 'simulation') AS simulacao,
  v.is_estimate AS estimativa,
  v.confidence AS confianca,
  (v.reviewed_by_id IS NOT NULL) AS conferido,
  rv.name AS conferido_por,
  v.reviewed_at AS conferido_em,
  v.created_at AS registrado_em
FROM public.process_valuations v
JOIN public.legal_processes p ON p.id = v.process_id AND p.organization_id = v.organization_id AND p.deleted_at IS NULL
LEFT JOIN public.users rv ON rv.id = v.reviewed_by_id
LEFT JOIN public.bi_labels l_tipo ON l_tipo.domain = 'valuation_kind' AND l_tipo.code = v.kind
LEFT JOIN public.bi_labels l_sit ON l_sit.domain = 'valuation_status' AND l_sit.code = v.status
LEFT JOIN public.bi_labels l_orig ON l_orig.domain = 'valuation_source' AND l_orig.code = v.source;
COMMENT ON VIEW "bi"."valoracoes" IS 'Histórico append-only de valores (causa, apurado, acordo, depósito...). Tipos diferentes nunca se somam; só situação oficial vale como posição. simulacao = extração simulada (demonstração).';
CREATE VIEW "bi"."pendencias" AS
WITH alertas AS (
  SELECT
    a.organization_id,
    a.type,
    COALESCE(lp.id, h.process_id, s.process_id, g.process_id, v.process_id, cb.process_id, ci.process_id, d.process_id) AS process_id
  FROM public.alerts a
  LEFT JOIN public.legal_processes lp ON a.entity_type = 'legal_process' AND lp.id = a.entity_id
  LEFT JOIN public.hearings h ON a.entity_type = 'hearing' AND h.id = a.entity_id AND h.deleted_at IS NULL
  LEFT JOIN public.settlements s ON a.entity_type = 'settlement' AND s.id = a.entity_id AND s.deleted_at IS NULL
  LEFT JOIN public.process_guarantees g ON a.entity_type = 'guarantee' AND g.id = a.entity_id AND g.deleted_at IS NULL
  LEFT JOIN public.process_valuations v ON a.entity_type = 'valuation' AND v.id = a.entity_id
  LEFT JOIN public.case_briefs cb ON a.entity_type = 'case_brief' AND cb.id = a.entity_id
  LEFT JOIN public.case_intakes ci ON a.entity_type = 'intake' AND ci.id = a.entity_id
  LEFT JOIN public.deadlines d ON a.entity_type = 'deadline' AND d.id = a.entity_id AND d.deleted_at IS NULL
  WHERE a.resolved_at IS NULL
)
SELECT x.organization_id, x.process_id, 'alerta'::text AS categoria, x.type AS tipo, l.label AS rotulo, count(*)::integer AS quantidade
FROM alertas x
JOIN public.legal_processes p ON p.id = x.process_id AND p.organization_id = x.organization_id AND p.deleted_at IS NULL
LEFT JOIN public.bi_labels l ON l.domain = 'alert_type' AND l.code = x.type
GROUP BY x.organization_id, x.process_id, x.type, l.label
UNION ALL
SELECT d.organization_id, d.process_id, 'prazo'::text, 'pending_validation'::text, 'Prazos sugeridos aguardando validação humana'::text, count(*)::integer
FROM public.deadlines d
JOIN public.legal_processes p ON p.id = d.process_id AND p.organization_id = d.organization_id AND p.deleted_at IS NULL
WHERE d.deleted_at IS NULL AND d.status = 'open' AND d.validation_status = 'pending_validation'
GROUP BY d.organization_id, d.process_id
UNION ALL
SELECT v.organization_id, v.process_id, 'valor'::text, 'proposed'::text, 'Valores propostos aguardando conferência'::text, count(*)::integer
FROM public.process_valuations v
JOIN public.legal_processes p ON p.id = v.process_id AND p.organization_id = v.organization_id AND p.deleted_at IS NULL
WHERE v.status = 'proposed'
GROUP BY v.organization_id, v.process_id;
COMMENT ON VIEW "bi"."pendencias" IS 'Contagens por processo: alertas abertos por tipo (categoria alerta), prazos sugeridos aguardando validação (prazo) e valores propostos aguardando conferência (valor). Somente quantidades.';
CREATE VIEW "bi"."acesso" AS
SELECT a.organization_id, a.user_key, a.process_id
FROM public.bi_process_access a;
COMMENT ON VIEW "bi"."acesso" IS 'Processos que cada usuário do Praetor pode ver, calculados pelo Praetor com as mesmas regras do sistema (rotina bi_access_refresh). Papel RLS no Power BI: [user_key] = USERNAME().';
CREATE VIEW "bi"."atualizacao" AS
SELECT s.organization_id, s.access_refreshed_at AS acessos_atualizados_em, s.access_user_count AS usuarios, s.access_row_count AS vinculos
FROM public.bi_settings s;
COMMENT ON VIEW "bi"."atualizacao" IS 'Quando a tabela de acessos (bi.acesso) foi reconstruída pela última vez em cada organização.';
