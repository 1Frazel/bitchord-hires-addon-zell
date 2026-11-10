'use strict';

const { handleRequest } = require('../lib/app');

module.exports = async function handler(req, res) {
  try {
    const handled = await handleRequest(req, res);
    if (handled === false && !res.writableEnded) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Route not found' }));
    }
  } catch (err) {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
    }
  }
};

// Disable Vercel's default body parser so raw binary uploads (/api/admin/upload-proxy) work cleanly
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
