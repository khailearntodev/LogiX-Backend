import { ConfigModule } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogixConfigModule } from './config.module.js';

describe('LogixConfigModule isolated environment loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it('honors DOTENV_CONFIG_PATH so isolated runners never load a service environment file', () => {
    vi.stubEnv('DOTENV_CONFIG_PATH', '.isolated-test-do-not-read-env');
    const root = vi.spyOn(ConfigModule, 'forRoot').mockResolvedValue({ module: ConfigModule });
    LogixConfigModule.forRoot();
    expect(root).toHaveBeenCalledWith(expect.objectContaining({
      envFilePath: '.isolated-test-do-not-read-env', validate: expect.any(Function),
    }));
  });
  it('keeps explicitly configured file paths authoritative', () => {
    vi.stubEnv('DOTENV_CONFIG_PATH', '.isolated-test-do-not-read-env');
    const root = vi.spyOn(ConfigModule, 'forRoot').mockResolvedValue({ module: ConfigModule });
    LogixConfigModule.forRoot({ envFilePath: [] });
    expect(root).toHaveBeenCalledWith(expect.objectContaining({ envFilePath: [] }));
  });
});
