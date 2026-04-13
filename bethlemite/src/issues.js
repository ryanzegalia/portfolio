const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { dbWrapper } = require('../config/database');
const { authenticate, crewOnly } = require('../middleware/auth');

// Get active issue for card requests (any authenticated user)
router.get('/active', authenticate, (req, res) => {
  try {
    const issue = dbWrapper.prepare('SELECT * FROM issues WHERE is_active_for_requests = 1').get();

    if (!issue) {
      return res.json({ active: false, message: 'No active issue for card requests' });
    }

    res.json({
      active: true,
      issue: {
        id: issue.id,
        name: issue.name,
        issue_type: issue.issue_type,
        start_date: issue.start_date,
        end_date: issue.end_date,
        // Legacy fields for backwards compatibility
        month: issue.month,
        year: issue.year,
        status: issue.status,
        notes: issue.notes
      }
    });
  } catch (err) {
    console.error('Error getting active issue:', err);
    res.status(500).json({ error: 'Failed to get active issue' });
  }
});

// Get cards pending receipt from printer (crew only)
router.get('/cards-to-receive', authenticate, crewOnly, (req, res) => {
  try {
    // Find issues with unfulfilled print runs (quantity_received < quantity_ordered)
    const result = dbWrapper.prepare(`
      SELECT
        i.id as issue_id,
        i.name as issue_name,
        pr.id as print_run_id,
        SUM(pr.quantity_ordered - COALESCE(pr.quantity_received, 0)) as cards_to_receive
      FROM issues i
      JOIN print_runs pr ON pr.issue_id = i.id
      WHERE pr.quantity_ordered > COALESCE(pr.quantity_received, 0)
      GROUP BY i.id
      ORDER BY i.is_active_for_requests DESC, i.start_date DESC
      LIMIT 1
    `).get();

    if (!result || result.cards_to_receive === 0) {
      return res.json({ count: 0, issueId: null, issueName: null, printRunId: null });
    }

    // Get the first unfulfilled print run for this issue
    const printRun = dbWrapper.prepare(`
      SELECT id FROM print_runs
      WHERE issue_id = ? AND quantity_ordered > COALESCE(quantity_received, 0)
      ORDER BY created_at DESC
      LIMIT 1
    `).get(result.issue_id);

    res.json({
      count: result.cards_to_receive,
      issueId: result.issue_id,
      issueName: result.issue_name,
      printRunId: printRun?.id || null
    });
  } catch (err) {
    console.error('Error getting cards to receive:', err);
    res.status(500).json({ error: 'Failed to get cards to receive' });
  }
});

router.get('/', authenticate, crewOnly, (req, res) => {
  const { status, year, issue_type } = req.query;
  let sql = `SELECT i.* FROM issues i WHERE 1=1`;
  const params = [];

  if (status) { sql += ' AND i.status = ?'; params.push(status); }
  if (year) { sql += ' AND i.year = ?'; params.push(year); }
  if (issue_type) { sql += ' AND i.issue_type = ?'; params.push(issue_type); }
  // Sort by start_date DESC (newest first)
  sql += ' ORDER BY i.start_date DESC';

  try {
    const issues = dbWrapper.prepare(sql).all(...params);
    res.json(issues);
  } catch (err) { res.status(500).json({ error: 'Failed to get issues' }); }
});

router.get('/:id', authenticate, crewOnly, (req, res) => {
  const issue = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  const events = dbWrapper.prepare(`SELECT e.*, v.name as venue_name FROM events e LEFT JOIN venues v ON e.venue_id = v.id WHERE e.issue_id = ? ORDER BY e.sort_order ASC, e.event_date ASC`).all(req.params.id);

  // Get print runs for this issue
  const printRuns = dbWrapper.prepare('SELECT * FROM print_runs WHERE issue_id = ? ORDER BY created_at DESC').all(req.params.id);

  // Calculate inventory stats
  const printRunStats = dbWrapper.prepare(`
    SELECT
      COALESCE(SUM(quantity_ordered), 0) as total_ordered,
      COALESCE(SUM(quantity_received), 0) as total_printed
    FROM print_runs WHERE issue_id = ?
  `).get(req.params.id);

  const deliveryStats = dbWrapper.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total_delivered
    FROM deliveries WHERE issue_id = ?
  `).get(req.params.id);

  // Get request stats (demand signals)
  const requestStats = dbWrapper.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' THEN quantity ELSE 0 END), 0) as pending_requested,
      COALESCE(SUM(CASE WHEN status = 'fulfilled' THEN quantity ELSE 0 END), 0) as fulfilled_requested,
      COALESCE(SUM(quantity), 0) as total_requested
    FROM card_requests
    WHERE issue_id = ? AND status IN ('pending', 'fulfilled')
  `).get(req.params.id);

  const remaining = printRunStats.total_printed - deliveryStats.total_delivered;

  const inventory = {
    total_ordered: printRunStats.total_ordered,
    total_printed: printRunStats.total_printed,
    total_delivered: deliveryStats.total_delivered,
    remaining: remaining,
    // Demand signals
    total_requested: requestStats.total_requested,
    pending_requested: requestStats.pending_requested,
    fulfilled_requested: requestStats.fulfilled_requested,
    unfulfilled_demand: Math.max(0, requestStats.pending_requested - remaining)
  };

  // Add selected art data if present (for preview in Issue Builder)
  let front_art = null;
  if (issue.front_art_id) {
    const art = dbWrapper.prepare(`
      SELECT a.*, GROUP_CONCAT(af.file_path) as file_paths
      FROM art_submissions a
      LEFT JOIN art_files af ON af.art_submission_id = a.id
      WHERE a.id = ?
      GROUP BY a.id
    `).get(issue.front_art_id);
    if (art) {
      front_art = {
        ...art,
        files: art.file_paths ? art.file_paths.split(',') : []
      };
    }
  }

  res.json({ ...issue, events, print_runs: printRuns, inventory, front_art });
});

router.post('/', authenticate, crewOnly, (req, res) => {
  const { name, issue_type, start_date, end_date, month, year, notes, max_events } = req.body;

  // Validate required fields
  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'Name, start_date, and end_date are required' });
  }

  // Validate issue_type if provided
  const validTypes = ['monthly', 'biweekly', 'weekly', 'special'];
  if (issue_type && !validTypes.includes(issue_type)) {
    return res.status(400).json({ error: 'Invalid issue_type. Must be: monthly, biweekly, weekly, or special' });
  }

  // Validate date range
  if (new Date(end_date) < new Date(start_date)) {
    return res.status(400).json({ error: 'End date must be after start date' });
  }

  // Check for overlapping date ranges (warning only, allow creation)
  const overlap = dbWrapper.prepare(`
    SELECT id, name FROM issues
    WHERE (start_date <= ? AND end_date >= ?)
       OR (start_date <= ? AND end_date >= ?)
       OR (start_date >= ? AND end_date <= ?)
  `).get(end_date, start_date, start_date, end_date, start_date, end_date);

  try {
    const result = dbWrapper.prepare(`
      INSERT INTO issues (name, issue_type, start_date, end_date, month, year, notes, max_events)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      issue_type || 'monthly',
      start_date,
      end_date,
      month || null,
      year || null,
      notes || null,
      max_events !== undefined ? max_events : 10
    );

    const issue = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({
      ...issue,
      warning: overlap ? `Note: This issue overlaps with "${overlap.name}"` : undefined
    });
  } catch (err) {
    console.error('Error creating issue:', err);
    res.status(500).json({ error: 'Failed to create issue' });
  }
});

router.patch('/:id', authenticate, crewOnly, (req, res) => {
  const issue = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  const { name, issue_type, start_date, end_date, status, front_art_id, notes, print_deadline, sent_to_printer_at, max_events } = req.body;
  const setClauses = [], params = [];

  // Handle new flexible fields
  if (name !== undefined) {
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    setClauses.push('name = ?');
    params.push(name);
  }

  if (issue_type !== undefined) {
    const validTypes = ['monthly', 'biweekly', 'weekly', 'special'];
    if (!validTypes.includes(issue_type)) {
      return res.status(400).json({ error: 'Invalid issue_type' });
    }
    setClauses.push('issue_type = ?');
    params.push(issue_type);
  }

  if (start_date !== undefined) {
    setClauses.push('start_date = ?');
    params.push(start_date);
  }

  if (end_date !== undefined) {
    setClauses.push('end_date = ?');
    params.push(end_date);
  }

  if (status) {
    if (!['planning', 'finalized', 'printed', 'distributed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Validate status transitions
    const validTransitions = {
      'planning': ['finalized'],
      'finalized': ['printed', 'planning'], // Allow reverting to planning if needed
      'printed': ['distributed', 'finalized'],
      'distributed': ['printed']
    };

    if (status !== issue.status) {
      if (!validTransitions[issue.status]?.includes(status)) {
        return res.status(400).json({
          error: `Cannot transition from ${issue.status} to ${status}`
        });
      }

      // When transitioning to 'finalized', set content_locked_at
      if (status === 'finalized' && issue.status === 'planning') {
        setClauses.push('content_locked_at = CURRENT_TIMESTAMP');
      }

      // When transitioning to 'printed', validate that we have received cards
      if (status === 'printed') {
        const printRunStats = dbWrapper.prepare(`
          SELECT COALESCE(SUM(quantity_received), 0) as total_received
          FROM print_runs WHERE issue_id = ?
        `).get(req.params.id);

        if (printRunStats.total_received === 0) {
          return res.status(400).json({
            error: 'Cannot mark as printed: No print runs with received cards. Add a print run and mark it as received first.'
          });
        }

        setClauses.push('received_from_printer_at = CURRENT_TIMESTAMP');
      }

      // When transitioning to 'distributed', validate all cards have been delivered
      if (status === 'distributed') {
        const printRunStats = dbWrapper.prepare(`
          SELECT COALESCE(SUM(quantity_received), 0) as total_printed
          FROM print_runs WHERE issue_id = ?
        `).get(req.params.id);

        const deliveryStats = dbWrapper.prepare(`
          SELECT COALESCE(SUM(quantity), 0) as total_delivered
          FROM deliveries WHERE issue_id = ?
        `).get(req.params.id);

        const remaining = printRunStats.total_printed - deliveryStats.total_delivered;

        if (remaining > 0) {
          return res.status(400).json({
            error: `Cannot mark as distributed: ${remaining} cards still in inventory. Use the "Close Issue" action to write off remaining cards.`,
            inventory: {
              total_printed: printRunStats.total_printed,
              total_delivered: deliveryStats.total_delivered,
              remaining: remaining
            }
          });
        }
      }

      // When reverting to planning, clear content_locked_at
      if (status === 'planning') {
        setClauses.push('content_locked_at = NULL');
      }

      // When reverting to finalized from printed, clear received_from_printer_at
      if (status === 'finalized' && issue.status === 'printed') {
        setClauses.push('received_from_printer_at = NULL');
      }
    }

    setClauses.push('status = ?');
    params.push(status);
  }

  if (front_art_id !== undefined) {
    // First, unassign the previous art (if any)
    const currentIssue = dbWrapper.prepare('SELECT front_art_id FROM issues WHERE id = ?').get(req.params.id);
    if (currentIssue?.front_art_id && currentIssue.front_art_id !== front_art_id) {
      // Revert old art back to approved status
      dbWrapper.prepare('UPDATE art_submissions SET status = ?, issue_id = NULL WHERE id = ?')
        .run('approved', currentIssue.front_art_id);
    }

    setClauses.push('front_art_id = ?');
    params.push(front_art_id);

    // Clear ALL artworks pointing to this issue (defensive cleanup for data corruption)
    dbWrapper.prepare('UPDATE art_submissions SET status = ?, issue_id = NULL WHERE issue_id = ? AND id != ?')
      .run('approved', req.params.id, front_art_id || 0);

    // Mark new art as used (if not null)
    if (front_art_id) {
      dbWrapper.prepare('UPDATE art_submissions SET status = ?, issue_id = ? WHERE id = ?')
        .run('used', req.params.id, front_art_id);
    }
  }

  if (notes !== undefined) {
    setClauses.push('notes = ?');
    params.push(notes);
  }

  if (max_events !== undefined) {
    // Allow null for unlimited, or positive integers
    if (max_events !== null && (typeof max_events !== 'number' || max_events < 1)) {
      return res.status(400).json({ error: 'max_events must be a positive number or null' });
    }
    setClauses.push('max_events = ?');
    params.push(max_events);
  }

  if (print_deadline !== undefined) {
    setClauses.push('print_deadline = ?');
    params.push(print_deadline);
  }

  if (sent_to_printer_at !== undefined) {
    setClauses.push('sent_to_printer_at = ?');
    params.push(sent_to_printer_at);
  }

  if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  try {
    dbWrapper.prepare(`UPDATE issues SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    const updated = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('Error updating issue:', err);
    res.status(500).json({ error: 'Failed to update issue' });
  }
});

router.delete('/:id', authenticate, crewOnly, (req, res) => {
  const eventCount = dbWrapper.prepare('SELECT COUNT(*) as count FROM events WHERE issue_id = ?').get(req.params.id);
  if (eventCount.count > 0) return res.status(400).json({ error: 'Cannot delete issue with assigned events. Unassign events first.' });

  const result = dbWrapper.prepare('DELETE FROM issues WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Issue not found' });
  res.json({ message: 'Issue deleted' });
});

router.get('/art/submissions', authenticate, crewOnly, (req, res) => {
  const { status } = req.query;
  let sql = `SELECT a.*, i.name as issue_name
             FROM art_submissions a
             LEFT JOIN issues i ON a.issue_id = i.id`;
  const params = [];

  if (status) { sql += ' WHERE a.status = ?'; params.push(status); }
  sql += ' ORDER BY a.created_at DESC';

  try {
    const submissions = dbWrapper.prepare(sql).all(...params);
    const withFiles = submissions.map(s => {
      const files = dbWrapper.prepare('SELECT file_path FROM art_files WHERE art_submission_id = ?').all(s.id);
      return { ...s, files: files.map(f => f.file_path) };
    });
    res.json(withFiles);
  } catch (err) { res.status(500).json({ error: 'Failed to get art submissions' }); }
});

router.patch('/art/submissions/:id', authenticate, crewOnly, (req, res) => {
  const { status } = req.body;
  if (!['pending', 'approved', 'rejected', 'used'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    dbWrapper.prepare('UPDATE art_submissions SET status = ? WHERE id = ?').run(status, req.params.id);
    const submission = dbWrapper.prepare('SELECT * FROM art_submissions WHERE id = ?').get(req.params.id);
    const files = dbWrapper.prepare('SELECT file_path FROM art_files WHERE art_submission_id = ?').all(req.params.id);
    res.json({ ...submission, files: files.map(f => f.file_path) });
  } catch (err) { res.status(500).json({ error: 'Failed to update art submission' }); }
});

router.delete('/art/submissions/:id', authenticate, crewOnly, (req, res) => {
  const submission = dbWrapper.prepare('SELECT * FROM art_submissions WHERE id = ?').get(req.params.id);
  if (!submission) return res.status(404).json({ error: 'Submission not found' });

  // Don't allow deleting submissions that are in use
  if (submission.status === 'used') {
    return res.status(400).json({ error: 'Cannot delete artwork that is in use for an issue' });
  }

  try {
    // Get files to delete from disk
    const files = dbWrapper.prepare('SELECT file_path FROM art_files WHERE art_submission_id = ?').all(req.params.id);

    // Delete files from disk
    files.forEach(f => {
      const filePath = path.join(__dirname, '../uploads', f.file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      // Also delete PSD previews if they exist
      const previewPath = filePath.replace(/\.psd$/i, '_preview.png');
      if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
    });

    // Delete from DB (CASCADE handles art_files table)
    dbWrapper.prepare('DELETE FROM art_submissions WHERE id = ?').run(req.params.id);

    res.json({ message: 'Submission deleted' });
  } catch (err) {
    console.error('Error deleting art submission:', err);
    res.status(500).json({ error: 'Failed to delete art submission' });
  }
});

router.get('/:id/export', authenticate, crewOnly, (req, res) => {
  const issue = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  const events = dbWrapper.prepare(`SELECT e.*, v.name as venue_name FROM events e LEFT JOIN venues v ON e.venue_id = v.id WHERE e.issue_id = ? AND e.status = 'approved' ORDER BY e.sort_order ASC, e.event_date ASC`).all(req.params.id);

  const printData = {
    title: 'THE BETHL\'MITE',
    subtitle: 'An imperfect monthly postcard of live concerts & obscure happenings around Bethlehem and a bit beyond',
    name: issue.name,
    issue_type: issue.issue_type,
    start_date: issue.start_date,
    end_date: issue.end_date,
    // Legacy fields for backwards compatibility
    month: issue.month,
    year: issue.year,
    events: events.map(e => ({
      date: new Date(e.event_date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }),
      time: e.event_time || null,
      name: e.event_name || e.artists,
      artists: (e.event_name && e.event_name.trim()) ? e.artists : null, // Only show artists separately if there's an event name
      venue: e.venue_name || e.venue_name_raw,
      age: e.age_restriction === '21+' ? '21+' : null
    }))
  };

  res.json(printData);
});

// Activate an issue for card requests (crew only)
router.post('/:id/activate', authenticate, crewOnly, (req, res) => {
  const issueId = req.params.id;

  try {
    const issue = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    // Get current active issue (if any)
    const currentActive = dbWrapper.prepare('SELECT * FROM issues WHERE is_active_for_requests = 1').get();

    // Count unfulfilled requests for current active issue
    let pendingCount = 0;
    if (currentActive && currentActive.id !== parseInt(issueId)) {
      const pending = dbWrapper.prepare(`
        SELECT COUNT(*) as count FROM card_requests
        WHERE issue_id = ? AND status = 'pending'
      `).get(currentActive.id);
      pendingCount = pending.count;
    }

    // Return preview if ?preview=true
    if (req.query.preview === 'true') {
      return res.json({
        currentActive: currentActive ? {
          id: currentActive.id,
          name: currentActive.name,
          month: currentActive.month,
          year: currentActive.year
        } : null,
        pendingRequestsToExpire: pendingCount,
        newIssue: {
          id: issue.id,
          name: issue.name,
          month: issue.month,
          year: issue.year
        }
      });
    }

    // Deactivate current and expire its pending requests
    if (currentActive && currentActive.id !== parseInt(issueId)) {
      dbWrapper.prepare('UPDATE issues SET is_active_for_requests = 0 WHERE id = ?').run(currentActive.id);
      dbWrapper.prepare(`
        UPDATE card_requests SET status = 'expired'
        WHERE issue_id = ? AND status = 'pending'
      `).run(currentActive.id);
    }

    // Activate new issue
    dbWrapper.prepare('UPDATE issues SET is_active_for_requests = 1 WHERE id = ?').run(issueId);

    const updated = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    res.json({
      success: true,
      issue: updated,
      expiredRequests: pendingCount
    });
  } catch (err) {
    console.error('Error activating issue:', err);
    res.status(500).json({ error: 'Failed to activate issue' });
  }
});

// Deactivate an issue (close requests without activating another)
router.post('/:id/deactivate', authenticate, crewOnly, (req, res) => {
  const issueId = req.params.id;

  try {
    const issue = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    if (!issue.is_active_for_requests) {
      return res.status(400).json({ error: 'Issue is not currently active' });
    }

    // Count pending requests
    const pending = dbWrapper.prepare(`
      SELECT COUNT(*) as count FROM card_requests
      WHERE issue_id = ? AND status = 'pending'
    `).get(issueId);

    // Return preview if ?preview=true
    if (req.query.preview === 'true') {
      return res.json({
        issue: { id: issue.id, name: issue.name, month: issue.month, year: issue.year },
        pendingRequestsToExpire: pending.count
      });
    }

    // Deactivate and expire pending requests
    dbWrapper.prepare('UPDATE issues SET is_active_for_requests = 0 WHERE id = ?').run(issueId);
    dbWrapper.prepare(`
      UPDATE card_requests SET status = 'expired'
      WHERE issue_id = ? AND status = 'pending'
    `).run(issueId);

    const updated = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    res.json({
      success: true,
      issue: updated,
      expiredRequests: pending.count
    });
  } catch (err) {
    console.error('Error deactivating issue:', err);
    res.status(500).json({ error: 'Failed to deactivate issue' });
  }
});

// ========================
// PRINT RUNS ENDPOINTS
// ========================

// Get all print runs for an issue
router.get('/:id/print-runs', authenticate, crewOnly, (req, res) => {
  const issueId = req.params.id;

  try {
    const issue = dbWrapper.prepare('SELECT id FROM issues WHERE id = ?').get(issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const printRuns = dbWrapper.prepare(`
      SELECT * FROM print_runs WHERE issue_id = ? ORDER BY created_at DESC
    `).all(issueId);

    res.json(printRuns);
  } catch (err) {
    console.error('Error getting print runs:', err);
    res.status(500).json({ error: 'Failed to get print runs' });
  }
});

// Create a new print run
router.post('/:id/print-runs', authenticate, crewOnly, (req, res) => {
  const issueId = req.params.id;
  const { quantity_ordered, quantity_received, unit_cost, vendor, order_date, expected_date, received_date, notes } = req.body;

  if (!quantity_ordered || quantity_ordered <= 0) {
    return res.status(400).json({ error: 'quantity_ordered is required and must be positive' });
  }

  try {
    const issue = dbWrapper.prepare('SELECT id FROM issues WHERE id = ?').get(issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const result = dbWrapper.prepare(`
      INSERT INTO print_runs (issue_id, quantity_ordered, quantity_received, unit_cost, vendor, order_date, expected_date, received_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issueId,
      quantity_ordered,
      quantity_received || 0,
      unit_cost || null,
      vendor || null,
      order_date || null,
      expected_date || null,
      received_date || null,
      notes || null
    );

    const printRun = dbWrapper.prepare('SELECT * FROM print_runs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(printRun);
  } catch (err) {
    console.error('Error creating print run:', err);
    res.status(500).json({ error: 'Failed to create print run' });
  }
});

// Update a print run
router.patch('/:id/print-runs/:runId', authenticate, crewOnly, (req, res) => {
  const { id: issueId, runId } = req.params;
  const { quantity_ordered, quantity_received, quantity_received_add, unit_cost, vendor, order_date, expected_date, received_date, notes } = req.body;

  try {
    const printRun = dbWrapper.prepare('SELECT * FROM print_runs WHERE id = ? AND issue_id = ?').get(runId, issueId);
    if (!printRun) return res.status(404).json({ error: 'Print run not found' });

    const setClauses = [];
    const params = [];

    if (quantity_ordered !== undefined) { setClauses.push('quantity_ordered = ?'); params.push(quantity_ordered); }

    // quantity_received_add: ADDITIVE - for "Mark Received" (partial shipments)
    // quantity_received: REPLACE - for "Edit Print Run" (corrections)
    if (quantity_received_add !== undefined) {
      const newTotal = (printRun.quantity_received || 0) + quantity_received_add;

      // Validate: can't reduce below what's been delivered
      const deliveryStats = dbWrapper.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as total_delivered
        FROM deliveries WHERE issue_id = ?
      `).get(issueId);

      const totalPrinted = dbWrapper.prepare(`
        SELECT COALESCE(SUM(quantity_received), 0) as total
        FROM print_runs WHERE issue_id = ? AND id != ?
      `).get(issueId, runId);

      const newTotalPrinted = (totalPrinted.total || 0) + newTotal;
      if (newTotalPrinted < deliveryStats.total_delivered) {
        return res.status(400).json({
          error: `Cannot set received cards below delivered amount. ${deliveryStats.total_delivered} cards have been delivered.`
        });
      }

      setClauses.push('quantity_received = ?');
      params.push(newTotal);
    } else if (quantity_received !== undefined) {
      // Direct replacement (for edit form corrections)
      const deliveryStats = dbWrapper.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as total_delivered
        FROM deliveries WHERE issue_id = ?
      `).get(issueId);

      const totalPrinted = dbWrapper.prepare(`
        SELECT COALESCE(SUM(quantity_received), 0) as total
        FROM print_runs WHERE issue_id = ? AND id != ?
      `).get(issueId, runId);

      const newTotalPrinted = (totalPrinted.total || 0) + quantity_received;
      if (newTotalPrinted < deliveryStats.total_delivered) {
        return res.status(400).json({
          error: `Cannot set received cards below delivered amount. ${deliveryStats.total_delivered} cards have been delivered.`
        });
      }

      setClauses.push('quantity_received = ?');
      params.push(quantity_received);
    }
    if (unit_cost !== undefined) { setClauses.push('unit_cost = ?'); params.push(unit_cost); }
    if (vendor !== undefined) { setClauses.push('vendor = ?'); params.push(vendor); }
    if (order_date !== undefined) { setClauses.push('order_date = ?'); params.push(order_date); }
    if (expected_date !== undefined) { setClauses.push('expected_date = ?'); params.push(expected_date); }
    if (received_date !== undefined) { setClauses.push('received_date = ?'); params.push(received_date); }
    if (notes !== undefined) { setClauses.push('notes = ?'); params.push(notes); }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    params.push(runId);
    dbWrapper.prepare(`UPDATE print_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

    const updated = dbWrapper.prepare('SELECT * FROM print_runs WHERE id = ?').get(runId);
    res.json(updated);
  } catch (err) {
    console.error('Error updating print run:', err);
    res.status(500).json({ error: 'Failed to update print run' });
  }
});

// Delete a print run (only if no cards received)
router.delete('/:id/print-runs/:runId', authenticate, crewOnly, (req, res) => {
  const { id: issueId, runId } = req.params;

  try {
    const printRun = dbWrapper.prepare('SELECT * FROM print_runs WHERE id = ? AND issue_id = ?').get(runId, issueId);
    if (!printRun) return res.status(404).json({ error: 'Print run not found' });

    // Block deletion if cards were received
    if (printRun.quantity_received > 0) {
      return res.status(400).json({
        error: 'Cannot delete a print run with received cards. Edit it instead if you need to make changes.'
      });
    }

    dbWrapper.prepare('DELETE FROM print_runs WHERE id = ?').run(runId);
    res.json({ message: 'Print run deleted' });
  } catch (err) {
    console.error('Error deleting print run:', err);
    res.status(500).json({ error: 'Failed to delete print run' });
  }
});

// Get inventory summary for an issue
router.get('/:id/inventory', authenticate, crewOnly, (req, res) => {
  const issueId = req.params.id;

  try {
    const issue = dbWrapper.prepare('SELECT id, name, issue_type, start_date, end_date, month, year, status FROM issues WHERE id = ?').get(issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    // Sum of all received quantities from print runs
    const printRunStats = dbWrapper.prepare(`
      SELECT
        COALESCE(SUM(quantity_ordered), 0) as total_ordered,
        COALESCE(SUM(quantity_received), 0) as total_printed
      FROM print_runs WHERE issue_id = ?
    `).get(issueId);

    // Sum of all deliveries for this issue
    const deliveryStats = dbWrapper.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as total_delivered
      FROM deliveries WHERE issue_id = ?
    `).get(issueId);

    const totalPrinted = printRunStats.total_printed;
    const totalDelivered = deliveryStats.total_delivered;
    const remaining = totalPrinted - totalDelivered;

    res.json({
      issue_id: issue.id,
      name: issue.name,
      issue_type: issue.issue_type,
      start_date: issue.start_date,
      end_date: issue.end_date,
      month: issue.month,
      year: issue.year,
      status: issue.status,
      total_ordered: printRunStats.total_ordered,
      total_printed: totalPrinted,
      total_delivered: totalDelivered,
      remaining: remaining
    });
  } catch (err) {
    console.error('Error getting inventory:', err);
    res.status(500).json({ error: 'Failed to get inventory' });
  }
});

// Close an issue early (force transition to distributed with remaining inventory)
router.post('/:id/close', authenticate, crewOnly, (req, res) => {
  const issueId = req.params.id;
  const { force, write_off_reason } = req.body;

  try {
    const issue = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    // Must be in 'printed' status to close
    if (issue.status !== 'printed') {
      return res.status(400).json({
        error: `Cannot close issue: must be in "printed" status (currently "${issue.status}")`
      });
    }

    // Calculate inventory
    const printRunStats = dbWrapper.prepare(`
      SELECT COALESCE(SUM(quantity_received), 0) as total_printed
      FROM print_runs WHERE issue_id = ?
    `).get(issueId);

    const deliveryStats = dbWrapper.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as total_delivered
      FROM deliveries WHERE issue_id = ?
    `).get(issueId);

    const totalPrinted = printRunStats.total_printed;
    const totalDelivered = deliveryStats.total_delivered;
    const remaining = totalPrinted - totalDelivered;

    // If there's remaining inventory, require force flag
    if (remaining > 0 && !force) {
      return res.status(400).json({
        error: `Cannot close issue: ${remaining} cards still in inventory. Use force=true to write off remaining cards.`,
        inventory: {
          total_printed: totalPrinted,
          total_delivered: totalDelivered,
          remaining: remaining
        }
      });
    }

    // Close the issue - transition to distributed
    const setClauses = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params = ['distributed'];

    // Store write-off info in notes if provided
    if (remaining > 0 && write_off_reason) {
      const existingNotes = issue.notes || '';
      const writeOffNote = `[Closed early: ${remaining} cards written off - ${write_off_reason}]`;
      const newNotes = existingNotes ? `${existingNotes}\n${writeOffNote}` : writeOffNote;
      setClauses.push('notes = ?');
      params.push(newNotes);
    }

    // Also deactivate for requests if it was active
    if (issue.is_active_for_requests) {
      setClauses.push('is_active_for_requests = 0');
      // Expire any remaining pending requests
      dbWrapper.prepare(`
        UPDATE card_requests SET status = 'expired'
        WHERE issue_id = ? AND status = 'pending'
      `).run(issueId);
    }

    params.push(issueId);
    dbWrapper.prepare(`UPDATE issues SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

    const updated = dbWrapper.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    res.json({
      success: true,
      issue: updated,
      written_off: remaining,
      write_off_reason: write_off_reason || null
    });
  } catch (err) {
    console.error('Error closing issue:', err);
    res.status(500).json({ error: 'Failed to close issue' });
  }
});

module.exports = router;
