// Phase 9 — /api/deals routes. Mounted with requireAuth + csrfProtect, so every
// handler already has req.userId. All queries are user-scoped in src/deals.js;
// a user can never read or mutate another user's deals (Test 7).

const express = require('express');
const router  = express.Router();
const {
  createDeal, getDeal, listDeals, updateDeal, deleteDeal,
  dealNameSuggestions, dealsToCsv, competitorActivityBeforeClose, DealError,
} = require('../deals');

function handleError(res, e) {
  if (e instanceof DealError) return res.status(e.status).json({ error: e.message });
  console.error('[deals] unexpected error:', e.message);
  return res.status(500).json({ error: 'Something went wrong saving the deal.' });
}

// Specific routes BEFORE /:id so they aren't swallowed by the param route.

router.get('/autocomplete', (req, res) => {
  res.json({ names: dealNameSuggestions(req.userId, req.query.q || '', 8) });
});

router.get('/export', (req, res) => {
  const csv = dealsToCsv(req.userId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="nivaria-deals-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

router.get('/', (req, res) => {
  const { outcome, competitor_id, limit, offset } = req.query;
  res.json(listDeals(req.userId, { outcome, competitor_id, limit, offset }));
});

router.post('/', (req, res) => {
  try {
    const deal = createDeal(req.userId, { ...req.body, source: 'manual_form' });
    res.status(201).json(deal);
  } catch (e) { handleError(res, e); }
});

router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid deal id' });
  const deal = getDeal(req.userId, id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  // The "aha" timeline: what the competitor was doing in the 30 days before close.
  const activity = (deal.outcome === 'lost' || deal.outcome === 'stalled') && deal.competitor_id
    ? competitorActivityBeforeClose(req.userId, deal.competitor_id, deal.close_date, 30)
    : [];

  res.json({ deal, competitor_activity: activity });
});

router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid deal id' });
  try {
    res.json(updateDeal(req.userId, id, req.body));
  } catch (e) { handleError(res, e); }
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid deal id' });
  try {
    res.json(deleteDeal(req.userId, id));
  } catch (e) { handleError(res, e); }
});

module.exports = router;
