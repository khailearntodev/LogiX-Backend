# Shared local Kafka

This single-node KRaft broker is shared by local LogiX services. It is **not a
production deployment**: PLAINTEXT is bound to loopback, replication is one,
and the volume persists across container restarts. Production requires a
separately secured, replicated broker deployment.

1. Copy `.env.example` to `.env` and fill all values. The local installation uses
   the pinned `apache/kafka:4.1.1` image.
2. From this directory run `docker compose --env-file .env -f kafka.yml up -d --wait kafka`.
3. From the repository root run `node scripts/setup-kafka.mjs`. Topic creation is
   idempotent and checks the partition/replication configuration.
4. Services running on the host use the configured external advertised address.
   Containers on the `logix` Compose network use `kafka:29092`.

Keep `KAFKA_ORDER_TOPIC`, `KAFKA_INVENTORY_TOPIC`, and `KAFKA_FULFILLMENT_TOPIC` identical in publisher and
subscriber environment files; consumer group IDs must differ between services
but remain identical across replicas of the same service. Auto-creation of
topics is disabled. A new domain topic must be explicitly provisioned.
The setup command provisions all three topics. When upgrading an existing local
environment, fill `KAFKA_FULFILLMENT_TOPIC` in this directory's ignored `.env`,
rerun setup, then restart any service that exited while subscribing to the
missing topic. Do not reset consumer offsets or delete existing topics.

Do not delete the Kafka volume during normal operation. To stop only Kafka,
run `docker compose --env-file .env -f kafka.yml stop kafka`. Do not run a
project-wide `down` because PostgreSQL shares the project.
