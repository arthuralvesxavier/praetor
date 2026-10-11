# ADR-0008 — Armazenamento local de arquivos atrás de uma interface de provedor

- **Status**: aceita
- **Data**: 2026-10

## Contexto

Documentos jurídicos (PDF, DOCX, imagens, textos) precisam ser guardados com versões, nunca expostos por URL pública e baixados só por quem pode vê-los. A primeira versão deve rodar sem serviços de nuvem.

## Decisão

- Interface `StorageProvider` (`put`, `getStream`, `delete`, `exists`) em `src/server/integrations/storage/provider.ts`, obtida por `getStorage()`.
- Implementação `LocalStorageProvider` no diretório `STORAGE_DIR` (padrão `./storage`, fora de `public/` e ignorado pelo git):
  - gravação atômica (temporário + `rename`);
  - chave validada (`[a-f0-9-/]`) e proteção contra path traversal;
  - erros permanentes marcados com `retryable = false`.
- Chaves geradas só no servidor: `buildStorageKey(orgId, documentId, versionId)`. O nome original é metadado sanitizado.
- O banco guarda `storage_key`, MIME detectado, tamanho e SHA-256. Versões são imutáveis.
- Download apenas via route handler autenticado com streaming. Upload via route handler com checagem de origem e limites.

## Consequências

- Zero dependências externas. Backup simples (banco + diretório juntos).
- Com várias instâncias web, é preciso volume compartilhado ou trocar para storage de objetos (passo a passo em [ARCHITECTURE.md](../ARCHITECTURE.md#como-trocar-o-armazenamento-s3-ou-compatível)).
- A criptografia em repouso depende do disco ou volume. Arquivos de documentos excluídos logicamente permanecem (sem expurgo nesta versão).

## Alternativas consideradas

- **S3/GCS/Azure Blob desde o início**: melhor para escala e durabilidade, mas exige conta, credenciais e configuração em dev. A interface permite migrar sem mudar os serviços.
- **Arquivos no banco (`bytea`)**: backup único, mas o banco incha e o streaming fica pior.
- **URLs pré-assinadas**: tiram tráfego do servidor, mas o link fica válido fora da sessão. Evitado nesta versão.
