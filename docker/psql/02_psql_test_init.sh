#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE "$POSTGRES_DB_TEST";
	GRANT ALL PRIVILEGES ON DATABASE "$POSTGRES_DB_TEST" TO "$POSTGRES_USER";
EOSQL

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB_TEST" -a -f ./docker-entrypoint-initdb.d/01_schema.sql