const express = require('express');
const cors = require('cors');
require('dotenv').config();

// 1. Imports des routes
const authRoutes = require('./routes/authRoutes');
const matchRoutes = require('./routes/matchRoutes');
const userRoutes = require('./routes/userRoutes'); // 👈 Placé ici avec les autres imports

const app = express();
const PORT = process.env.PORT || 5000;

// 2. Middlewares globaux
app.use(cors());
app.use(express.json());

// 3. Déclaration des routes API
app.use('/api/auth', authRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/users', userRoutes); // 👈 Placé ici avec les autres routes

// Route de test de santé
app.get('/', (req, res) => {
  res.json({ message: '🤺 API MPP Escrime opérationnelle !' });
});

// 4. Lancement du serveur (TOUJOURS À LA FIN)
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});