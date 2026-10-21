import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getRepository } from '../db/client.js';
import { getUserId } from '../utils/auth.js';
import { normalizeQuestion } from '../ai/answerRules.js';

/** Screening answers the user gives once; reused for every future application. */
export const answersRouter = Router();

answersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const entries = await getRepository().getAnswerBank(getUserId(req));
    res.json({ success: true, data: entries, pending: entries.filter((e) => !e.answer).length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

answersRouter.post('/', async (req: Request, res: Response) => {
  const parsed = z.object({ question: z.string().trim().min(3).max(500), answer: z.string().trim().min(1).max(5000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Question and answer are required' });
  try {
    const entry = await getRepository().saveAnswerEntry({
      user_id: getUserId(req),
      question: parsed.data.question,
      normalized: normalizeQuestion(parsed.data.question),
      answer: parsed.data.answer,
      times_seen: 0,
    });
    res.json({ success: true, data: entry });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

answersRouter.put('/:id', async (req: Request, res: Response) => {
  const parsed = z.object({ answer: z.string().trim().max(5000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Answer is required' });
  try {
    const repo = getRepository();
    const userId = getUserId(req);
    const owned = (await repo.getAnswerBank(userId)).find((e) => e.id === req.params.id);
    if (!owned) return res.status(404).json({ success: false, error: 'Answer not found' });
    const entry = await repo.updateAnswerEntry(owned.id, { answer: parsed.data.answer || undefined });
    res.json({ success: true, data: entry });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

answersRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const removed = await getRepository().deleteAnswerEntry(getUserId(req), req.params.id);
    res.json({ success: removed });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
