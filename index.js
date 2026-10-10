const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const skill = require('./src/skill');

const app = express();

// Alexa's adapter handles request-body parsing itself because signature
// verification must be performed against the original request body.
const adapter = new ExpressAdapter(skill, true, true);

app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'alexa-jeopardy',
    alexaEndpoint: '/alexa'
  });
});

app.post('/alexa', adapter.getRequestHandlers());

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
