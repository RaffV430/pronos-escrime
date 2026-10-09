const express = require('express');
const { rateLimit } = require('express-rate-limit');
const auth = require('../middleware/auth');
const prisma = require('../lib/prisma');
const { sendMail } = require('../services/mailer');
const { supportMessage } = require('../services/supportMessage');
const router = express.Router();
router.post(
  '/',
  auth,
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.userId),
    message: { error: 'Limite atteinte : réessayez dans une heure.' },
  }),
  async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { email: true, name: true },
      });
      if (!user) return res.status(401).json({ error: 'Compte introuvable.' });
      await sendMail(supportMessage(req.body, user));
      res.json({ sent: true });
    } catch (error) {
      next(error);
    }
  },
);
module.exports = router;
