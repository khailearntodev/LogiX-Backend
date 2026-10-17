import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const requireMessaging = createRequire(new URL('../libs/messaging/package.json', import.meta.url));
const { Kafka } = requireMessaging('kafkajs');
const path = process.argv[2] ?? fileURLToPath(new URL('../infrastructure/docker-compose/.env', import.meta.url));
const config = { ...parseEnv(readFileSync(path, 'utf8')), ...process.env };
function required(key) {
  const value = config[key]?.trim();
  if (!value) throw new Error(`Missing configuration: ${key}`);
  return value;
}
function positiveInteger(key) {
  const value = Number(required(key));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid configuration: ${key}`);
  return value;
}

const topics = [required('KAFKA_ORDER_TOPIC'), required('KAFKA_INVENTORY_TOPIC')];
if (new Set(topics).size !== topics.length) throw new Error('Domain topics must be distinct');
const numPartitions = positiveInteger('KAFKA_TOPIC_PARTITIONS');
const replicationFactor = positiveInteger('KAFKA_TOPIC_REPLICATION_FACTOR');
const kafka = new Kafka({
  clientId: required('KAFKA_CLIENT_ID'),
  brokers: required('KAFKA_BROKERS').split(',').map((broker) => broker.trim()),
});
const admin = kafka.admin();
await admin.connect();
try {
  await admin.createTopics({
    waitForLeaders: true,
    topics: topics.map((topic) => ({
      topic,
      numPartitions,
      replicationFactor,
      configEntries: [{ name: 'cleanup.policy', value: 'delete' }],
    })),
  });
  const metadata = await admin.fetchTopicMetadata({ topics });
  for (const topic of metadata.topics) {
    if (topic.partitions.length !== numPartitions ||
        topic.partitions.some((partition) => partition.replicas.length !== replicationFactor)) {
      throw new Error(`Topic ${topic.name} does not match configured partitions/replication`);
    }
    console.log(`Ready: ${topic.name}, partitions=${numPartitions}, replication=${replicationFactor}`);
  }
} finally {
  await admin.disconnect();
}
