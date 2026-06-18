require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/workers', require('./routes/workers'));
app.use('/admin', require('./routes/admin'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/verification', require('./routes/verification'));

app.get('/', (req, res) => {
  res.json({ status: 'BeyondX API is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BeyondX server running on port ${PORT}`);
});