const { createServer } = require('../server');

const requestHandler = createServer().listeners('request')[0];
const supportedEndpoints = new Set(['health', 'medicine-search', 'drug-info']);

module.exports = (req, res) => {
  const route = req.query?.path;
  const endpointFromQuery = Array.isArray(route) ? route.join('/') : route;
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const endpointFromUrl = pathname.startsWith('/api/')
    ? pathname.slice('/api/'.length)
    : '';
  const endpoint = endpointFromUrl || endpointFromQuery;
  if (!supportedEndpoints.has(endpoint)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API route not found.' }));
    return;
  }

  req.url = `/api/${endpoint}`;
  requestHandler(req, res);
};
