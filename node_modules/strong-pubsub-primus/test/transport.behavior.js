var PrimusTransport = require('../');
var Client = require('strong-pubsub');
var Adapter = require('strong-pubsub-mqtt');
var Connection = require('strong-pubsub-connection-mqtt');
var helper = require('strong-pubsub-test');
var Primus = require('primus');

describe('primus transport end to end behavior', function () {
  beforeEach(function setUpServer(done) {
    var test = this;
    helper.getFreePort(function(port) {
      test.port = port;
      var httpServer = require('http').createServer();
      httpServer.listen(port, done);
      var options = {
        transformer: 'engine.io',
        parser: 'binary'
      };
      var primus = test.primus = new Primus(httpServer, options);
    });
  });

  beforeEach(function setUpClient(done) {
    var test = this;
    var client = new Client({
      host: 'localhost',
      port: this.port
    }, Adapter, PrimusTransport);
    var message = test.message = 'my message';
    var topic = test.topic = 'my topic';

    client.publish(topic, new Buffer(message));
    this.primus.on('connection', function(conn) {
      var mqttConn = new Connection(conn);
      mqttConn.on('connect', function(connectPacket) {
        mqttConn.ack('connect', connectPacket);
      });
      mqttConn.on('publish', function(publishPacket) {
        test.received = publishPacket;
        done();
      });
    });
  });

  it('should send the correct packet', function() {
    expect(this.received.message.toString()).to.equal(this.message);
    expect(this.received.topic.toString()).to.equal(this.topic);
  });
});
