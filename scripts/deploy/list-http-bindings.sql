-- Binding rows that production can no longer call (review P-8, I-4).
--
--     psql "$DATABASE_URL" -f scripts/deploy/list-http-bindings.sql
--
-- Under NODE_ENV=production a binding endpoint must be https. The save DTOs
-- refuse a new http:// endpoint, and the invoker refuses one per call, so a
-- row saved with http:// before that rule stays PUBLISHED and every call to it
-- ends SYSTEM_ERROR with reason TRANSPORT_HTTPS_REQUIRED: no charge, no strike,
-- but it soaks up a failover attempt on every call. Run this when the rule
-- ships and tell each provider listed to save an https:// endpoint, or pause
-- the row. Read-only: it changes nothing.
SELECT
  b.id,
  b.organization_id,
  b.tool_id,
  b.status,
  b.endpoint,
  b.published_at
FROM tool_bindings b
WHERE lower(b.endpoint) NOT LIKE 'https://%'
ORDER BY (b.status = 'PUBLISHED') DESC, b.organization_id, b.tool_id;
