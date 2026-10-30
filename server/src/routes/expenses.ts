import { Router } from 'express';
import { z } from 'zod';
import { me, requireAuth } from '../middleware/auth.js';
import {
  EXPENSE_CATEGORIES,
  budgetBodySchema,
  expenseCreateBodySchema,
  isoDateTime,
} from '../lib/schemas.js';
import { badRequest } from '../lib/errors.js';
import {
  createExpense,
  deleteExpense,
  expenseDto,
  expenseSummary,
  getBudget,
  getOwnedExpense,
  listExpenses,
  setBudget,
  updateExpense,
} from '../services/expenses.js';

const router = Router();
router.use(requireAuth);

const patchSchema = z.object({
  type: z.enum(['expense', 'income']).optional(),
  amount: z.number().positive().max(10_000_000).optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  note: z.string().trim().max(500).nullable().optional(),
  occurredAt: isoDateTime.optional(),
});

router.get('/summary', async (req, res) => {
  const period = z.enum(['day', 'week', 'month']).catch('month').parse(req.query.period);
  const summary = await expenseSummary(me(req), period);
  res.json({ summary });
});

router.get('/budget/:month', async (req, res) => {
  const month = req.params.month;
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Month must be YYYY-MM');
  res.json({ budget: await getBudget(me(req).id, month) });
});

router.put('/budget', async (req, res) => {
  const input = budgetBodySchema.parse(req.body);
  res.json({ budget: await setBudget(me(req), input.month, input.amount) });
});

router.get('/', async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  if (from && Number.isNaN(from.getTime())) throw badRequest('Invalid from date');
  if (to && Number.isNaN(to.getTime())) throw badRequest('Invalid to date');
  const category = req.query.category ? String(req.query.category) : undefined;
  const type = req.query.type ? String(req.query.type) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  const rows = await listExpenses(me(req).id, {
    from,
    to,
    category,
    type,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  res.json({ expenses: rows.map(expenseDto) });
});

router.post('/', async (req, res) => {
  const input = expenseCreateBodySchema.parse(req.body);
  const row = await createExpense(me(req), input);
  res.status(201).json({ expense: expenseDto(row) });
});

router.get('/:id', async (req, res) => {
  const row = await getOwnedExpense(me(req).id, req.params.id);
  res.json({ expense: expenseDto(row) });
});

router.patch('/:id', async (req, res) => {
  const input = patchSchema.parse(req.body);
  const row = await updateExpense(me(req).id, req.params.id, input);
  res.json({ expense: expenseDto(row) });
});

router.delete('/:id', async (req, res) => {
  await deleteExpense(me(req).id, req.params.id);
  res.status(204).end();
});

export default router;
