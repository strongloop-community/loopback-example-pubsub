var loopback = require('loopback');
var boot = require('loopback-boot');

var app = module.exports = loopback();

// Bootstrap the application, configure models, datasources and middleware.
// Sub-apps like REST API are mounted via boot scripts.
boot(app, __dirname);

app.use(loopback.static(require('path').join(__dirname, '..', 'client')));

app.start = function() {
  // start the web server
  var server = app.listen(function() {
    app.emit('started', server);
    console.log('Web server listening at: %s', app.get('url'));
  });
  return server;
};

// start the server if `$ node server.js`
if (require.main === module) {
  app.start();
}
