-- =============================================================================
-- One-time setup of the PostgreSQL server installed on this machine (the one
-- pgAdmin manages, port 5432) for local Trendz development. Safe to run again.
--
-- Easiest: pgAdmin → right-click your server → "PSQL Tool", then run
--     \i 'C:/Projects/e-commerce/trendz/infra/postgres/local-setup.sql'
-- Or from a terminal (asks for the postgres password):
--     "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h 127.0.0.1 -f infra/postgres/local-setup.sql
--
-- LOCAL DEVELOPMENT ONLY: the trendz role is a superuser because the test suite
-- suspends triggers while it resets its own database (session_replication_role).
-- Production uses a normal, non-superuser role (see infra/scripts/provision-ubuntu.sh).
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'trendz') THEN
    CREATE ROLE trendz LOGIN SUPERUSER PASSWORD 'trendz_local_pw';
  END IF;
END
$$;

-- CREATE DATABASE cannot run inside a DO block; \gexec runs each generated statement on its own.
SELECT 'CREATE DATABASE trendz OWNER trendz' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'trendz')\gexec
SELECT 'CREATE DATABASE trendz_test OWNER trendz' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'trendz_test')\gexec

SELECT datname AS "Trendz databases ready" FROM pg_database WHERE datname IN ('trendz', 'trendz_test') ORDER BY 1;
