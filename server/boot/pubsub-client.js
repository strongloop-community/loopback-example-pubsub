var path = require('path');
var browserify = require('browserify');

module.exports = function(app) {
  app.get('/pubsub-client.js', function(req, res) {
    var b = browserify({
      basedir: __dirname,
      debug: true
    });

    b.require('stream');
    b.require('url');
    b.require('util');
    b.require('buffer');

    b.require(path.join(__dirname, '..', '..',
      'client', 'js', 'pubsub-client.js'), {expose: 'pubsub-client'});

    b.bundle().pipe(res);
  });
}
