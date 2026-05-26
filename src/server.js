const { start } = require('./api/server');

if (require.main === module) {
  start();
}

module.exports = {
  start,
};
