const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { dbWrapper, saveDb, getDbDiagnostics } = require('../config/database');
const { authenticate, crewOnly } = require('../middleware/auth');

// Rate limiting for auth endpoints (prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 attempts per window (increased for testing)
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Email validation regex
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validateEmail = (email) => emailRegex.test(email);

// Password validation (min 8 chars, at least one number)
const validatePassword = (password) => password.length >= 8 && /\d/.test(password);

// ===== GOOGLE OAUTH =====

// Google Sign-In - verify token and login/start signup
router.post('/google', authLimiter, async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google credential required' });

  try {
    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email.toLowerCase();
    const name = payload.name || email.split('@')[0];

    // Check if user exists by google_id
    let user = dbWrapper.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);

    if (user) {
      // Existing Google user - log them in
      if (user.status === 'pending') return res.status(403).json({ error: 'Account pending approval' });
      if (user.status === 'inactive') return res.status(403).json({ error: 'Account deactivated' });

      dbWrapper.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
      const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, user: { id: user.id, email: user.email, name: user.name, type: user.type, google_id: user.google_id } });
    }

    // Check if user exists by email (link Google account)
    user = dbWrapper.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      // Link Google account to existing user
      dbWrapper.prepare('UPDATE users SET google_id = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?').run(googleId, user.id);

      if (user.status === 'pending') return res.status(403).json({ error: 'Account pending approval' });
      if (user.status === 'inactive') return res.status(403).json({ error: 'Account deactivated' });

      const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, user: { id: user.id, email: user.email, name: user.name, type: user.type, google_id: googleId } });
    }

    // New user - needs to select account type
    // Create a temporary token for the signup completion
    const tempToken = jwt.sign({ googleId, email, name }, process.env.JWT_SECRET, { expiresIn: '15m' });
    return res.json({ needsTypeSelection: true, tempToken, email, name });

  } catch (err) {
    console.error('Google auth error:', err);
    return res.status(401).json({ error: 'Invalid Google credential' });
  }
});

// Complete Google signup - user selects their account type
router.post('/google/complete-signup', (req, res) => {
  const { tempToken, type, pendingEventId } = req.body;
  if (!tempToken || !type) return res.status(400).json({ error: 'Token and account type required' });
  if (!['venue', 'distro', 'venue_distro'].includes(type)) return res.status(400).json({ error: 'Invalid account type' });

  try {
    // Verify the temp token
    const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    const { googleId, email, name } = decoded;

    // Double-check user doesn't already exist
    const existing = dbWrapper.prepare('SELECT id FROM users WHERE email = ? OR google_id = ?').get(email, googleId);
    if (existing) return res.status(400).json({ error: 'Account already exists. Please sign in.' });

    // Create the new user (no password, just Google)
    const result = dbWrapper.prepare(
      `INSERT INTO users (email, google_id, name, type, status) VALUES (?, ?, ?, ?, 'active')`
    ).run(email, googleId, name, type);

    const userId = result.lastInsertRowid;

    // Link pending event to new user if provided
    if (pendingEventId) {
      const event = dbWrapper.prepare('SELECT id FROM events WHERE id = ? AND submitted_by_user_id IS NULL').get(pendingEventId);
      if (event) {
        dbWrapper.prepare('UPDATE events SET submitted_by_user_id = ? WHERE id = ?').run(userId, pendingEventId);
        console.log(`Linked event ${pendingEventId} to new user ${userId}`);
      }
    }

    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'Account created',
      token,
      user: { id: userId, email, name, type, google_id: googleId }
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Signup session expired. Please sign in with Google again.' });
    }
    console.error('Google signup completion error:', err);
    return res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/signup', (req, res) => {
  const { email, password, name, type } = req.body;
  if (!email || !password || !name || !type) return res.status(400).json({ error: 'All fields required' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (!validatePassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters with at least one number' });
  if (!['venue', 'distro', 'venue_distro'].includes(type)) return res.status(400).json({ error: 'Invalid account type' });

  const existing = dbWrapper.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    const result = dbWrapper.prepare(`INSERT INTO users (email, password_hash, name, type, status) VALUES (?, ?, ?, ?, 'active')`).run(email.toLowerCase(), passwordHash, name, type);
    const userId = result.lastInsertRowid;
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Account created', token, user: { id: userId, email: email.toLowerCase(), name, type } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/signup/invite/:token', (req, res) => {
  const { token } = req.params;
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (!validatePassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters with at least one number' });

  const invite = dbWrapper.prepare(`SELECT * FROM invites WHERE token = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`).get(token);
  if (!invite) return res.status(400).json({ error: 'Invalid or expired invite' });

  const existing = dbWrapper.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    const result = dbWrapper.prepare(`INSERT INTO users (email, password_hash, name, type, status) VALUES (?, ?, ?, ?, 'active')`).run(email.toLowerCase(), passwordHash, name, invite.type);
    const userId = result.lastInsertRowid;

    if (invite.venue_id) dbWrapper.prepare('UPDATE venues SET contact_user_id = ? WHERE id = ?').run(userId, invite.venue_id);
    if (invite.distro_point_id) dbWrapper.prepare('UPDATE distro_points SET contact_user_id = ? WHERE id = ?').run(userId, invite.distro_point_id);
    dbWrapper.prepare('UPDATE invites SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(invite.id);

    const jwtToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Account created', token: jwtToken, user: { id: userId, email: email.toLowerCase(), name, type: invite.type } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.get('/me', authenticate, (req, res) => {
  const { id, email, name, type, status, google_id } = req.user;
  res.json({ user: { id, email, name, type, status, google_id } });
});

router.get('/pending', authenticate, crewOnly, (req, res) => {
  const pending = dbWrapper.prepare(`SELECT id, email, name, type, created_at FROM users WHERE status = 'pending' ORDER BY created_at DESC`).all();
  res.json(pending);
});

router.post('/approve/:id', authenticate, crewOnly, (req, res) => {
  const result = dbWrapper.prepare(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found or already processed' });
  res.json({ message: 'User approved' });
});

router.post('/reject/:id', authenticate, crewOnly, (req, res) => {
  // Soft-delete: mark as rejected instead of hard delete (preserves data for review)
  const result = dbWrapper.prepare(`UPDATE users SET status = 'rejected' WHERE id = ? AND status = 'pending'`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found or already processed' });
  res.json({ message: 'User rejected' });
});

// ===== CREW USER MANAGEMENT =====

// List all users (excludes soft-deleted)
router.get('/users', authenticate, crewOnly, (req, res) => {
  const users = dbWrapper.prepare(`
    SELECT
      u.id, u.email, u.name, u.phone, u.type, u.status, u.google_id, u.created_at, u.last_login,
      v.id as linked_venue_id, v.name as linked_venue_name,
      dp.id as linked_distro_id, dp.name as linked_distro_name
    FROM users u
    LEFT JOIN venues v ON v.contact_user_id = u.id AND v.deleted_at IS NULL
    LEFT JOIN distro_points dp ON dp.contact_user_id = u.id AND dp.deleted_at IS NULL
    WHERE u.deleted_at IS NULL
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// Create new user (crew can create any type)
router.post('/users', authenticate, crewOnly, (req, res) => {
  const { email, password, name, type } = req.body;
  if (!email || !password || !name || !type) return res.status(400).json({ error: 'All fields required' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (!validatePassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters with at least one number' });
  if (!['crew', 'venue', 'distro', 'venue_distro'].includes(type)) return res.status(400).json({ error: 'Invalid account type' });

  const existing = dbWrapper.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    const result = dbWrapper.prepare(`INSERT INTO users (email, password_hash, name, type, status) VALUES (?, ?, ?, ?, 'active')`).run(email.toLowerCase(), passwordHash, name, type);
    res.status(201).json({ message: 'User created', userId: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Edit user (name, email, phone, type, status)
router.patch('/users/:id', authenticate, crewOnly, (req, res) => {
  const { name, email, phone, type, status } = req.body;
  const userId = req.params.id;

  const user = dbWrapper.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Can't deactivate yourself
  if (req.user.id == userId && status === 'inactive') {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }

  const updates = [];
  const values = [];

  if (name) { updates.push('name = ?'); values.push(name); }
  if (email) {
    if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
    const existing = dbWrapper.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.toLowerCase(), userId);
    if (existing) return res.status(400).json({ error: 'Email already in use' });
    updates.push('email = ?'); values.push(email.toLowerCase());
  }
  if (phone !== undefined) { updates.push('phone = ?'); values.push(phone || null); }
  if (type && ['crew', 'venue', 'distro', 'venue_distro'].includes(type)) {
    updates.push('type = ?'); values.push(type);
  }
  if (status && ['pending', 'active', 'inactive'].includes(status)) {
    updates.push('status = ?'); values.push(status);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid updates provided' });

  values.push(userId);
  dbWrapper.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ message: 'User updated' });
});

// Reset user password
router.post('/users/:id/reset-password', authenticate, crewOnly, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!validatePassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters with at least one number' });

  const user = dbWrapper.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const passwordHash = bcrypt.hashSync(password, 10);
  dbWrapper.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, req.params.id);
  res.json({ message: 'Password reset' });
});

// Delete user (soft-delete)
router.delete('/users/:id', authenticate, crewOnly, (req, res) => {
  const userId = req.params.id;

  // Can't delete yourself
  if (req.user.id == userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  // Soft-delete: set deleted_at timestamp instead of hard delete
  const result = dbWrapper.prepare('UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL').run(userId);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ message: 'User deleted' });
});

// ===== CREW ACCESS REQUESTS =====

// Submit crew access request (requires Google auth - validates credential)
router.post('/crew-request', authLimiter, async (req, res) => {
  const { credential, name, reason } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google sign-in required' });
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

  try {
    // Verify Google credential
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email.toLowerCase();

    // Check if user already exists
    const existingUser = dbWrapper.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').get(googleId, email);
    if (existingUser) {
      return res.status(400).json({ error: 'You already have an account. Please sign in.' });
    }

    // Check for existing pending request
    const existingRequest = dbWrapper.prepare(
      `SELECT * FROM crew_requests WHERE (google_id = ? OR email = ?) AND status = 'pending'`
    ).get(googleId, email);
    if (existingRequest) {
      return res.status(400).json({ error: 'You already have a pending request.' });
    }

    // Create the request
    const result = dbWrapper.prepare(
      `INSERT INTO crew_requests (email, google_id, name, reason) VALUES (?, ?, ?, ?)`
    ).run(email, googleId, name.trim(), reason?.trim() || null);

    res.status(201).json({
      message: 'Request submitted! The crew will review it and get back to you.',
      requestId: result.lastInsertRowid
    });
  } catch (err) {
    console.error('Crew request error:', err);
    return res.status(401).json({ error: 'Authentication failed' });
  }
});

// List crew requests (crew only)
router.get('/crew-requests', authenticate, crewOnly, (req, res) => {
  const requests = dbWrapper.prepare(`
    SELECT cr.*, u.name as reviewed_by_name
    FROM crew_requests cr
    LEFT JOIN users u ON cr.reviewed_by_user_id = u.id
    ORDER BY
      CASE cr.status WHEN 'pending' THEN 0 ELSE 1 END,
      cr.created_at DESC
  `).all();
  res.json(requests);
});

// Get pending crew requests count
router.get('/crew-requests/pending-count', authenticate, crewOnly, (req, res) => {
  const result = dbWrapper.prepare(`SELECT COUNT(*) as count FROM crew_requests WHERE status = 'pending'`).get();
  res.json({ count: result.count });
});

// Approve crew request
router.post('/crew-requests/:id/approve', authenticate, crewOnly, (req, res) => {
  const request = dbWrapper.prepare('SELECT * FROM crew_requests WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!request) return res.status(404).json({ error: 'Request not found or already processed' });

  // Check if user already exists (edge case - someone signed up in the meantime)
  const existingUser = dbWrapper.prepare('SELECT id FROM users WHERE google_id = ? OR email = ?').get(request.google_id, request.email);
  if (existingUser) {
    dbWrapper.prepare(`UPDATE crew_requests SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by_user_id = ? WHERE id = ?`)
      .run(req.user.id, req.params.id);
    return res.status(400).json({ error: 'User already exists. Request has been closed.' });
  }

  // Create the crew user
  const userResult = dbWrapper.prepare(
    `INSERT INTO users (email, google_id, name, type, status) VALUES (?, ?, ?, 'crew', 'active')`
  ).run(request.email, request.google_id, request.name);

  // Update request status
  dbWrapper.prepare(
    `UPDATE crew_requests SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP, reviewed_by_user_id = ? WHERE id = ?`
  ).run(req.user.id, req.params.id);

  res.json({ message: 'Request approved. User has been granted crew access.', userId: userResult.lastInsertRowid });
});

// Reject crew request
router.post('/crew-requests/:id/reject', authenticate, crewOnly, (req, res) => {
  const result = dbWrapper.prepare(
    `UPDATE crew_requests SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by_user_id = ? WHERE id = ? AND status = 'pending'`
  ).run(req.user.id, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Request not found or already processed' });
  res.json({ message: 'Request rejected' });
});

// ===== DATABASE HEALTH DIAGNOSTIC =====
// Compares in-memory DB state with what db.export() produces
router.get('/db-health', authenticate, crewOnly, async (req, res) => {
  try {
    const diag = await getDbDiagnostics();
    res.json(diag);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force save and return result
router.post('/save-db', authenticate, crewOnly, (req, res) => {
  try {
    const result = saveDb();
    res.json({ message: 'Save triggered', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;