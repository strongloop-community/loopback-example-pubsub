var Primus = require('primus');
var Client = require('strong-pubsub');
var Connection = require('strong-pubsub-connection-mqtt');
var PubSubProxy = require('strong-pubsub-proxy');
var Adapter = require('strong-pubsub-mqtt');
var MOSQUITTO_PORT = process.env.MOSQUITTO_PORT || 1883;

module.exports = function(app) {
  app.on('started', function(server) {
    var primus = new Primus(server, {
      transformer: 'engine.io',
      parser: 'binary'
    });

    primus.on('connection', function(spark) {
      var client = new Client({port: MOSQUITTO_PORT}, Adapter);
      var proxy = new PubSubProxy(
        new Connection(spark),
        client
      );
      proxy.connect();
    });
  });

  var testClient = new Client({port: MOSQUITTO_PORT}, Adapter);

  setInterval(function() {
    testClient.publish('/my-topic', 'hello');
  }, 1000);
};
