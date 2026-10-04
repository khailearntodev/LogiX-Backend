SELECT 'CREATE DATABASE logix_identity'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_identity')\gexec

SELECT 'CREATE DATABASE logix_master_data'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_master_data')\gexec

SELECT 'CREATE DATABASE logix_inventory'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_inventory')\gexec
