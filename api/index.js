'use strict';

const { handleRequest } = require('../lib/app');

module.exports = async function handler(req, res) {
  try {
    // Support both native req.url preservation and Vercel ?__path= rewrite forwarding
    if (req.url && req.url.startsWith('/api') && req.url.includes('__path=')) {
      const parsed = new URL(req.url, 'http://localhost');
      const forwardedPath = parsed.searchParams.get('__path');
      if (forwardedPath) {
        parsed.searchParams.delete('__path');
        const remainingQuery = parsed.searchParams.toString();
        req.url = forwardedPath + (remainingQuery ? `?${remainingQuery}` : '');
      }
    }

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
