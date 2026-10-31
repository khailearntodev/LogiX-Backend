SELECT 'CREATE DATABASE logix_identity'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_identity')\gexec

SELECT 'CREATE DATABASE logix_master_data'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_master_data')\gexec

SELECT 'CREATE DATABASE logix_inventory'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_inventory')\gexec

SELECT 'CREATE DATABASE logix_order'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_order')\gexec

SELECT 'CREATE DATABASE logix_fulfillment'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_fulfillment')\gexec

SELECT 'CREATE DATABASE logix_transport'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_transport')\gexec

SELECT 'CREATE DATABASE logix_audit'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_audit')\gexec

SELECT 'CREATE DATABASE logix_notification'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_notification')\gexec
