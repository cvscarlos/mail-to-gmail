import winston from 'winston';
import { Logger } from '../core/types.js';

const createLogger = (level: string = 'info'): Logger => {
  const logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
      }),
    ],
  });

  return logger;
};

export { createLogger };
