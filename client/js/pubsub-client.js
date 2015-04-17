var Client = require('strong-pubsub');
var Adapter = require('strong-pubsub-mqtt');
var duplex = require('duplex');

Primus.Stream = require('stream');

module.exports = function(PORT) {

  var client = new Client({port: PORT, host: 'localhost'}, Adapter, {
    createConnection: function(port, host) {
      var connection = duplex();

      var primus = Primus.connect('http://localhost:3000', {
        transformer: 'engine.io',
        parser: 'binary'
      });

      connection.on('_data', function(chunk) {
        // someone called `connection.write(buf)`
        primus.write(chunk);
      });

      primus.on('data', function(chunk) {
        if (chunk && !Buffer.isBuffer(chunk)) {
          // chunk is an arrayBuffer
          connection._data(toBuffer(chunk));
        }
      });

      primus.on('open', function() {
        connection.emit('connect');
      });

      connection.on('_end', function() {
        primus.end();
        this._end();
      });

      return connection;
    }
  });

  return client;
}


function toBuffer(ab) {
  var buffer = new Buffer(ab.byteLength);
  var view = new Uint8Array(ab);
  for(var i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i];
  }
  return buffer;
}
