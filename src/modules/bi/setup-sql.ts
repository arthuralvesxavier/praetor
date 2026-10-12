/**
 * Comandos SQL dos usuários de banco somente leitura do Power BI (`praetor_bi`,
 * ou `praetor_bi_<sufixo>` quando o banco tem várias organizações), usados por
 * scripts/bi-setup.ts. Funções puras (sem I/O) para poder ser testadas.
 *
 * O usuário recebe apenas USAGE no schema `bi` e SELECT nas views dele; nada no
 * schema público. As views são executadas com os privilégios do dono (o usuário
 * das migrações) e são barreiras de segurança (security_barrier, migração
 * 0011): o Power BI lê só o que a camada governada expõe, e somente as linhas da
 * organização registrada para aquele usuário em `bi_reader_roles` (sem registro,
 * as views não devolvem nada). Cada usuário lê uma única organização.
 */
export const BI_DB_ROLE = "praetor_bi";

/** `praetor_bi` or `praetor_bi_<suffix>` (lowercase letters, digits, underscore): safe as a bare identifier. */
const BI_ROLE_PATTERN = /^praetor_bi(?:_[a-z0-9]+)*$/;

export function isBiReaderRole(name: string): boolean {
  return name.length <= 63 && BI_ROLE_PATTERN.test(name);
}

function assertBiReaderRole(name: string): string {
  if (!isBiReaderRole(name)) throw new Error("Invalid BI reader role name.");
  return name;
}

/** Suggested reader role for an organization slug: `praetor_bi_<slug>` (sanitized, at most 63 characters). */
export function suggestBiRoleName(slug: string): string {
  const suffix = slug
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63 - BI_DB_ROLE.length - 1)
    .replace(/_+$/g, "");
  return suffix ? `${BI_DB_ROLE}_${suffix}` : `${BI_DB_ROLE}_2`;
}

export type BiSetupInput = {
  /** Reader role (`praetor_bi` by default). Must pass `isBiReaderRole`. */
  role?: string;
  /** Whether the role already exists (CREATE vs ALTER). */
  roleExists: boolean;
  /** Password already escaped as a SQL literal (e.g. pg `client.escapeLiteral`). */
  passwordLiteral: string;
  /** Database name already escaped as an identifier (e.g. pg `client.escapeIdentifier`). */
  databaseIdent: string;
  /** Organization whose rows the role may read, already escaped as a SQL literal. */
  organizationLiteral: string;
  /**
   * Move an existing mapping of the role to this organization (--reassign). Without it, a role already
   * mapped to another organization keeps its mapping (the script refuses before and checks after).
   */
  reassign?: boolean;
};

export function biSetupStatements(input: BiSetupInput): string[] {
  const role = assertBiReaderRole(input.role ?? BI_DB_ROLE);
  const attrs = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
  const onConflict = input.reassign ? "DO UPDATE SET organization_id = excluded.organization_id" : "DO NOTHING";
  return [
    input.roleExists
      ? `ALTER ROLE ${role} WITH ${attrs} PASSWORD ${input.passwordLiteral}`
      : `CREATE ROLE ${role} WITH ${attrs} PASSWORD ${input.passwordLiteral}`,
    `ALTER ROLE ${role} SET default_transaction_read_only = on`,
    `ALTER ROLE ${role} SET search_path = bi`,
    `GRANT CONNECT ON DATABASE ${input.databaseIdent} TO ${role}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`,
    `REVOKE CREATE ON SCHEMA public FROM ${role}`,
    `GRANT USAGE ON SCHEMA bi TO ${role}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA bi TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA bi GRANT SELECT ON TABLES TO ${role}`,
    `INSERT INTO public.bi_reader_roles (role_name, organization_id) VALUES ('${role}', ${input.organizationLiteral}::uuid) ` +
      `ON CONFLICT (role_name) ${onConflict}`,
  ];
}

/** Organization the role reads after the statements ran (compared with the chosen one, inside the transaction). */
export function biReaderMappingSql(role: string = BI_DB_ROLE): string {
  return `select organization_id::text as organization_id from public.bi_reader_roles where role_name = '${assertBiReaderRole(role)}'`;
}

/**
 * What the role can still do besides reading `bi`. Run after the statements,
 * inside the same transaction.
 * - Before PostgreSQL 15, every role inherits from PUBLIC the right to create
 *   objects in the `public` schema, which a grant to one role cannot take away;
 *   with it, the role could write (create tables) after switching its read-only
 *   default off in its own session.
 * - SELECT on the system tables (a grant to PUBLIC, or membership in
 *   pg_read_all_data) would also make the views return every organization.
 * - TEMPORARY (granted to PUBLIC by default) lets the role create functions in
 *   its own session. The security_barrier views keep those functions away from
 *   rows of other organizations, so this is only a warning (defense in depth).
 */
export function biPrivilegeCheckSql(role: string = BI_DB_ROLE): string {
  const r = assertBiReaderRole(role);
  return `select
  current_setting('server_version_num')::int as server_version_num,
  has_schema_privilege('${r}', 'public', 'CREATE') as can_create_in_public,
  has_database_privilege('${r}', current_database(), 'CREATE') as can_create_schema,
  has_table_privilege('${r}', 'public.legal_processes', 'SELECT') as can_read_tables,
  has_database_privilege('${r}', current_database(), 'TEMPORARY') as can_create_temp`;
}

export const BI_PRIVILEGE_CHECK_SQL = biPrivilegeCheckSql();

export type BiPrivilegeCheck = {
  serverVersionNum: number;
  canCreateInPublic: boolean;
  canCreateSchema: boolean;
  canReadTables: boolean;
};

/** pt-BR problems that make the setup unsafe (empty = only reading the bi schema is possible). */
export function biPrivilegeProblems(check: BiPrivilegeCheck, role: string = BI_DB_ROLE): string[] {
  const problems: string[] = [];
  if (check.canCreateInPublic) {
    const version =
      check.serverVersionNum < 150000
        ? " Nesta versão do PostgreSQL (anterior à 15), todo usuário herda de PUBLIC a permissão de criar objetos no schema public."
        : "";
    problems.push(
      `O usuário ${role} conseguiria criar tabelas no schema public.${version} Peça ao administrador do banco para ` +
        "executar REVOKE CREATE ON SCHEMA public FROM PUBLIC (e, se o Praetor depender disso, GRANT CREATE ON SCHEMA public " +
        "TO <usuário do Praetor>) e rode o bi-setup de novo.",
    );
  }
  if (check.canCreateSchema) {
    problems.push(
      `O usuário ${role} conseguiria criar schemas neste banco. Peça ao administrador do banco para executar ` +
        "REVOKE CREATE ON DATABASE <banco> FROM PUBLIC e rode o bi-setup de novo.",
    );
  }
  if (check.canReadTables) {
    problems.push(
      `O usuário ${role} conseguiria ler as tabelas do sistema (permissão dada a PUBLIC ou participação em ` +
        "pg_read_all_data) e, com isso, as linhas de todas as organizações. Peça ao administrador do banco para retirar " +
        "essa permissão (REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM PUBLIC, ou REVOKE pg_read_all_data FROM " +
        `${role}) e rode o bi-setup de novo.`,
    );
  }
  return problems;
}

/** pt-BR warnings that do not block the setup (defense in depth). */
export function biPrivilegeWarnings(check: { canCreateTemp: boolean }, role: string = BI_DB_ROLE): string[] {
  if (!check.canCreateTemp) return [];
  return [
    `O usuário ${role} pode criar objetos temporários da própria sessão (permissão TEMPORARY, que o PostgreSQL dá a ` +
      "todos por padrão). Isso não dá acesso a linhas de outra organização, porque as visões do schema bi são barreiras " +
      "de segurança. Como proteção adicional, o administrador do banco pode executar REVOKE TEMPORARY ON DATABASE <banco> " +
      "FROM PUBLIC (o Praetor não usa tabelas temporárias).",
  ];
}

/** Problems with the role name or with an existing role of that name (null = it can be used). */
export function biRoleProblem(input: {
  role: string;
  currentUser: string;
  existing: { isSuperuser: boolean } | null;
}): string | null {
  if (!isBiReaderRole(input.role)) {
    return (
      `Nome de usuário inválido: ${input.role}. Use ${BI_DB_ROLE} ou ${BI_DB_ROLE}_<sufixo>, só com letras minúsculas ` +
      "sem acento, números e _ (no máximo 63 caracteres)."
    );
  }
  if (input.role === input.currentUser) {
    return `O usuário ${input.role} é o mesmo que está executando o bi-setup. O usuário de leitura precisa ser outro.`;
  }
  if (input.existing?.isSuperuser) {
    return `O usuário ${input.role} já existe e é superusuário do banco. Escolha outro nome com --role=.`;
  }
  return null;
}

/**
 * A reader role serves a single organization (`bi_reader_roles.role_name` is the
 * primary key). Moving an existing role to another organization would make every
 * Power BI dataset that already uses its credentials import the other
 * organization's rows on the next refresh (and Admin, Member and Contributor of the
 * workspace bypass RLS), so it requires an explicit --reassign.
 */
export function biReaderMappingProblem(input: {
  role: string;
  currentOrganizationId: string | null;
  requestedOrganizationId: string;
  reassign: boolean;
  organizations: { id: string; name: string; slug?: string | null }[];
}): string | null {
  const current = input.currentOrganizationId;
  if (!current || current.toLowerCase() === input.requestedOrganizationId.toLowerCase() || input.reassign) return null;
  const find = (id: string) => input.organizations.find((o) => o.id.toLowerCase() === id.toLowerCase());
  const from = find(current)?.name ?? current;
  const target = find(input.requestedOrganizationId);
  const to = target?.name ?? input.requestedOrganizationId;
  const suggestion = suggestBiRoleName(target?.slug ?? target?.name ?? "");
  return (
    `O usuário ${input.role} já lê a organização ${from}. Cada usuário de leitura serve a uma única organização: para ` +
    `${to}, crie outro usuário, por exemplo com --role=${suggestion}. Para mover ${input.role} de propósito, use ` +
    `--reassign: o conjunto de dados do Power BI que já usa este usuário passará a importar as linhas de ${to} na ` +
    "próxima atualização."
  );
}

/** Picks the organization the role reads: the one given, or the only one in the database. */
export function chooseBiOrganization(
  orgs: { id: string; name: string }[],
  requested: string | null,
): { ok: true; id: string } | { ok: false; message: string } {
  if (requested) {
    const found = orgs.find((o) => o.id.toLowerCase() === requested.toLowerCase());
    return found
      ? { ok: true, id: found.id }
      : { ok: false, message: `A organização ${requested} não existe neste banco.` };
  }
  if (orgs.length === 1) return { ok: true, id: orgs[0].id };
  if (orgs.length === 0) return { ok: false, message: "Nenhuma organização cadastrada neste banco." };
  const list = orgs.map((o) => `  ${o.id}  ${o.name}`).join("\n");
  return {
    ok: false,
    message:
      `Este banco tem ${orgs.length} organizações e cada usuário de leitura lê apenas uma: informe qual com --org=<id> ` +
      `e, para cada organização além da primeira, um usuário próprio com --role=${BI_DB_ROLE}_<nome curto>.\n${list}`,
  };
}
