// Express 4 does not forward rejected async handlers to error middleware.
const asyncRoute = handler => (req, res, next) =>
  Promise.resolve().then(() => handler(req, res, next)).catch(next);

function storageErrorHandler(err, req, res, next) {
  if (err.code !== 'ELOCKTIMEOUT' || res.headersSent) return next(err);
  res.setHeader('Retry-After', '1');
  res.status(503).json({ error: err.message });
}

module.exports = { asyncRoute, storageErrorHandler };
