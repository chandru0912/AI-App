import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { me, requireAuth } from '../middleware/auth.js';
import {
  assistantHistory,
  cancelAction,
  confirmAction,
  handleAssistantMessage,
} from '../services/assistant.js';

const router = Router();
router.use(requireAuth);

const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many assistant messages. Slow down.' } },
});

router.post('/messages', chatLimiter, async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
  res.json(await handleAssistantMessage(me(req), text));
});

router.get('/messages', async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json({ messages: await assistantHistory(me(req).id, Number.isFinite(limit) ? limit : 50) });
});

router.post('/actions/:id/confirm', async (req, res) => {
  res.json(await confirmAction(me(req), req.params.id));
});

router.post('/actions/:id/cancel', async (req, res) => {
  res.json(await cancelAction(me(req), req.params.id));
});

export default router;
