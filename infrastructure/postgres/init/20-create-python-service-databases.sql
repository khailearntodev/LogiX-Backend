SELECT 'CREATE DATABASE logix_agent'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_agent')\gexec

SELECT 'CREATE DATABASE logix_forecast'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_forecast')\gexec

SELECT 'CREATE DATABASE logix_route_optimizer'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logix_route_optimizer')\gexec
