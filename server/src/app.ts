import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { rateLimit } from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import reminderRoutes from './routes/reminders.js';
import expenseRoutes from './routes/expenses.js';
import assistantRoutes from './routes/assistant.js';
import memoryRoutes from './routes/memory.js';
import notificationRoutes from './routes/notifications.js';
import documentRoutes from './routes/documents.js';
import serviceRoutes from './routes/services.js';
import accountRoutes from './routes/account.js';

// Dev servers are often opened through a LAN IP or a fallback port (8082, 19006),
// so allow any loopback or private-network origin outside production.
function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      /^(10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin) || (!config.isProd && isLocalOrigin(origin))) {
          return callback(null, true);
        }
        callback(new ApiError(403, 'CORS_REJECTED', 'Origin is not allowed'));
      },
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
    }),
  );

  app.get('/api/v1/health', (_req, res) => {
    res.json({
      ok: true,
      time: new Date().toISOString(),
      ai: config.aiEnabled,
      places: config.placesEnabled,
      documents: Boolean(config.DOCUMENT_ENCRYPTION_KEY),
      push: Boolean(config.EXPO_ACCESS_TOKEN),
    });
  });

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/reminders', reminderRoutes);
  app.use('/api/v1/expenses', expenseRoutes);
  app.use('/api/v1/assistant', assistantRoutes);
  app.use('/api/v1/memories', memoryRoutes);
  app.use('/api/v1/notifications', notificationRoutes);
  app.use('/api/v1/documents', documentRoutes);
  app.use('/api/v1/services', serviceRoutes);
  app.use('/api/v1/account', accountRoutes);

  app.use((_req, _res, next) => {
    next(new ApiError(404, 'NOT_FOUND', 'Route not found'));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some fields are invalid',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
      return;
    }
    if (error instanceof multer.MulterError) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image is larger than 10 MB'
          : 'Could not read the uploaded image';
      res.status(400).json({ error: { code: error.code, message } });
      return;
    }
    if (error instanceof ApiError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
      return;
    }
    console.error('Unhandled request error:', error);
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
    });
  });

  return app;
}

export const app = createApp();
