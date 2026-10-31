import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const suffix = randomUUID().replaceAll("-", "");
const database = `logix_driver_test_trip_${suffix}`;
const image = "postgres:17-bookworm";
const phase3 = process.argv.includes("--phase3");
const phase4 = process.argv.includes("--phase4");
const createPhase4Migrations = process.argv.includes("--create-phase4-migrations");
const env = {
  ...process.env,
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  TRIP_CANCEL_PREVIEW_SECRET: randomBytes(32).toString("hex"),
  DOTENV_CONFIG_PATH: path.join(root, ".isolated-test-do-not-read-env"),
};
let container;

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    shell: command === "pnpm" && process.platform === "win32",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} failed (exit ${result.status})`);
  return result.stdout?.trim();
}

try {
  run("docker", ["info"], true);
  run("docker", ["image", "inspect", image], true);
  run("docker", ["image", "inspect", "apache/kafka:4.1.1"], true);
  container = run(
    "docker",
    [
      "run",
      "--rm",
      "--pull=never",
      "-d",
      "--name",
      `logix-trip-test-${suffix}`,
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      `POSTGRES_DB=${database}`,
      "-p",
      "127.0.0.1::5432",
      image,
    ],
    true,
  );
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = spawnSync(
      "docker",
      ["exec", container, "pg_isready", "-U", "postgres", "-d", database],
      { stdio: "ignore" },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("Owned trip PostgreSQL did not become ready");
  const port = run("docker", ["port", container, "5432/tcp"], true)
    .split(":")
    .at(-1);
  if (!/^\d+$/.test(port)) throw new Error("Invalid isolated database port");
  const base = `postgresql://postgres:${env.POSTGRES_PASSWORD}@127.0.0.1:${port}/${database}`;
  env.DRIVER_TEST_DATABASE_URL = base;
  env.TRIP_TEST_DATABASE_URL = base;
  for (const [service, schema] of [
    ["identity-service", "identity"],
    ["master-data-service", "master_data"],
    ["order-service", "orders"],
    ...(phase4 ? [["inventory-service", "inventory"]] : []),
    ["fulfillment-service", "fulfillment"],
    ["transport-service", "transport"],
  ]) {
    env.DATABASE_URL = `${base}?schema=${schema}`;
    run("pnpm", ["--filter", service, "db:migrate:deploy"]);
    if (createPhase4Migrations && ["order-service", "fulfillment-service", "transport-service"].includes(service)) {
      run("pnpm", ["--filter", service, "exec", "prisma", "migrate", "dev", "--create-only", "--name", "phase4_durable_dispatch"]);
      run("pnpm", ["--filter", service, "db:migrate:deploy"]);
      run("pnpm", ["--filter", service, "db:generate"]);
    }
    run("pnpm", ["--filter", service, "db:migrate:status"]);
  }
  if (phase3) {
    if (!env.ROUTE_OPTIMIZER_TEST_PYTHON)
      throw new Error("Set ROUTE_OPTIMIZER_TEST_PYTHON to the installed optimizer Python executable");
    env.DATABASE_URL = base.replace("postgresql://", "postgresql+asyncpg://");
    run(env.ROUTE_OPTIMIZER_TEST_PYTHON, ["-m", "alembic", "-c",
      path.join(root, "apps", "route-optimizer-service", "alembic.ini"), "upgrade", "head"]);
    run(env.ROUTE_OPTIMIZER_TEST_PYTHON, ["-m", "alembic", "-c",
      path.join(root, "apps", "route-optimizer-service", "alembic.ini"), "current"]);
    env.DATABASE_URL = `${base}?schema=transport`;
  }
  if (!createPhase4Migrations) run("pnpm", [
    "--filter",
    "transport-service",
    "exec",
    "vitest",
    "run",
    "--config",
    path.join(root, "apps/transport-service/vitest.config.e2e.ts"),
    "--root",
    path.join(root, "apps/transport-service"),
    path.join(root, phase4 ? "apps/transport-service/test/dispatch.e2e-spec.ts" : phase3 ? "apps/transport-service/test/routes.e2e-spec.ts" : "apps/transport-service/test/trips.e2e-spec.ts"),
    "--hookTimeout=120000",
    "--testTimeout=60000",
    "--maxWorkers=1",
  ]);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Trip integration runner failed",
  );
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      run("docker", ["rm", "-f", container], true);
      console.info("Owned isolated Trip PostgreSQL removed");
    } catch (error) {
      console.error(
        error instanceof Error
          ? error.message
          : "Trip PostgreSQL cleanup failed",
      );
      process.exitCode = 1;
    }
  }
}
