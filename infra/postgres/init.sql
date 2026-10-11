-- Runs once when the local Postgres volume is first created.
-- A separate database is used by the automated test suite so tests never
-- touch development data.
CREATE DATABASE trendz_test OWNER trendz;
