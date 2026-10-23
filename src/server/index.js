const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { createRouter } = require('./bit-api');
const dashboard = require('./dashboard-api');
const metricsRoute = require('./metrics-route');
const { API_HOST, API_PORT } = require('../config');
const vnc = require('../browser/vnc');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(metricsRoute);
  app.use(dashboard);
  app.use(createRouter());

  const uiRoot = path.join(__dirname, '../../ui');
  const novncRoot = path.join(__dirname, '../../node_modules/@novnc/novnc');
  if (fs.existsSync(novncRoot)) {
    app.use('/vendor/novnc', express.static(novncRoot, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        }
      },
    }));
  }

  app.use('/ui', express.static(uiRoot));
  app.get('/', (req, res) => {
    res.sendFile(path.join(uiRoot, 'index.html'));
  });
  app.get('/vnc.html', (req, res) => {
    res.sendFile(path.join(uiRoot, 'vnc.html'));
  });
  app.use(express.static(uiRoot));

  return app;
}

function startServer(port = API_PORT, host = API_HOST) {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      vnc.attachToHttpServer(server);
      resolve({ app, server, url: `http://${host}:${port}` });
    });
  });
}

module.exports = { createApp, startServer };
