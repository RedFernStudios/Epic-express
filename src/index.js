const { EpicClient, EpicApiError } = require('./epicClient');
const { createEpicClientMiddleware } = require('./middleware');

module.exports = {
  EpicClient,
  EpicApiError,
  createEpicClientMiddleware,
};
