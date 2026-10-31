import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Kafka, logLevel } from 'kafkajs';

const CACHED_KAFKA_IMAGE = 'apache/kafka:4.1.1';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Kafka test could not allocate a loopback port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  return address.port;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Owns one disposable broker; never connects to or mutates the shared broker. */
export async function startIsolatedKafka() {
  const suffix = randomUUID().replaceAll('-', '');
  const name = `logix-messaging-test-${suffix}`;
  const image = process.env.TEST_KAFKA_IMAGE ?? CACHED_KAFKA_IMAGE;
  docker(['image', 'inspect', image]);
  const port = await availablePort();
  const kafka = new Kafka({
    brokers: [`127.0.0.1:${port}`],
    clientId: `logix-test-${suffix}`,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 1_000,
    requestTimeout: 3_000,
    retry: { retries: 10, initialRetryTime: 300, maxRetryTime: 2_000 },
  });
  let containerId: string | undefined;
  let disposed = false;
  const dispose = async () => {
    if (containerId && !disposed) {
      docker(['rm', '--force', containerId]);
      disposed = true;
    }
  };
  try {
    containerId = docker([
      'run', '--detach', '--pull=never', '--name', name,
      '--publish', `127.0.0.1:${port}:9092`,
      '--env', 'KAFKA_NODE_ID=1',
      '--env', 'KAFKA_PROCESS_ROLES=broker,controller',
      '--env', 'KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093',
      '--env', `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${port}`,
      '--env', 'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
      '--env', 'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER',
      '--env', 'KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093',
      '--env', 'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
      '--env', 'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1',
      '--env', 'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
      '--env', 'KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0',
      '--env', 'KAFKA_AUTO_CREATE_TOPICS_ENABLE=false',
      image,
    ]);
    const deadline = Date.now() + 90_000;
    let lastFailure: unknown;
    while (Date.now() < deadline) {
      const admin = kafka.admin();
      try {
        await admin.connect();
        await admin.listTopics();
        return {
          kafka,
          brokers: [`127.0.0.1:${port}`],
          topic: `logix-test-${suffix}`,
          groupId: `logix-test-group-${suffix}`,
          dispose,
        };
      } catch (error) {
        lastFailure = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await admin.disconnect();
      }
    }
    throw new Error('Isolated Kafka did not become ready within 90 seconds', { cause: lastFailure });
  } catch (error) {
    await dispose();
    throw error;
  }
}
