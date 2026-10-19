
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/mysql');

const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID
);

// Register with email and password
router.post('/signup', async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            error: 'All fields are required.'
        });
    }

    if (password.length < 8) {
        return res.status(400).json({
            error: 'Password must be at least 8 characters long.'
        });
    }

    try {
        const cleanUsername = username.trim();
        const cleanEmail = email.trim().toLowerCase();

        const [existing] = await pool.execute(
            'SELECT learner_id FROM learner WHERE email = ? OR username = ?',
            [cleanEmail, cleanUsername]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                error: 'That email or username is already registered.'
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const [result] = await pool.execute(
            `INSERT INTO learner (username, email, password_hash)
             VALUES (?, ?, ?)`,
            [cleanUsername, cleanEmail, passwordHash]
        );

        return res.status(201).json({
            message: 'Account created successfully.',
            learner: {
                learner_id: result.insertId,
                username: cleanUsername,
                email: cleanEmail
            }
        });
    } catch (error) {
        console.error('Signup error:', error);
        return res.status(500).json({
            error: 'Registration failed. Please try again.'
        });
    }
});

// Sign in with email and password
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email and password are required.'
        });
    }

    try {
        const [learners] = await pool.execute(
            `SELECT learner_id, username, email, password_hash
             FROM learner
             WHERE email = ?`,
            [email.trim().toLowerCase()]
        );

        if (learners.length === 0 || !learners[0].password_hash) {
            return res.status(401).json({
                error: 'Invalid email or password.'
            });
        }

        const learner = learners[0];
        const passwordMatches = await bcrypt.compare(
            password,
            learner.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                error: 'Invalid email or password.'
            });
        }

        return res.status(200).json({
            message: 'Login successful.',
            learner: {
                learner_id: learner.learner_id,
                username: learner.username,
                email: learner.email
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({
            error: 'Login failed. Please try again.'
        });
    }
});

// Sign in with Google
router.post('/google', async (req, res) => {
    const { credential } = req.body;

    if (!credential) {
        return res.status(400).json({
            error: 'Google credential is required.'
        });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
        console.error('GOOGLE_CLIENT_ID is missing.');
        return res.status(500).json({
            error: 'Google sign-in is not configured.'
        });
    }

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        if (
            !payload ||
            !payload.sub ||
            !payload.email ||
            payload.email_verified !== true
        ) {
            return res.status(401).json({
                error: 'Google account verification failed.'
            });
        }

        const googleId = payload.sub;
        const email = payload.email.trim().toLowerCase();

        // Return the learner if this Google account is already linked.
        const [linked] = await pool.execute(
            `SELECT learner_id, username, email
             FROM learner
             WHERE google_id = ?`,
            [googleId]
        );

        if (linked.length > 0) {
            return res.status(200).json({
                message: 'Google sign-in successful.',
                learner: linked[0]
            });
        }

        // Do not silently link an existing password account.
        const [existingEmail] = await pool.execute(
            `SELECT learner_id
             FROM learner
             WHERE email = ?`,
            [email]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({
                error:
                    'An account with this email already exists. Sign in with your password first; account linking must be completed separately.'
            });
        }

        // Create a unique username from the Google email.
        const baseUsername = (
            (payload.name || email.split('@')[0])
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, '')
                .slice(0, 80) || 'learner'
        );

        let username = baseUsername;
        let suffix = 1;

        while (true) {
            const [matches] = await pool.execute(
                'SELECT learner_id FROM learner WHERE username = ?',
                [username]
            );

            if (matches.length === 0) break;

            username = `${baseUsername}_${suffix++}`;
        }

        const [result] = await pool.execute(
            `INSERT INTO learner
                (username, email, password_hash, google_id)
             VALUES (?, ?, NULL, ?)`,
            [username, email, googleId]
        );

        return res.status(201).json({
            message: 'Google account registered successfully.',
            learner: {
                learner_id: result.insertId,
                username,
                email
            }
        });
    } catch (error) {
        console.error('Google sign-in error:', error);

        return res.status(401).json({
            error: 'Google sign-in failed. Please try again.'
        });
    }
});

module.exports = router;
