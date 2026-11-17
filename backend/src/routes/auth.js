
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/mysql');

// Generate a JWT for an authenticated learner.
function generateToken(learnerId) {
    return jwt.sign(
        { learnerId },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRES_IN || '1d'
        }
    );
}

// Format names supplied by Google.
function formatName(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID
);

// Register using email and password.
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
        const cleanUsername = username.trim().replace(/\s+/g, ' ');
        const cleanEmail = email.trim().toLowerCase();

        if (!cleanUsername) {
            return res.status(400).json({
                error: 'Username is required.'
            });
        }

        const [existing] = await pool.execute(
            `SELECT learner_id
             FROM learner
             WHERE email = ? OR username = ?`,
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

        const learner = {
            learner_id: result.insertId,
            username: cleanUsername,
            email: cleanEmail,
            role: 'student'
        };

        const token = generateToken(learner.learner_id);

        return res.status(201).json({
            message: 'Account created successfully.',
            token,
            learner
        });

    } catch (error) {
        console.error('Signup error:', error);

        return res.status(500).json({
            error: 'Registration failed. Please try again.'
        });
    }
});

// Log in using email and password.
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email and password are required.'
        });
    }

    try {
        const [learners] = await pool.execute(
            `SELECT learner_id, username, email, password_hash, role
             FROM learner
             WHERE email = ?`,
            [email.trim().toLowerCase()]
        );

        if (
            learners.length === 0 ||
            !learners[0].password_hash
        ) {
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

        const learnerData = {
            learner_id: learner.learner_id,
            username: learner.username,
            email: learner.email,
            role: learner.role
        };

        const token = generateToken(learner.learner_id);

        return res.status(200).json({
            message: 'Login successful.',
            token,
            learner: learnerData
        });

    } catch (error) {
        console.error('Login error:', error);

        return res.status(500).json({
            error: 'Login failed. Please try again.'
        });
    }
});

// Sign in or register with Google.
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
        // Verify the Google ID token.
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

        const googleName = formatName(
            payload.name || email.split('@')[0] || 'Learner'
        );

        // Check whether this Google account is already linked.
        const [linked] = await pool.execute(
            `SELECT learner_id, username, email, role
             FROM learner
             WHERE google_id = ?`,
            [googleId]
        );

        if (linked.length > 0) {
            const learner = linked[0];

            // Update the username if Google supplies a profile name.
            if (payload.name && payload.name.trim()) {
                const [nameMatches] = await pool.execute(
                    `SELECT learner_id
                     FROM learner
                     WHERE username = ?
                       AND learner_id <> ?`,
                    [googleName, learner.learner_id]
                );

                if (nameMatches.length === 0) {
                    await pool.execute(
                        `UPDATE learner
                         SET username = ?
                         WHERE learner_id = ?`,
                        [googleName, learner.learner_id]
                    );

                    learner.username = googleName;
                }
            }

            const learnerData = {
                learner_id: learner.learner_id,
                username: learner.username,
                email: learner.email,
                role: learner.role
            };

            const token = generateToken(learner.learner_id);

            return res.status(200).json({
                message: 'Google sign-in successful.',
                token,
                learner: learnerData
            });
        }

        // Prevent automatic linking to an existing password account.
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

        // Generate a unique username based on Google's profile name.
        const baseUsername = (
            googleName
                .replace(/[^a-zA-Z0-9_ ]/g, '')
                .slice(0, 80)
                .trim() || 'Learner'
        );

        let username = baseUsername;
        let suffix = 1;

        while (true) {
            const [matches] = await pool.execute(
                `SELECT learner_id
                 FROM learner
                 WHERE username = ?`,
                [username]
            );

            if (matches.length === 0) {
                break;
            }

            const suffixText = `_${suffix++}`;

            username =
                baseUsername.slice(0, 80 - suffixText.length) +
                suffixText;
        }

        // Create the new Google learner.
        const [result] = await pool.execute(
            `INSERT INTO learner
                (username, email, password_hash, google_id)
             VALUES (?, ?, NULL, ?)`,
            [username, email, googleId]
        );

        const learnerData = {
            learner_id: result.insertId,
            username,
            email,
            role: 'student'
        };

        const token = generateToken(result.insertId);

        return res.status(201).json({
            message: 'Google account registered successfully.',
            token,
            learner: learnerData
        });

    } catch (error) {
        console.error('Google sign-in error:', error);

        return res.status(500).json({
            error: 'Google sign-in failed. Please try again.'
        });
    }
});


const authenticateToken = require('../middleware/authenticateToken');

// Get the currently authenticated learner.
router.get('/me', authenticateToken, (req, res) => {
    return res.status(200).json({
        success: true,
        learner: req.user
    });
});

module.exports = router;
