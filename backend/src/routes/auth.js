const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/mysql');

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
        const [existing] = await pool.execute(
            'SELECT learner_id FROM learner WHERE email = ? OR username = ?',
            [email.trim().toLowerCase(), username.trim()]
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
            [
                username.trim(),
                email.trim().toLowerCase(),
                passwordHash
            ]
        );

        return res.status(201).json({
            message: 'Account created successfully.',
            learner: {
                learner_id: result.insertId,
                username: username.trim(),
                email: email.trim().toLowerCase()
            }
        });

    } catch (error) {
        console.error('Signup error:', error);

        return res.status(500).json({
            error: 'Registration failed. Please try again.'
        });
    }
});

// Sign in an existing learner
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

        if (learners.length === 0) {
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

module.exports = router;