const { EpicClient } = require('./epicClient');

function createEpicClientMiddleware(config) {
  const client = new EpicClient(config);

  return function epicClientMiddleware(req, _res, next) {
    req.epic = client;
    next();
  };
}

module.exports = {
  createEpicClientMiddleware,
};
