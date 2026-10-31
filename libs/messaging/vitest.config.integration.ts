import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/kafka-roundtrip.spec.ts'],
    fileParallelism: false,
  },
});
