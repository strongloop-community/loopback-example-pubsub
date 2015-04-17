exports.createConnection = createConnection;

var duplex = require('duplex');
var debug = require('debug')('strong-pubsub-primus');
var Primus = require('Primus');
var util = require('util');

function createConnection(port, host, options) {
  debug('creating connection');

  var protocol = options.protocol || 'http';
  var host = host || 'localhost';
  var port = port || 3000;
  var url = util.format('%s://%s:%d', protocol, host, port);

  debug('configuring url', url);

  var transformer = options && options.primus && options.primus.transformer ||
      'engine.io';
  var Socket = Primus.createSocket({
    transformer: transformer,
    parser: 'binary'
  });
  var primus = new Socket(url);
  primus.open();

  var connection = duplex();
  primus.on('open', function() {
    debug('primus open event');
    connection.emit('connect');
  });
  primus.on('data', function(chunk) {
    debug('primus data event');
    // chunk is an arrayBuffer
    if (chunk && !Buffer.isBuffer(chunk)) {
      chunk = toBuffer(chunk);
    }
    connection._data(chunk);
  });
  connection.on('_data', function(chunk) {
    debug('connection _data event');
    // someone called connection.write(buf)
    primus.write(chunk);
  });
  connection.on('_end', function() {
    debug('connection _end event');
    primus.end();
    this._end();
  });

  return connection;
}

function toBuffer(ab) {
  var buffer = new Buffer(ab.byteLength);
  var view = new Uint8Array(ab);
  for(var i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i];
  }
  return buffer;
}
