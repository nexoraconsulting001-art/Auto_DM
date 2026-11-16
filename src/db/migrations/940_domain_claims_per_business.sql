-- A custom domain is proved by a TXT record carrying the claiming business's own token (PRD 5.4). Until that proof is found,
-- several businesses may be trying to prove the same name, and a later claim must never take the name away from an earlier
-- claimant whose proof is already in DNS (atk-tenancy-2). So each business keeps its own claim row, and the database allows
-- at most one verified row per name. Verifying a name drops every other business's pending claim on it, and a closed
-- business's verified row gives way (src/modules/domains/repo.js).
ALTER TABLE tenant_domains DROP CONSTRAINT tenant_domains_pkey;
ALTER TABLE tenant_domains DROP CONSTRAINT tenant_domains_tenant_key;
ALTER TABLE tenant_domains ADD PRIMARY KEY (tenant_id, domain);
CREATE UNIQUE INDEX tenant_domains_verified_idx ON tenant_domains (domain) WHERE status = 'verified';
CREATE INDEX tenant_domains_domain_idx ON tenant_domains (domain);
