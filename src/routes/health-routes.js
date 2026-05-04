function healthRoutes(fastify, _options, done) {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      service: 'live-alias',
    };
  });

  done();
}

module.exports = healthRoutes;
