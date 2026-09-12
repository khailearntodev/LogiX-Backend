export { LogixLoggerModule } from './logger.module.js';
export type { LogixLoggerModuleOptions } from './logger.module.js';

// Re-export nestjs-pino's Logger and InjectPinoLogger for service-level use
export { Logger, InjectPinoLogger, PinoLogger } from 'nestjs-pino';
