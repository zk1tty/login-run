function installErrorHandler(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode =
      Number.isInteger(error.statusCode) && error.statusCode >= 400
        ? error.statusCode
        : 500;

    request.log.error({ err: error }, 'request failed');

    reply.code(statusCode).send({
      status: 'error',
      message: statusCode >= 500 ? 'Internal Server Error' : error.message,
    });
  });
}

module.exports = {
  installErrorHandler,
};
