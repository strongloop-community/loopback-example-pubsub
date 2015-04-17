(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.PrimusTransport = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

var util = require('util');

/**
 * Generic Primus error.
 *
 * @constructor
 * @param {String} message The reason for the error
 * @param {EventEmitter} logger Optional EventEmitter to emit a `log` event on.
 * @api public
 */
function PrimusError(message, logger) {
  Error.call(this);
  Error.captureStackTrace(this, this.constructor);

  this.message = message;
  this.name = this.constructor.name;

  if (logger) {
    logger.emit('log', 'error', this);
  }
}

util.inherits(PrimusError, Error);

/**
 * There was an error while parsing incoming or outgoing data.
 *
 * @param {String} message The reason for the error.
 * @param {Spark} spark The spark that caused the error.
 * @api public
 */
function ParserError(message, spark) {
  Error.call(this);
  Error.captureStackTrace(this, this.constructor);

  this.message = message;
  this.name = this.constructor.name;

  if (spark) {
    if (spark.listeners('error').length) spark.emit('error', this);
    spark.primus.emit('log', 'error', this);
  }
}

util.inherits(ParserError, Error);

//
// Expose our custom events.
//
exports.PrimusError = PrimusError;
exports.ParserError = ParserError;

},{"util":82}],2:[function(require,module,exports){
(function (process,__dirname){
'use strict';

var PrimusError = require('./errors').PrimusError
  , EventEmitter = require('eventemitter3')
  , Transformer = require('./transformer')
  , log = require('diagnostics')('primus')
  , Spark = require('./spark')
  , fuse = require('fusing')
  , fs = require('fs');

/**
 * Primus is a universal wrapper for real-time frameworks that provides a common
 * interface for server and client interaction.
 *
 * @constructor
 * @param {HTTP.Server} server HTTP or HTTPS server instance.
 * @param {Object} options Configuration
 * @api public
 */
function Primus(server, options) {
  if (!(this instanceof Primus)) return new Primus(server, options);
  if ('object' !== typeof server) {
    var message = 'The first argument of the constructor must be ' +
      'an HTTP or HTTPS server instance';
    throw new PrimusError(message, this);
  }

  options = options || {};
  this.fuse();

  var primus = this
    , key;

  this.auth = options.authorization || null;  // Do we have an authorization handler.
  this.connections = Object.create(null);     // Connection storage.
  this.ark = Object.create(null);             // Plugin storage.
  this.layers = [];                           // Middleware layers.
  this.transformer = null;                    // Reference to the real-time engine instance.
  this.encoder = null;                        // Shorthand to the parser's encoder.
  this.decoder = null;                        // Shorthand to the parser's decoder.
  this.connected = 0;                         // Connection counter.
  this.sparks = 0;                            // Increment id for connection ids.
  this.timeout = 'timeout' in options         // The timeout used to detect zombie sparks.
    ? options.timeout
    : 35000;
  this.whitelist = [];                        // Forwarded-for white listing.
  this.options = options;                     // The configuration.
  this.transformers = {                       // Message transformers.
    outgoing: [],
    incoming: []
  };

  this.server = server;
  this.pathname = 'string' === typeof options.pathname
    ? options.pathname.charAt(0) !== '/'
      ? '/'+ options.pathname
      : options.pathname
    : '/primus';

  //
  // Create a specification file with the information that people might need to
  // connect to the server.
  //
  this.spec = {
    version: this.version,
    pathname: this.pathname,
    timeout: this.timeout
  };

  //
  // Create a pre-bound Spark constructor. Doing a Spark.bind(Spark, this) doesn't
  // work as we cannot extend the constructor of it anymore. The added benefit of
  // approach listed below is that the prototype extensions are only applied to
  // the Spark of this Primus instance.
  //
  this.Spark = function Sparky(headers, address, query, id, request) {
    Spark.call(this, primus, headers, address, query, id, request);
  };

  this.Spark.prototype = Object.create(Spark.prototype, {
    constructor: {
      value: this.Spark,
      writable: true,
      enumerable: false,
      configurable: true
    }
  });

  //
  // Copy over the original Spark static properties and methods so readable and
  // writable can also be used.
  //
  for (key in Spark) {
    this.Spark[key] = Spark[key];
  }

  this.parsers(options.parser);
  this.initialise(options.transformer || options.transport, options);

  //
  // If the plugins are supplied through the options, also initialise them. This
  // allows us to do `primus.createSocket({})` to also use plugins.
  //
  if ('string' === typeof options.plugin) {
    options.plugin.split(/[\s|,]+/).forEach(function register(name) {
      primus.use(name, name);
    });

    return;
  }

  if ('object' === typeof options.plugin) {
    for (key in options.plugin) {
      this.use(key, options.plugin[key]);
    }
  }

  //
  // - Cluster node 0.10 lets the Operating System decide to which worker a request
  //   goes. This can result in a not even distribution where some workers are
  //   used at 10% while others at 90%. In addition to that the load balancing
  //   isn't sticky.
  //
  // - Cluster node 0.12 implements a custom round robin algorithm. This solves the
  //   not even distribution of work but it does not address our sticky session
  //   requirement.
  //
  // Projects like `sticky-session` attempt to implement sticky sessions but they
  // are using `net` server instead of a HTTP server in combination with the
  // remoteAddress of the connection to load balance. This does not work when you
  // address your servers behind a load balancer as the IP is set to the load
  // balancer, not the connecting clients. All in all, it only causes more
  // scalability problems. So we've opted-in to warn users about the
  // risks of using Primus in a cluster.
  //
  if (!options.iknowclusterwillbreakconnections && require('cluster').isWorker) [
    '',
    'The `cluster` module does not implement sticky sessions. Learn more about',
    'this issue at:',
    '',
    'http://github.com/primus/primus#can-i-use-cluster',
    '',
  ].forEach(function warn(line) {
    console.error('Primus: '+ line);
  });
}

//
// Fuse and spice-up the Primus prototype with EventEmitter and predefine
// awesomeness.
//
fuse(Primus, EventEmitter);

//
// Lazy read the primus.js JavaScript client.
//
Object.defineProperty(Primus.prototype, 'client', {
  get: function read() {
    if (!read.primus) {
      read.primus = fs.readFileSync(__dirname + '/primus.js', 'utf-8');
    }

    return this.customGlobal(read.primus);
  }
});

//
// Lazy compile the primus.js JavaScript client for Node.js
//
Object.defineProperty(Primus.prototype, 'Socket', {
  get: function () {
    return require('load').compiler(this.library(true), 'primus.js', {
      __filename: 'primus.js',
      __dirname: process.cwd()
    }).Primus;
  }
});

/**
 * Change the default Primus global which we use in client code to something
 * custom. This makes it easier for people to integrate libraries in to their
 * own custom code bases.
 *
 * @param {String} input The library code.
 * @returns {String} The updated library code with the global replacements.
 * @api private
 */
Primus.prototype.customGlobal = function customGlobal(input) {
  var libraryNameLength = 'Primus'.length
    , global = this.options.global;

  if (!global) return input;

  input.match(/Primus[^\ ]/g).filter(function filter(e, i, values) {
    return values.lastIndexOf(e) === i;
  }).forEach(function each(match) {
    //
    // Doing a split then join prevents us needing to escape for RegExp
    //
    input = input.split(match).join(global + match.substr(libraryNameLength, 1));
  });

  return input;
};

//
// Expose the current version number.
//
Primus.prototype.version = require('./package.json').version;

//
// A list of supported transformers and the required Node.js modules.
//
Primus.transformers = require('./transformers.json');
Primus.parsers = require('./parsers.json');

/**
 * Simple function to output common errors.
 *
 * @param {String} what What is missing.
 * @param {Object} where Either Primus.parsers or Primus.transformers.
 * @returns {Object}
 * @api private
 */
Primus.readable('is', function is(what, where) {
  var missing = Primus.parsers !== where
      ? 'transformer'
      : 'parser'
    , dependency = where[what];

  return {
    missing: function write() {
      console.error('Primus:');
      console.error('Primus: Missing required npm dependency for '+ what);
      console.error('Primus: Please run the following command and try again:');
      console.error('Primus:');
      console.error('Primus:   npm install --save %s', dependency.server);
      console.error('Primus:');

      return 'Missing dependencies for '+ missing +': "'+ what + '"';
    },

    unknown: function write() {
      console.error('Primus:');
      console.error('Primus: Unsupported %s: "%s"', missing, what);
      console.error('Primus: We only support the following %ss:', missing);
      console.error('Primus:');
      console.error('Primus:   %s', Object.keys(where).join(', '));
      console.error('Primus:');

      return 'Unsupported '+ missing +': "'+ what +'"';
    }
  };
});

/**
 * Initialise the real-time transport that was chosen.
 *
 * @param {Mixed} Transformer The name of the transformer or a constructor;
 * @param {Object} options Options.
 * @api private
 */
Primus.readable('initialise', function initialise(Transformer, options) {
  Transformer = Transformer || 'websockets';

  var primus = this
    , transformer;

  if ('string' === typeof Transformer) {
    log('transformer `%s` is a string, attempting to resolve location', Transformer);
    Transformer = transformer = Transformer.toLowerCase();
    this.spec.transformer = transformer;

    //
    // This is a unknown transporter, it could be people made a typo.
    //
    if (!(Transformer in Primus.transformers)) {
      log('the supplied transformer %s is not supported, please use %s', transformer, Primus.transformers);
      throw new PrimusError(this.is(Transformer, Primus.transformers).unknown(), this);
    }

    try {
      Transformer = require('./transformers/'+ transformer);
      this.transformer = new Transformer(this);
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        log('the supplied transformer `%s` is missing', transformer);
        throw new PrimusError(this.is(transformer, Primus.transformers).missing(), this);
      } else {
        log(e);
        throw e;
      }
    }
  } else {
    log('received a custom transformer');
    this.spec.transformer = 'custom';
  }

  if ('function' !== typeof Transformer) {
    throw new PrimusError('The given transformer is not a constructor', this);
  }

  this.transformer = this.transformer || new Transformer(this);

  this.on('connection', function connection(stream) {
    this.connected++;
    this.connections[stream.id] = stream;

    log('connection: %s currently serving %d concurrent', stream.id, this.connected);
  });

  this.on('disconnection', function disconnected(stream) {
    this.connected--;
    delete this.connections[stream.id];

    log('disconnection: %s currently serving %d concurrent', stream.id, this.connected);
  });

  //
  // Add our default middleware layers.
  //
  this.before('forwarded', require('./middleware/forwarded'));
  this.before('cors', require('./middleware/access-control'));
  this.before('primus.js', require('./middleware/primus'));
  this.before('spec', require('./middleware/spec'));
  this.before('x-xss', require('./middleware/xss'));
  this.before('no-cache', require('./middleware/no-cache'));
  this.before('authorization', require('./middleware/authorization'));

  //
  // Emit the initialised event after the next tick so we have some time to
  // attach listeners.
  //
  process.nextTick(function tock() {
    primus.emit('initialised', primus.transformer, primus.parser, options);
  });
});

/**
 * Add a new authorization handler.
 *
 * @param {Function} auth The authorization handler.
 * @returns {Primus}
 * @api public
 */
Primus.readable('authorize', function authorize(auth) {
  if ('function' !== typeof auth) {
    throw new PrimusError('Authorize only accepts functions', this);
  }

  if (auth.length < 2) {
    throw new PrimusError('Authorize function requires more arguments', this);
  }

  log('setting an authorization function');
  this.auth = auth;
  return this;
});

/**
 * Iterate over the connections.
 *
 * @param {Function} fn The function that is called every iteration.
 * @param {Function} done Optional callback, if you want to iterate asynchronously.
 * @returns {Primus}
 * @api public
 */
Primus.readable('forEach', function forEach(fn, done) {
  if (!done) {
    for (var id in this.connections) {
      if (fn(this.connections[id], id, this.connections) === false) break;
    }

    return this;
  }

  var ids = Object.keys(this.connections)
    , primus = this;

  log('iterating over %d connections', ids.length);

  function pushId(spark) {
    ids.push(spark.id);
  }

  //
  // We are going to iterate through the connections asynchronously so
  // we should handle new connections as they come in.
  //
  primus.on('connection', pushId);

  (function iterate() {
    var id = ids.shift()
      , spark;

    if (!id) {
      primus.removeListener('connection', pushId);
      return done();
    }

    spark = primus.connections[id];

    //
    // The connection may have already been closed.
    //
    if (!spark) return iterate();

    fn(spark, function next(err, forward) {
      if (err || forward === false) {
        primus.removeListener('connection', pushId);
        return done(err);
      }

      iterate();
    });
  }());

  return this;
});

/**
 * Broadcast the message to all connections.
 *
 * @param {Mixed} data The data you want to send.
 * @returns {Primus}
 * @api public
 */
Primus.readable('write', function write(data) {
  this.forEach(function forEach(spark) {
    spark.write(data);
  });

  return this;
});

/**
 * Install message parsers.
 *
 * @param {Mixed} parser Parse name or parser Object.
 * @returns {Primus}
 * @api private
 */
Primus.readable('parsers', function parsers(parser) {
  parser = parser || 'json';

  if ('string' === typeof parser) {
    log('transformer `%s` is a string, attempting to resolve location', parser);
    parser = parser.toLowerCase();
    this.spec.parser = parser;

    //
    // This is a unknown parser, it could be people made a typo.
    //
    if (!(parser in Primus.parsers)) {
      log('the supplied parser `%s` is not supported please use %s', parser, Primus.parsers);
      throw new PrimusError(this.is(parser, Primus.parsers).unknown(), this);
    }

    try { parser = require('./parsers/'+ parser); }
    catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        log('the supplied parser `%s` is missing', parser);
        throw new PrimusError(this.is(parser, Primus.parsers).missing(), this);
      } else {
        log(e);
        throw e;
      }
    }
  } else {
    this.spec.parser = 'custom';
  }

  if ('object' !== typeof parser) {
    throw new PrimusError('The given parser is not an Object', this);
  }

  this.encoder = parser.encoder;
  this.decoder = parser.decoder;
  this.parser = parser;

  return this;
});

/**
 * Register a new message transformer. This allows you to easily manipulate incoming
 * and outgoing data which is particularity handy for plugins that want to send
 * meta data together with the messages.
 *
 * @param {String} type Incoming or outgoing
 * @param {Function} fn A new message transformer.
 * @returns {Primus}
 * @api public
 */
Primus.readable('transform', function transform(type, fn) {
  if (!(type in this.transformers)) {
    throw new PrimusError('Invalid transformer type', this);
  }

  if (~this.transformers[type].indexOf(fn)) {
    log('the %s message transformer already exists, not adding it', type);
    return this;
  }

  this.transformers[type].push(fn);
  return this;
});

/**
 * Gets a spark by its id.
 *
 * @param {String} id The spark's id.
 * @returns {Spark}
 * @api private
 */
Primus.prototype.spark = function spark(id) {
  return this.connections[id];
};

/**
 * Generate a client library.
 *
 * @param {Boolean} nodejs Don't include the library, as we're running on Node.js.
 * @returns {String} The client library.
 * @api public
 */
Primus.readable('library', function compile(nodejs) {
  var encoder = this.encoder.client || this.encoder
    , decoder = this.decoder.client || this.decoder
    , library = [ !nodejs ? this.transformer.library : null ]
    , global = this.options.global || 'Primus'
    , transport = this.transformer.client
    , parser = this.parser.library || '';

  //
  // Add a simple export wrapper so it can be used as Node.js, AMD or browser
  // client.
  //
  var client = '(function UMDish(name, context, definition) {'
    + '  context[name] = definition.call(context);'
    + '  if (typeof module !== "undefined" && module.exports) {'
    + '    module.exports = context[name];'
    + '  } else if (typeof define == "function" && define.amd) {'
    + '    define(function reference() { return context[name]; });'
    + '  }'
    + '})("'+ global +'", this, function '+ global +'() {'
    + this.client;

  //
  // Replace some basic content.
  //
  client = client
    .replace('null; // @import {primus::pathname}', '"'+ this.pathname.toString() +'"')
    .replace('null; // @import {primus::version}', '"'+ this.version +'"')
    .replace('null; // @import {primus::transport}', transport.toString())
    .replace('null; // @import {primus::auth}', (!!this.auth).toString())
    .replace('null; // @import {primus::encoder}', encoder.toString())
    .replace('null; // @import {primus::decoder}', decoder.toString());

  //
  // As we're given a timeout value on the server side, we need to update the
  // `ping` interval of the client to ensure that we've sent the server
  // a message before the timeout gets triggered and we get disconnected.
  //
  if ('number' === typeof this.timeout) {
    var timeout = this.timeout - 10000;
    log('adding a custom timeout to the client');
    client = client.replace('options.ping : 25e3;', 'options.ping : '+ timeout +';');
  }

  //
  // Add the parser inside the closure, to prevent global leaking.
  //
  if (parser && parser.length) {
    log('adding parser to the client file');
    client += parser;
  }

  //
  // Iterate over the parsers, and register the client side plugins. If there's
  // a library bundled, add it the library array as there were some issues with
  // frameworks that get included in module wrapper as it forces strict mode.
  //
  var name, plugin;

  for (name in this.ark) {
    plugin = this.ark[name];
    name = JSON.stringify(name);

    if (plugin.library) {
      log('adding the library of the %s plugin to the client file', name);
      library.push(this.customGlobal(plugin.library));
    }

    if (!plugin.client) continue;

    log('adding the client code of the %s plugin to the client file', name);
    client += global +'.prototype.ark['+ name +'] = '+ plugin.client.toString() +';\n';
  }

  //
  // Close the export wrapper and return the client. If we need to add
  // a library, we should add them after we've created our closure and module
  // exports. Some libraries seem to fail hard once they are wrapped in our
  // closure so I'll rather expose a global variable instead of having to monkey
  // patch to much code.
  //
  return client +' return '+ global +'; });'
  + library.filter(Boolean).map(function expose(library) {
    return '(function '+ global +'LibraryWrap('+ global +') {'
    + library
    + '})(this["'+ global +'"]);';
  }).join('\n');
});

/**
 * Save the library to disk.
 *
 * @param {String} dir The location that we need to save the library.
 * @param {function} fn Optional callback, if you want an async save.
 * @returns {Primus}
 * @api public
 */
Primus.readable('save', function save(path, fn) {
  if (!fn) fs.writeFileSync(path, this.library(), 'utf-8');
  else fs.writeFile(path, this.library(), 'utf-8', fn);

  return this;
});

/**
 * Register a new Primus plugin.
 *
 * ```js
 * primus.use('ack', {
 *   //
 *   // Only ran on the server.
 *   //
 *   server: function (primus, options) {
 *      // do stuff
 *   },
 *
 *   //
 *   // Runs on the client, it's automatically bundled.
 *   //
 *   client: function (primus, options) {
 *      // do client stuff
 *   },
 *
 *   //
 *   // Optional library that needs to be bundled on the client (should be a string)
 *   //
 *   library: ''
 * });
 * ```
 *
 * @param {String} name The name of the plugin.
 * @param {Object} energon The plugin that contains client and server extensions.
 * @returns {Primus}
 * @api public
 */
Primus.readable('use', function use(name, energon) {
  if ('object' === typeof name && !energon) {
    energon = name;
    name = energon.name;
  }

  if (!name) {
    throw new PrimusError('Plugin should be specified with a name', this);
  }

  if ('string' !== typeof name) {
    throw new PrimusError('Plugin names should be a string', this);
  }

  if ('string' === typeof energon) {
    log('plugin was passed as a string, attempting to require %s', energon);
    energon = require(energon);
  }

  //
  // Plugin accepts an object or a function only.
  //
  if (!/^(object|function)$/.test(typeof energon)) {
    throw new PrimusError('Plugin should be an object or function', this);
  }

  //
  // Plugin require a client, server or both to be specified in the object.
  //
  if (!energon.server && !energon.client) {
    throw new PrimusError('The plugin is missing a client or server function', this);
  }

  //
  // Don't allow duplicate plugins or plugin override as this is most likely
  // unintentional.
  //
  if (name in this.ark) {
    throw new PrimusError('The plugin name was already defined', this);
  }

  log('adding %s as new plugin', name);
  this.ark[name] = energon;
  this.emit('plugin', name, energon);

  if (!energon.server) return this;

  log('calling the %s plugin\'s server code', name);
  energon.server.call(this, this, this.options);

  return this;
});

/**
 * Return the given plugin.
 *
 * @param {String} name The name of the plugin.
 * @returns {Mixed}
 * @api public
 */
Primus.readable('plugin', function plugin(name) {
  if (name) return this.ark[name];

  var plugins = {};

  for (name in this.ark) {
    plugins[name] = this.ark[name];
  }

  return plugins;
});

/**
 * Remove plugin from the ark.
 *
 * @param {String} name Name of the plugin we need to remove from the ark.
 * @returns {Boolean} Successful removal of the plugin.
 * @api public
 */
Primus.readable('plugout', function plugout(name) {
  if (!(name in this.ark)) return false;

  this.emit('plugout', name, this.ark[name]);
  delete this.ark[name];

  return true;
});

/**
 * Add a new middleware layer. If no middleware name has been provided we will
 * attempt to take the name of the supplied function. If that fails, well fuck,
 * just random id it.
 *
 * @param {String} name The name of the middleware.
 * @param {Function} fn The middleware that's called each time.
 * @param {Object} options Middleware configuration.
 * @param {Number} level 0 based optional index for the middleware.
 * @returns {Primus}
 * @api public
 */
Primus.readable('before', function before(name, fn, options, level) {
  if ('function' === typeof name) {
    level = options;
    options = fn;
    fn = name;
    name = fn.name || 'pid_'+ Date.now();
  }

  if (!level && 'number' === typeof options) {
    level = options;
    options = {};
  }

  options = options || {};

  //
  // No or only 1 argument means that we need to initialise the middleware, this
  // is a special initialisation process where we pass in a reference to the
  // initialised Primus instance so a pre-compiling process can be done.
  //
  if (fn.length < 2) {
    log('automatically configuring middleware `%s`', name);
    fn = fn.call(this, options);
  }

  //
  // Make sure that we have a function that takes at least 2 arguments.
  //
  if ('function' !== typeof fn || fn.length < 2) {
    throw new PrimusError('Middleware should be a function that accepts at least 2 args');
  }

  var layer = {
    length: fn.length,                // Amount of arguments indicates if it's async.
    enabled: true,                    // Middleware is enabled by default.
    name: name,                       // Used for lookups.
    fn: fn                            // The actual middleware.
  }, index = this.indexOfLayer(name);

  //
  // Override middleware layer if we already have a middleware layer with
  // exactly the same name.
  //
  if (!~index) {
    if (level >= 0 && level < this.layers.length) {
      log('adding middleware `%s` to the supplied index at %d', name, level);
      this.layers.splice(level, 0, layer);
    } else {
      this.layers.push(layer);
    }
  } else {
    this.layers[index] = layer;
  }

  return this;
});

/**
 * Remove a middleware layer from the stack.
 *
 * @param {String} name The name of the middleware.
 * @returns {Primus}
 * @api public
 */
Primus.readable('remove', function remove(name) {
  var index = this.indexOfLayer(name);

  if (~index) {
    log('removing middleware `%s`', name);
    this.layers.splice(index, 1);
  }

  return this;
});

/**
 * Enable a given middleware layer.
 *
 * @param {String} name The name of the middleware.
 * @returns {Primus}
 * @api public
 */
Primus.readable('enable', function enable(name) {
  var index = this.indexOfLayer(name);

  if (~index) {
    log('enabling middleware `%s`', name);
    this.layers[index].enabled = true;
  }
  return this;
});

/**
 * Disable a given middleware layer.
 *
 * @param {String} name The name of the middleware.
 * @returns {Primus}
 * @api public
 */
Primus.readable('disable', function disable(name) {
  var index = this.indexOfLayer(name);

  if (~index) {
    log('disabling middleware `%s`', name);
    this.layers[index].enabled = false;
  }

  return this;
});

/**
 * Find the index of a given middleware layer by name.
 *
 * @param {String} name The name of the layer.
 * @returns {Number}
 * @api private
 */
Primus.readable('indexOfLayer', function indexOfLayer(name) {
  for (var i = 0, length = this.layers.length; i < length; i++) {
    if (this.layers[i].name === name) return i;
  }

  return -1;
});

/**
 * Destroy the created Primus instance.
 *
 * Options:
 * - close (boolean)  Close the given server.
 * - end (boolean)    Shut down all active connections.
 * - timeout (number) Forcefully close all connections after a given x MS.
 *
 * @param {Object} options Destruction instructions.
 * @param {Function} fn Callback.
 * @returns {Primus}
 * @api public
 */
Primus.readable('destroy', function destroy(options, fn) {
  if ('function' === typeof options) {
    fn = options;
    options = null;
  }

  options = options || {};

  var primus = this;

  setTimeout(function cleanup() {
    //
    // Optionally close the server.
    //
    if (options.close !== false && primus.server) {
      //
      // Closing a server that isn't started yet would throw an error.
      //
      try { primus.server.close(); }
      catch (e) {}
    }

    //
    // Optionally close connections that are left open.
    //
    if (options.end !== false) {
      primus.forEach(function shutdown(spark) {
        spark.end();
      });
    } else {
      [
        '',
        'We\'ve detected that you are using the `destroy` method with the',
        '`end` option set to `false`. This is deprecated and the ability to',
        'leave the connections open will be removed in future releases.',
        ''
      ].forEach(function each(line) {
        console.error('Primus: '+ line);
      });
    }

    //
    // Emit some final closing events right before we remove all listener
    // references from all the event emitters.
    //
    primus.asyncemit('close', options, function done(err) {
      if (err) {
        if (fn) return fn(err);
        throw err;
      }

      if (primus.transformer) {
        primus.transformer.emit('close', options);
        primus.transformer.removeAllListeners();
      }

      if (primus.server) primus.server.removeAllListeners();
      primus.removeAllListeners();

      //
      // Null some potentially heavy objects to free some more memory instantly.
      //
      primus.transformers.outgoing.length = primus.transformers.incoming.length = 0;
      primus.transformer = primus.encoder = primus.decoder = primus.server = null;
      primus.sparks = primus.connected = 0;

      primus.connections = Object.create(null);
      primus.ark = Object.create(null);

      if (fn) fn();
    });
  }, +options.timeout || 0);

  return this;
});

/**
 * Async emit an event. We make a really broad assumption here and that is they
 * have the same amount of arguments as the supplied arguments (excluding the
 * event name).
 *
 * @returns {Primus}
 * @api private
 */
Primus.readable('asyncemit', function asyncemit() {
  var args = Array.prototype.slice.call(arguments, 0)
    , event = args.shift()
    , listeners = this._events[event] || []
    , async = args.length
    , fn = args.pop()
    , primus = this;

  if (listeners && !Array.isArray(listeners)) {
    listeners = [ listeners ];
  }

  (function each(stack) {
    if (!stack.length) return fn();

    var listener = stack.shift();

    if (listener.once) {
      primus.removeListener(event, listener.fn);
    }

    if (listener.fn.length !== async) {
      listener.fn.apply(listener.context, args);
      return each(stack);
    }

    //
    // Async operation
    //
    listener.fn.apply(
      listener.context,
      args.concat(function done(err) {
        if (err) return fn(err);

        each(stack);
      })
    );
  })(listeners.slice());

  return this;
});

//
// Alias for destroy.
//
Primus.readable('end', Primus.prototype.destroy);

/**
 * Checks if the given event is an emitted event by Primus.
 *
 * @param {String} evt The event name.
 * @returns {Boolean}
 * @api public
 */
Primus.readable('reserved', function reserved(evt) {
  return (/^(incoming|outgoing)::/).test(evt)
  || evt in reserved.events;
});

/**
 * The actual events that are used by Primus.
 *
 * @type {Object}
 * @api public
 */
Primus.prototype.reserved.events = {
  'disconnection': 1,
  'initialised': 1,
  'connection': 1,
  'plugout': 1,
  'plugin': 1,
  'close': 1,
  'log': 1
};

/**
 * Add a createSocket interface so we can create a Server client with the
 * specified `transformer` and `parser`.
 *
 * ```js
 * var Socket = Primus.createSocket({ transformer: transformer, parser: parser })
 *   , socket = new Socket(url);
 * ```
 *
 * @param {Object} options The transformer / parser we need.
 * @returns {Socket}
 * @api public
 */
Primus.createSocket = function createSocket(options) {
  options = options || {};

  var primus = new Primus(new EventEmitter(), options);
  return primus.Socket;
};

/**
 * Create a new Primus server.
 *
 * @param {Function} fn Request listener.
 * @param {Object} options Configuration.
 * @returns {Pipe}
 * @api public
 */
Primus.createServer = function createServer(fn, options) {
  if ('object' === typeof fn) {
    options = fn;
    fn = null;
  }

  options = options || {};

  var server = require('create-server')(Primus.prototype.merge.call(Primus, {
    http: function warn() {
      if (!options.iknowhttpsisbetter) [
        '',
        'We\'ve detected that you\'re using a HTTP instead of a HTTPS server.',
        'Please be aware that real-time connections have less chance of being blocked',
        'by firewalls and anti-virus scanners if they are encrypted (using SSL). If',
        'you run your server behind a reverse and HTTPS terminating proxy ignore',
        'this message, if not, you\'ve been warned.',
        ''
      ].forEach(function each(line) {
        console.log('primus: '+ line);
      });
    }
  }, options));

  //
  // Now that we've got a server, we can setup the Primus and start listening.
  //
  var application = new Primus(server, options);

  if (fn) application.on('connection', fn);
  return application;
};

//
// Expose the constructors of our Spark and Transformer so it can be extended by
// a third party if needed.
//
Primus.Transformer = Transformer;
Primus.Spark = Spark;

//
// Expose the module.
//
module.exports = Primus;

}).call(this,require('_process'),"/node_modules/strong-pubsub-primus/node_modules/Primus")
},{"./errors":1,"./middleware/access-control":3,"./middleware/authorization":4,"./middleware/forwarded":6,"./middleware/no-cache":7,"./middleware/primus":8,"./middleware/spec":9,"./middleware/xss":10,"./package.json":37,"./parsers.json":38,"./spark":39,"./transformer":40,"./transformers.json":41,"_process":61,"cluster":47,"create-server":14,"diagnostics":16,"eventemitter3":27,"fs":47,"fusing":29,"load":33}],3:[function(require,module,exports){
'use strict';

var access = require('access-control');

/**
 * Add Access-Control to each request.
 *
 * @returns {Function}
 * @api public
 */
module.exports = function configure() {
  var control = access(this.options);

  //
  // We don't add Access-Control headers for HTTP upgrades.
  //
  control.upgrade = false;

  return control;
};

},{"access-control":11}],4:[function(require,module,exports){
(function (Buffer){
'use strict';

/**
 * Authorization middleware for Primus which would accept or deny requests.
 *
 * @returns {Function}
 * @api public
 */
module.exports = function configuration() {
  /**
   * The actual HTTP middleware.
   *
   * @param {Request} req HTTP request.
   * @param {Response} res HTTP response.
   * @param {Function} next Continuation.
   * @api private
   */
  return function client(req, res, next) {
    if ('function' !== typeof this.auth) return next();

    req.pause();

    this.auth(req, function authorized(err) {
      req.resume();

      if (!err) return next();

      var message = JSON.stringify({ error: err.message || err })
        , length = Buffer.byteLength(message)
        , code = err.statusCode || 401;

      //
      // We need to handle two cases here, authentication for regular HTTP
      // requests as well as authentication of WebSocket (upgrade) requests.
      //
      if (res.setHeader) {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', length);

        if (code === 401 && err.authenticate) {
          res.setHeader('WWW-Authenticate', err.authenticate);
        }

        res.end(message);
      } else {
        res.write('HTTP/'+ req.httpVersion +' ');
        res.write(code +' '+ require('http').STATUS_CODES[code] +'\r\n');
        res.write('Connection: close\r\n');
        res.write('Content-Type: application/json\r\n');
        res.write('Content-Length: '+ length +'\r\n');

        if (code === 401 && err.authenticate) {
          res.write('WWW-Authenticate: ' + err.authenticate + '\r\n');
        }

        res.write('\r\n');
        res.write(message);
        res.destroy();
      }
    });
  };
};

}).call(this,require("buffer").Buffer)
},{"buffer":49,"http":54}],5:[function(require,module,exports){
(function (Buffer){
'use strict';

/**
 * WARNING: this middleware is only used internally and does not follow the
 * pattern of the other middleware. You should not use it.  
 *
 * Handle async middleware errors.
 *
 * @param {Error} err Error returned by the middleware.
 * @param {Request} req HTTP request.
 * @param {Response} res HTTP response.
 * @api private
 */
module.exports = function error(err, req, res) {
  var message = JSON.stringify({ error: err.message || err })
    , length = Buffer.byteLength(message)
    , code = err.statusCode || 500;

  //
  // As in the authorization middleware we need to handle two cases here:
  // regular HTTP requests and upgrade requests.
  //
  if (res.setHeader) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', length);

    return res.end(message);
  }
  
  res.write('HTTP/'+ req.httpVersion +' ');
  res.write(code +' '+ require('http').STATUS_CODES[code] +'\r\n');
  res.write('Connection: close\r\n');
  res.write('Content-Type: application/json\r\n');
  res.write('Content-Length: '+ length +'\r\n');
  res.write('\r\n');
  res.write(message);
  res.destroy();
};

}).call(this,require("buffer").Buffer)
},{"buffer":49,"http":54}],6:[function(require,module,exports){
'use strict';

var forwarded = require('forwarded-for');

/**
 * Add the `forwarded` property.
 *
 * @param {Request} req HTTP request.
 * @param {Response} res HTTP response.
 * @api private
 */
module.exports = function configure() {
  var primus = this;

  return function ipaddress(req, res) {
    req.forwarded = forwarded(req, req.headers || {}, primus.whitelist);
  };
};

},{"forwarded-for":28}],7:[function(require,module,exports){
'use strict';

var setHeader = require('setheader');

/**
 * Forcefully add no-cache headers to HTTP responses.
 *
 * @param {Request} req The incoming HTTP request.
 * @param {Response} res The outgoing HTTP response.
 * @api public
 */
function nocache(req, res) {
  setHeader(res, 'Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  setHeader(res, 'Pragma', 'no-cache');
}

//
// We don't need no-cache headers for HTTP upgrades.
//
nocache.upgrade = false;

//
// Expose the module.
//
module.exports = nocache;

},{"setheader":34}],8:[function(require,module,exports){
(function (Buffer){
'use strict';

/**
 * Serve the client library that is shipped and compiled within Primus.
 *
 * @returns {Function}
 * @api public
 */
module.exports = function configure() {
  var primusjs = this.pathname +'/primus.js'
    , primus = this
    , library
    , length;

  /**
   * The actual HTTP middleware.
   *
   * @param {Request} req HTTP request.
   * @param {Response} res HTTP response.
   * @api private
   */
  function client(req, res) {
    if (req.uri.pathname !== primusjs) return;

    //
    // Lazy include and compile the library so we give our server some time to
    // add plugins or we will compile the client library without plugins, which
    // is sad :(
    //
    library = library || new Buffer(primus.library());
    length = length || library.length;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Content-Length', length);
    res.end(library);

    return true;
  }

  //
  // We don't serve our client-side library over HTTP upgrades.
  //
  client.upgrade = false;

  return client;
};

}).call(this,require("buffer").Buffer)
},{"buffer":49}],9:[function(require,module,exports){
'use strict';

/**
 * Answer HTTP requests with the server specification when requested.
 *
 * @returns {Function}
 * @api public
 */
module.exports = function configure() {
  var specification = this.pathname +'/spec'
    , primus = this;

  /**
   * The actual HTTP middleware.
   *
   * @param {Request} req HTTP request.
   * @param {Response} res HTTP response.
   * @api private
   */
  function spec(req, res) {
    if (req.uri.pathname !== specification) return;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(primus.spec));

    return true;
  }

  //
  // Don't run a specification test for HTTP upgrades.
  //
  spec.upgrade = false;

  return spec;
};

},{}],10:[function(require,module,exports){
'use strict';

var setHeader = require('setheader');

/**
 * Forcefully add x-xss-protection headers.
 *
 * @param {Request} req The incoming HTTP request.
 * @param {Response} res The outgoing HTTP response.
 * @api public
 */
function xss(req, res) {
  var agent = (req.headers['user-agent'] || '').toLowerCase();

  if (agent && (~agent.indexOf(';msie') || ~agent.indexOf('trident/'))) {
    setHeader(res, 'X-XSS-Protection', '0');
  }
}

//
// We don't need protection headers for HTTP upgrades.
//
xss.upgrade = false;

//
// Expose the module.
//
module.exports = xss;

},{"setheader":34}],11:[function(require,module,exports){
'use strict';

var setHeader = require('setheader')
  , parse = require('url').parse
  , ms = require('millisecond')
  , vary = require('vary');

/**
 * Configure the CORS / Access Control headers.
 *
 * @param {Object} options Configuration
 * @returns {Function}
 * @api public
 */
function access(options) {
  options = options || {};

  // The allowed origins of the request.
  options.origins = 'origins' in options
    ? options.origins
    : '*';

  // The allowed methods for the request.
  options.methods = 'methods' in options
    ? options.methods
    : ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'OPTIONS'];

  // Allow sending of authorization and cookie information.
  options.credentials = 'credentials' in options
    ? options.credentials
    : true;

  // Cache duration of the preflight/OPTIONS request.
  options.maxAge = 'maxAge' in options
    ? options.maxAge
    : '30 days';

  // The allowed request headers.
  options.headers = 'headers' in options
    ? options.headers
    : '';

  // Server headers exposed to the user agent.
  options.exposed = 'exposed' in options
    ? options.exposed
    : '';

  //
  // Be a bit flexible in the way the arguments are supplied, transform Array's
  // in to strings and human readable numbers strings in to numbers.
  //
  ['methods', 'headers', 'exposed', 'origins'].forEach(function cleanup(key) {
    if (Array.isArray(options[key])) options[key] = options[key].join(', ');
  });

  //
  // The maxAge header value must be expressed in seconds so we need to convert
  // the milliseconds returned by the `millisecond` module in seconds.
  //
  if ('string' === typeof options.maxAge) {
    options.maxAge = ms(options.maxAge) / 1000;
  }

  var separator = /[, ]+/
    , methods = options.methods.toUpperCase().split(separator).filter(Boolean)
    , headers = options.headers.toLowerCase().split(separator).filter(Boolean)
    , origins = options.origins.toLowerCase().split(separator).filter(Boolean);

  /**
   * The actual function that handles the setting of the requests and answering
   * of the OPTIONS method.
   *
   * @param {Request} req The incoming HTTP request.
   * @param {Response} res The outgoing HTTP response.
   * @param {Function} next Optional callback for middleware support.
   * @returns {Boolean}
   * @api public
   */
  return function control(req, res, next) {
    var origin = (req.headers.origin || '').toLowerCase().trim()
      , credentials = options.credentials;

    //
    // The `origin` header WILL always be send for browsers that support CORS.
    // If it's in the request headers, we should not be sending the headers as
    // it would only be pointless overhead.
    //
    // @see https://developer.mozilla.org/en/docs/HTTP/Access_control_CORS#Origin
    //
    if (!('origin' in req.headers)) {
      if ('function' === typeof next) next();
      return false;
    }

    //
    // Validate the current request to ensure that proper headers are being sent
    // and that we don't answer with bullshit.
    //
    if (
         ~origin.indexOf('%')
      || (origin !== 'null' && !parse(origin).protocol)
      || options.origins !== '*' && !~origins.indexOf(origin)
      || (methods.length && !~methods.indexOf(req.method))
      // @TODO header validation
    ) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain');
      res.end([
        'Invalid HTTP Access Control (CORS) request:',
        '  Origin: '+ req.headers.origin,
        '  Method: '+ req.method
      ].join('\n'));

      return true;
    }

    //
    // GET requests are not preflighted for CORS but the browser WILL reject the
    // response if the request is made with the `withCredentials` flag enabled
    // and the `Access-Control-Allow-Origin` header is set to `*`. In addition to
    // this, if the server specifies an origin host rather than `*`, the it must
    // be either a SINGLE origin or the string `null`.
    //
    if (options.origins !== '*' || credentials) {
      setHeader(res, 'Access-Control-Allow-Origin', req.headers.origin);
      vary(res, 'Origin');
    } else {
      setHeader(res, 'Access-Control-Allow-Origin', '*');
    }

    if (credentials) {
      setHeader(res, 'Access-Control-Allow-Credentials', 'true');
    }

    //
    // The HTTP Access Control (CORS) uses the OPTIONS method for preflight
    // requests so it can get approval before doing the actual request. So it's
    // vital that these requests are handled first and as soon as possible. But
    // as OPTIONS requests can also be made for other types of requests, we need
    // to explicitly check if the `Access-Control-Request-Method` header has been
    // sent to ensure that this is a preflight request.
    //
    if (
         'OPTIONS' === req.method
      && req.headers['access-control-request-method']
    ) {
      if (options.maxAge) {
        setHeader(res, 'Access-Control-Max-Age', options.maxAge);
      }

      if (options.methods) {
        setHeader(res, 'Access-Control-Allow-Methods', methods.join(', '));
      }

      if (options.headers) {
        setHeader(res, 'Access-Control-Allow-Headers', options.headers);
      } else if (req.headers['access-control-request-headers']) {
        setHeader(res, 'Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
      }

      //
      // OPTION methods SHOULD be answered with a 200 status code so we're
      // correctly following the RFC 2616
      //
      // @see http://www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
      //
      res.statusCode = 200;
      res.setHeader('Content-Length', 0);
      res.end('');

      return true;
    }

    if (options.exposed) {
      setHeader(res, 'Access-Control-Expose-Headers', options.exposed);
    }

    if ('function' === typeof next) next();
    return false;
  };
}

//
// Expose the module.
//
module.exports = access;

},{"millisecond":12,"setheader":34,"url":80,"vary":13}],12:[function(require,module,exports){
/**
 * Parse a time string and return the number value of it.
 *
 * @param {String} ms Time string.
 * @returns {Number}
 * @api private
 */
module.exports = function millisecond(ms) {
  'use strict';

  if ('string' !== typeof ms || '0' === ms || +ms) return +ms;

  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(ms)
    , second = 1000
    , minute = second * 60
    , hour = minute * 60
    , day = hour * 24
    , amount;

  if (!match) return 0;

  amount = parseFloat(match[1]);

  switch (match[2].toLowerCase()) {
    case 'days':
    case 'day':
    case 'd':
      return amount * day;

    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return amount * hour;

    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return amount * minute;

    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return amount * second;

    default:
      return amount;
  }
};

},{}],13:[function(require,module,exports){
/*!
 * vary
 * Copyright(c) 2014 Douglas Christopher Wilson
 * MIT Licensed
 */

/**
 * Module exports.
 */

module.exports = vary;
module.exports.append = append;

/**
 * Variables.
 */

var separators = /[\(\)<>@,;:\\"\/\[\]\?=\{\}\u0020\u0009]/;

/**
 * Append a field to a vary header.
 *
 * @param {String} header
 * @param {String|Array} field
 * @return {String}
 * @api public
 */

function append(header, field) {
  if (typeof header !== 'string') {
    throw new TypeError('header argument is required');
  }

  if (!field) {
    throw new TypeError('field argument is required');
  }

  // get fields array
  var fields = !Array.isArray(field)
    ? parse(String(field))
    : field;

  // assert on invalid fields
  for (var i = 0; i < fields.length; i++) {
    if (separators.test(fields[i])) {
      throw new TypeError('field argument contains an invalid header');
    }
  }

  // existing, unspecified vary
  if (header === '*') {
    return header;
  }

  // enumerate current values
  var vals = parse(header.toLowerCase());

  // unspecified vary
  if (fields.indexOf('*') !== -1 || vals.indexOf('*') !== -1) {
    return '*';
  }

  for (var i = 0; i < fields.length; i++) {
    field = fields[i].toLowerCase();

    // append value (case-preserving)
    if (vals.indexOf(field) === -1) {
      vals.push(field);
      header = header
        ? header + ', ' + fields[i]
        : fields[i];
    }
  }

  return header;
}

/**
 * Parse a vary header into an array.
 *
 * @param {String} header
 * @return {Array}
 * @api private
 */

function parse(header) {
  return header.trim().split(/ *, */);
}

/**
 * Mark that a request is varied on a header field.
 *
 * @param {Object} res
 * @param {String|Array} field
 * @api public
 */

function vary(res, field) {
  if (!res || !res.getHeader || !res.setHeader) {
    // quack quack
    throw new TypeError('res argument is required');
  }

  // get existing header
  var val = res.getHeader('Vary') || ''
  var header = Array.isArray(val)
    ? val.join(', ')
    : String(val);

  // set new header
  res.setHeader('Vary', append(header, field));
}

},{}],14:[function(require,module,exports){
'use strict';

var listen = require('connected')
  , parse = require('url').parse
  , path = require('path')
  , fs = require('fs');

/**
 * Get an accurate type check for the given Object.
 *
 * @param {Mixed} obj The object that needs to be detected.
 * @returns {String} The object type.
 * @api public
 */
function is(obj) {
  return Object.prototype.toString.call(obj).slice(8, -1).toLowerCase();
}

/**
 * Create a HTTP server.
 *
 * @param {Mixed} server Different ways of constructing a server.
 * @param {Object} fn Callback or callbacks.
 * @returns {Server} The created server.
 */
function create(server, fn) {
  var options;

  switch (is(server)) {
    case 'object':
      options = server;
    break;

    case 'number':
      options = { port: server };
    break;

    default:
      options = {};
    break;
  }

  fn = create.fns(fn || options);

  var port = options.port || 443                // Force HTTPS by default.
    , certs = options.key && options.cert       // Check HTTPS certs.
    , secure = certs || 443 === port            // Check for true HTTPS
    , spdy = 'spdy' in options                  // Or are we spdy
    , type;

  //
  // Determine which type of server we need to create.
  //
  if (spdy) type = 'spdy';
  else if (secure) type = 'https';
  else type = 'http';

  //
  // We need to have SSL certs for SPDY and secure servers.
  //
  if ((secure || spdy) && !certs) {
    throw new Error('Missing the SSL key or certificate files in the options.');
  }

  //
  // When given a `options.root` assume that our SSL certs and keys are path
  // references that still needs to be read. This allows a much more human
  // readable interface for SSL.
  //
  if (secure && options.root) {
    ['cert', 'key', 'ca', 'pfx', 'crl'].filter(function filter(key) {
      return key in options;
    }).forEach(function parse(key) {
      var data = options[key];

      if (Array.isArray(data)) {
        options[key] = data.map(function read(file) {
          return fs.readFileSync(path.join(options.root, file));
        });
      } else {
        options[key] = fs.readFileSync(path.join(options.root, data));
      }
    });
  }

  if ('http' === type) {
    server = require('http').createServer();
  } else {
    server = require(type).createServer(options);
  }

  //
  // Setup an addition redirect server which redirects people to the correct
  // HTTP or HTTPS server.
  //
  if (+options.redirect) {
    var redirect = require('http').createServer(function handle(req, res) {
      res.statusCode = 404;

      if (req.headers.host) {
        var url = parse('http://'+ req.headers.host);

        res.statusCode = 301;
        res.setHeader(
          'Location',
          'http'+ (secure ? 's' : '') +'://'+ url.hostname +':'+ port + req.url
        );
      }

      if (secure) res.setHeader(
        'Strict-Transport-Security',
        'max-age=8640000; includeSubDomains'
      );

      res.end('');
    }).listen(+options.redirect);

    //
    // Close the redirect server when the main server is closed.
    //
    server.once('close', function close() {
      try { redirect.close(); }
      catch (e) {}
    });
  }

  //
  // Assign the last callbacks.
  //
  if (fn.close) server.once('close', fn.close);
  ['request', 'upgrade', 'error'].forEach(function each(event) {
    if (fn[event]) server.on(event, fn[event]);
  });

  //
  // Things are completed, call callback.
  //
  if (fn[type]) fn[type]();

  if (options.listen !== false) {
    listen(server, port, fn.listening);
  } else if (fn.listening) {
    server.once('listening', fn.listening);
  }

  return server;
}

/**
 * Create callbacks.
 *
 * @param {Object} fn Callback hooks.
 * @returns {Object} The callbacks
 * @api private
 */
create.fns = function fns(fn) {
  var callbacks = {};

  if ('function' === typeof fn) {
    callbacks.listening = fn;
    return callbacks;
  }

  [
    'close', 'request', 'listening', 'upgrade', 'error',
    'http', 'https', 'spdy'
  ].forEach(function each(name) {
    if ('function' !== typeof fn[name]) return;

    callbacks[name] = fn[name];
  });

  return callbacks;
};

//
// Expose the create server method.
//
module.exports = create;

},{"connected":15,"fs":47,"http":54,"path":60,"url":80}],15:[function(require,module,exports){
'use strict';

/**
 * Simple abstraction to merge the awfully emitted `error` events for listening
 * to a callback.
 *
 * ```js
 * var app = require('net').createServer();
 * require('listening')(app, function (err) {
 *   .. handle listen errors here ..
 * });
 * ```
 *
 * @api public
 */
module.exports = function listen() {
  var args = Array.prototype.slice.call(arguments, 0)
    , server = args.shift()
    , fn = args.pop();

  /**
   * The actual callback method that is passed in to the server which collects
   * the different events and passes it to the given callback method.
   *
   * @param {Error}
   * @api private
   */
  function collector(err) {
    server.removeListener('error', collector);
    server.removeListener('listening', collector);

    if (fn) fn.apply(server, arguments);
    else if (err) throw err;
  }

  //
  // Allow people to supply the server with no callback function.
  //
  if ('function' !== typeof fn) {
    args.push(fn);
    fn = null;
  }

  server.once('listening', collector);
  server.once('error', collector);

  return server.listen.apply(server, args);
};

},{}],16:[function(require,module,exports){
(function (process){
'use strict';

var env = require('env-variable')
  , Stream = require('stream')
  , colorjs = require('color')
  , hex = require('text-hex')
  , kuler = require('kuler')
  , util = require('util');

/**
 * Check if the terminal we're using allows the use of colors.
 *
 * @type {Boolean}
 * @private
 */
var tty = require('tty').isatty(1);

/**
 * The default stream instance we should be writing against.
 *
 * @type {Stream}
 * @public
 */
var stream = process.stdout;

/**
 * A simple environment based logger.
 *
 * Options:
 *
 * - color: The color for the namespace, can be a hex/CSS color string, defaults
 *   to automatically generated color from the method name.
 *
 * - colour: Alternate spelling for color, does the same thing.
 *
 * - colors: Force the use of colors or forcefully disable them. If this option
 *   is not supplied the colors will be based on your terminal.
 *
 * - stream: The Stream instance we should write our logs to, defaults to
 *   process.stdout but can be anything you like.
 *
 * - precise: By default our log timing is rounded up to the nearest value. If
 *   you need a more precise timing you can set this true.
 *
 * @param {String} name The namespace of your log function.
 * @param {Object} options Logger configuration.
 * @returns {Function} Configured logging method.
 * @api public
 */
function factory(name, options) {
  options = options || {};

  if ('object' === typeof name) options = name;
  if ('string' !== typeof name) name = resolve(module);

  //
  // All argument normalization has been done, check if the given name is
  // actually allowed to log something.
  //
  if (!enabled(name)) return function nope() {};

  options.colors = 'colors' in options ? options.colors : tty;
  options.color = options.color || options.colour || paint(name);
  options.ansi = options.colors ? kuler(name, options.color) : name;
  options.stream = options.stream || stream;

  //
  // Allow multiple streams, so make sure it's an array which makes iteration
  // easier.
  //
  if (!Array.isArray(options.stream)) options.stream = [options.stream];

  //
  // The actual debug function which does the logging magic.
  //
  return function debug(line) {
    //
    // Better formatting for error instances.
    //
    if (line instanceof Error) line = line.stack || line.message || line;

    line = [
      //
      // Add the colorized namespace.
      //
      options.ansi,

      //
      // The total time we took to execute the next debug statement.
      //
      ' ',
      line
    ].join('');

    //
    // Use util.format so we can follow the same API as console.log.
    //
    line = util.format.apply(this, [line].concat(
        Array.prototype.slice.call(arguments, 1)
    )) + '\n';

    options.stream.forEach(function each(stream) {
      stream.write(line);
    });
  };
}

/**
 * Checks if a given logger based on the allowed environment variables.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api private
 */
function enabled(name) {
  var envy = env()
    , variable = envy.diagnostics || envy.debug || '';

  if (!variable) return false;

  return variable.split(/[\s,]+/).some(function checks(check) {
    check = check.replace('*', '.*?');

    if ('-' === check.charAt(0)) {
      return !(new RegExp('^' + check.substr(1) + '$')).test(name);
    }

    return (new RegExp('^' + check + '$')).test(name);
  });
}

/**
 * Generate a color for a given name. But be reasonably smart about it by
 * understanding name spaces and coloring each namespace a bit lighter so they
 * still have the same base color as the root.
 *
 * @param {String} name The namespace
 * @returns {String} color
 * @api private
 */
function paint(name) {
  name = name.split(':');

  for (var base = hex(name[0]), i = 0, l = name.length - 1; i < l; i++) {
    base = colorjs(base).mix(colorjs(hex(name[i + 1]))).saturate(1).hexString();
  }

  return base;
}

/**
 * Attempt to resolve the name of the application by searching for the
 * package.json use the name property of that. If we cannot find a name property
 * we will use the name of the folder of the module that required us.
 *
 * @param {Module} module The module reference.
 * @returns {String} name of the module.
 * @api private
 */
function resolve(module) {
  var fs = require('fs')
    , path = require('path')
    , folder = path.dirname(module.filename);

  while (folder) {
    var json = path.join(folder, 'package.json');

    if (fs.existsSync(json)) {
      json = require(json);

      if (
           'diagnostics' in json.dependencies
        || 'diagnostics' in json.devDependencies
      ) {
        return json.name;
      }
    }

    folder = path.join(folder, '..');
    if (path.sep === folder) break;
  }

  //
  // We couldn't find a package.json, use a directory/folder as name instead.
  //
  return path.dirname(module.filename).split(path.sep).pop();
}

/**
 * Override the "default" stream that we write to. This allows you to globally
 * configure the steams.
 *
 * @param {Stream} output
 * @returns {function} Factory
 * @api private
 */
function to(output) {
  stream = output instanceof Stream ? output : stream;
  return factory;
}

//
// Expose our private methods so they can be tested.
//
factory.resolve = resolve;
factory.enabled = enabled;
factory.paint = paint;
factory.to = to;

//
// Expose the module.
//
module.exports = factory;

}).call(this,require('_process'))
},{"_process":61,"color":17,"env-variable":24,"fs":47,"kuler":25,"path":60,"stream":77,"text-hex":26,"tty":79,"util":82}],17:[function(require,module,exports){
/* MIT license */
var convert = require("color-convert"),
    string = require("color-string");

var Color = function(cssString) {
  if (cssString instanceof Color) return cssString;
  if (! (this instanceof Color)) return new Color(cssString);

   this.values = {
      rgb: [0, 0, 0],
      hsl: [0, 0, 0],
      hsv: [0, 0, 0],
      hwb: [0, 0, 0],
      cmyk: [0, 0, 0, 0],
      alpha: 1
   }

   // parse Color() argument
   if (typeof cssString == "string") {
      var vals = string.getRgba(cssString);
      if (vals) {
         this.setValues("rgb", vals);
      }
      else if(vals = string.getHsla(cssString)) {
         this.setValues("hsl", vals);
      }
      else if(vals = string.getHwb(cssString)) {
         this.setValues("hwb", vals);
      }
      else {
        throw new Error("Unable to parse color from string \"" + cssString + "\"");
      }
   }
   else if (typeof cssString == "object") {
      var vals = cssString;
      if(vals["r"] !== undefined || vals["red"] !== undefined) {
         this.setValues("rgb", vals)
      }
      else if(vals["l"] !== undefined || vals["lightness"] !== undefined) {
         this.setValues("hsl", vals)
      }
      else if(vals["v"] !== undefined || vals["value"] !== undefined) {
         this.setValues("hsv", vals)
      }
      else if(vals["w"] !== undefined || vals["whiteness"] !== undefined) {
         this.setValues("hwb", vals)
      }
      else if(vals["c"] !== undefined || vals["cyan"] !== undefined) {
         this.setValues("cmyk", vals)
      }
      else {
        throw new Error("Unable to parse color from object " + JSON.stringify(cssString));
      }
   }
}

Color.prototype = {
   rgb: function (vals) {
      return this.setSpace("rgb", arguments);
   },
   hsl: function(vals) {
      return this.setSpace("hsl", arguments);
   },
   hsv: function(vals) {
      return this.setSpace("hsv", arguments);
   },
   hwb: function(vals) {
      return this.setSpace("hwb", arguments);
   },
   cmyk: function(vals) {
      return this.setSpace("cmyk", arguments);
   },

   rgbArray: function() {
      return this.values.rgb;
   },
   hslArray: function() {
      return this.values.hsl;
   },
   hsvArray: function() {
      return this.values.hsv;
   },
   hwbArray: function() {
      if (this.values.alpha !== 1) {
        return this.values.hwb.concat([this.values.alpha])
      }
      return this.values.hwb;
   },
   cmykArray: function() {
      return this.values.cmyk;
   },
   rgbaArray: function() {
      var rgb = this.values.rgb;
      return rgb.concat([this.values.alpha]);
   },
   hslaArray: function() {
      var hsl = this.values.hsl;
      return hsl.concat([this.values.alpha]);
   },
   alpha: function(val) {
      if (val === undefined) {
         return this.values.alpha;
      }
      this.setValues("alpha", val);
      return this;
   },

   red: function(val) {
      return this.setChannel("rgb", 0, val);
   },
   green: function(val) {
      return this.setChannel("rgb", 1, val);
   },
   blue: function(val) {
      return this.setChannel("rgb", 2, val);
   },
   hue: function(val) {
      return this.setChannel("hsl", 0, val);
   },
   saturation: function(val) {
      return this.setChannel("hsl", 1, val);
   },
   lightness: function(val) {
      return this.setChannel("hsl", 2, val);
   },
   saturationv: function(val) {
      return this.setChannel("hsv", 1, val);
   },
   whiteness: function(val) {
      return this.setChannel("hwb", 1, val);
   },
   blackness: function(val) {
      return this.setChannel("hwb", 2, val);
   },
   value: function(val) {
      return this.setChannel("hsv", 2, val);
   },
   cyan: function(val) {
      return this.setChannel("cmyk", 0, val);
   },
   magenta: function(val) {
      return this.setChannel("cmyk", 1, val);
   },
   yellow: function(val) {
      return this.setChannel("cmyk", 2, val);
   },
   black: function(val) {
      return this.setChannel("cmyk", 3, val);
   },

   hexString: function() {
      return string.hexString(this.values.rgb);
   },
   rgbString: function() {
      return string.rgbString(this.values.rgb, this.values.alpha);
   },
   rgbaString: function() {
      return string.rgbaString(this.values.rgb, this.values.alpha);
   },
   percentString: function() {
      return string.percentString(this.values.rgb, this.values.alpha);
   },
   hslString: function() {
      return string.hslString(this.values.hsl, this.values.alpha);
   },
   hslaString: function() {
      return string.hslaString(this.values.hsl, this.values.alpha);
   },
   hwbString: function() {
      return string.hwbString(this.values.hwb, this.values.alpha);
   },
   keyword: function() {
      return string.keyword(this.values.rgb, this.values.alpha);
   },

   rgbNumber: function() {
      return (this.values.rgb[0] << 16) | (this.values.rgb[1] << 8) | this.values.rgb[2];
   },

   luminosity: function() {
      // http://www.w3.org/TR/WCAG20/#relativeluminancedef
      var rgb = this.values.rgb;
      var lum = [];
      for (var i = 0; i < rgb.length; i++) {
         var chan = rgb[i] / 255;
         lum[i] = (chan <= 0.03928) ? chan / 12.92
                  : Math.pow(((chan + 0.055) / 1.055), 2.4)
      }
      return 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
   },

   contrast: function(color2) {
      // http://www.w3.org/TR/WCAG20/#contrast-ratiodef
      var lum1 = this.luminosity();
      var lum2 = color2.luminosity();
      if (lum1 > lum2) {
         return (lum1 + 0.05) / (lum2 + 0.05)
      };
      return (lum2 + 0.05) / (lum1 + 0.05);
   },

   level: function(color2) {
     var contrastRatio = this.contrast(color2);
     return (contrastRatio >= 7.1)
       ? 'AAA'
       : (contrastRatio >= 4.5)
        ? 'AA'
        : '';
   },

   dark: function() {
      // YIQ equation from http://24ways.org/2010/calculating-color-contrast
      var rgb = this.values.rgb,
          yiq = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
   	return yiq < 128;
   },

   light: function() {
      return !this.dark();
   },

   negate: function() {
      var rgb = []
      for (var i = 0; i < 3; i++) {
         rgb[i] = 255 - this.values.rgb[i];
      }
      this.setValues("rgb", rgb);
      return this;
   },

   lighten: function(ratio) {
      this.values.hsl[2] += this.values.hsl[2] * ratio;
      this.setValues("hsl", this.values.hsl);
      return this;
   },

   darken: function(ratio) {
      this.values.hsl[2] -= this.values.hsl[2] * ratio;
      this.setValues("hsl", this.values.hsl);
      return this;
   },

   saturate: function(ratio) {
      this.values.hsl[1] += this.values.hsl[1] * ratio;
      this.setValues("hsl", this.values.hsl);
      return this;
   },

   desaturate: function(ratio) {
      this.values.hsl[1] -= this.values.hsl[1] * ratio;
      this.setValues("hsl", this.values.hsl);
      return this;
   },

   whiten: function(ratio) {
      this.values.hwb[1] += this.values.hwb[1] * ratio;
      this.setValues("hwb", this.values.hwb);
      return this;
   },

   blacken: function(ratio) {
      this.values.hwb[2] += this.values.hwb[2] * ratio;
      this.setValues("hwb", this.values.hwb);
      return this;
   },

   greyscale: function() {
      var rgb = this.values.rgb;
      // http://en.wikipedia.org/wiki/Grayscale#Converting_color_to_grayscale
      var val = rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11;
      this.setValues("rgb", [val, val, val]);
      return this;
   },

   clearer: function(ratio) {
      this.setValues("alpha", this.values.alpha - (this.values.alpha * ratio));
      return this;
   },

   opaquer: function(ratio) {
      this.setValues("alpha", this.values.alpha + (this.values.alpha * ratio));
      return this;
   },

   rotate: function(degrees) {
      var hue = this.values.hsl[0];
      hue = (hue + degrees) % 360;
      hue = hue < 0 ? 360 + hue : hue;
      this.values.hsl[0] = hue;
      this.setValues("hsl", this.values.hsl);
      return this;
   },

   mix: function(color2, weight) {
      weight = 1 - (weight == null ? 0.5 : weight);

      // algorithm from Sass's mix(). Ratio of first color in mix is
      // determined by the alphas of both colors and the weight
      var t1 = weight * 2 - 1,
          d = this.alpha() - color2.alpha();

      var weight1 = (((t1 * d == -1) ? t1 : (t1 + d) / (1 + t1 * d)) + 1) / 2;
      var weight2 = 1 - weight1;

      var rgb = this.rgbArray();
      var rgb2 = color2.rgbArray();

      for (var i = 0; i < rgb.length; i++) {
         rgb[i] = rgb[i] * weight1 + rgb2[i] * weight2;
      }
      this.setValues("rgb", rgb);

      var alpha = this.alpha() * weight + color2.alpha() * (1 - weight);
      this.setValues("alpha", alpha);

      return this;
   },

   toJSON: function() {
     return this.rgb();
   },

   clone: function() {
     return new Color(this.rgb());
   }
}


Color.prototype.getValues = function(space) {
   var vals = {};
   for (var i = 0; i < space.length; i++) {
      vals[space[i]] = this.values[space][i];
   }
   if (this.values.alpha != 1) {
      vals["a"] = this.values.alpha;
   }
   // {r: 255, g: 255, b: 255, a: 0.4}
   return vals;
}

Color.prototype.setValues = function(space, vals) {
   var spaces = {
      "rgb": ["red", "green", "blue"],
      "hsl": ["hue", "saturation", "lightness"],
      "hsv": ["hue", "saturation", "value"],
      "hwb": ["hue", "whiteness", "blackness"],
      "cmyk": ["cyan", "magenta", "yellow", "black"]
   };

   var maxes = {
      "rgb": [255, 255, 255],
      "hsl": [360, 100, 100],
      "hsv": [360, 100, 100],
      "hwb": [360, 100, 100],
      "cmyk": [100, 100, 100, 100]
   };

   var alpha = 1;
   if (space == "alpha") {
      alpha = vals;
   }
   else if (vals.length) {
      // [10, 10, 10]
      this.values[space] = vals.slice(0, space.length);
      alpha = vals[space.length];
   }
   else if (vals[space[0]] !== undefined) {
      // {r: 10, g: 10, b: 10}
      for (var i = 0; i < space.length; i++) {
        this.values[space][i] = vals[space[i]];
      }
      alpha = vals.a;
   }
   else if (vals[spaces[space][0]] !== undefined) {
      // {red: 10, green: 10, blue: 10}
      var chans = spaces[space];
      for (var i = 0; i < space.length; i++) {
        this.values[space][i] = vals[chans[i]];
      }
      alpha = vals.alpha;
   }
   this.values.alpha = Math.max(0, Math.min(1, (alpha !== undefined ? alpha : this.values.alpha) ));
   if (space == "alpha") {
      return;
   }

   // cap values of the space prior converting all values
   for (var i = 0; i < space.length; i++) {
      var capped = Math.max(0, Math.min(maxes[space][i], this.values[space][i]));
      this.values[space][i] = Math.round(capped);
   }

   // convert to all the other color spaces
   for (var sname in spaces) {
      if (sname != space) {
         this.values[sname] = convert[space][sname](this.values[space])
      }

      // cap values
      for (var i = 0; i < sname.length; i++) {
         var capped = Math.max(0, Math.min(maxes[sname][i], this.values[sname][i]));
         this.values[sname][i] = Math.round(capped);
      }
   }
   return true;
}

Color.prototype.setSpace = function(space, args) {
   var vals = args[0];
   if (vals === undefined) {
      // color.rgb()
      return this.getValues(space);
   }
   // color.rgb(10, 10, 10)
   if (typeof vals == "number") {
      vals = Array.prototype.slice.call(args);
   }
   this.setValues(space, vals);
   return this;
}

Color.prototype.setChannel = function(space, index, val) {
   if (val === undefined) {
      // color.red()
      return this.values[space][index];
   }
   // color.red(100)
   this.values[space][index] = val;
   this.setValues(space, this.values[space]);
   return this;
}

module.exports = Color;

},{"color-convert":19,"color-string":20}],18:[function(require,module,exports){
/* MIT license */

module.exports = {
  rgb2hsl: rgb2hsl,
  rgb2hsv: rgb2hsv,
  rgb2hwb: rgb2hwb,
  rgb2cmyk: rgb2cmyk,
  rgb2keyword: rgb2keyword,
  rgb2xyz: rgb2xyz,
  rgb2lab: rgb2lab,
  rgb2lch: rgb2lch,

  hsl2rgb: hsl2rgb,
  hsl2hsv: hsl2hsv,
  hsl2hwb: hsl2hwb,
  hsl2cmyk: hsl2cmyk,
  hsl2keyword: hsl2keyword,

  hsv2rgb: hsv2rgb,
  hsv2hsl: hsv2hsl,
  hsv2hwb: hsv2hwb,
  hsv2cmyk: hsv2cmyk,
  hsv2keyword: hsv2keyword,

  hwb2rgb: hwb2rgb,
  hwb2hsl: hwb2hsl,
  hwb2hsv: hwb2hsv,
  hwb2cmyk: hwb2cmyk,
  hwb2keyword: hwb2keyword,

  cmyk2rgb: cmyk2rgb,
  cmyk2hsl: cmyk2hsl,
  cmyk2hsv: cmyk2hsv,
  cmyk2hwb: cmyk2hwb,
  cmyk2keyword: cmyk2keyword,

  keyword2rgb: keyword2rgb,
  keyword2hsl: keyword2hsl,
  keyword2hsv: keyword2hsv,
  keyword2hwb: keyword2hwb,
  keyword2cmyk: keyword2cmyk,
  keyword2lab: keyword2lab,
  keyword2xyz: keyword2xyz,

  xyz2rgb: xyz2rgb,
  xyz2lab: xyz2lab,
  xyz2lch: xyz2lch,

  lab2xyz: lab2xyz,
  lab2rgb: lab2rgb,
  lab2lch: lab2lch,

  lch2lab: lch2lab,
  lch2xyz: lch2xyz,
  lch2rgb: lch2rgb
}


function rgb2hsl(rgb) {
  var r = rgb[0]/255,
      g = rgb[1]/255,
      b = rgb[2]/255,
      min = Math.min(r, g, b),
      max = Math.max(r, g, b),
      delta = max - min,
      h, s, l;

  if (max == min)
    h = 0;
  else if (r == max)
    h = (g - b) / delta;
  else if (g == max)
    h = 2 + (b - r) / delta;
  else if (b == max)
    h = 4 + (r - g)/ delta;

  h = Math.min(h * 60, 360);

  if (h < 0)
    h += 360;

  l = (min + max) / 2;

  if (max == min)
    s = 0;
  else if (l <= 0.5)
    s = delta / (max + min);
  else
    s = delta / (2 - max - min);

  return [h, s * 100, l * 100];
}

function rgb2hsv(rgb) {
  var r = rgb[0],
      g = rgb[1],
      b = rgb[2],
      min = Math.min(r, g, b),
      max = Math.max(r, g, b),
      delta = max - min,
      h, s, v;

  if (max == 0)
    s = 0;
  else
    s = (delta/max * 1000)/10;

  if (max == min)
    h = 0;
  else if (r == max)
    h = (g - b) / delta;
  else if (g == max)
    h = 2 + (b - r) / delta;
  else if (b == max)
    h = 4 + (r - g) / delta;

  h = Math.min(h * 60, 360);

  if (h < 0)
    h += 360;

  v = ((max / 255) * 1000) / 10;

  return [h, s, v];
}

function rgb2hwb(rgb) {
  var r = rgb[0],
      g = rgb[1],
      b = rgb[2],
      h = rgb2hsl(rgb)[0],
      w = 1/255 * Math.min(r, Math.min(g, b)),
      b = 1 - 1/255 * Math.max(r, Math.max(g, b));

  return [h, w * 100, b * 100];
}

function rgb2cmyk(rgb) {
  var r = rgb[0] / 255,
      g = rgb[1] / 255,
      b = rgb[2] / 255,
      c, m, y, k;

  k = Math.min(1 - r, 1 - g, 1 - b);
  c = (1 - r - k) / (1 - k) || 0;
  m = (1 - g - k) / (1 - k) || 0;
  y = (1 - b - k) / (1 - k) || 0;
  return [c * 100, m * 100, y * 100, k * 100];
}

function rgb2keyword(rgb) {
  return reverseKeywords[JSON.stringify(rgb)];
}

function rgb2xyz(rgb) {
  var r = rgb[0] / 255,
      g = rgb[1] / 255,
      b = rgb[2] / 255;

  // assume sRGB
  r = r > 0.04045 ? Math.pow(((r + 0.055) / 1.055), 2.4) : (r / 12.92);
  g = g > 0.04045 ? Math.pow(((g + 0.055) / 1.055), 2.4) : (g / 12.92);
  b = b > 0.04045 ? Math.pow(((b + 0.055) / 1.055), 2.4) : (b / 12.92);

  var x = (r * 0.4124) + (g * 0.3576) + (b * 0.1805);
  var y = (r * 0.2126) + (g * 0.7152) + (b * 0.0722);
  var z = (r * 0.0193) + (g * 0.1192) + (b * 0.9505);

  return [x * 100, y *100, z * 100];
}

function rgb2lab(rgb) {
  var xyz = rgb2xyz(rgb),
        x = xyz[0],
        y = xyz[1],
        z = xyz[2],
        l, a, b;

  x /= 95.047;
  y /= 100;
  z /= 108.883;

  x = x > 0.008856 ? Math.pow(x, 1/3) : (7.787 * x) + (16 / 116);
  y = y > 0.008856 ? Math.pow(y, 1/3) : (7.787 * y) + (16 / 116);
  z = z > 0.008856 ? Math.pow(z, 1/3) : (7.787 * z) + (16 / 116);

  l = (116 * y) - 16;
  a = 500 * (x - y);
  b = 200 * (y - z);

  return [l, a, b];
}

function rgb2lch(args) {
  return lab2lch(rgb2lab(args));
}

function hsl2rgb(hsl) {
  var h = hsl[0] / 360,
      s = hsl[1] / 100,
      l = hsl[2] / 100,
      t1, t2, t3, rgb, val;

  if (s == 0) {
    val = l * 255;
    return [val, val, val];
  }

  if (l < 0.5)
    t2 = l * (1 + s);
  else
    t2 = l + s - l * s;
  t1 = 2 * l - t2;

  rgb = [0, 0, 0];
  for (var i = 0; i < 3; i++) {
    t3 = h + 1 / 3 * - (i - 1);
    t3 < 0 && t3++;
    t3 > 1 && t3--;

    if (6 * t3 < 1)
      val = t1 + (t2 - t1) * 6 * t3;
    else if (2 * t3 < 1)
      val = t2;
    else if (3 * t3 < 2)
      val = t1 + (t2 - t1) * (2 / 3 - t3) * 6;
    else
      val = t1;

    rgb[i] = val * 255;
  }

  return rgb;
}

function hsl2hsv(hsl) {
  var h = hsl[0],
      s = hsl[1] / 100,
      l = hsl[2] / 100,
      sv, v;
  l *= 2;
  s *= (l <= 1) ? l : 2 - l;
  v = (l + s) / 2;
  sv = (2 * s) / (l + s);
  return [h, sv * 100, v * 100];
}

function hsl2hwb(args) {
  return rgb2hwb(hsl2rgb(args));
}

function hsl2cmyk(args) {
  return rgb2cmyk(hsl2rgb(args));
}

function hsl2keyword(args) {
  return rgb2keyword(hsl2rgb(args));
}


function hsv2rgb(hsv) {
  var h = hsv[0] / 60,
      s = hsv[1] / 100,
      v = hsv[2] / 100,
      hi = Math.floor(h) % 6;

  var f = h - Math.floor(h),
      p = 255 * v * (1 - s),
      q = 255 * v * (1 - (s * f)),
      t = 255 * v * (1 - (s * (1 - f))),
      v = 255 * v;

  switch(hi) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    case 5:
      return [v, p, q];
  }
}

function hsv2hsl(hsv) {
  var h = hsv[0],
      s = hsv[1] / 100,
      v = hsv[2] / 100,
      sl, l;

  l = (2 - s) * v;
  sl = s * v;
  sl /= (l <= 1) ? l : 2 - l;
  sl = sl || 0;
  l /= 2;
  return [h, sl * 100, l * 100];
}

function hsv2hwb(args) {
  return rgb2hwb(hsv2rgb(args))
}

function hsv2cmyk(args) {
  return rgb2cmyk(hsv2rgb(args));
}

function hsv2keyword(args) {
  return rgb2keyword(hsv2rgb(args));
}

// http://dev.w3.org/csswg/css-color/#hwb-to-rgb
function hwb2rgb(hwb) {
  var h = hwb[0] / 360,
      wh = hwb[1] / 100,
      bl = hwb[2] / 100,
      ratio = wh + bl,
      i, v, f, n;

  // wh + bl cant be > 1
  if (ratio > 1) {
    wh /= ratio;
    bl /= ratio;
  }

  i = Math.floor(6 * h);
  v = 1 - bl;
  f = 6 * h - i;
  if ((i & 0x01) != 0) {
    f = 1 - f;
  }
  n = wh + f * (v - wh);  // linear interpolation

  switch (i) {
    default:
    case 6:
    case 0: r = v; g = n; b = wh; break;
    case 1: r = n; g = v; b = wh; break;
    case 2: r = wh; g = v; b = n; break;
    case 3: r = wh; g = n; b = v; break;
    case 4: r = n; g = wh; b = v; break;
    case 5: r = v; g = wh; b = n; break;
  }

  return [r * 255, g * 255, b * 255];
}

function hwb2hsl(args) {
  return rgb2hsl(hwb2rgb(args));
}

function hwb2hsv(args) {
  return rgb2hsv(hwb2rgb(args));
}

function hwb2cmyk(args) {
  return rgb2cmyk(hwb2rgb(args));
}

function hwb2keyword(args) {
  return rgb2keyword(hwb2rgb(args));
}

function cmyk2rgb(cmyk) {
  var c = cmyk[0] / 100,
      m = cmyk[1] / 100,
      y = cmyk[2] / 100,
      k = cmyk[3] / 100,
      r, g, b;

  r = 1 - Math.min(1, c * (1 - k) + k);
  g = 1 - Math.min(1, m * (1 - k) + k);
  b = 1 - Math.min(1, y * (1 - k) + k);
  return [r * 255, g * 255, b * 255];
}

function cmyk2hsl(args) {
  return rgb2hsl(cmyk2rgb(args));
}

function cmyk2hsv(args) {
  return rgb2hsv(cmyk2rgb(args));
}

function cmyk2hwb(args) {
  return rgb2hwb(cmyk2rgb(args));
}

function cmyk2keyword(args) {
  return rgb2keyword(cmyk2rgb(args));
}


function xyz2rgb(xyz) {
  var x = xyz[0] / 100,
      y = xyz[1] / 100,
      z = xyz[2] / 100,
      r, g, b;

  r = (x * 3.2406) + (y * -1.5372) + (z * -0.4986);
  g = (x * -0.9689) + (y * 1.8758) + (z * 0.0415);
  b = (x * 0.0557) + (y * -0.2040) + (z * 1.0570);

  // assume sRGB
  r = r > 0.0031308 ? ((1.055 * Math.pow(r, 1.0 / 2.4)) - 0.055)
    : r = (r * 12.92);

  g = g > 0.0031308 ? ((1.055 * Math.pow(g, 1.0 / 2.4)) - 0.055)
    : g = (g * 12.92);

  b = b > 0.0031308 ? ((1.055 * Math.pow(b, 1.0 / 2.4)) - 0.055)
    : b = (b * 12.92);

  r = Math.min(Math.max(0, r), 1);
  g = Math.min(Math.max(0, g), 1);
  b = Math.min(Math.max(0, b), 1);

  return [r * 255, g * 255, b * 255];
}

function xyz2lab(xyz) {
  var x = xyz[0],
      y = xyz[1],
      z = xyz[2],
      l, a, b;

  x /= 95.047;
  y /= 100;
  z /= 108.883;

  x = x > 0.008856 ? Math.pow(x, 1/3) : (7.787 * x) + (16 / 116);
  y = y > 0.008856 ? Math.pow(y, 1/3) : (7.787 * y) + (16 / 116);
  z = z > 0.008856 ? Math.pow(z, 1/3) : (7.787 * z) + (16 / 116);

  l = (116 * y) - 16;
  a = 500 * (x - y);
  b = 200 * (y - z);

  return [l, a, b];
}

function xyz2lch(args) {
  return lab2lch(xyz2lab(args));
}

function lab2xyz(lab) {
  var l = lab[0],
      a = lab[1],
      b = lab[2],
      x, y, z, y2;

  if (l <= 8) {
    y = (l * 100) / 903.3;
    y2 = (7.787 * (y / 100)) + (16 / 116);
  } else {
    y = 100 * Math.pow((l + 16) / 116, 3);
    y2 = Math.pow(y / 100, 1/3);
  }

  x = x / 95.047 <= 0.008856 ? x = (95.047 * ((a / 500) + y2 - (16 / 116))) / 7.787 : 95.047 * Math.pow((a / 500) + y2, 3);

  z = z / 108.883 <= 0.008859 ? z = (108.883 * (y2 - (b / 200) - (16 / 116))) / 7.787 : 108.883 * Math.pow(y2 - (b / 200), 3);

  return [x, y, z];
}

function lab2lch(lab) {
  var l = lab[0],
      a = lab[1],
      b = lab[2],
      hr, h, c;

  hr = Math.atan2(b, a);
  h = hr * 360 / 2 / Math.PI;
  if (h < 0) {
    h += 360;
  }
  c = Math.sqrt(a * a + b * b);
  return [l, c, h];
}

function lab2rgb(args) {
  return xyz2rgb(lab2xyz(args));
}

function lch2lab(lch) {
  var l = lch[0],
      c = lch[1],
      h = lch[2],
      a, b, hr;

  hr = h / 360 * 2 * Math.PI;
  a = c * Math.cos(hr);
  b = c * Math.sin(hr);
  return [l, a, b];
}

function lch2xyz(args) {
  return lab2xyz(lch2lab(args));
}

function lch2rgb(args) {
  return lab2rgb(lch2lab(args));
}

function keyword2rgb(keyword) {
  return cssKeywords[keyword];
}

function keyword2hsl(args) {
  return rgb2hsl(keyword2rgb(args));
}

function keyword2hsv(args) {
  return rgb2hsv(keyword2rgb(args));
}

function keyword2hwb(args) {
  return rgb2hwb(keyword2rgb(args));
}

function keyword2cmyk(args) {
  return rgb2cmyk(keyword2rgb(args));
}

function keyword2lab(args) {
  return rgb2lab(keyword2rgb(args));
}

function keyword2xyz(args) {
  return rgb2xyz(keyword2rgb(args));
}

var cssKeywords = {
  aliceblue:  [240,248,255],
  antiquewhite: [250,235,215],
  aqua: [0,255,255],
  aquamarine: [127,255,212],
  azure:  [240,255,255],
  beige:  [245,245,220],
  bisque: [255,228,196],
  black:  [0,0,0],
  blanchedalmond: [255,235,205],
  blue: [0,0,255],
  blueviolet: [138,43,226],
  brown:  [165,42,42],
  burlywood:  [222,184,135],
  cadetblue:  [95,158,160],
  chartreuse: [127,255,0],
  chocolate:  [210,105,30],
  coral:  [255,127,80],
  cornflowerblue: [100,149,237],
  cornsilk: [255,248,220],
  crimson:  [220,20,60],
  cyan: [0,255,255],
  darkblue: [0,0,139],
  darkcyan: [0,139,139],
  darkgoldenrod:  [184,134,11],
  darkgray: [169,169,169],
  darkgreen:  [0,100,0],
  darkgrey: [169,169,169],
  darkkhaki:  [189,183,107],
  darkmagenta:  [139,0,139],
  darkolivegreen: [85,107,47],
  darkorange: [255,140,0],
  darkorchid: [153,50,204],
  darkred:  [139,0,0],
  darksalmon: [233,150,122],
  darkseagreen: [143,188,143],
  darkslateblue:  [72,61,139],
  darkslategray:  [47,79,79],
  darkslategrey:  [47,79,79],
  darkturquoise:  [0,206,209],
  darkviolet: [148,0,211],
  deeppink: [255,20,147],
  deepskyblue:  [0,191,255],
  dimgray:  [105,105,105],
  dimgrey:  [105,105,105],
  dodgerblue: [30,144,255],
  firebrick:  [178,34,34],
  floralwhite:  [255,250,240],
  forestgreen:  [34,139,34],
  fuchsia:  [255,0,255],
  gainsboro:  [220,220,220],
  ghostwhite: [248,248,255],
  gold: [255,215,0],
  goldenrod:  [218,165,32],
  gray: [128,128,128],
  green:  [0,128,0],
  greenyellow:  [173,255,47],
  grey: [128,128,128],
  honeydew: [240,255,240],
  hotpink:  [255,105,180],
  indianred:  [205,92,92],
  indigo: [75,0,130],
  ivory:  [255,255,240],
  khaki:  [240,230,140],
  lavender: [230,230,250],
  lavenderblush:  [255,240,245],
  lawngreen:  [124,252,0],
  lemonchiffon: [255,250,205],
  lightblue:  [173,216,230],
  lightcoral: [240,128,128],
  lightcyan:  [224,255,255],
  lightgoldenrodyellow: [250,250,210],
  lightgray:  [211,211,211],
  lightgreen: [144,238,144],
  lightgrey:  [211,211,211],
  lightpink:  [255,182,193],
  lightsalmon:  [255,160,122],
  lightseagreen:  [32,178,170],
  lightskyblue: [135,206,250],
  lightslategray: [119,136,153],
  lightslategrey: [119,136,153],
  lightsteelblue: [176,196,222],
  lightyellow:  [255,255,224],
  lime: [0,255,0],
  limegreen:  [50,205,50],
  linen:  [250,240,230],
  magenta:  [255,0,255],
  maroon: [128,0,0],
  mediumaquamarine: [102,205,170],
  mediumblue: [0,0,205],
  mediumorchid: [186,85,211],
  mediumpurple: [147,112,219],
  mediumseagreen: [60,179,113],
  mediumslateblue:  [123,104,238],
  mediumspringgreen:  [0,250,154],
  mediumturquoise:  [72,209,204],
  mediumvioletred:  [199,21,133],
  midnightblue: [25,25,112],
  mintcream:  [245,255,250],
  mistyrose:  [255,228,225],
  moccasin: [255,228,181],
  navajowhite:  [255,222,173],
  navy: [0,0,128],
  oldlace:  [253,245,230],
  olive:  [128,128,0],
  olivedrab:  [107,142,35],
  orange: [255,165,0],
  orangered:  [255,69,0],
  orchid: [218,112,214],
  palegoldenrod:  [238,232,170],
  palegreen:  [152,251,152],
  paleturquoise:  [175,238,238],
  palevioletred:  [219,112,147],
  papayawhip: [255,239,213],
  peachpuff:  [255,218,185],
  peru: [205,133,63],
  pink: [255,192,203],
  plum: [221,160,221],
  powderblue: [176,224,230],
  purple: [128,0,128],
  rebeccapurple: [102, 51, 153],
  red:  [255,0,0],
  rosybrown:  [188,143,143],
  royalblue:  [65,105,225],
  saddlebrown:  [139,69,19],
  salmon: [250,128,114],
  sandybrown: [244,164,96],
  seagreen: [46,139,87],
  seashell: [255,245,238],
  sienna: [160,82,45],
  silver: [192,192,192],
  skyblue:  [135,206,235],
  slateblue:  [106,90,205],
  slategray:  [112,128,144],
  slategrey:  [112,128,144],
  snow: [255,250,250],
  springgreen:  [0,255,127],
  steelblue:  [70,130,180],
  tan:  [210,180,140],
  teal: [0,128,128],
  thistle:  [216,191,216],
  tomato: [255,99,71],
  turquoise:  [64,224,208],
  violet: [238,130,238],
  wheat:  [245,222,179],
  white:  [255,255,255],
  whitesmoke: [245,245,245],
  yellow: [255,255,0],
  yellowgreen:  [154,205,50]
};

var reverseKeywords = {};
for (var key in cssKeywords) {
  reverseKeywords[JSON.stringify(cssKeywords[key])] = key;
}

},{}],19:[function(require,module,exports){
var conversions = require("./conversions");

var convert = function() {
   return new Converter();
}

for (var func in conversions) {
  // export Raw versions
  convert[func + "Raw"] =  (function(func) {
    // accept array or plain args
    return function(arg) {
      if (typeof arg == "number")
        arg = Array.prototype.slice.call(arguments);
      return conversions[func](arg);
    }
  })(func);

  var pair = /(\w+)2(\w+)/.exec(func),
      from = pair[1],
      to = pair[2];

  // export rgb2hsl and ["rgb"]["hsl"]
  convert[from] = convert[from] || {};

  convert[from][to] = convert[func] = (function(func) { 
    return function(arg) {
      if (typeof arg == "number")
        arg = Array.prototype.slice.call(arguments);
      
      var val = conversions[func](arg);
      if (typeof val == "string" || val === undefined)
        return val; // keyword

      for (var i = 0; i < val.length; i++)
        val[i] = Math.round(val[i]);
      return val;
    }
  })(func);
}


/* Converter does lazy conversion and caching */
var Converter = function() {
   this.convs = {};
};

/* Either get the values for a space or
  set the values for a space, depending on args */
Converter.prototype.routeSpace = function(space, args) {
   var values = args[0];
   if (values === undefined) {
      // color.rgb()
      return this.getValues(space);
   }
   // color.rgb(10, 10, 10)
   if (typeof values == "number") {
      values = Array.prototype.slice.call(args);        
   }

   return this.setValues(space, values);
};
  
/* Set the values for a space, invalidating cache */
Converter.prototype.setValues = function(space, values) {
   this.space = space;
   this.convs = {};
   this.convs[space] = values;
   return this;
};

/* Get the values for a space. If there's already
  a conversion for the space, fetch it, otherwise
  compute it */
Converter.prototype.getValues = function(space) {
   var vals = this.convs[space];
   if (!vals) {
      var fspace = this.space,
          from = this.convs[fspace];
      vals = convert[fspace][space](from);

      this.convs[space] = vals;
   }
  return vals;
};

["rgb", "hsl", "hsv", "cmyk", "keyword"].forEach(function(space) {
   Converter.prototype[space] = function(vals) {
      return this.routeSpace(space, arguments);
   }
});

module.exports = convert;
},{"./conversions":18}],20:[function(require,module,exports){
/* MIT license */
var colorNames = require('color-name');

module.exports = {
   getRgba: getRgba,
   getHsla: getHsla,
   getRgb: getRgb,
   getHsl: getHsl,
   getHwb: getHwb,
   getAlpha: getAlpha,

   hexString: hexString,
   rgbString: rgbString,
   rgbaString: rgbaString,
   percentString: percentString,
   percentaString: percentaString,
   hslString: hslString,
   hslaString: hslaString,
   hwbString: hwbString,
   keyword: keyword
}

function getRgba(string) {
   if (!string) {
      return;
   }
   var abbr =  /^#([a-fA-F0-9]{3})$/,
       hex =  /^#([a-fA-F0-9]{6})$/,
       rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d\.]+)\s*)?\)$/,
       per = /^rgba?\(\s*([\d\.]+)\%\s*,\s*([\d\.]+)\%\s*,\s*([\d\.]+)\%\s*(?:,\s*([\d\.]+)\s*)?\)$/,
       keyword = /(\D+)/;

   var rgb = [0, 0, 0],
       a = 1,
       match = string.match(abbr);
   if (match) {
      match = match[1];
      for (var i = 0; i < rgb.length; i++) {
         rgb[i] = parseInt(match[i] + match[i], 16);
      }
   }
   else if (match = string.match(hex)) {
      match = match[1];
      for (var i = 0; i < rgb.length; i++) {
         rgb[i] = parseInt(match.slice(i * 2, i * 2 + 2), 16);
      }
   }
   else if (match = string.match(rgba)) {
      for (var i = 0; i < rgb.length; i++) {
         rgb[i] = parseInt(match[i + 1]);
      }
      a = parseFloat(match[4]);
   }
   else if (match = string.match(per)) {
      for (var i = 0; i < rgb.length; i++) {
         rgb[i] = Math.round(parseFloat(match[i + 1]) * 2.55);
      }
      a = parseFloat(match[4]);
   }
   else if (match = string.match(keyword)) {
      if (match[1] == "transparent") {
         return [0, 0, 0, 0];
      }
      rgb = colorNames[match[1]];
      if (!rgb) {
         return;
      }
   }

   for (var i = 0; i < rgb.length; i++) {
      rgb[i] = scale(rgb[i], 0, 255);
   }
   if (!a && a != 0) {
      a = 1;
   }
   else {
      a = scale(a, 0, 1);
   }
   rgb[3] = a;
   return rgb;
}

function getHsla(string) {
   if (!string) {
      return;
   }
   var hsl = /^hsla?\(\s*(\d+)(?:deg)?\s*,\s*([\d\.]+)%\s*,\s*([\d\.]+)%\s*(?:,\s*([\d\.]+)\s*)?\)/;
   var match = string.match(hsl);
   if (match) {
      var h = scale(parseInt(match[1]), 0, 360),
          s = scale(parseFloat(match[2]), 0, 100),
          l = scale(parseFloat(match[3]), 0, 100),
          a = scale(parseFloat(match[4]) || 1, 0, 1);
      return [h, s, l, a];
   }
}

function getHwb(string) {
   if (!string) {
      return;
   }
   var hwb = /^hwb\(\s*(\d+)(?:deg)?\s*,\s*([\d\.]+)%\s*,\s*([\d\.]+)%\s*(?:,\s*([\d\.]+)\s*)?\)/;
   var match = string.match(hwb);
   if (match) {
      var h = scale(parseInt(match[1]), 0, 360),
          w = scale(parseFloat(match[2]), 0, 100),
          b = scale(parseFloat(match[3]), 0, 100),
          a = scale(parseFloat(match[4]) || 1, 0, 1);
      return [h, w, b, a];
   }
}

function getRgb(string) {
   var rgba = getRgba(string);
   return rgba && rgba.slice(0, 3);
}

function getHsl(string) {
  var hsla = getHsla(string);
  return hsla && hsla.slice(0, 3);
}

function getAlpha(string) {
   var vals = getRgba(string);
   if (vals) {
      return vals[3];
   }
   else if (vals = getHsla(string)) {
      return vals[3];
   }
   else if (vals = getHwb(string)) {
      return vals[3];
   }
}

// generators
function hexString(rgb) {
   return "#" + hexDouble(rgb[0]) + hexDouble(rgb[1])
              + hexDouble(rgb[2]);
}

function rgbString(rgba, alpha) {
   if (alpha < 1 || (rgba[3] && rgba[3] < 1)) {
      return rgbaString(rgba, alpha);
   }
   return "rgb(" + rgba[0] + ", " + rgba[1] + ", " + rgba[2] + ")";
}

function rgbaString(rgba, alpha) {
   if (alpha === undefined) {
      alpha = (rgba[3] !== undefined ? rgba[3] : 1);
   }
   return "rgba(" + rgba[0] + ", " + rgba[1] + ", " + rgba[2]
           + ", " + alpha + ")";
}

function percentString(rgba, alpha) {
   if (alpha < 1 || (rgba[3] && rgba[3] < 1)) {
      return percentaString(rgba, alpha);
   }
   var r = Math.round(rgba[0]/255 * 100),
       g = Math.round(rgba[1]/255 * 100),
       b = Math.round(rgba[2]/255 * 100);

   return "rgb(" + r + "%, " + g + "%, " + b + "%)";
}

function percentaString(rgba, alpha) {
   var r = Math.round(rgba[0]/255 * 100),
       g = Math.round(rgba[1]/255 * 100),
       b = Math.round(rgba[2]/255 * 100);
   return "rgba(" + r + "%, " + g + "%, " + b + "%, " + (alpha || rgba[3] || 1) + ")";
}

function hslString(hsla, alpha) {
   if (alpha < 1 || (hsla[3] && hsla[3] < 1)) {
      return hslaString(hsla, alpha);
   }
   return "hsl(" + hsla[0] + ", " + hsla[1] + "%, " + hsla[2] + "%)";
}

function hslaString(hsla, alpha) {
   if (alpha === undefined) {
      alpha = (hsla[3] !== undefined ? hsla[3] : 1);
   }
   return "hsla(" + hsla[0] + ", " + hsla[1] + "%, " + hsla[2] + "%, "
           + alpha + ")";
}

// hwb is a bit different than rgb(a) & hsl(a) since there is no alpha specific syntax
// (hwb have alpha optional & 1 is default value)
function hwbString(hwb, alpha) {
   if (alpha === undefined) {
      alpha = (hwb[3] !== undefined ? hwb[3] : 1);
   }
   return "hwb(" + hwb[0] + ", " + hwb[1] + "%, " + hwb[2] + "%"
           + (alpha !== undefined && alpha !== 1 ? ", " + alpha : "") + ")";
}

function keyword(rgb) {
  return reverseNames[rgb.slice(0, 3)];
}

// helpers
function scale(num, min, max) {
   return Math.min(Math.max(min, num), max);
}

function hexDouble(num) {
  var str = num.toString(16).toUpperCase();
  return (str.length < 2) ? "0" + str : str;
}


//create a list of reverse color names
var reverseNames = {};
for (var name in colorNames) {
   reverseNames[colorNames[name]] = name;
}
},{"color-name":21}],21:[function(require,module,exports){
module.exports={
	"aliceblue": [240, 248, 255],
	"antiquewhite": [250, 235, 215],
	"aqua": [0, 255, 255],
	"aquamarine": [127, 255, 212],
	"azure": [240, 255, 255],
	"beige": [245, 245, 220],
	"bisque": [255, 228, 196],
	"black": [0, 0, 0],
	"blanchedalmond": [255, 235, 205],
	"blue": [0, 0, 255],
	"blueviolet": [138, 43, 226],
	"brown": [165, 42, 42],
	"burlywood": [222, 184, 135],
	"cadetblue": [95, 158, 160],
	"chartreuse": [127, 255, 0],
	"chocolate": [210, 105, 30],
	"coral": [255, 127, 80],
	"cornflowerblue": [100, 149, 237],
	"cornsilk": [255, 248, 220],
	"crimson": [220, 20, 60],
	"cyan": [0, 255, 255],
	"darkblue": [0, 0, 139],
	"darkcyan": [0, 139, 139],
	"darkgoldenrod": [184, 134, 11],
	"darkgray": [169, 169, 169],
	"darkgreen": [0, 100, 0],
	"darkgrey": [169, 169, 169],
	"darkkhaki": [189, 183, 107],
	"darkmagenta": [139, 0, 139],
	"darkolivegreen": [85, 107, 47],
	"darkorange": [255, 140, 0],
	"darkorchid": [153, 50, 204],
	"darkred": [139, 0, 0],
	"darksalmon": [233, 150, 122],
	"darkseagreen": [143, 188, 143],
	"darkslateblue": [72, 61, 139],
	"darkslategray": [47, 79, 79],
	"darkslategrey": [47, 79, 79],
	"darkturquoise": [0, 206, 209],
	"darkviolet": [148, 0, 211],
	"deeppink": [255, 20, 147],
	"deepskyblue": [0, 191, 255],
	"dimgray": [105, 105, 105],
	"dimgrey": [105, 105, 105],
	"dodgerblue": [30, 144, 255],
	"firebrick": [178, 34, 34],
	"floralwhite": [255, 250, 240],
	"forestgreen": [34, 139, 34],
	"fuchsia": [255, 0, 255],
	"gainsboro": [220, 220, 220],
	"ghostwhite": [248, 248, 255],
	"gold": [255, 215, 0],
	"goldenrod": [218, 165, 32],
	"gray": [128, 128, 128],
	"green": [0, 128, 0],
	"greenyellow": [173, 255, 47],
	"grey": [128, 128, 128],
	"honeydew": [240, 255, 240],
	"hotpink": [255, 105, 180],
	"indianred": [205, 92, 92],
	"indigo": [75, 0, 130],
	"ivory": [255, 255, 240],
	"khaki": [240, 230, 140],
	"lavender": [230, 230, 250],
	"lavenderblush": [255, 240, 245],
	"lawngreen": [124, 252, 0],
	"lemonchiffon": [255, 250, 205],
	"lightblue": [173, 216, 230],
	"lightcoral": [240, 128, 128],
	"lightcyan": [224, 255, 255],
	"lightgoldenrodyellow": [250, 250, 210],
	"lightgray": [211, 211, 211],
	"lightgreen": [144, 238, 144],
	"lightgrey": [211, 211, 211],
	"lightpink": [255, 182, 193],
	"lightsalmon": [255, 160, 122],
	"lightseagreen": [32, 178, 170],
	"lightskyblue": [135, 206, 250],
	"lightslategray": [119, 136, 153],
	"lightslategrey": [119, 136, 153],
	"lightsteelblue": [176, 196, 222],
	"lightyellow": [255, 255, 224],
	"lime": [0, 255, 0],
	"limegreen": [50, 205, 50],
	"linen": [250, 240, 230],
	"magenta": [255, 0, 255],
	"maroon": [128, 0, 0],
	"mediumaquamarine": [102, 205, 170],
	"mediumblue": [0, 0, 205],
	"mediumorchid": [186, 85, 211],
	"mediumpurple": [147, 112, 219],
	"mediumseagreen": [60, 179, 113],
	"mediumslateblue": [123, 104, 238],
	"mediumspringgreen": [0, 250, 154],
	"mediumturquoise": [72, 209, 204],
	"mediumvioletred": [199, 21, 133],
	"midnightblue": [25, 25, 112],
	"mintcream": [245, 255, 250],
	"mistyrose": [255, 228, 225],
	"moccasin": [255, 228, 181],
	"navajowhite": [255, 222, 173],
	"navy": [0, 0, 128],
	"oldlace": [253, 245, 230],
	"olive": [128, 128, 0],
	"olivedrab": [107, 142, 35],
	"orange": [255, 165, 0],
	"orangered": [255, 69, 0],
	"orchid": [218, 112, 214],
	"palegoldenrod": [238, 232, 170],
	"palegreen": [152, 251, 152],
	"paleturquoise": [175, 238, 238],
	"palevioletred": [219, 112, 147],
	"papayawhip": [255, 239, 213],
	"peachpuff": [255, 218, 185],
	"peru": [205, 133, 63],
	"pink": [255, 192, 203],
	"plum": [221, 160, 221],
	"powderblue": [176, 224, 230],
	"purple": [128, 0, 128],
	"rebeccapurple": [102, 51, 153],
	"red": [255, 0, 0],
	"rosybrown": [188, 143, 143],
	"royalblue": [65, 105, 225],
	"saddlebrown": [139, 69, 19],
	"salmon": [250, 128, 114],
	"sandybrown": [244, 164, 96],
	"seagreen": [46, 139, 87],
	"seashell": [255, 245, 238],
	"sienna": [160, 82, 45],
	"silver": [192, 192, 192],
	"skyblue": [135, 206, 235],
	"slateblue": [106, 90, 205],
	"slategray": [112, 128, 144],
	"slategrey": [112, 128, 144],
	"snow": [255, 250, 250],
	"springgreen": [0, 255, 127],
	"steelblue": [70, 130, 180],
	"tan": [210, 180, 140],
	"teal": [0, 128, 128],
	"thistle": [216, 191, 216],
	"tomato": [255, 99, 71],
	"turquoise": [64, 224, 208],
	"violet": [238, 130, 238],
	"wheat": [245, 222, 179],
	"white": [255, 255, 255],
	"whitesmoke": [245, 245, 245],
	"yellow": [255, 255, 0],
	"yellowgreen": [154, 205, 50]
}
},{}],22:[function(require,module,exports){
module.exports = [
  {
    "value":"#B0171F",
    "name":"indian red"
  },
  {
    "value":"#DC143C",
    "css":true,
    "name":"crimson"
  },
  {
    "value":"#FFB6C1",
    "css":true,
    "name":"lightpink"
  },
  {
    "value":"#FFAEB9",
    "name":"lightpink 1"
  },
  {
    "value":"#EEA2AD",
    "name":"lightpink 2"
  },
  {
    "value":"#CD8C95",
    "name":"lightpink 3"
  },
  {
    "value":"#8B5F65",
    "name":"lightpink 4"
  },
  {
    "value":"#FFC0CB",
    "css":true,
    "name":"pink"
  },
  {
    "value":"#FFB5C5",
    "name":"pink 1"
  },
  {
    "value":"#EEA9B8",
    "name":"pink 2"
  },
  {
    "value":"#CD919E",
    "name":"pink 3"
  },
  {
    "value":"#8B636C",
    "name":"pink 4"
  },
  {
    "value":"#DB7093",
    "css":true,
    "name":"palevioletred"
  },
  {
    "value":"#FF82AB",
    "name":"palevioletred 1"
  },
  {
    "value":"#EE799F",
    "name":"palevioletred 2"
  },
  {
    "value":"#CD6889",
    "name":"palevioletred 3"
  },
  {
    "value":"#8B475D",
    "name":"palevioletred 4"
  },
  {
    "value":"#FFF0F5",
    "name":"lavenderblush 1"
  },
  {
    "value":"#FFF0F5",
    "css":true,
    "name":"lavenderblush"
  },
  {
    "value":"#EEE0E5",
    "name":"lavenderblush 2"
  },
  {
    "value":"#CDC1C5",
    "name":"lavenderblush 3"
  },
  {
    "value":"#8B8386",
    "name":"lavenderblush 4"
  },
  {
    "value":"#FF3E96",
    "name":"violetred 1"
  },
  {
    "value":"#EE3A8C",
    "name":"violetred 2"
  },
  {
    "value":"#CD3278",
    "name":"violetred 3"
  },
  {
    "value":"#8B2252",
    "name":"violetred 4"
  },
  {
    "value":"#FF69B4",
    "css":true,
    "name":"hotpink"
  },
  {
    "value":"#FF6EB4",
    "name":"hotpink 1"
  },
  {
    "value":"#EE6AA7",
    "name":"hotpink 2"
  },
  {
    "value":"#CD6090",
    "name":"hotpink 3"
  },
  {
    "value":"#8B3A62",
    "name":"hotpink 4"
  },
  {
    "value":"#872657",
    "name":"raspberry"
  },
  {
    "value":"#FF1493",
    "name":"deeppink 1"
  },
  {
    "value":"#FF1493",
    "css":true,
    "name":"deeppink"
  },
  {
    "value":"#EE1289",
    "name":"deeppink 2"
  },
  {
    "value":"#CD1076",
    "name":"deeppink 3"
  },
  {
    "value":"#8B0A50",
    "name":"deeppink 4"
  },
  {
    "value":"#FF34B3",
    "name":"maroon 1"
  },
  {
    "value":"#EE30A7",
    "name":"maroon 2"
  },
  {
    "value":"#CD2990",
    "name":"maroon 3"
  },
  {
    "value":"#8B1C62",
    "name":"maroon 4"
  },
  {
    "value":"#C71585",
    "css":true,
    "name":"mediumvioletred"
  },
  {
    "value":"#D02090",
    "name":"violetred"
  },
  {
    "value":"#DA70D6",
    "css":true,
    "name":"orchid"
  },
  {
    "value":"#FF83FA",
    "name":"orchid 1"
  },
  {
    "value":"#EE7AE9",
    "name":"orchid 2"
  },
  {
    "value":"#CD69C9",
    "name":"orchid 3"
  },
  {
    "value":"#8B4789",
    "name":"orchid 4"
  },
  {
    "value":"#D8BFD8",
    "css":true,
    "name":"thistle"
  },
  {
    "value":"#FFE1FF",
    "name":"thistle 1"
  },
  {
    "value":"#EED2EE",
    "name":"thistle 2"
  },
  {
    "value":"#CDB5CD",
    "name":"thistle 3"
  },
  {
    "value":"#8B7B8B",
    "name":"thistle 4"
  },
  {
    "value":"#FFBBFF",
    "name":"plum 1"
  },
  {
    "value":"#EEAEEE",
    "name":"plum 2"
  },
  {
    "value":"#CD96CD",
    "name":"plum 3"
  },
  {
    "value":"#8B668B",
    "name":"plum 4"
  },
  {
    "value":"#DDA0DD",
    "css":true,
    "name":"plum"
  },
  {
    "value":"#EE82EE",
    "css":true,
    "name":"violet"
  },
  {
    "value":"#FF00FF",
    "vga":true,
    "name":"magenta"
  },
  {
    "value":"#FF00FF",
    "vga":true,
    "css":true,
    "name":"fuchsia"
  },
  {
    "value":"#EE00EE",
    "name":"magenta 2"
  },
  {
    "value":"#CD00CD",
    "name":"magenta 3"
  },
  {
    "value":"#8B008B",
    "name":"magenta 4"
  },
  {
    "value":"#8B008B",
    "css":true,
    "name":"darkmagenta"
  },
  {
    "value":"#800080",
    "vga":true,
    "css":true,
    "name":"purple"
  },
  {
    "value":"#BA55D3",
    "css":true,
    "name":"mediumorchid"
  },
  {
    "value":"#E066FF",
    "name":"mediumorchid 1"
  },
  {
    "value":"#D15FEE",
    "name":"mediumorchid 2"
  },
  {
    "value":"#B452CD",
    "name":"mediumorchid 3"
  },
  {
    "value":"#7A378B",
    "name":"mediumorchid 4"
  },
  {
    "value":"#9400D3",
    "css":true,
    "name":"darkviolet"
  },
  {
    "value":"#9932CC",
    "css":true,
    "name":"darkorchid"
  },
  {
    "value":"#BF3EFF",
    "name":"darkorchid 1"
  },
  {
    "value":"#B23AEE",
    "name":"darkorchid 2"
  },
  {
    "value":"#9A32CD",
    "name":"darkorchid 3"
  },
  {
    "value":"#68228B",
    "name":"darkorchid 4"
  },
  {
    "value":"#4B0082",
    "css":true,
    "name":"indigo"
  },
  {
    "value":"#8A2BE2",
    "css":true,
    "name":"blueviolet"
  },
  {
    "value":"#9B30FF",
    "name":"purple 1"
  },
  {
    "value":"#912CEE",
    "name":"purple 2"
  },
  {
    "value":"#7D26CD",
    "name":"purple 3"
  },
  {
    "value":"#551A8B",
    "name":"purple 4"
  },
  {
    "value":"#9370DB",
    "css":true,
    "name":"mediumpurple"
  },
  {
    "value":"#AB82FF",
    "name":"mediumpurple 1"
  },
  {
    "value":"#9F79EE",
    "name":"mediumpurple 2"
  },
  {
    "value":"#8968CD",
    "name":"mediumpurple 3"
  },
  {
    "value":"#5D478B",
    "name":"mediumpurple 4"
  },
  {
    "value":"#483D8B",
    "css":true,
    "name":"darkslateblue"
  },
  {
    "value":"#8470FF",
    "name":"lightslateblue"
  },
  {
    "value":"#7B68EE",
    "css":true,
    "name":"mediumslateblue"
  },
  {
    "value":"#6A5ACD",
    "css":true,
    "name":"slateblue"
  },
  {
    "value":"#836FFF",
    "name":"slateblue 1"
  },
  {
    "value":"#7A67EE",
    "name":"slateblue 2"
  },
  {
    "value":"#6959CD",
    "name":"slateblue 3"
  },
  {
    "value":"#473C8B",
    "name":"slateblue 4"
  },
  {
    "value":"#F8F8FF",
    "css":true,
    "name":"ghostwhite"
  },
  {
    "value":"#E6E6FA",
    "css":true,
    "name":"lavender"
  },
  {
    "value":"#0000FF",
    "vga":true,
    "css":true,
    "name":"blue"
  },
  {
    "value":"#0000EE",
    "name":"blue 2"
  },
  {
    "value":"#0000CD",
    "name":"blue 3"
  },
  {
    "value":"#0000CD",
    "css":true,
    "name":"mediumblue"
  },
  {
    "value":"#00008B",
    "name":"blue 4"
  },
  {
    "value":"#00008B",
    "css":true,
    "name":"darkblue"
  },
  {
    "value":"#000080",
    "vga":true,
    "css":true,
    "name":"navy"
  },
  {
    "value":"#191970",
    "css":true,
    "name":"midnightblue"
  },
  {
    "value":"#3D59AB",
    "name":"cobalt"
  },
  {
    "value":"#4169E1",
    "css":true,
    "name":"royalblue"
  },
  {
    "value":"#4876FF",
    "name":"royalblue 1"
  },
  {
    "value":"#436EEE",
    "name":"royalblue 2"
  },
  {
    "value":"#3A5FCD",
    "name":"royalblue 3"
  },
  {
    "value":"#27408B",
    "name":"royalblue 4"
  },
  {
    "value":"#6495ED",
    "css":true,
    "name":"cornflowerblue"
  },
  {
    "value":"#B0C4DE",
    "css":true,
    "name":"lightsteelblue"
  },
  {
    "value":"#CAE1FF",
    "name":"lightsteelblue 1"
  },
  {
    "value":"#BCD2EE",
    "name":"lightsteelblue 2"
  },
  {
    "value":"#A2B5CD",
    "name":"lightsteelblue 3"
  },
  {
    "value":"#6E7B8B",
    "name":"lightsteelblue 4"
  },
  {
    "value":"#778899",
    "css":true,
    "name":"lightslategray"
  },
  {
    "value":"#708090",
    "css":true,
    "name":"slategray"
  },
  {
    "value":"#C6E2FF",
    "name":"slategray 1"
  },
  {
    "value":"#B9D3EE",
    "name":"slategray 2"
  },
  {
    "value":"#9FB6CD",
    "name":"slategray 3"
  },
  {
    "value":"#6C7B8B",
    "name":"slategray 4"
  },
  {
    "value":"#1E90FF",
    "name":"dodgerblue 1"
  },
  {
    "value":"#1E90FF",
    "css":true,
    "name":"dodgerblue"
  },
  {
    "value":"#1C86EE",
    "name":"dodgerblue 2"
  },
  {
    "value":"#1874CD",
    "name":"dodgerblue 3"
  },
  {
    "value":"#104E8B",
    "name":"dodgerblue 4"
  },
  {
    "value":"#F0F8FF",
    "css":true,
    "name":"aliceblue"
  },
  {
    "value":"#4682B4",
    "css":true,
    "name":"steelblue"
  },
  {
    "value":"#63B8FF",
    "name":"steelblue 1"
  },
  {
    "value":"#5CACEE",
    "name":"steelblue 2"
  },
  {
    "value":"#4F94CD",
    "name":"steelblue 3"
  },
  {
    "value":"#36648B",
    "name":"steelblue 4"
  },
  {
    "value":"#87CEFA",
    "css":true,
    "name":"lightskyblue"
  },
  {
    "value":"#B0E2FF",
    "name":"lightskyblue 1"
  },
  {
    "value":"#A4D3EE",
    "name":"lightskyblue 2"
  },
  {
    "value":"#8DB6CD",
    "name":"lightskyblue 3"
  },
  {
    "value":"#607B8B",
    "name":"lightskyblue 4"
  },
  {
    "value":"#87CEFF",
    "name":"skyblue 1"
  },
  {
    "value":"#7EC0EE",
    "name":"skyblue 2"
  },
  {
    "value":"#6CA6CD",
    "name":"skyblue 3"
  },
  {
    "value":"#4A708B",
    "name":"skyblue 4"
  },
  {
    "value":"#87CEEB",
    "css":true,
    "name":"skyblue"
  },
  {
    "value":"#00BFFF",
    "name":"deepskyblue 1"
  },
  {
    "value":"#00BFFF",
    "css":true,
    "name":"deepskyblue"
  },
  {
    "value":"#00B2EE",
    "name":"deepskyblue 2"
  },
  {
    "value":"#009ACD",
    "name":"deepskyblue 3"
  },
  {
    "value":"#00688B",
    "name":"deepskyblue 4"
  },
  {
    "value":"#33A1C9",
    "name":"peacock"
  },
  {
    "value":"#ADD8E6",
    "css":true,
    "name":"lightblue"
  },
  {
    "value":"#BFEFFF",
    "name":"lightblue 1"
  },
  {
    "value":"#B2DFEE",
    "name":"lightblue 2"
  },
  {
    "value":"#9AC0CD",
    "name":"lightblue 3"
  },
  {
    "value":"#68838B",
    "name":"lightblue 4"
  },
  {
    "value":"#B0E0E6",
    "css":true,
    "name":"powderblue"
  },
  {
    "value":"#98F5FF",
    "name":"cadetblue 1"
  },
  {
    "value":"#8EE5EE",
    "name":"cadetblue 2"
  },
  {
    "value":"#7AC5CD",
    "name":"cadetblue 3"
  },
  {
    "value":"#53868B",
    "name":"cadetblue 4"
  },
  {
    "value":"#00F5FF",
    "name":"turquoise 1"
  },
  {
    "value":"#00E5EE",
    "name":"turquoise 2"
  },
  {
    "value":"#00C5CD",
    "name":"turquoise 3"
  },
  {
    "value":"#00868B",
    "name":"turquoise 4"
  },
  {
    "value":"#5F9EA0",
    "css":true,
    "name":"cadetblue"
  },
  {
    "value":"#00CED1",
    "css":true,
    "name":"darkturquoise"
  },
  {
    "value":"#F0FFFF",
    "name":"azure 1"
  },
  {
    "value":"#F0FFFF",
    "css":true,
    "name":"azure"
  },
  {
    "value":"#E0EEEE",
    "name":"azure 2"
  },
  {
    "value":"#C1CDCD",
    "name":"azure 3"
  },
  {
    "value":"#838B8B",
    "name":"azure 4"
  },
  {
    "value":"#E0FFFF",
    "name":"lightcyan 1"
  },
  {
    "value":"#E0FFFF",
    "css":true,
    "name":"lightcyan"
  },
  {
    "value":"#D1EEEE",
    "name":"lightcyan 2"
  },
  {
    "value":"#B4CDCD",
    "name":"lightcyan 3"
  },
  {
    "value":"#7A8B8B",
    "name":"lightcyan 4"
  },
  {
    "value":"#BBFFFF",
    "name":"paleturquoise 1"
  },
  {
    "value":"#AEEEEE",
    "name":"paleturquoise 2"
  },
  {
    "value":"#AEEEEE",
    "css":true,
    "name":"paleturquoise"
  },
  {
    "value":"#96CDCD",
    "name":"paleturquoise 3"
  },
  {
    "value":"#668B8B",
    "name":"paleturquoise 4"
  },
  {
    "value":"#2F4F4F",
    "css":true,
    "name":"darkslategray"
  },
  {
    "value":"#97FFFF",
    "name":"darkslategray 1"
  },
  {
    "value":"#8DEEEE",
    "name":"darkslategray 2"
  },
  {
    "value":"#79CDCD",
    "name":"darkslategray 3"
  },
  {
    "value":"#528B8B",
    "name":"darkslategray 4"
  },
  {
    "value":"#00FFFF",
    "name":"cyan"
  },
  {
    "value":"#00FFFF",
    "css":true,
    "name":"aqua"
  },
  {
    "value":"#00EEEE",
    "name":"cyan 2"
  },
  {
    "value":"#00CDCD",
    "name":"cyan 3"
  },
  {
    "value":"#008B8B",
    "name":"cyan 4"
  },
  {
    "value":"#008B8B",
    "css":true,
    "name":"darkcyan"
  },
  {
    "value":"#008080",
    "vga":true,
    "css":true,
    "name":"teal"
  },
  {
    "value":"#48D1CC",
    "css":true,
    "name":"mediumturquoise"
  },
  {
    "value":"#20B2AA",
    "css":true,
    "name":"lightseagreen"
  },
  {
    "value":"#03A89E",
    "name":"manganeseblue"
  },
  {
    "value":"#40E0D0",
    "css":true,
    "name":"turquoise"
  },
  {
    "value":"#808A87",
    "name":"coldgrey"
  },
  {
    "value":"#00C78C",
    "name":"turquoiseblue"
  },
  {
    "value":"#7FFFD4",
    "name":"aquamarine 1"
  },
  {
    "value":"#7FFFD4",
    "css":true,
    "name":"aquamarine"
  },
  {
    "value":"#76EEC6",
    "name":"aquamarine 2"
  },
  {
    "value":"#66CDAA",
    "name":"aquamarine 3"
  },
  {
    "value":"#66CDAA",
    "css":true,
    "name":"mediumaquamarine"
  },
  {
    "value":"#458B74",
    "name":"aquamarine 4"
  },
  {
    "value":"#00FA9A",
    "css":true,
    "name":"mediumspringgreen"
  },
  {
    "value":"#F5FFFA",
    "css":true,
    "name":"mintcream"
  },
  {
    "value":"#00FF7F",
    "css":true,
    "name":"springgreen"
  },
  {
    "value":"#00EE76",
    "name":"springgreen 1"
  },
  {
    "value":"#00CD66",
    "name":"springgreen 2"
  },
  {
    "value":"#008B45",
    "name":"springgreen 3"
  },
  {
    "value":"#3CB371",
    "css":true,
    "name":"mediumseagreen"
  },
  {
    "value":"#54FF9F",
    "name":"seagreen 1"
  },
  {
    "value":"#4EEE94",
    "name":"seagreen 2"
  },
  {
    "value":"#43CD80",
    "name":"seagreen 3"
  },
  {
    "value":"#2E8B57",
    "name":"seagreen 4"
  },
  {
    "value":"#2E8B57",
    "css":true,
    "name":"seagreen"
  },
  {
    "value":"#00C957",
    "name":"emeraldgreen"
  },
  {
    "value":"#BDFCC9",
    "name":"mint"
  },
  {
    "value":"#3D9140",
    "name":"cobaltgreen"
  },
  {
    "value":"#F0FFF0",
    "name":"honeydew 1"
  },
  {
    "value":"#F0FFF0",
    "css":true,
    "name":"honeydew"
  },
  {
    "value":"#E0EEE0",
    "name":"honeydew 2"
  },
  {
    "value":"#C1CDC1",
    "name":"honeydew 3"
  },
  {
    "value":"#838B83",
    "name":"honeydew 4"
  },
  {
    "value":"#8FBC8F",
    "css":true,
    "name":"darkseagreen"
  },
  {
    "value":"#C1FFC1",
    "name":"darkseagreen 1"
  },
  {
    "value":"#B4EEB4",
    "name":"darkseagreen 2"
  },
  {
    "value":"#9BCD9B",
    "name":"darkseagreen 3"
  },
  {
    "value":"#698B69",
    "name":"darkseagreen 4"
  },
  {
    "value":"#98FB98",
    "css":true,
    "name":"palegreen"
  },
  {
    "value":"#9AFF9A",
    "name":"palegreen 1"
  },
  {
    "value":"#90EE90",
    "name":"palegreen 2"
  },
  {
    "value":"#90EE90",
    "css":true,
    "name":"lightgreen"
  },
  {
    "value":"#7CCD7C",
    "name":"palegreen 3"
  },
  {
    "value":"#548B54",
    "name":"palegreen 4"
  },
  {
    "value":"#32CD32",
    "css":true,
    "name":"limegreen"
  },
  {
    "value":"#228B22",
    "css":true,
    "name":"forestgreen"
  },
  {
    "value":"#00FF00",
    "vga":true,
    "name":"green 1"
  },
  {
    "value":"#00FF00",
    "vga":true,
    "css":true,
    "name":"lime"
  },
  {
    "value":"#00EE00",
    "name":"green 2"
  },
  {
    "value":"#00CD00",
    "name":"green 3"
  },
  {
    "value":"#008B00",
    "name":"green 4"
  },
  {
    "value":"#008000",
    "vga":true,
    "css":true,
    "name":"green"
  },
  {
    "value":"#006400",
    "css":true,
    "name":"darkgreen"
  },
  {
    "value":"#308014",
    "name":"sapgreen"
  },
  {
    "value":"#7CFC00",
    "css":true,
    "name":"lawngreen"
  },
  {
    "value":"#7FFF00",
    "name":"chartreuse 1"
  },
  {
    "value":"#7FFF00",
    "css":true,
    "name":"chartreuse"
  },
  {
    "value":"#76EE00",
    "name":"chartreuse 2"
  },
  {
    "value":"#66CD00",
    "name":"chartreuse 3"
  },
  {
    "value":"#458B00",
    "name":"chartreuse 4"
  },
  {
    "value":"#ADFF2F",
    "css":true,
    "name":"greenyellow"
  },
  {
    "value":"#CAFF70",
    "name":"darkolivegreen 1"
  },
  {
    "value":"#BCEE68",
    "name":"darkolivegreen 2"
  },
  {
    "value":"#A2CD5A",
    "name":"darkolivegreen 3"
  },
  {
    "value":"#6E8B3D",
    "name":"darkolivegreen 4"
  },
  {
    "value":"#556B2F",
    "css":true,
    "name":"darkolivegreen"
  },
  {
    "value":"#6B8E23",
    "css":true,
    "name":"olivedrab"
  },
  {
    "value":"#C0FF3E",
    "name":"olivedrab 1"
  },
  {
    "value":"#B3EE3A",
    "name":"olivedrab 2"
  },
  {
    "value":"#9ACD32",
    "name":"olivedrab 3"
  },
  {
    "value":"#9ACD32",
    "css":true,
    "name":"yellowgreen"
  },
  {
    "value":"#698B22",
    "name":"olivedrab 4"
  },
  {
    "value":"#FFFFF0",
    "name":"ivory 1"
  },
  {
    "value":"#FFFFF0",
    "css":true,
    "name":"ivory"
  },
  {
    "value":"#EEEEE0",
    "name":"ivory 2"
  },
  {
    "value":"#CDCDC1",
    "name":"ivory 3"
  },
  {
    "value":"#8B8B83",
    "name":"ivory 4"
  },
  {
    "value":"#F5F5DC",
    "css":true,
    "name":"beige"
  },
  {
    "value":"#FFFFE0",
    "name":"lightyellow 1"
  },
  {
    "value":"#FFFFE0",
    "css":true,
    "name":"lightyellow"
  },
  {
    "value":"#EEEED1",
    "name":"lightyellow 2"
  },
  {
    "value":"#CDCDB4",
    "name":"lightyellow 3"
  },
  {
    "value":"#8B8B7A",
    "name":"lightyellow 4"
  },
  {
    "value":"#FAFAD2",
    "css":true,
    "name":"lightgoldenrodyellow"
  },
  {
    "value":"#FFFF00",
    "vga":true,
    "name":"yellow 1"
  },
  {
    "value":"#FFFF00",
    "vga":true,
    "css":true,
    "name":"yellow"
  },
  {
    "value":"#EEEE00",
    "name":"yellow 2"
  },
  {
    "value":"#CDCD00",
    "name":"yellow 3"
  },
  {
    "value":"#8B8B00",
    "name":"yellow 4"
  },
  {
    "value":"#808069",
    "name":"warmgrey"
  },
  {
    "value":"#808000",
    "vga":true,
    "css":true,
    "name":"olive"
  },
  {
    "value":"#BDB76B",
    "css":true,
    "name":"darkkhaki"
  },
  {
    "value":"#FFF68F",
    "name":"khaki 1"
  },
  {
    "value":"#EEE685",
    "name":"khaki 2"
  },
  {
    "value":"#CDC673",
    "name":"khaki 3"
  },
  {
    "value":"#8B864E",
    "name":"khaki 4"
  },
  {
    "value":"#F0E68C",
    "css":true,
    "name":"khaki"
  },
  {
    "value":"#EEE8AA",
    "css":true,
    "name":"palegoldenrod"
  },
  {
    "value":"#FFFACD",
    "name":"lemonchiffon 1"
  },
  {
    "value":"#FFFACD",
    "css":true,
    "name":"lemonchiffon"
  },
  {
    "value":"#EEE9BF",
    "name":"lemonchiffon 2"
  },
  {
    "value":"#CDC9A5",
    "name":"lemonchiffon 3"
  },
  {
    "value":"#8B8970",
    "name":"lemonchiffon 4"
  },
  {
    "value":"#FFEC8B",
    "name":"lightgoldenrod 1"
  },
  {
    "value":"#EEDC82",
    "name":"lightgoldenrod 2"
  },
  {
    "value":"#CDBE70",
    "name":"lightgoldenrod 3"
  },
  {
    "value":"#8B814C",
    "name":"lightgoldenrod 4"
  },
  {
    "value":"#E3CF57",
    "name":"banana"
  },
  {
    "value":"#FFD700",
    "name":"gold 1"
  },
  {
    "value":"#FFD700",
    "css":true,
    "name":"gold"
  },
  {
    "value":"#EEC900",
    "name":"gold 2"
  },
  {
    "value":"#CDAD00",
    "name":"gold 3"
  },
  {
    "value":"#8B7500",
    "name":"gold 4"
  },
  {
    "value":"#FFF8DC",
    "name":"cornsilk 1"
  },
  {
    "value":"#FFF8DC",
    "css":true,
    "name":"cornsilk"
  },
  {
    "value":"#EEE8CD",
    "name":"cornsilk 2"
  },
  {
    "value":"#CDC8B1",
    "name":"cornsilk 3"
  },
  {
    "value":"#8B8878",
    "name":"cornsilk 4"
  },
  {
    "value":"#DAA520",
    "css":true,
    "name":"goldenrod"
  },
  {
    "value":"#FFC125",
    "name":"goldenrod 1"
  },
  {
    "value":"#EEB422",
    "name":"goldenrod 2"
  },
  {
    "value":"#CD9B1D",
    "name":"goldenrod 3"
  },
  {
    "value":"#8B6914",
    "name":"goldenrod 4"
  },
  {
    "value":"#B8860B",
    "css":true,
    "name":"darkgoldenrod"
  },
  {
    "value":"#FFB90F",
    "name":"darkgoldenrod 1"
  },
  {
    "value":"#EEAD0E",
    "name":"darkgoldenrod 2"
  },
  {
    "value":"#CD950C",
    "name":"darkgoldenrod 3"
  },
  {
    "value":"#8B6508",
    "name":"darkgoldenrod 4"
  },
  {
    "value":"#FFA500",
    "name":"orange 1"
  },
  {
    "value":"#FF8000",
    "css":true,
    "name":"orange"
  },
  {
    "value":"#EE9A00",
    "name":"orange 2"
  },
  {
    "value":"#CD8500",
    "name":"orange 3"
  },
  {
    "value":"#8B5A00",
    "name":"orange 4"
  },
  {
    "value":"#FFFAF0",
    "css":true,
    "name":"floralwhite"
  },
  {
    "value":"#FDF5E6",
    "css":true,
    "name":"oldlace"
  },
  {
    "value":"#F5DEB3",
    "css":true,
    "name":"wheat"
  },
  {
    "value":"#FFE7BA",
    "name":"wheat 1"
  },
  {
    "value":"#EED8AE",
    "name":"wheat 2"
  },
  {
    "value":"#CDBA96",
    "name":"wheat 3"
  },
  {
    "value":"#8B7E66",
    "name":"wheat 4"
  },
  {
    "value":"#FFE4B5",
    "css":true,
    "name":"moccasin"
  },
  {
    "value":"#FFEFD5",
    "css":true,
    "name":"papayawhip"
  },
  {
    "value":"#FFEBCD",
    "css":true,
    "name":"blanchedalmond"
  },
  {
    "value":"#FFDEAD",
    "name":"navajowhite 1"
  },
  {
    "value":"#FFDEAD",
    "css":true,
    "name":"navajowhite"
  },
  {
    "value":"#EECFA1",
    "name":"navajowhite 2"
  },
  {
    "value":"#CDB38B",
    "name":"navajowhite 3"
  },
  {
    "value":"#8B795E",
    "name":"navajowhite 4"
  },
  {
    "value":"#FCE6C9",
    "name":"eggshell"
  },
  {
    "value":"#D2B48C",
    "css":true,
    "name":"tan"
  },
  {
    "value":"#9C661F",
    "name":"brick"
  },
  {
    "value":"#FF9912",
    "name":"cadmiumyellow"
  },
  {
    "value":"#FAEBD7",
    "css":true,
    "name":"antiquewhite"
  },
  {
    "value":"#FFEFDB",
    "name":"antiquewhite 1"
  },
  {
    "value":"#EEDFCC",
    "name":"antiquewhite 2"
  },
  {
    "value":"#CDC0B0",
    "name":"antiquewhite 3"
  },
  {
    "value":"#8B8378",
    "name":"antiquewhite 4"
  },
  {
    "value":"#DEB887",
    "css":true,
    "name":"burlywood"
  },
  {
    "value":"#FFD39B",
    "name":"burlywood 1"
  },
  {
    "value":"#EEC591",
    "name":"burlywood 2"
  },
  {
    "value":"#CDAA7D",
    "name":"burlywood 3"
  },
  {
    "value":"#8B7355",
    "name":"burlywood 4"
  },
  {
    "value":"#FFE4C4",
    "name":"bisque 1"
  },
  {
    "value":"#FFE4C4",
    "css":true,
    "name":"bisque"
  },
  {
    "value":"#EED5B7",
    "name":"bisque 2"
  },
  {
    "value":"#CDB79E",
    "name":"bisque 3"
  },
  {
    "value":"#8B7D6B",
    "name":"bisque 4"
  },
  {
    "value":"#E3A869",
    "name":"melon"
  },
  {
    "value":"#ED9121",
    "name":"carrot"
  },
  {
    "value":"#FF8C00",
    "css":true,
    "name":"darkorange"
  },
  {
    "value":"#FF7F00",
    "name":"darkorange 1"
  },
  {
    "value":"#EE7600",
    "name":"darkorange 2"
  },
  {
    "value":"#CD6600",
    "name":"darkorange 3"
  },
  {
    "value":"#8B4500",
    "name":"darkorange 4"
  },
  {
    "value":"#FFA54F",
    "name":"tan 1"
  },
  {
    "value":"#EE9A49",
    "name":"tan 2"
  },
  {
    "value":"#CD853F",
    "name":"tan 3"
  },
  {
    "value":"#CD853F",
    "css":true,
    "name":"peru"
  },
  {
    "value":"#8B5A2B",
    "name":"tan 4"
  },
  {
    "value":"#FAF0E6",
    "css":true,
    "name":"linen"
  },
  {
    "value":"#FFDAB9",
    "name":"peachpuff 1"
  },
  {
    "value":"#FFDAB9",
    "css":true,
    "name":"peachpuff"
  },
  {
    "value":"#EECBAD",
    "name":"peachpuff 2"
  },
  {
    "value":"#CDAF95",
    "name":"peachpuff 3"
  },
  {
    "value":"#8B7765",
    "name":"peachpuff 4"
  },
  {
    "value":"#FFF5EE",
    "name":"seashell 1"
  },
  {
    "value":"#FFF5EE",
    "css":true,
    "name":"seashell"
  },
  {
    "value":"#EEE5DE",
    "name":"seashell 2"
  },
  {
    "value":"#CDC5BF",
    "name":"seashell 3"
  },
  {
    "value":"#8B8682",
    "name":"seashell 4"
  },
  {
    "value":"#F4A460",
    "css":true,
    "name":"sandybrown"
  },
  {
    "value":"#C76114",
    "name":"rawsienna"
  },
  {
    "value":"#D2691E",
    "css":true,
    "name":"chocolate"
  },
  {
    "value":"#FF7F24",
    "name":"chocolate 1"
  },
  {
    "value":"#EE7621",
    "name":"chocolate 2"
  },
  {
    "value":"#CD661D",
    "name":"chocolate 3"
  },
  {
    "value":"#8B4513",
    "name":"chocolate 4"
  },
  {
    "value":"#8B4513",
    "css":true,
    "name":"saddlebrown"
  },
  {
    "value":"#292421",
    "name":"ivoryblack"
  },
  {
    "value":"#FF7D40",
    "name":"flesh"
  },
  {
    "value":"#FF6103",
    "name":"cadmiumorange"
  },
  {
    "value":"#8A360F",
    "name":"burntsienna"
  },
  {
    "value":"#A0522D",
    "css":true,
    "name":"sienna"
  },
  {
    "value":"#FF8247",
    "name":"sienna 1"
  },
  {
    "value":"#EE7942",
    "name":"sienna 2"
  },
  {
    "value":"#CD6839",
    "name":"sienna 3"
  },
  {
    "value":"#8B4726",
    "name":"sienna 4"
  },
  {
    "value":"#FFA07A",
    "name":"lightsalmon 1"
  },
  {
    "value":"#FFA07A",
    "css":true,
    "name":"lightsalmon"
  },
  {
    "value":"#EE9572",
    "name":"lightsalmon 2"
  },
  {
    "value":"#CD8162",
    "name":"lightsalmon 3"
  },
  {
    "value":"#8B5742",
    "name":"lightsalmon 4"
  },
  {
    "value":"#FF7F50",
    "css":true,
    "name":"coral"
  },
  {
    "value":"#FF4500",
    "name":"orangered 1"
  },
  {
    "value":"#FF4500",
    "css":true,
    "name":"orangered"
  },
  {
    "value":"#EE4000",
    "name":"orangered 2"
  },
  {
    "value":"#CD3700",
    "name":"orangered 3"
  },
  {
    "value":"#8B2500",
    "name":"orangered 4"
  },
  {
    "value":"#5E2612",
    "name":"sepia"
  },
  {
    "value":"#E9967A",
    "css":true,
    "name":"darksalmon"
  },
  {
    "value":"#FF8C69",
    "name":"salmon 1"
  },
  {
    "value":"#EE8262",
    "name":"salmon 2"
  },
  {
    "value":"#CD7054",
    "name":"salmon 3"
  },
  {
    "value":"#8B4C39",
    "name":"salmon 4"
  },
  {
    "value":"#FF7256",
    "name":"coral 1"
  },
  {
    "value":"#EE6A50",
    "name":"coral 2"
  },
  {
    "value":"#CD5B45",
    "name":"coral 3"
  },
  {
    "value":"#8B3E2F",
    "name":"coral 4"
  },
  {
    "value":"#8A3324",
    "name":"burntumber"
  },
  {
    "value":"#FF6347",
    "name":"tomato 1"
  },
  {
    "value":"#FF6347",
    "css":true,
    "name":"tomato"
  },
  {
    "value":"#EE5C42",
    "name":"tomato 2"
  },
  {
    "value":"#CD4F39",
    "name":"tomato 3"
  },
  {
    "value":"#8B3626",
    "name":"tomato 4"
  },
  {
    "value":"#FA8072",
    "css":true,
    "name":"salmon"
  },
  {
    "value":"#FFE4E1",
    "name":"mistyrose 1"
  },
  {
    "value":"#FFE4E1",
    "css":true,
    "name":"mistyrose"
  },
  {
    "value":"#EED5D2",
    "name":"mistyrose 2"
  },
  {
    "value":"#CDB7B5",
    "name":"mistyrose 3"
  },
  {
    "value":"#8B7D7B",
    "name":"mistyrose 4"
  },
  {
    "value":"#FFFAFA",
    "name":"snow 1"
  },
  {
    "value":"#FFFAFA",
    "css":true,
    "name":"snow"
  },
  {
    "value":"#EEE9E9",
    "name":"snow 2"
  },
  {
    "value":"#CDC9C9",
    "name":"snow 3"
  },
  {
    "value":"#8B8989",
    "name":"snow 4"
  },
  {
    "value":"#BC8F8F",
    "css":true,
    "name":"rosybrown"
  },
  {
    "value":"#FFC1C1",
    "name":"rosybrown 1"
  },
  {
    "value":"#EEB4B4",
    "name":"rosybrown 2"
  },
  {
    "value":"#CD9B9B",
    "name":"rosybrown 3"
  },
  {
    "value":"#8B6969",
    "name":"rosybrown 4"
  },
  {
    "value":"#F08080",
    "css":true,
    "name":"lightcoral"
  },
  {
    "value":"#CD5C5C",
    "css":true,
    "name":"indianred"
  },
  {
    "value":"#FF6A6A",
    "name":"indianred 1"
  },
  {
    "value":"#EE6363",
    "name":"indianred 2"
  },
  {
    "value":"#8B3A3A",
    "name":"indianred 4"
  },
  {
    "value":"#CD5555",
    "name":"indianred 3"
  },
  {
    "value":"#A52A2A",
    "css":true,
    "name":"brown"
  },
  {
    "value":"#FF4040",
    "name":"brown 1"
  },
  {
    "value":"#EE3B3B",
    "name":"brown 2"
  },
  {
    "value":"#CD3333",
    "name":"brown 3"
  },
  {
    "value":"#8B2323",
    "name":"brown 4"
  },
  {
    "value":"#B22222",
    "css":true,
    "name":"firebrick"
  },
  {
    "value":"#FF3030",
    "name":"firebrick 1"
  },
  {
    "value":"#EE2C2C",
    "name":"firebrick 2"
  },
  {
    "value":"#CD2626",
    "name":"firebrick 3"
  },
  {
    "value":"#8B1A1A",
    "name":"firebrick 4"
  },
  {
    "value":"#FF0000",
    "vga":true,
    "name":"red 1"
  },
  {
    "value":"#FF0000",
    "vga":true,
    "css":true,
    "name":"red"
  },
  {
    "value":"#EE0000",
    "name":"red 2"
  },
  {
    "value":"#CD0000",
    "name":"red 3"
  },
  {
    "value":"#8B0000",
    "name":"red 4"
  },
  {
    "value":"#8B0000",
    "css":true,
    "name":"darkred"
  },
  {
    "value":"#800000",
    "vga":true,
    "css":true,
    "name":"maroon"
  },
  {
    "value":"#8E388E",
    "name":"sgi beet"
  },
  {
    "value":"#7171C6",
    "name":"sgi slateblue"
  },
  {
    "value":"#7D9EC0",
    "name":"sgi lightblue"
  },
  {
    "value":"#388E8E",
    "name":"sgi teal"
  },
  {
    "value":"#71C671",
    "name":"sgi chartreuse"
  },
  {
    "value":"#8E8E38",
    "name":"sgi olivedrab"
  },
  {
    "value":"#C5C1AA",
    "name":"sgi brightgray"
  },
  {
    "value":"#C67171",
    "name":"sgi salmon"
  },
  {
    "value":"#555555",
    "name":"sgi darkgray"
  },
  {
    "value":"#1E1E1E",
    "name":"sgi gray 12"
  },
  {
    "value":"#282828",
    "name":"sgi gray 16"
  },
  {
    "value":"#515151",
    "name":"sgi gray 32"
  },
  {
    "value":"#5B5B5B",
    "name":"sgi gray 36"
  },
  {
    "value":"#848484",
    "name":"sgi gray 52"
  },
  {
    "value":"#8E8E8E",
    "name":"sgi gray 56"
  },
  {
    "value":"#AAAAAA",
    "name":"sgi lightgray"
  },
  {
    "value":"#B7B7B7",
    "name":"sgi gray 72"
  },
  {
    "value":"#C1C1C1",
    "name":"sgi gray 76"
  },
  {
    "value":"#EAEAEA",
    "name":"sgi gray 92"
  },
  {
    "value":"#F4F4F4",
    "name":"sgi gray 96"
  },
  {
    "value":"#FFFFFF",
    "vga":true,
    "css":true,
    "name":"white"
  },
  {
    "value":"#F5F5F5",
    "name":"white smoke"
  },
  {
    "value":"#F5F5F5",
    "name":"gray 96"
  },
  {
    "value":"#DCDCDC",
    "css":true,
    "name":"gainsboro"
  },
  {
    "value":"#D3D3D3",
    "css":true,
    "name":"lightgrey"
  },
  {
    "value":"#C0C0C0",
    "vga":true,
    "css":true,
    "name":"silver"
  },
  {
    "value":"#A9A9A9",
    "css":true,
    "name":"darkgray"
  },
  {
    "value":"#808080",
    "vga":true,
    "css":true,
    "name":"gray"
  },
  {
    "value":"#696969",
    "css":true,
    "name":"dimgray"
  },
  {
    "value":"#696969",
    "name":"gray 42"
  },
  {
    "value":"#000000",
    "vga":true,
    "css":true,
    "name":"black"
  },
  {
    "value":"#FCFCFC",
    "name":"gray 99"
  },
  {
    "value":"#FAFAFA",
    "name":"gray 98"
  },
  {
    "value":"#F7F7F7",
    "name":"gray 97"
  },
  {
    "value":"#F2F2F2",
    "name":"gray 95"
  },
  {
    "value":"#F0F0F0",
    "name":"gray 94"
  },
  {
    "value":"#EDEDED",
    "name":"gray 93"
  },
  {
    "value":"#EBEBEB",
    "name":"gray 92"
  },
  {
    "value":"#E8E8E8",
    "name":"gray 91"
  },
  {
    "value":"#E5E5E5",
    "name":"gray 90"
  },
  {
    "value":"#E3E3E3",
    "name":"gray 89"
  },
  {
    "value":"#E0E0E0",
    "name":"gray 88"
  },
  {
    "value":"#DEDEDE",
    "name":"gray 87"
  },
  {
    "value":"#DBDBDB",
    "name":"gray 86"
  },
  {
    "value":"#D9D9D9",
    "name":"gray 85"
  },
  {
    "value":"#D6D6D6",
    "name":"gray 84"
  },
  {
    "value":"#D4D4D4",
    "name":"gray 83"
  },
  {
    "value":"#D1D1D1",
    "name":"gray 82"
  },
  {
    "value":"#CFCFCF",
    "name":"gray 81"
  },
  {
    "value":"#CCCCCC",
    "name":"gray 80"
  },
  {
    "value":"#C9C9C9",
    "name":"gray 79"
  },
  {
    "value":"#C7C7C7",
    "name":"gray 78"
  },
  {
    "value":"#C4C4C4",
    "name":"gray 77"
  },
  {
    "value":"#C2C2C2",
    "name":"gray 76"
  },
  {
    "value":"#BFBFBF",
    "name":"gray 75"
  },
  {
    "value":"#BDBDBD",
    "name":"gray 74"
  },
  {
    "value":"#BABABA",
    "name":"gray 73"
  },
  {
    "value":"#B8B8B8",
    "name":"gray 72"
  },
  {
    "value":"#B5B5B5",
    "name":"gray 71"
  },
  {
    "value":"#B3B3B3",
    "name":"gray 70"
  },
  {
    "value":"#B0B0B0",
    "name":"gray 69"
  },
  {
    "value":"#ADADAD",
    "name":"gray 68"
  },
  {
    "value":"#ABABAB",
    "name":"gray 67"
  },
  {
    "value":"#A8A8A8",
    "name":"gray 66"
  },
  {
    "value":"#A6A6A6",
    "name":"gray 65"
  },
  {
    "value":"#A3A3A3",
    "name":"gray 64"
  },
  {
    "value":"#A1A1A1",
    "name":"gray 63"
  },
  {
    "value":"#9E9E9E",
    "name":"gray 62"
  },
  {
    "value":"#9C9C9C",
    "name":"gray 61"
  },
  {
    "value":"#999999",
    "name":"gray 60"
  },
  {
    "value":"#969696",
    "name":"gray 59"
  },
  {
    "value":"#949494",
    "name":"gray 58"
  },
  {
    "value":"#919191",
    "name":"gray 57"
  },
  {
    "value":"#8F8F8F",
    "name":"gray 56"
  },
  {
    "value":"#8C8C8C",
    "name":"gray 55"
  },
  {
    "value":"#8A8A8A",
    "name":"gray 54"
  },
  {
    "value":"#878787",
    "name":"gray 53"
  },
  {
    "value":"#858585",
    "name":"gray 52"
  },
  {
    "value":"#828282",
    "name":"gray 51"
  },
  {
    "value":"#7F7F7F",
    "name":"gray 50"
  },
  {
    "value":"#7D7D7D",
    "name":"gray 49"
  },
  {
    "value":"#7A7A7A",
    "name":"gray 48"
  },
  {
    "value":"#787878",
    "name":"gray 47"
  },
  {
    "value":"#757575",
    "name":"gray 46"
  },
  {
    "value":"#737373",
    "name":"gray 45"
  },
  {
    "value":"#707070",
    "name":"gray 44"
  },
  {
    "value":"#6E6E6E",
    "name":"gray 43"
  },
  {
    "value":"#666666",
    "name":"gray 40"
  },
  {
    "value":"#636363",
    "name":"gray 39"
  },
  {
    "value":"#616161",
    "name":"gray 38"
  },
  {
    "value":"#5E5E5E",
    "name":"gray 37"
  },
  {
    "value":"#5C5C5C",
    "name":"gray 36"
  },
  {
    "value":"#595959",
    "name":"gray 35"
  },
  {
    "value":"#575757",
    "name":"gray 34"
  },
  {
    "value":"#545454",
    "name":"gray 33"
  },
  {
    "value":"#525252",
    "name":"gray 32"
  },
  {
    "value":"#4F4F4F",
    "name":"gray 31"
  },
  {
    "value":"#4D4D4D",
    "name":"gray 30"
  },
  {
    "value":"#4A4A4A",
    "name":"gray 29"
  },
  {
    "value":"#474747",
    "name":"gray 28"
  },
  {
    "value":"#454545",
    "name":"gray 27"
  },
  {
    "value":"#424242",
    "name":"gray 26"
  },
  {
    "value":"#404040",
    "name":"gray 25"
  },
  {
    "value":"#3D3D3D",
    "name":"gray 24"
  },
  {
    "value":"#3B3B3B",
    "name":"gray 23"
  },
  {
    "value":"#383838",
    "name":"gray 22"
  },
  {
    "value":"#363636",
    "name":"gray 21"
  },
  {
    "value":"#333333",
    "name":"gray 20"
  },
  {
    "value":"#303030",
    "name":"gray 19"
  },
  {
    "value":"#2E2E2E",
    "name":"gray 18"
  },
  {
    "value":"#2B2B2B",
    "name":"gray 17"
  },
  {
    "value":"#292929",
    "name":"gray 16"
  },
  {
    "value":"#262626",
    "name":"gray 15"
  },
  {
    "value":"#242424",
    "name":"gray 14"
  },
  {
    "value":"#212121",
    "name":"gray 13"
  },
  {
    "value":"#1F1F1F",
    "name":"gray 12"
  },
  {
    "value":"#1C1C1C",
    "name":"gray 11"
  },
  {
    "value":"#1A1A1A",
    "name":"gray 10"
  },
  {
    "value":"#171717",
    "name":"gray 9"
  },
  {
    "value":"#141414",
    "name":"gray 8"
  },
  {
    "value":"#121212",
    "name":"gray 7"
  },
  {
    "value":"#0F0F0F",
    "name":"gray 6"
  },
  {
    "value":"#0D0D0D",
    "name":"gray 5"
  },
  {
    "value":"#0A0A0A",
    "name":"gray 4"
  },
  {
    "value":"#080808",
    "name":"gray 3"
  },
  {
    "value":"#050505",
    "name":"gray 2"
  },
  {
    "value":"#030303",
    "name":"gray 1"
  },
  {
    "value":"#F5F5F5",
    "css":true,
    "name":"whitesmoke"
  }
]

},{}],23:[function(require,module,exports){
/**
 * Module dependencies
 */
var colors = require('./colors')

var cssColors = colors.filter(function(color){
  return !! color.css
})

var vgaColors = colors.filter(function(color){
  return !! color.vga
})


/**
 * Get color value for a certain name.
 * @param name {String}
 * @return {String} Hex color value
 * @api public
 */

module.exports = function(name) {
  var color = module.exports.get(name)
  return color && color.value
}

/**
 * Get color object.
 *
 * @param name {String}
 * @return {Object} Color object
 * @api public
 */

module.exports.get = function(name) {
  name = name || ''
  name = name.trim()
  return colors.filter(function(color){
    return color.name === name
  }).pop()
}

/**
 * Get all color object.
 *
 * @return {Array}
 * @api public
 */

module.exports.all = module.exports.get.all = function() {
 return colors
}

/**
 * Get color object compatible with CSS.
 *
 * @return {Array}
 * @api public
 */

module.exports.get.css = function(name) {
  if (!name) return cssColors
  name = name || ''
  name = name.trim()
  return cssColors.filter(function(color){
    return color.name === name
  }).pop()
}



module.exports.get.vga = function(name) {
  if (!name) return vgaColors
  name = name || ''
  name = name.trim()
  return vgaColors.filter(function(color){
    return color.name === name
  }).pop()
}

},{"./colors":22}],24:[function(require,module,exports){
(function (process){
'use strict';

var has = Object.prototype.hasOwnProperty;

/**
 * Gather environment variables from various locations.
 *
 * @param {Object} environment The default environment variables.
 * @returns {Object} environment.
 * @api public
 */
function env(environment) {
  environment = environment || {};

  if ('object' === typeof process && 'object' === typeof process.env) {
    env.merge(environment, process.env);
  }

  if ('undefined' !== typeof window) {
    if ('string' === window.name && window.name.length) {
      env.merge(environment, env.parse(window.name));
    }

    try { env.merge(environment, env.parse(window.localStorage.env || window.localStorage.debug)); }
    catch (e) {}

    if (
         'object' === typeof window.location
      && 'string' === typeof window.location.hash
      && window.location.hash.length
    ) {
      env.merge(environment, env.parse(window.location.hash.charAt(0) === '#'
        ? window.location.hash.slice(1)
        : window.location.hash
      ));
    }
  }

  //
  // Also add lower case variants to the object for easy access.
  //
  var key, lower;
  for (key in environment) {
    lower = key.toLowerCase();

    if (!(lower in environment)) {
      environment[lower] = environment[key];
    }
  }

  return environment;
}

/**
 * A poor man's merge utility.
 *
 * @param {Object} base Object where the add object is merged in.
 * @param {Object} add Object that needs to be added to the base object.
 * @returns {Object} base
 * @api private
 */
env.merge = function merge(base, add) {
  for (var key in add) {
    if (has.call(add, key)) {
      base[key] = add[key];
    }
  }

  return base;
};

/**
 * A poor man's query string parser.
 *
 * @param {String} query The query string that needs to be parsed.
 * @returns {Object} Key value mapped query string.
 * @api private
 */
env.parse = function parse(query) {
  var parser = /([^=?&]+)=([^&]*)/g
    , result = {}
    , part;

  if (!query) return result;

  for (;
    part = parser.exec(query);
    result[decodeURIComponent(part[1])] = decodeURIComponent(part[2])
  );

  return result.env || result;
};

//
// Expose the module
//
module.exports = env;

}).call(this,require('_process'))
},{"_process":61}],25:[function(require,module,exports){
'use strict';

var colornames = require('colornames');

/**
 * Kuler: Color text using CSS colors
 *
 * @constructor
 * @param {String} text The text that needs to be styled
 * @param {String} color Optional color for alternate API.
 * @api public
 */
function Kuler(text, color) {
  if (color) return (new Kuler(text)).style(color);
  if (!(this instanceof Kuler)) return new Kuler(text);

  this.text = text;
}

/**
 * ANSI color codes.
 *
 * @type {String}
 * @private
 */
Kuler.prototype.prefix = '\x1b[';
Kuler.prototype.suffix = 'm';

/**
 * Parse a hex color string and parse it to it's RGB equiv.
 *
 * @param {String} color
 * @returns {Array}
 * @api private
 */
Kuler.prototype.hex = function hex(color) {
  color = color[0] === '#' ? color.substring(1) : color;

  //
  // Pre-parse for shorthand hex colors.
  //
  if (color.length === 3) {
    color = color.split('');

    color[5] = color[2]; // F60##0
    color[4] = color[2]; // F60#00
    color[3] = color[1]; // F60600
    color[2] = color[1]; // F66600
    color[1] = color[0]; // FF6600

    color = color.join('');
  }

  var r = color.substring(0, 2)
    , g = color.substring(2, 4)
    , b = color.substring(4, 6);

  return [ parseInt(r, 16), parseInt(g, 16), parseInt(b, 16) ];
};

/**
 * Transform a 255 RGB value to an RGV code.
 *
 * @param {Number} r Red color channel.
 * @param {Number} g Green color channel.
 * @param {Number} b Blue color channel.
 * @returns {String}
 * @api public
 */
Kuler.prototype.rgb = function rgb(r, g, b) {
  var red = r / 255 * 5
    , green = g / 255 * 5
    , blue = b / 255 * 5;

  return this.ansi(red, green, blue);
};

/**
 * Turns RGB 0-5 values into a single ANSI code.
 *
 * @param {Number} r Red color channel.
 * @param {Number} g Green color channel.
 * @param {Number} b Blue color channel.
 * @returns {String}
 * @api public
 */
Kuler.prototype.ansi = function ansi(r, g, b) {
  var red = Math.round(r)
    , green = Math.round(g)
    , blue = Math.round(b);

  return 16 + (red * 36) + (green * 6) + blue;
};

/**
 * Marks an end of color sequence.
 *
 * @returns {String} Reset sequence.
 * @api public
 */
Kuler.prototype.reset = function reset() {
  return this.prefix +'39;49'+ this.suffix;
};

/**
 * Colour the terminal using CSS.
 *
 * @param {String} color The HEX color code.
 * @returns {String} the escape code.
 * @api public
 */
Kuler.prototype.style = function style(color) {
  //
  // We've been supplied a CSS color name instead of a hex color format so we
  // need to transform it to proper CSS color and continue with our execution
  // flow.
  //
  if (!/^#?(?:[0-9a-fA-F]{3}){1,2}$/.test(color)) {
    color = colornames(color);
  }

  return this.prefix +'38;5;'+ this.rgb.apply(this, this.hex(color)) + this.suffix + this.text + this.reset();
};


//
// Expose the actual interface.
//
module.exports = Kuler;

},{"colornames":23}],26:[function(require,module,exports){
'use strict';

/***
 * Convert string to hex color.
 *
 * @param {String} str Text to hash and convert to hex.
 * @returns {String}
 * @api public
 */
module.exports = function hex(str) {
  for (
    var i = 0, hash = 0;
    i < str.length;
    hash = str.charCodeAt(i++) + ((hash << 5) - hash)
  );

  var color = Math.floor(
    Math.abs(
      (Math.sin(hash) * 10000) % 1 * 16777216
    )
  ).toString(16);

  return '#' + Array(6 - color.length + 1).join('0') + color;
};

},{}],27:[function(require,module,exports){
'use strict';

/**
 * Representation of a single EventEmitter function.
 *
 * @param {Function} fn Event handler to be called.
 * @param {Mixed} context Context for function execution.
 * @param {Boolean} once Only emit once
 * @api private
 */
function EE(fn, context, once) {
  this.fn = fn;
  this.context = context;
  this.once = once || false;
}

/**
 * Minimal EventEmitter interface that is molded against the Node.js
 * EventEmitter interface.
 *
 * @constructor
 * @api public
 */
function EventEmitter() { /* Nothing to set */ }

/**
 * Holds the assigned EventEmitters by name.
 *
 * @type {Object}
 * @private
 */
EventEmitter.prototype._events = undefined;

/**
 * Return a list of assigned event listeners.
 *
 * @param {String} event The events that should be listed.
 * @returns {Array}
 * @api public
 */
EventEmitter.prototype.listeners = function listeners(event) {
  if (!this._events || !this._events[event]) return [];
  if (this._events[event].fn) return [this._events[event].fn];

  for (var i = 0, l = this._events[event].length, ee = new Array(l); i < l; i++) {
    ee[i] = this._events[event][i].fn;
  }

  return ee;
};

/**
 * Emit an event to all registered event listeners.
 *
 * @param {String} event The name of the event.
 * @returns {Boolean} Indication if we've emitted an event.
 * @api public
 */
EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
  if (!this._events || !this._events[event]) return false;

  var listeners = this._events[event]
    , len = arguments.length
    , args
    , i;

  if ('function' === typeof listeners.fn) {
    if (listeners.once) this.removeListener(event, listeners.fn, true);

    switch (len) {
      case 1: return listeners.fn.call(listeners.context), true;
      case 2: return listeners.fn.call(listeners.context, a1), true;
      case 3: return listeners.fn.call(listeners.context, a1, a2), true;
      case 4: return listeners.fn.call(listeners.context, a1, a2, a3), true;
      case 5: return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
      case 6: return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
    }

    for (i = 1, args = new Array(len -1); i < len; i++) {
      args[i - 1] = arguments[i];
    }

    listeners.fn.apply(listeners.context, args);
  } else {
    var length = listeners.length
      , j;

    for (i = 0; i < length; i++) {
      if (listeners[i].once) this.removeListener(event, listeners[i].fn, true);

      switch (len) {
        case 1: listeners[i].fn.call(listeners[i].context); break;
        case 2: listeners[i].fn.call(listeners[i].context, a1); break;
        case 3: listeners[i].fn.call(listeners[i].context, a1, a2); break;
        default:
          if (!args) for (j = 1, args = new Array(len -1); j < len; j++) {
            args[j - 1] = arguments[j];
          }

          listeners[i].fn.apply(listeners[i].context, args);
      }
    }
  }

  return true;
};

/**
 * Register a new EventListener for the given event.
 *
 * @param {String} event Name of the event.
 * @param {Functon} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @api public
 */
EventEmitter.prototype.on = function on(event, fn, context) {
  var listener = new EE(fn, context || this);

  if (!this._events) this._events = {};
  if (!this._events[event]) this._events[event] = listener;
  else {
    if (!this._events[event].fn) this._events[event].push(listener);
    else this._events[event] = [
      this._events[event], listener
    ];
  }

  return this;
};

/**
 * Add an EventListener that's only called once.
 *
 * @param {String} event Name of the event.
 * @param {Function} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @api public
 */
EventEmitter.prototype.once = function once(event, fn, context) {
  var listener = new EE(fn, context || this, true);

  if (!this._events) this._events = {};
  if (!this._events[event]) this._events[event] = listener;
  else {
    if (!this._events[event].fn) this._events[event].push(listener);
    else this._events[event] = [
      this._events[event], listener
    ];
  }

  return this;
};

/**
 * Remove event listeners.
 *
 * @param {String} event The event we want to remove.
 * @param {Function} fn The listener that we need to find.
 * @param {Boolean} once Only remove once listeners.
 * @api public
 */
EventEmitter.prototype.removeListener = function removeListener(event, fn, once) {
  if (!this._events || !this._events[event]) return this;

  var listeners = this._events[event]
    , events = [];

  if (fn) {
    if (listeners.fn && (listeners.fn !== fn || (once && !listeners.once))) {
      events.push(listeners);
    }
    if (!listeners.fn) for (var i = 0, length = listeners.length; i < length; i++) {
      if (listeners[i].fn !== fn || (once && !listeners[i].once)) {
        events.push(listeners[i]);
      }
    }
  }

  //
  // Reset the array, or remove it completely if we have no more listeners.
  //
  if (events.length) {
    this._events[event] = events.length === 1 ? events[0] : events;
  } else {
    delete this._events[event];
  }

  return this;
};

/**
 * Remove all listeners or only the listeners for the specified event.
 *
 * @param {String} event The event want to remove all listeners for.
 * @api public
 */
EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
  if (!this._events) return this;

  if (event) delete this._events[event];
  else this._events = {};

  return this;
};

//
// Alias methods names because people roll like that.
//
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

//
// This function doesn't apply anymore.
//
EventEmitter.prototype.setMaxListeners = function setMaxListeners() {
  return this;
};

//
// Expose the module.
//
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.EventEmitter2 = EventEmitter;
EventEmitter.EventEmitter3 = EventEmitter;

//
// Expose the module.
//
module.exports = EventEmitter;

},{}],28:[function(require,module,exports){
'use strict';

var net = require('net');

/**
 * Forwarded instance.
 *
 * @constructor
 * @param {String} ip The IP address.
 * @param {Number} port The port number.
 * @param {Boolean} secured The connection was secured.
 * @api private
 */
function Forwarded(ip, port, secured) {
  this.ip = ip || '127.0.0.1';
  this.secure = !!secured;
  this.port = +port || 0;
}

/**
 * List of possible proxy headers that should be checked for the original client
 * IP address and forwarded port.
 *
 * @type {Array}
 * @private
 */
var proxies = [
  {
    ip: 'fastly-client-ip',
    port: 'fastly-client-port', // Estimated guess, no standard header available.
    proto: 'fastly-ssl'
  },
  {
    ip: 'x-forwarded-for',
    port: 'x-forwarded-port',
    proto: 'x-forwarded-proto'
  }, {
    ip: 'z-forwarded-for',
    port: 'z-forwarded-port',   // Estimated guess, no standard header available.
    proto: 'z-forwarded-proto'  // Estimated guess, no standard header available.
  }, {
    ip: 'forwarded',
    port: 'forwarded-port',
    proto: 'forwarded-proto'    // Estimated guess, no standard header available.
  }, {
    ip: 'x-real-ip',
    port: 'x-real-port',        // Estimated guess, no standard header available.
    proto: 'x-real-proto'       // Estimated guess, no standard header available.
  }
];

/**
 * Search the headers for a possible match against a known proxy header.
 *
 * @param {Object} headers The received HTTP headers.
 * @param {Array} whitelist White list of proxies that should be checked.
 * @returns {String|Undefined} A IP address or nothing.
 * @api private
 */
function forwarded(headers, whitelist) {
  var ports, port, proto, ips, ip, length = proxies.length, i = 0;

  for (; i < length; i++) {
    if (!(proxies[i].ip in headers)) continue;

    ports = (headers[proxies[i].port] || '').split(',');
    ips = (headers[proxies[i].ip] || '').split(',');
    proto = (headers[proxies[i].proto] || 'http');

    //
    // As these headers can potentially be set by a 1337H4X0R we need to ensure
    // that all supplied values are valid IP addresses. If we receive a none
    // IP value inside the IP header field we are going to assume that this
    // header has been compromised and should be ignored
    //
    if (!ips.length || !ips.every(net.isIP)) return;

    port = ports.shift();   // Extract the first port as it's the "source" port.
    ip = ips.shift();       // Extract the first IP as it's the "source" IP.

    //
    // If we were given a white list, we need to ensure that the proxies that
    // we're given are known and allowed.
    //
    if (whitelist && whitelist.length && !ips.every(function every(ip) {
      return ~whitelist.indexOf(ip.trim());
    })) return;

    //
    // Shift the most recently found proxy header to the front of the proxies
    // array. This optimizes future calls, placing the most commonly found headers
    // near the front of the array.
    //
    if (i !== 0) {
      proxies.unshift(proxies.splice(i, 1)[0]);
    }

    //
    // We've gotten a match on a HTTP header, we need to parse it further as it
    // could consist of multiple hops. The pattern for multiple hops is:
    //
    //   client, proxy, proxy, proxy, etc.
    //
    // So extracting the first IP should be sufficient. There are SSL
    // terminators like the once's that is used by `fastly.com` which set their
    // HTTPS header to `1` as an indication that the connection was secure.
    // (This reduces bandwidth)
    //
    return new Forwarded(ip, port, proto === '1' || proto === 'https');
  }
}

/**
 * Parse out the address information..
 *
 * @param {Object} obj A socket like object that could contain a `remoteAddress`.
 * @param {Object} headers The received HTTP headers.
 * @param {Array} whitelist White list
 * @returns {String} The IP address.
 * @api private
 */
function parse(obj, headers, whitelist) {
  var proxied = forwarded(headers || {}, whitelist)
    , connection = obj.connection
    , socket = connection
      ? connection.socket
      : obj.socket;

  //
  // We should always be testing for HTTP headers as remoteAddress would point
  // to proxies.
  //
  if (proxied) return proxied;

  // Check for the property on our given object.
  if ('object' === typeof obj) {
    if ('remoteAddress' in obj) {
      return new Forwarded(
        obj.remoteAddress,
        obj.remotePort,
        'secure' in obj ? obj.secure : obj.encrypted
      );
    }

    // Edge case for Socket.IO 0.9
    if ('object' === typeof obj.address && obj.address.address) {
      return new Forwarded(
        obj.address.address,
        obj.address.port,
        'secure' in obj ? obj.secure : obj.encrypted
      );
    }
  }

  if ('object' === typeof connection && 'remoteAddress' in connection) {
    return new Forwarded(
      connection.remoteAddress,
      connection.remotePort,
      'secure' in connection ? connection.secure : connection.encrypted
    );
  }

  if ('object' === typeof socket && 'remoteAddress' in socket) {
    return new Forwarded(
      socket.remoteAddress,
      socket.remoteAddress,
      'secure' in socket ? socket.secure : socket.encrypted
    );
  }

  return new Forwarded();
}

//
// Expose the module and all of it's interfaces.
//
parse.Forwarded = Forwarded;
parse.forwarded = forwarded;
parse.proxies = proxies;
module.exports = parse;

},{"net":47}],29:[function(require,module,exports){
'use strict';

var predefine = require('predefine')
  , slice = Array.prototype.slice
  , emits = require('emits')
  , path = require('path');

/**
 * Fuses the prototypes of two base classes in to one single class.
 *
 * @param {Function} Base Base function.
 * @param {Function} inherits The function where the base needs to inherit from.
 * @param {Object} options Configure how the inheritance is done.
 * @returns {Function} Base.
 * @api private
 */
module.exports = function fuse(Base, inherits, options) {
  options = options || {};

  if ('function' === typeof inherits) {
    Base.prototype.__proto__ = inherits.prototype;
  } else if ('object' === typeof inherits) {
    options = inherits;
    inherits = null;
  }

  /**
   * Add a new property to the prototype which is not enumerable but still
   * writable.
   *
   * @type {Function}
   * @public
   */
  Base.writable = predefine(Base.prototype, predefine.WRITABLE);

  /**
   * Add a new property to the prototype which is not enumerable but only
   * readable.
   *
   * @type {Function}
   * @public
   */
  Base.readable = predefine(Base.prototype, {
    configurable: false,
    enumerable: false,
    writable: false
  });

  /**
   * Add a new property to the prototype which is not enumerable but only
   * a getter.
   *
   * @type {Function}
   * @public
   */
  Base.get = function get(method, getter) {
    Object.defineProperty(Base.prototype, method, {
      configurable: false,
      enumerable: false,
      get: getter
    });

    return get;
  };

  /**
   * Add a new property to the prototype which is not enumerable but only
   * a getter and setter.
   *
   * @type {Function}
   * @public
   */
  Base.set = function set(method, getter, setter) {
    Object.defineProperty(Base.prototype, method, {
      configurable: false,
      enumerable: false,
      get: getter,
      set: setter
    });

    return set;
  };

  /**
   * Reset the constructor so it points to the Base class.
   *
   * @type {Function}
   * @api public
   */
  Base.writable('constructor', Base);

  /**
   * Spice up
   *
   * @api public
   */
  var fused = Base.prototype.fuse;
  Base.writable('fuse', function fuse(args) {
    var writable = predefine(this, predefine.WRITABLE);

    if (!this.writable) writable('writable', writable);
    if (!this.readable) writable('readable', predefine(this));

    if (fused) this.fuse = fused;

    //
    // Inheritance is optional, so only execute it when it's an actual function.
    //
    if ('function' === typeof inherits) {
      inherits.apply(this, args || arguments);
    }
  });

  /**
   * Make the Base class extendable using Backbone's .extend pattern.
   *
   * @type {Function}
   * @api public
   */
  Base.extend = predefine.extend;

  /**
   * Expose the predefine.
   *
   * @type {Function}
   * @api public
   */
  Base.predefine = predefine;

  //
  // Allow inheritance without adding additional default methods to the
  // prototype.
  //
  if (options.defaults === false) return Base;

  //
  // Inherit some methods from common module we use.
  //
  if (options.mixin !== false) Base.readable('mixin', predefine.mixin);
  if (options.merge !== false) Base.readable('merge', predefine.merge);
  if (options.emits !== false) Base.readable('emits', emits);

  return Base;
};

},{"emits":30,"path":60,"predefine":31}],30:[function(require,module,exports){
'use strict';

/**
 * Return a function that emits the given event.
 *
 * @param {String} event Name of the event we wish to emit.
 * @returns {Function} The function that emits all the things.
 * @api public
 */
module.exports = function emits(event) {
  var self = this
    , parser;

  for (var i = 0, l = arguments.length, args = new Array(l); i < l; i++) {
    args[i] = arguments[i];
  }

  //
  // Assume that if the last given argument is a function, it would be
  // a parser.
  //
  if ('function' === typeof args[args.length - 1]) {
    parser = args.pop();
  }

  return function emit() {
    for (var i = 0, l = arguments.length, arg = new Array(l); i < l; i++) {
      arg[i] = arguments[i];
    }

    if (parser) {
      var returned = parser.apply(self, arg);

      if (returned === parser) return false;
      if (returned === null) arg = [];
      else if (returned !== undefined) arg = returned;
    }

    return self.listeners(event).length
      ? self.emit.apply(self, args.concat(arg))
      : false;
  };
};

},{}],31:[function(require,module,exports){
'use strict';

var toString = Object.prototype.toString;

/**
 * The properties that need should be on a valid description object. As defined
 * in the specification.
 *
 * @type {Object}
 * @private
 */
var description = {
  configurable: 'boolean',  // Property may be changed or deleted.
  enumerable: 'boolean',    // Shows up in enumeration of the properties.
  get: 'function',          // A function that serves as a getter.
  set: 'function',          // A function that serves as a setter.
  value: undefined,         // Value associated with the property.
  writable: 'boolean'       // Property may be changed using assignment.
};

/**
 * Check if a given object is valid as an descriptor.
 *
 * @param {Object} obj The object with a possible description.
 * @returns {Boolean}
 * @api public
 */
function descriptor(obj) {
  if (!obj || 'object' !== typeof obj || Array.isArray(obj)) return false;

  var keys = Object.keys(obj);

  //
  // A descriptor can only be a data or accessor descriptor, never both.
  // An data descriptor can only specify:
  //
  // - configurable
  // - enumerable
  // - (optional) value
  // - (optional) writable
  //
  // And an accessor descriptor can only specify;
  //
  // - configurable
  // - enumerable
  // - (optional) get
  // - (optional) set
  //
  if (
       ('value' in obj || 'writable' in obj)
    && ('function' === typeof obj.set || 'function' === typeof obj.get)
  ) return false;

  return !!keys.length && keys.every(function allowed(key) {
    var type = description[key]
      , valid = type === undefined || is(obj[key], type);

    return key in description && valid;
  });
}

/**
 * Get accurate type information for a given JavaScript thing.
 *
 * @param {Mixed} thing The thing we want to know.
 * @param {String} type The class
 * @returns {Boolean}
 * @api private
 */
function is(thing, type) {
  return toString.call(thing).toLowerCase().slice(8, -1) === type;
}

/**
 * Predefine, preconfigure an Object.defineProperty.
 *
 * @param {Object} obj The context, prototype or object we define on.
 * @param {Object} pattern The default description.
 * @param {Boolean} override Override the pattern.
 * @returns {Function} The function definition.
 * @api public
 */
function predefine(obj, pattern) {
  pattern = pattern || predefine.READABLE;

  return function predefined(method, description, clean) {
    //
    // If we are given a description compatible Object, use that instead of
    // setting it as value. This allows easy creation of getters and setters.
    //
    if (
         !predefine.descriptor(description)
      || is(description, 'object')
         && !clean
         && !predefine.descriptor(predefine.mixin({}, pattern, description))
    ) { description = {
        value: description
      };
    }

    //
    // Prevent thrown errors when we attempt to override a readonly
    // property
    //
    var described = Object.getOwnPropertyDescriptor(obj, method);
    if (described && !described.configurable) {
      return predefined;
    }

    Object.defineProperty(obj, method, !clean
      ? predefine.mixin({}, pattern, description)
      : description
    );

    return predefined;
  };
}

/**
 * Lazy initialization pattern.
 *
 * @param {Object} obj The object where we need to add lazy loading prop.
 * @param {String} prop The name of the property that should lazy load.
 * @param {Function} fn The function that returns the lazy laoded value.
 * @api public
 */
function lazy(obj, prop, fn) {
  Object.defineProperty(obj, prop, {
    configurable: true,

    get: function get() {
      return Object.defineProperty(this, prop, {
        value: fn.call(this)
      })[prop];
    },

    set: function set(value) {
      return Object.defineProperty(this, prop, {
        value: value
      })[prop];
    }
  });
}

/**
 * A Object could override the `hasOwnProperty` method so we cannot blindly
 * trust the value of `obj.hasOwnProperty` so instead we get `hasOwnProperty`
 * directly from the Object.
 *
 * @type {Function}
 * @api private
 */
var has = Object.prototype.hasOwnProperty;

/**
 * Remove all enumerable properties from an given object.
 *
 * @param {Object} obj The object that needs cleaning.
 * @param {Array} keep Properties that should be kept.
 * @api public
 */
function remove(obj, keep) {
  if (!obj) return false;
  keep = keep || [];

  for (var prop in obj) {
    if (has.call(obj, prop) && !~keep.indexOf(prop)) {
      delete obj[prop];
    }
  }

  return true;
}

/**
 * Create a description that can be used for Object.create(null, definition) or
 * Object.defineProperties.
 *
 * @param {String} property The name of the property we are going to define.
 * @param {Object} description The object's description.
 * @param {Object} pattern Optional pattern that needs to be merged in.
 * @returns {Object} A object compatible with Object.create & defineProperties.
 */
function create(property, description, pattern) {
  pattern = pattern || {};

  if (!predefine.descriptor(description)) description = {
    enumberable: false,
    value: description
  };

  var definition = {};
  definition[property] = predefine.mixin(pattern, description);

  return definition;
}

/**
 * Mix multiple objects in to one single object that contains the properties of
 * all given objects. This assumes objects that are not nested deeply and it
 * correctly transfers objects that were created using `Object.defineProperty`.
 *
 * @returns {Object} target
 * @api public
 */
function mixin(target) {
  Array.prototype.slice.call(arguments, 1).forEach(function forEach(o) {
    Object.getOwnPropertyNames(o).forEach(function eachAttr(attr) {
      Object.defineProperty(target, attr, Object.getOwnPropertyDescriptor(o, attr));
    });
  });

  return target;
}
/**
 * Iterate over a collection. When you return false, it will stop the iteration.
 *
 * @param {Mixed} collection Either an Array or Object.
 * @param {Function} iterator Function to be called for each item.
 * @param {Mixed} context The context for the iterator.
 * @api public
 */
function each(collection, iterator, context) {
  if (arguments.length === 1) {
    iterator = collection;
    collection = this;
  }

  var isArray = Array.isArray(collection || this)
    , length = collection.length
    , i = 0
    , value;

  if (context) {
    if (isArray) {
      for (; i < length; i++) {
        value = iterator.apply(collection[ i ], context);
        if (value === false) break;
      }
    } else {
      for (i in collection) {
        value = iterator.apply(collection[ i ], context);
        if (value === false) break;
      }
    }
  } else {
    if (isArray) {
      for (; i < length; i++) {
        value = iterator.call(collection[i], i, collection[i]);
        if (value === false) break;
      }
    } else {
      for (i in collection) {
        value = iterator.call(collection[i], i, collection[i]);
        if (value === false) break;
      }
    }
  }

  return this;
}

/**
 * Merge in objects, deeply nested objects.
 *
 * @param {Object} target The object that receives the props.
 * @param {Object} additional Extra object that needs to be merged in the target.
 * @returns {Object} The first argument, target, which is fully merged.
 * @api public
 */
function merge(target, additional) {
  var result = target
    , undefined;

  if (Array.isArray(target)) {
    each(additional, function arrayForEach(index) {
      if (JSON.stringify(target).indexOf(JSON.stringify(additional[index])) === -1) {
        result.push(additional[index]);
      }
    });
  } else if ('object' === typeof target) {
    each(additional, function objectForEach(key, value) {
      if (target[key] === undefined) {
        result[key] = value;
      } else {
        result[key] = merge(target[key], additional[key]);
      }
    });
  } else {
    result = additional;
  }

  return result;
}

//
// Attach some convenience functions.
//
predefine.extend = require('extendible');
predefine.descriptor = descriptor;
predefine.create = create;
predefine.remove = remove;
predefine.merge = merge;
predefine.mixin = mixin;
predefine.each = each;
predefine.lazy = lazy;

//
// Predefined description templates.
//
predefine.WRITABLE = {
  configurable: true,
  enumerable: false,
  writable: true
};

predefine.READABLE = {
  enumerable: false,
  writable: false
};

//
// Expose the module.
//
module.exports = predefine;

},{"extendible":32}],32:[function(require,module,exports){
// 'use strict'; //<-- Root of all evil, causes thrown errors on readyOnly props.

var has = Object.prototype.hasOwnProperty
  , slice = Array.prototype.slice;

/**
 * Copy all readable properties from an Object or function and past them on the
 * object.
 *
 * @param {Object} obj The object we should paste everything on.
 * @returns {Object} obj
 * @api private
 */
function copypaste(obj) {
  var args = slice.call(arguments, 1)
    , i = 0
    , prop;

  for (; i < args.length; i++) {
    if (!args[i]) continue;

    for (prop in args[i]) {
      if (!has.call(args[i], prop)) continue;

      obj[prop] = args[i][prop];
    }
  }

  return obj;
}

/**
 * A proper mixin function that respects getters and setters.
 *
 * @param {Object} obj The object that should receive all properties.
 * @returns {Object} obj
 * @api private
 */
function mixin(obj) {
  if (
       'function' !== typeof Object.getOwnPropertyNames
    || 'function' !== typeof Object.defineProperty
    || 'function' !== typeof Object.getOwnPropertyDescriptor
  ) {
    return copypaste.apply(null, arguments);
  }

  //
  // We can safely assume that if the methods we specify above are supported
  // that it's also save to use Array.forEach for iteration purposes.
  //
  slice.call(arguments, 1).forEach(function forEach(o) {
    Object.getOwnPropertyNames(o).forEach(function eachAttr(attr) {
      Object.defineProperty(obj, attr, Object.getOwnPropertyDescriptor(o, attr));
    });
  });

  return obj;
}

/**
 * Detect if a given parent is constructed in strict mode so we can force the
 * child in to the same mode. It detects the strict mode by accessing properties
 * on the function that are forbidden in strict mode:
 *
 * - `caller`
 * - `callee`
 * - `arguments`
 *
 * Forcing the a thrown TypeError.
 *
 * @param {Function} parent Parent constructor
 * @returns {Function} The child constructor
 * @api private
 */
function mode(parent) {
  try {
    var e = parent.caller || parent.arguments || parent.callee;

    return function child() {
      return parent.apply(this, arguments);
    };
  } catch(e) {}

  return function child() {
    'use strict';

    return parent.apply(this, arguments);
  };
}

//
// Helper function to correctly set up the prototype chain, for subclasses.
// Similar to `goog.inherits`, but uses a hash of prototype properties and
// class properties to be extended.
//
module.exports = function extend(protoProps, staticProps) {
  var parent = this
    , child;

  //
  // The constructor function for the new subclass is either defined by you
  // (the "constructor" property in your `extend` definition), or defaulted
  // by us to simply call the parent's constructor.
  //
  if (protoProps && has.call(protoProps, 'constructor')) {
    child = protoProps.constructor;
  } else {
    child = mode(parent);
  }

  //
  // Set the prototype chain to inherit from `parent`, without calling
  // `parent`'s constructor function.
  //
  function Surrogate() {
    this.constructor = child;
  }

  Surrogate.prototype = parent.prototype;
  child.prototype = new Surrogate;

  //
  // Add prototype properties (instance properties) to the subclass,
  // if supplied.
  //
  if (protoProps) mixin(child.prototype, protoProps);

  //
  // Add static properties to the constructor function, if supplied.
  //
  copypaste(child, parent, staticProps);

  //
  // Set a convenience property in case the parent's prototype is needed later.
  //
  child.__super__ = parent.prototype;

  return child;
};

},{}],33:[function(require,module,exports){
(function (global){
'use strict';

var path = require('path')
  , vm = require('vm')
  , fs = require('fs');

/**
 * Load:
 *
 * Loads plain'ol JavaScript files without exports, module patterns in to Node.
 * The only assumption it makes is that it introduces at least one global.
 *
 * @param {String} location
 * @returns {Mixed}
 * @api public
 */
function load(location, globals) {
  globals = globals || {};

  if (!path.extname(location)) location = location +'.js';
  location = path.resolve(path.dirname(module.parent.filename), location);

  globals.__filename = path.basename(location);
  globals.__dirname = path.dirname(location);

  return compiler(read(location), path.basename(location), globals);
}

/**
 * The module compiler.
 *
 * @param {String} code The source code that needs to be compiled
 * @param {String} name The name of the file.
 * @param {Object} globals Additional globals
 * @returns {Mixed} Things.
 * @api public
 */
function compiler(code, name, globals) {
  name = name || 'load.js';
  globals = globals || {};

  var context = { load: require };

  // Add the missing globals that are not present in vm module.
  Object.keys(missing).forEach(function missingInVM(global) {
    context[global] = missing[global];
  });

  // Add extra globals.
  Object.keys(globals).forEach(function missingInVM(global) {
    context[global] = globals[global];
  });

  // Run it in a context so we can expose the globals.
  context = vm.createContext(context);
  vm.runInContext(code, context, name);

  // Remove the load module if it's still unchanged
  if (context.load === require) delete context.load;

  return context;
}

/**
 * Code reading and cleaning up.
 *
 * @param {String} location
 * @api private
 */
function read(location) {
  var code = fs.readFileSync(location, 'utf-8');

  //
  // Remove byte order marker. This catches EF BB BF (the UTF-8 BOM)
  // because the buffer-to-string conversion in `fs.readFileSync()`
  // translates it to FEFF, the UTF-16 BOM.
  //
  if (code.charCodeAt(0) === 0xFEFF) {
    code = code.slice(1);
  }

  return code;
}

/**
 * The following properties are missing when loading plain ol files.
 *
 * @type {Object}
 * @private
 */
var missing = Object.keys(global).reduce(function add(missing, prop) {
  missing[prop] = global[prop];
  return missing;
}, {
  require: require,
  Error: Error
});

//
// These values should not be exposed as they point to our module.
//
delete missing.module;
delete missing.exports;

//
// Expose the module.
//
load.compiler = compiler;
module.exports = load;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"fs":47,"path":60,"vm":83}],34:[function(require,module,exports){
'use strict';

var debug = require('debug')('setHeader');

/**
 * This code mimics the internals of the setHeader methods that is found in the
 * _http_outgoing.js file which node uses as response object. The only big
 * difference is that we don't throw and crash your application and ensure that
 * the headers you set using this function CANNOT be removed.
 *
 * @param {Response} res The HTTP Outgoing response instance.
 * @param {String} name The header name.
 * @param {String} value The value of the header.
 * @returns {Boolean} The header was set.
 * @api public
 */
module.exports = function setHeader(res, name, value) {
  if (!res || !name || !value || res._header) {
    return false;
  }

  var key = name.toLowerCase();

  //
  // Delegate the header setting magic first to the default setHeader method as
  // it can also be used to remove automatically injected headers.
  //
  res.setHeader(name, value);

  //
  // Prevent thrown errors when we want to set the same header again using our
  // own `setHeader` method.
  //
  var described = Object.getOwnPropertyDescriptor(res._headers, key);

  if (described && !described.configurable) {
    return false;
  }

  //
  // Internally, the `res.setHeader` stores the lowercase name and it's value in
  // a private `_headers` object. We're going to override the value that got set
  // using the Object.defineProperty so nobody can set the same header again.
  //
  Object.defineProperty(res._headers, key, {
    configurable: false,
    enumerable: true,

    //
    // Return the value that got set using our `setHeader` method.
    //
    get: function get() {
      return value;
    },

    //
    // Log an override attempt on our protected header.
    //
    set: function set(val) {
      debug('attempt to override header %s:%s with %s', name, value, val);
      return value;
    }
  });

  return true;
};

},{"debug":35}],35:[function(require,module,exports){

/**
 * Expose `debug()` as the module.
 */

module.exports = debug;

/**
 * Create a debugger with the given `name`.
 *
 * @param {String} name
 * @return {Type}
 * @api public
 */

function debug(name) {
  if (!debug.enabled(name)) return function(){};

  return function(fmt){
    fmt = coerce(fmt);

    var curr = new Date;
    var ms = curr - (debug[name] || curr);
    debug[name] = curr;

    fmt = name
      + ' '
      + fmt
      + ' +' + debug.humanize(ms);

    // This hackery is required for IE8
    // where `console.log` doesn't have 'apply'
    window.console
      && console.log
      && Function.prototype.apply.call(console.log, console, arguments);
  }
}

/**
 * The currently active debug mode names.
 */

debug.names = [];
debug.skips = [];

/**
 * Enables a debug mode by name. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} name
 * @api public
 */

debug.enable = function(name) {
  try {
    localStorage.debug = name;
  } catch(e){}

  var split = (name || '').split(/[\s,]+/)
    , len = split.length;

  for (var i = 0; i < len; i++) {
    name = split[i].replace('*', '.*?');
    if (name[0] === '-') {
      debug.skips.push(new RegExp('^' + name.substr(1) + '$'));
    }
    else {
      debug.names.push(new RegExp('^' + name + '$'));
    }
  }
};

/**
 * Disable debug output.
 *
 * @api public
 */

debug.disable = function(){
  debug.enable('');
};

/**
 * Humanize the given `ms`.
 *
 * @param {Number} m
 * @return {String}
 * @api private
 */

debug.humanize = function(ms) {
  var sec = 1000
    , min = 60 * 1000
    , hour = 60 * min;

  if (ms >= hour) return (ms / hour).toFixed(1) + 'h';
  if (ms >= min) return (ms / min).toFixed(1) + 'm';
  if (ms >= sec) return (ms / sec | 0) + 's';
  return ms + 'ms';
};

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

debug.enabled = function(name) {
  for (var i = 0, len = debug.skips.length; i < len; i++) {
    if (debug.skips[i].test(name)) {
      return false;
    }
  }
  for (var i = 0, len = debug.names.length; i < len; i++) {
    if (debug.names[i].test(name)) {
      return true;
    }
  }
  return false;
};

/**
 * Coerce `val`.
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

// persist

try {
  if (window.localStorage) debug.enable(localStorage.debug);
} catch(e){}

},{}],36:[function(require,module,exports){
'use strict';

/**
 * An auto incrementing id which we can use to create "unique" Ultron instances
 * so we can track the event emitters that are added through the Ultron
 * interface.
 *
 * @type {Number}
 * @private
 */
var id = 0;

/**
 * Ultron is high-intelligence robot. It gathers intelligence so it can start improving
 * upon his rudimentary design. It will learn from your EventEmitting patterns
 * and exterminate them.
 *
 * @constructor
 * @param {EventEmitter} ee EventEmitter instance we need to wrap.
 * @api public
 */
function Ultron(ee) {
  if (!(this instanceof Ultron)) return new Ultron(ee);

  this.id = id++;
  this.ee = ee;
}

/**
 * Register a new EventListener for the given event.
 *
 * @param {String} event Name of the event.
 * @param {Functon} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @returns {Ultron}
 * @api public
 */
Ultron.prototype.on = function on(event, fn, context) {
  fn.__ultron = this.id;
  this.ee.on(event, fn, context);

  return this;
};
/**
 * Add an EventListener that's only called once.
 *
 * @param {String} event Name of the event.
 * @param {Function} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @returns {Ultron}
 * @api public
 */
Ultron.prototype.once = function once(event, fn, context) {
  fn.__ultron = this.id;
  this.ee.once(event, fn, context);

  return this;
};

/**
 * Remove the listeners we assigned for the given event.
 *
 * @returns {Ultron}
 * @api public
 */
Ultron.prototype.remove = function remove() {
  var args = arguments
    , event;

  //
  // When no event names are provided we assume that we need to clear all the
  // events that were assigned through us.
  //
  if (args.length === 1 && 'string' === typeof args[0]) {
    args = args[0].split(/[, ]+/);
  } else if (!args.length) {
    args = [];

    for (event in this.ee._events) {
      if (this.ee._events.hasOwnProperty(event)) {
        args.push(event);
      }
    }
  }

  for (var i = 0; i < args.length; i++) {
    var listeners = this.ee.listeners(args[i]);

    for (var j = 0; j < listeners.length; j++) {
      event = listeners[j];

      if (event.listener) {
        if (event.listener.__ultron !== this.id) continue;
        delete event.listener.__ultron;
      } else {
        if (event.__ultron !== this.id) continue;
        delete event.__ultron;
      }

      this.ee.removeListener(args[i], event);
    }
  }

  return this;
};

/**
 * Destroy the Ultron instance, remove all listeners and release all references.
 *
 * @returns {Boolean}
 * @api public
 */
Ultron.prototype.destroy = function destroy() {
  if (!this.ee) return false;

  this.remove();
  this.ee = null;

  return true;
};

//
// Expose the module.
//
module.exports = Ultron;

},{}],37:[function(require,module,exports){
module.exports={
  "name": "primus",
  "version": "2.4.12",
  "description": "Primus is a simple abstraction around real-time frameworks. It allows you to easily switch between different frameworks without any code changes.",
  "main": "index.js",
  "scripts": {
    "integration": "NODE_ENV=testing mocha $(find test -name '*.integration.js')",
    "test": "NODE_ENV=testing mocha $(find test -name '*.test.js')",
    "update": "find transformers -name update.sh -exec bash {} \\;"
  },
  "homepage": "http://primus.io",
  "repository": {
    "type": "git",
    "url": "git://github.com/primus/primus.git"
  },
  "keywords": [
    "abstraction",
    "browserchannel",
    "engine.io",
    "framework",
    "comet",
    "streaming",
    "pubsub",
    "pub",
    "sub",
    "ajax",
    "xhr",
    "polling",
    "http",
    "faye",
    "io",
    "primus",
    "prumus",
    "real-time",
    "realtime",
    "socket",
    "socket.io",
    "sockets",
    "sockjs",
    "spark",
    "transformer",
    "transformers",
    "websocket",
    "websockets",
    "ws"
  ],
  "author": {
    "name": "Arnout Kazemier"
  },
  "license": "MIT",
  "dependencies": {
    "access-control": "0.0.x",
    "create-server": "0.0.x",
    "diagnostics": "0.0.x",
    "eventemitter3": "0.1.x",
    "forwarded-for": "0.1.x",
    "fusing": "0.4.x",
    "load": "1.0.x",
    "setheader": "0.0.x",
    "ultron": "1.0.x"
  },
  "devDependencies": {
    "binary-pack": "0.0.x",
    "browserchannel": "2.0.x",
    "browserify": "6.3.x",
    "chai": "1.9.x",
    "concat-stream": "1.4.x",
    "derequire": "1.2.x",
    "deumdify": "0.0.x",
    "ejson": "1.0.x",
    "engine.io": "1.4.x",
    "engine.io-client": "1.4.x",
    "faye-websocket": "0.8.x",
    "jsonh": "0.0.x",
    "mocha": "2.0.x",
    "pre-commit": "0.0.x",
    "request": "2.48.x",
    "socket.io": "0.9.x",
    "socket.io-client": "0.9.x",
    "sockjs": "0.3.x",
    "sockjs-client-node": "0.1.x",
    "ws": "0.5.x"
  },
  "gitHead": "e6e58473b4215674364b793292e8223c32bf0af4",
  "bugs": {
    "url": "https://github.com/primus/primus/issues"
  },
  "_id": "primus@2.4.12",
  "_shasum": "872d0e08cbbb6b8a5594363b4f2c314549cbbf3c",
  "_from": "primus@>=2.4.12 <3.0.0",
  "_npmVersion": "1.4.28",
  "_npmUser": {
    "name": "V1",
    "email": "info@3rd-Eden.com"
  },
  "maintainers": [
    {
      "name": "V1",
      "email": "info@3rd-Eden.com"
    },
    {
      "name": "jcrugzz",
      "email": "jcrugzz@gmail.com"
    },
    {
      "name": "swaagie",
      "email": "info@martijnswaagman.nl"
    },
    {
      "name": "lpinca",
      "email": "luigipinca@gmail.com"
    },
    {
      "name": "davedoesdev",
      "email": "dahalls@gmail.com"
    }
  ],
  "dist": {
    "shasum": "872d0e08cbbb6b8a5594363b4f2c314549cbbf3c",
    "tarball": "http://ci.strongloop.com:4873/primus/-/primus-2.4.12.tgz"
  },
  "directories": {},
  "_resolved": "http://ci.strongloop.com:4873/primus/-/primus-2.4.12.tgz",
  "readme": "ERROR: No README data found!"
}

},{}],38:[function(require,module,exports){
module.exports={
  "json": {},
  "jsonh": {
    "server": "jsonh"
  },
  "ejson": {
    "server": "ejson"
  },
  "binary": {
    "server": "binary-pack"
  }
}

},{}],39:[function(require,module,exports){
(function (process){
'use strict';

var ParserError = require('./errors').ParserError
  , log = require('diagnostics')('primus:spark')
  , parse = require('querystring').parse
  , forwarded = require('forwarded-for')
  , Ultron = require('ultron')
  , fuse = require('fusing')
  , u2028 = /\u2028/g
  , u2029 = /\u2029/g;

/**
 * The Spark is an indefinable, indescribable energy or soul of a transformer
 * which can be used to create new transformers. In our case, it's a simple
 * wrapping interface.
 *
 * @constructor
 * @param {Primus} primus Reference to the Primus server. (Set using .bind)
 * @param {Object} headers The request headers for this connection.
 * @param {Object} address The object that holds the remoteAddress and port.
 * @param {Object} query The query string of request.
 * @param {String} id An optional id of the socket, or we will generate one.
 * @param {Request} request The HTTP Request instance that initialised the spark.
 * @api public
 */
function Spark(primus, headers, address, query, id, request) {
  this.fuse();

  var writable = this.writable
    , spark = this;

  query = query || {};
  id = id || this.uuid(primus);
  headers = headers || {};
  address = address || {};
  request = request || headers['primus::req::backup'];

  writable('id', id);                   // Unique id for socket.
  writable('primus', primus);           // References to Primus.
  writable('remote', address);          // The remote address location.
  writable('headers', headers);         // The request headers.
  writable('request', request);         // Reference to an HTTP request.
  writable('writable', true);           // Silly stream compatibility.
  writable('readable', true);           // Silly stream compatibility.
  writable('query', query);             // The query string.
  writable('timeout', null);            // Heartbeat timeout.
  writable('ultron', new Ultron(this)); // Our event listening cleanup.

  //
  // Parse our query string.
  //
  if ('string' === typeof this.query) {
    this.query = parse(this.query);
  }

  this.heartbeat().__initialise.forEach(function execute(initialise) {
    initialise.call(spark);
  });
}

fuse(Spark, require('stream'), {
  defaults: false
});

//
// Internal readyState's to prevent writes against close sockets.
//
Spark.OPENING = 1;    // Only here for primus.js readyState number compatibility.
Spark.CLOSED  = 2;    // The connection is closed.
Spark.OPEN    = 3;    // The connection is open.

//
// Make sure that we emit `readyState` change events when a new readyState is
// checked. This way plugins can correctly act according to this.
//
Spark.readable('readyState', {
  get: function get() {
    return this.__readyState;
  },
  set: function set(readyState) {
    if (this.__readyState === readyState) return readyState;

    this.__readyState = readyState;
    this.emit('readyStateChange');

    return readyState;
  }
}, true);

Spark.writable('__readyState', Spark.OPEN);

//
// Lazy parse interface for IP address information. As nobody is always
// interested in this, we're going to defer parsing until it's actually needed.
//
Spark.get('address', function address() {
  return this.request.forwarded || forwarded(this.remote, this.headers, this.primus.whitelist);
});

/**
 * Set a timer to forcibly disconnect the spark if no data is received from the
 * client within the given timeout.
 *
 * @api private
 */
Spark.readable('heartbeat', function heartbeat() {
  var spark = this;

  clearTimeout(spark.timeout);

  if ('number' !== typeof spark.primus.timeout) return spark;

  log('setting new heartbeat timeout for %s', spark.id);

  this.timeout = setTimeout(function timeout() {
    //
    // Set reconnect to true so we're not sending a `primus::server::close`
    // packet.
    //
    spark.end(undefined, { reconnect: true });
  }, spark.primus.timeout);

  return this;
});

/**
 * Checks if the given event is an emitted event by Primus.
 *
 * @param {String} evt The event name.
 * @returns {Boolean}
 * @api public
 */
Spark.readable('reserved', function reserved(evt) {
  return (/^(incoming|outgoing)::/).test(evt)
  || evt in reserved.events;
});

/**
 * The actual events that are used by the Spark.
 *
 * @type {Object}
 * @api public
 */
Spark.prototype.reserved.events = {
  readyStateChange: 1,
  error: 1,
  data: 1,
  end: 1
};

/**
 * Allows for adding initialise listeners without people overriding our default
 * initializer. If they are feeling adventures and really want want to hack it
 * up, they can remove it from the __initialise array.
 *
 * @returns {Function} The last added initialise hook.
 * @api public
 */
Spark.readable('initialise', {
  get: function get() {
    return this.__initialise[this.__initialise.length - 1];
  },

  set: function set(initialise) {
    if ('function' === typeof initialise) this.__initialise.push(initialise);
  }
}, true);

/**
 * Attach hooks and automatically announce a new connection.
 *
 * @type {Array}
 * @api private
 */
Spark.readable('__initialise', [function initialise() {
  var primus = this.primus
    , ultron = this.ultron
    , spark = this;

  //
  // Prevent double initialization of the spark. If we already have an
  // `incoming::data` handler we assume that all other cases are handled as well.
  //
  if (this.listeners('incoming::data').length) {
    return log('already has incoming::data listeners, bailing out');
  }

  //
  // We've received new data from our client, decode and emit it.
  //
  ultron.on('incoming::data', function message(raw) {
    //
    // New data has arrived so we're certain that the connection is still alive,
    // so it's save to restart the heartbeat sequence.
    //
    spark.heartbeat();

    primus.decoder.call(spark, raw, function decoding(err, data) {
      //
      // Do a "save" emit('error') when we fail to parse a message. We don't
      // want to throw here as listening to errors should be optional.
      //
      if (err) {
        log('failed to decode the incoming data for %s', spark.id);
        return new ParserError('Failed to decode incoming data: '+ err.message, spark, err);
      }

      //
      // Handle "primus::" prefixed protocol messages.
      //
      if (spark.protocol(data)) return;
      spark.transforms(primus, spark, 'incoming', data, raw);
    });
  });

  //
  // We've received a ping message.
  //
  ultron.on('incoming::ping', function ping(time) {
    spark.emit('outgoing::pong', time);
    spark._write('primus::pong::'+ time);
  });

  //
  // The client has disconnected.
  //
  ultron.on('incoming::end', function disconnect() {
    //
    // The socket is closed, sending data over it will throw an error.
    //
    log('transformer closed connection for %s', spark.id);
    spark.end(undefined, { reconnect: true });
  });

  ultron.on('incoming::error', function error(err) {
    //
    // Ensure that the error we emit is always an Error instance. There are
    // transformers that used to emit only strings. A string is not an Error.
    //
    if ('string' === typeof err) {
      err = new Error(err);
    }

    if (spark.listeners('error').length) spark.emit('error', err);
    spark.primus.emit('log', 'error', err);

    log('transformer received error `%s` for %s', err.message, spark.id);
    spark.end();
  });

  //
  // End is triggered by both incoming and outgoing events.
  //
  ultron.on('end', function end() {
    clearTimeout(spark.timeout);
    primus.emit('disconnection', spark);

    //
    // We are most likely the first `end` event in the EventEmitter stack which
    // will make our callback the first to be execute. If we instantly delete
    // properties it will cause that our users can't access them anymore in
    // their `end` listener. So if they need to un-register something based on
    // the spark.id, that would be impossible. Therefor we delay our deletion
    // with a non scientific amount of milliseconds to give people some time to
    // use these references for the last time.
    //
    setTimeout(function timeout() {
      log('releasing references from our spark object for %s', spark.id);
      //
      // Release references.
      // @TODO also remove the references that we're set by users.
      //
      [
        'id', 'primus', 'remote', 'headers', 'request', 'query'
      ].forEach(function each(key) {
        delete spark[key];
      });
    }, 10);
  });

  //
  // Announce a new connection. This allows the transformers to change or listen
  // to events before we announce it.
  //
  process.nextTick(function tick() {
    primus.asyncemit('connection', spark, function damn(err) {
      if (!err) return;

      spark.emit('incoming::error', err);
    });
  });
}]);

/**
 * Execute the set of message transformers from Primus on the incoming or
 * outgoing message.
 * This function and it's content should be in sync with Primus#transforms in
 * primus.js.
 *
 * @param {Primus} primus Reference to the Primus instance with message transformers.
 * @param {Spark|Primus} connection Connection that receives or sends data.
 * @param {String} type The type of message, 'incoming' or 'outgoing'.
 * @param {Mixed} data The data to send or that has been received.
 * @param {String} raw The raw encoded data.
 * @returns {Spark}
 * @api public
 */
Spark.readable('transforms', function transforms(primus, connection, type, data, raw) {
  var packet = { data: data, raw: raw }
    , fns = primus.transformers[type];

  //
  // Iterate in series over the message transformers so we can allow optional
  // asynchronous execution of message transformers which could for example
  // retrieve additional data from the server, do extra decoding or even
  // message validation.
  //
  (function transform(index, done) {
    var transformer = fns[index++];

    if (!transformer) return done();

    if (1 === transformer.length) {
      if (false === transformer.call(connection, packet)) {
        //
        // When false is returned by an incoming transformer it means that's
        // being handled by the transformer and we should not emit the `data`
        // event.
        //
        return;
      }

      return transform(index, done);
    }

    transformer.call(connection, packet, function finished(err, arg) {
      if (err) return connection.emit('error', err);
      if (false === arg) return;

      transform(index, done);
    });
  }(0, function done() {
    //
    // We always emit 2 arguments for the data event, the first argument is the
    // parsed data and the second argument is the raw string that we received.
    // This allows you, for example, to do some validation on the parsed data
    // and then save the raw string in your database without the stringify
    // overhead.
    //
    if ('incoming' === type) {
      return connection.emit('data', packet.data, packet.raw);
    }

    connection._write(packet.data);
  }));

  return this;
});

/**
 * Generate a unique UUID.
 *
 * @param {Primus} primus Reference to the primus instance.
 * @returns {String} UUID.
 * @api private
 */
Spark.readable('uuid', function uuid(primus) {
  return Date.now() +'$'+ primus.sparks++;
});

/**
 * Really dead simple protocol parser. We simply assume that every message that
 * is prefixed with `primus::` could be used as some sort of protocol definition
 * for Primus.
 *
 * @param {String} msg The data.
 * @returns {Boolean} Is a protocol message.
 * @api private
 */
Spark.readable('protocol', function protocol(msg) {
  if (
       'string' !== typeof msg
    || msg.indexOf('primus::') !== 0
  ) return false;

  var last = msg.indexOf(':', 8)
    , value = msg.slice(last + 2);

  switch (msg.slice(8,  last)) {
    case 'ping':
      this.emit('incoming::ping', value);
    break;

    case 'id':
      this._write('primus::id::'+ this.id);
    break;

    //
    // Unknown protocol, somebody is probably sending `primus::` prefixed
    // messages.
    //
    default:
      log('message `%s` was prefixed with primus:: but not supported', msg);
      return false;
  }

  log('processed a primus protocol message `%s`', msg);
  return true;
});

/**
 * Simple emit wrapper that returns a function that emits an event once it's
 * called. This makes it easier for transports to emit specific events. The
 * scope of this function is limited as it will only emit one single argument.
 *
 * @param {String} event Name of the event that we should emit.
 * @param {Function} parser Argument parser.
 * @api public
 */
Spark.readable('emits', function emits(event, parser) {
  var spark = this;

  return function emit(arg) {
    var data = parser ? parser.apply(spark, arguments) : arg;

    spark.emit('incoming::'+ event, data);
  };
});

/**
 * Send a new message to a given spark.
 *
 * @param {Mixed} data The data that needs to be written.
 * @returns {Boolean} Always returns true.
 * @api public
 */
Spark.readable('write', function write(data) {
  var primus = this.primus;

  //
  // The connection is closed, return false.
  //
  if (Spark.CLOSED === this.readyState) {
    log('attempted to write but readyState was already set to CLOSED for %s', this.id);
    return false;
  }

  this.transforms(primus, this, 'outgoing', data);

  return true;
});

/**
 * The actual message writer.
 *
 * @param {Mixed} data The message that needs to be written.
 * @returns {Boolean}
 * @api private
 */
Spark.readable('_write', function _write(data) {
  var primus = this.primus
    , spark = this;

  //
  // The connection is closed, normally this would already be done in the
  // `spark.write` method, but as `_write` is used internally, we should also
  // add the same check here to prevent potential crashes by writing to a dead
  // socket.
  //
  if (Spark.CLOSED === spark.readyState) {
    log('attempted to _write but readyState was already set to CLOSED for %s', spark.id);
    return false;
  }

  primus.encoder.call(spark, data, function encoded(err, packet) {
    //
    // Do a "save" emit('error') when we fail to parse a message. We don't
    // want to throw here as listening to errors should be optional.
    //
    if (err) return new ParserError('Failed to encode outgoing data: '+ err.message, spark, err);
    if (!packet) return log('nothing to write, bailing out for %s', spark.id);

    //
    // Hack 1: \u2028 and \u2029 are allowed inside string in JSON. But JavaScript
    // defines them as newline separators. Because no literal newlines are allowed
    // in a string this causes a ParseError. We work around this issue by replacing
    // these characters with a properly escaped version for those chars. This can
    // cause errors with JSONP requests or if the string is just evaluated.
    //
    if ('string' === typeof packet) {
      if (~packet.indexOf('\u2028')) packet = packet.replace(u2028, '\\u2028');
      if (~packet.indexOf('\u2029')) packet = packet.replace(u2029, '\\u2029');
    }

    spark.emit('outgoing::data', packet);
  });

  return true;
});

/**
 * End the connection.
 *
 * Options:
 * - reconnect (boolean) Trigger client-side reconnect.
 *
 * @param {Mixed} data Optional closing data.
 * @param {Object} options End instructions.
 * @api public
 */
Spark.readable('end', function end(data, options) {
  if (Spark.CLOSED === this.readyState) return this;

  log('end initiated by developer for %s', this.id);

  options = options || {};
  if (data !== undefined) this.write(data);

  //
  // If we want to trigger a reconnect do not send
  // `primus::server::close`, otherwise bypass the .write method
  // as this message should not be transformed.
  //
  if (!options.reconnect) this._write('primus::server::close');

  this.readyState = Spark.CLOSED;
  this.emit('outgoing::end');
  this.emit('end');
  this.ultron.destroy();

  return this;
});

//
// Expose the module.
//
module.exports = Spark;

}).call(this,require('_process'))
},{"./errors":1,"_process":61,"diagnostics":16,"forwarded-for":28,"fusing":29,"querystring":65,"stream":77,"ultron":36}],40:[function(require,module,exports){
(function (Buffer){
'use strict';

var log = require('diagnostics')('primus:transformer')
  , middlewareError = require('./middleware/error')
  , url = require('url').parse
  , fuse = require('fusing');

/**
 * Transformer skeletons
 *
 * @constructor
 * @param {Primus} primus Reference to the Primus instance.
 * @api public
 */
function Transformer(primus) {
  this.fuse();

  this.Spark = primus.Spark;    // Used by the Server to create a new connection.
  this.primus = primus;         // Reference to the Primus instance.
  this.service = null;          // Stores the real-time service.

  this.initialise();
}

fuse(Transformer, require('eventemitter3'));

//
// Simple logger shortcut.
//
Object.defineProperty(Transformer.prototype, 'logger', {
  get: function logger() {
    return {
      error: this.primus.emits('log', 'error'), // Log error <line>.
      warn:  this.primus.emits('log', 'warn'),  // Log warn <line>.
      info:  this.primus.emits('log', 'info'),  // Log info <line>.
      debug: this.primus.emits('log', 'debug'), // Log debug <line>.
      log:   this.primus.emits('log', 'log'),   // Log log <line>.
      plain: this.primus.emits('log', 'log')    // Log log <line>.
    };
  }
});

/**
 * Create the server and attach the appropriate event listeners.
 *
 * @api private
 */
Transformer.readable('initialise', function initialise() {
  if (this.server) this.server();

  var server = this.primus.server
    , transformer = this;

  server.listeners('request').forEach(function each(fn) {
    log('found existing request handlers on the HTTP server, moving Primus as first');
    transformer.on('previous::request', fn);
  });

  server.listeners('upgrade').forEach(function each(fn) {
    log('found existing upgrade handlers on the HTTP server, moving Primus as first');
    transformer.on('previous::upgrade', fn);
  });

  //
  // Remove the old listeners as we want to be the first request handler for all
  // events.
  //
  server.removeAllListeners('request');
  server.removeAllListeners('upgrade');

  //
  // Emit a close event.
  //
  server.on('close', function close() {
    log('the HTTP server is closing');
    transformer.emit('close');
  });

  //
  // Start listening for incoming requests if we have a listener assigned to us.
  //
  if (this.listeners('request').length || this.listeners('previous::request').length) {
    server.on('request', this.request.bind(this));
  }

  if (this.listeners('upgrade').length || this.listeners('previous::upgrade').length) {
    server.on('upgrade', this.upgrade.bind(this));
  }
});

/**
 * Iterate all the middleware layers that we're set on our Primus instance.
 *
 * @param {String} type Either `http` or `upgrade`
 * @param {Request} req HTTP request.
 * @param {Response} res HTTP response.
 * @param {Function} next Continuation callback.
 * @api private
 */
Transformer.readable('forEach', function forEach(type, req, res, next) {
  var transformer = this
    , layers = transformer.primus.layers
    , primus = transformer.primus;

  req.query = req.uri.query || {};

  //
  // Add some silly HTTP properties for connect.js compatibility.
  //
  req.originalUrl = req.url;

  if (!layers.length) {
    next();
    return transformer;
  }

  //
  // Async or sync call the middleware layer.
  //
  (function iterate(index) {
    var layer = layers[index++];

    if (!layer) return next();
    if (!layer.enabled || layer.fn[type] === false) return iterate(index);

    if (layer.length === 2) {
      log('executing middleware (%s) synchronously', layer.name);

      if (layer.fn.call(primus, req, res)) return;
      return iterate(index);
    }

    log('executing middleware (%s) asynchronously', layer.name);
    layer.fn.call(primus, req, res, function done(err) {
      if (err) return middlewareError(err, req, res);

      iterate(index);
    });
  }(0));

  return transformer;
});

/**
 * Start listening for incoming requests and check if we need to forward them to
 * the transformers.
 *
 * @param {Request} req HTTP request.
 * @param {Response} res HTTP response.
 * @api private
 */
Transformer.readable('request', function request(req, res) {
  if (!this.test(req)) return this.emit('previous::request', req, res);

  req.headers['primus::req::backup'] = req;
  res.once('end', function gc() {
    delete req.headers['primus::req::backup'];
  });

  //
  // I want to see you're face when you're looking at the lines of code above
  // while you think, WTF what is this shit, you mad bro!? Let me take a moment
  // to explain this mad and sadness.
  //
  // There are some real-time transformers that do not give us access to the
  // HTTP request that initiated their `socket` connection. They only give us
  // access to the information that they think is useful, we're greedy, we want
  // everything and let developers decide what they want to use instead and
  // therefor want to expose this HTTP request on our `spark` object.
  //
  // The reason it's added to the headers is because it's currently the only
  // field that is accessible through all transformers.
  //

  log('handling HTTP request for url: %s', req.url);
  this.forEach('http', req, res, this.emits('request', req, res));
});

/**
 * Starting listening for incoming upgrade requests and check if we need to
 * forward them to the transformers.
 *
 * @param {Request} req HTTP request.
 * @param {Socket} socket Socket.
 * @param {Buffer} head Buffered data.
 * @api private
 */
Transformer.readable('upgrade', function upgrade(req, socket, head) {
  if (!this.test(req)) return this.emit('previous::upgrade', req, socket, head);

  //
  // Copy buffer to prevent large buffer retention in Node core.
  // @see jmatthewsr-ms/node-slab-memory-issues
  //
  var buffy = new Buffer(head.length);
  head.copy(buffy);

  //
  // See Transformer#request for an explanation of this madness.
  //
  req.headers['primus::req::backup'] = req;
  socket.once('end', function gc() {
    delete req.headers['primus::req::backup'];
  });

  log('handling HTTP upgrade for url: %s', req.url);
  this.forEach('upgrade', req, socket, this.emits('upgrade', req, socket, buffy));
});

/**
 * Check if we should accept this request.
 *
 * @param {Request} req HTTP Request.
 * @returns {Boolean} Do we need to accept this request.
 * @api private
 */
Transformer.readable('test', function test(req) {
  req.uri = url(req.url, true);

  var pathname = req.uri.pathname || '/'
    , route = this.primus.pathname;

  return pathname.slice(0, route.length) === route;
});

//
// Expose the transformer's skeleton.
//
module.exports = Transformer;

}).call(this,require("buffer").Buffer)
},{"./middleware/error":5,"buffer":49,"diagnostics":16,"eventemitter3":27,"fusing":29,"url":80}],41:[function(require,module,exports){
module.exports={
  "websockets": {
    "server": "ws",
    "client": "ws"
  },
  "engine.io": {
    "server": "engine.io",
    "client": "engine.io-client"
  },
  "socket.io": {
    "server": "socket.io",
    "client": "socket.io-client"
  },
  "browserchannel": {
    "server": "browserchannel",
    "client": "browserchannel"
  },
  "sockjs": {
    "server": "sockjs",
    "client": "sockjs-client-node"
  },
  "faye": {
    "server": "faye-websocket",
    "client": "faye-websocket"
  }
}

},{}],42:[function(require,module,exports){

/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;

/**
 * Use chrome.storage.local if we are in an app
 */

var storage;

if (typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined')
  storage = chrome.storage.local;
else
  storage = localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // is webkit? http://stackoverflow.com/a/16459606/376773
  return ('WebkitAppearance' in document.documentElement.style) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (window.console && (console.firebug || (console.exception && console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31);
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  return JSON.stringify(v);
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs() {
  var args = arguments;
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return args;

  var c = 'color: ' + this.color;
  args = [args[0], c, 'color: inherit'].concat(Array.prototype.slice.call(args, 1));

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
  return args;
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      storage.removeItem('debug');
    } else {
      storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = storage.debug;
  } catch(e) {}
  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage(){
  try {
    return window.localStorage;
  } catch (e) {}
}

},{"./debug":43}],43:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = debug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lowercased letter, i.e. "n".
 */

exports.formatters = {};

/**
 * Previously assigned color.
 */

var prevColor = 0;

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 *
 * @return {Number}
 * @api private
 */

function selectColor() {
  return exports.colors[prevColor++ % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function debug(namespace) {

  // define the `disabled` version
  function disabled() {
  }
  disabled.enabled = false;

  // define the `enabled` version
  function enabled() {

    var self = enabled;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // add the `color` if not set
    if (null == self.useColors) self.useColors = exports.useColors();
    if (null == self.color && self.useColors) self.color = selectColor();

    var args = Array.prototype.slice.call(arguments);

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %o
      args = ['%o'].concat(args);
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    if ('function' === typeof exports.formatArgs) {
      args = exports.formatArgs.apply(self, args);
    }
    var logFn = enabled.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }
  enabled.enabled = true;

  var fn = exports.enabled(namespace) ? enabled : disabled;

  fn.namespace = namespace;

  return fn;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  var split = (namespaces || '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":44}],44:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} options
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options){
  options = options || {};
  if ('string' == typeof val) return parse(val);
  return options.long
    ? long(val)
    : short(val);
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str);
  if (!match) return;
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function short(ms) {
  if (ms >= d) return Math.round(ms / d) + 'd';
  if (ms >= h) return Math.round(ms / h) + 'h';
  if (ms >= m) return Math.round(ms / m) + 'm';
  if (ms >= s) return Math.round(ms / s) + 's';
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function long(ms) {
  return plural(ms, d, 'day')
    || plural(ms, h, 'hour')
    || plural(ms, m, 'minute')
    || plural(ms, s, 'second')
    || ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) return;
  if (ms < n * 1.5) return Math.floor(ms / n) + ' ' + name;
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],45:[function(require,module,exports){
(function (process){
var Stream = require('stream')

module.exports = function (write, end) {
  var stream = new Stream() 
  var buffer = [], ended = false, destroyed = false, emitEnd
  stream.writable = stream.readable = true
  stream.paused = false
  stream._paused = false
  stream.buffer = buffer
  
  stream
    .on('pause', function () {
      stream._paused = true
    })
    .on('drain', function () {
      stream._paused = false
    })
   
  function destroySoon () {
    process.nextTick(stream.destroy.bind(stream))
  }

  if(write)
    stream.on('_data', write)
  if(end)
    stream.on('_end', end)

  //destroy the stream once both ends are over
  //but do it in nextTick, so that other listeners
  //on end have time to respond
  stream.once('end', function () { 
    stream.readable = false
    if(!stream.writable) {
      process.nextTick(function () {
        stream.destroy()
      })
    }
  })

  stream.once('_end', function () { 
    stream.writable = false
    if(!stream.readable)
      stream.destroy()
  })

  // this is the default write method,
  // if you overide it, you are resposible
  // for pause state.

  
  stream._data = function (data) {
    if(!stream.paused && !buffer.length)
      stream.emit('data', data)
    else 
      buffer.push(data)
    return !(stream.paused || buffer.length)
  }

  stream._end = function (data) { 
    if(data) stream._data(data)
    if(emitEnd) return
    emitEnd = true
    //destroy is handled above.
    stream.drain()
  }

  stream.write = function (data) {
    stream.emit('_data', data)
    return !stream._paused
  }

  stream.end = function () {
    stream.writable = false
    if(stream.ended) return
    stream.ended = true
    stream.emit('_end')
  }

  stream.drain = function () {
    if(!buffer.length && !emitEnd) return
    //if the stream is paused after just before emitEnd()
    //end should be buffered.
    while(!stream.paused) {
      if(buffer.length) {
        stream.emit('data', buffer.shift())
        if(buffer.length == 0) {
          stream.emit('_drain')
        }
      }
      else if(emitEnd && stream.readable) {
        stream.readable = false
        stream.emit('end')
        return
      } else {
        //if the buffer has emptied. emit drain.
        return true
      }
    }
  }
  var started = false
  stream.resume = function () {
    //this is where I need pauseRead, and pauseWrite.
    //here the reading side is unpaused,
    //but the writing side may still be paused.
    //the whole buffer might not empity at once.
    //it might pause again.
    //the stream should never emit data inbetween pause()...resume()
    //and write should return !buffer.length
    started = true
    stream.paused = false
    stream.drain() //will emit drain if buffer empties.
    return stream
  }

  stream.destroy = function () {
    if(destroyed) return
    destroyed = ended = true     
    buffer.length = 0
    stream.emit('close')
  }
  var pauseCalled = false
  stream.pause = function () {
    started = true
    stream.paused = true
    stream.emit('_pause')
    return stream
  }
  stream._pause = function () {
    if(!stream._paused) {
      stream._paused = true
      stream.emit('pause')
    }
    return this
  }
  stream.paused = true
  process.nextTick(function () {
    //unless the user manually paused
    if(started) return
    stream.resume()
  })
 
  return stream
}


}).call(this,require('_process'))
},{"_process":61,"stream":77}],46:[function(require,module,exports){
(function (Buffer){
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

}).call(this,require("buffer").Buffer)
},{"Primus":2,"buffer":49,"debug":42,"duplex":45,"util":82}],47:[function(require,module,exports){

},{}],48:[function(require,module,exports){
arguments[4][47][0].apply(exports,arguments)
},{"dup":47}],49:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var isArray = require('is-array')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var kMaxLength = 0x3fffffff
var rootParent = {}

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Note:
 *
 * - Implementation must support adding new properties to `Uint8Array` instances.
 *   Firefox 4-29 lacked support, fixed in Firefox 30+.
 *   See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *  - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *  - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *    incorrect length in some situations.
 *
 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they will
 * get the Object implementation, which is slower but will work correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = (function () {
  try {
    var buf = new ArrayBuffer(0)
    var arr = new Uint8Array(buf)
    arr.foo = function () { return 42 }
    return arr.foo() === 42 && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        new Uint8Array(1).subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
})()

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (subject, encoding) {
  var self = this
  if (!(self instanceof Buffer)) return new Buffer(subject, encoding)

  var type = typeof subject
  var length

  if (type === 'number') {
    length = +subject
  } else if (type === 'string') {
    length = Buffer.byteLength(subject, encoding)
  } else if (type === 'object' && subject !== null) {
    // assume object is array-like
    if (subject.type === 'Buffer' && isArray(subject.data)) subject = subject.data
    length = +subject.length
  } else {
    throw new TypeError('must start with number, buffer, array or string')
  }

  if (length > kMaxLength) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum size: 0x' +
      kMaxLength.toString(16) + ' bytes')
  }

  if (length < 0) length = 0
  else length >>>= 0 // coerce to uint32

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Preferred: Return an augmented `Uint8Array` instance for best performance
    self = Buffer._augment(new Uint8Array(length)) // eslint-disable-line consistent-this
  } else {
    // Fallback: Return THIS instance of Buffer (created by `new`)
    self.length = length
    self._isBuffer = true
  }

  var i
  if (Buffer.TYPED_ARRAY_SUPPORT && typeof subject.byteLength === 'number') {
    // Speed optimization -- use set if we're copying from a typed array
    self._set(subject)
  } else if (isArrayish(subject)) {
    // Treat array-ish objects as a byte array
    if (Buffer.isBuffer(subject)) {
      for (i = 0; i < length; i++) {
        self[i] = subject.readUInt8(i)
      }
    } else {
      for (i = 0; i < length; i++) {
        self[i] = ((subject[i] % 256) + 256) % 256
      }
    }
  } else if (type === 'string') {
    self.write(subject, 0, encoding)
  } else if (type === 'number' && !Buffer.TYPED_ARRAY_SUPPORT) {
    for (i = 0; i < length; i++) {
      self[i] = 0
    }
  }

  if (length > 0 && length <= Buffer.poolSize) self.parent = rootParent

  return self
}

function SlowBuffer (subject, encoding) {
  if (!(this instanceof SlowBuffer)) return new SlowBuffer(subject, encoding)

  var buf = new Buffer(subject, encoding)
  delete buf.parent
  return buf
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length
  for (var i = 0, len = Math.min(x, y); i < len && a[i] === b[i]; i++) {}
  if (i !== len) {
    x = a[i]
    y = b[i]
  }
  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, totalLength) {
  if (!isArray(list)) throw new TypeError('list argument must be an Array of Buffers.')

  if (list.length === 0) {
    return new Buffer(0)
  } else if (list.length === 1) {
    return list[0]
  }

  var i
  if (totalLength === undefined) {
    totalLength = 0
    for (i = 0; i < list.length; i++) {
      totalLength += list[i].length
    }
  }

  var buf = new Buffer(totalLength)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

Buffer.byteLength = function byteLength (str, encoding) {
  var ret
  str = str + ''
  switch (encoding || 'utf8') {
    case 'ascii':
    case 'binary':
    case 'raw':
      ret = str.length
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = str.length * 2
      break
    case 'hex':
      ret = str.length >>> 1
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8ToBytes(str).length
      break
    case 'base64':
      ret = base64ToBytes(str).length
      break
    default:
      ret = str.length
  }
  return ret
}

// pre-set for values that may exist in the future
Buffer.prototype.length = undefined
Buffer.prototype.parent = undefined

// toString(encoding, start=0, end=buffer.length)
Buffer.prototype.toString = function toString (encoding, start, end) {
  var loweredCase = false

  start = start >>> 0
  end = end === undefined || end === Infinity ? this.length : end >>> 0

  if (!encoding) encoding = 'utf8'
  if (start < 0) start = 0
  if (end > this.length) end = this.length
  if (end <= start) return ''

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return 0
  return Buffer.compare(this, b)
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset) {
  if (byteOffset > 0x7fffffff) byteOffset = 0x7fffffff
  else if (byteOffset < -0x80000000) byteOffset = -0x80000000
  byteOffset >>= 0

  if (this.length === 0) return -1
  if (byteOffset >= this.length) return -1

  // Negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = Math.max(this.length + byteOffset, 0)

  if (typeof val === 'string') {
    if (val.length === 0) return -1 // special case: looking for empty string always fails
    return String.prototype.indexOf.call(this, val, byteOffset)
  }
  if (Buffer.isBuffer(val)) {
    return arrayIndexOf(this, val, byteOffset)
  }
  if (typeof val === 'number') {
    if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
      return Uint8Array.prototype.indexOf.call(this, val, byteOffset)
    }
    return arrayIndexOf(this, [ val ], byteOffset)
  }

  function arrayIndexOf (arr, val, byteOffset) {
    var foundIndex = -1
    for (var i = 0; byteOffset + i < arr.length; i++) {
      if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === val.length) return byteOffset + foundIndex
      } else {
        foundIndex = -1
      }
    }
    return -1
  }

  throw new TypeError('val must be string, number or Buffer')
}

// `get` will be removed in Node 0.13+
Buffer.prototype.get = function get (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` will be removed in Node 0.13+
Buffer.prototype.set = function set (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) throw new Error('Invalid hex string')
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
  return charsWritten
}

function asciiWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(asciiToBytes(string), buf, offset, length)
  return charsWritten
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(base64ToBytes(string), buf, offset, length)
  return charsWritten
}

function utf16leWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
  return charsWritten
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Support both (string, offset, length, encoding)
  // and the legacy (string, encoding, offset, length)
  if (isFinite(offset)) {
    if (!isFinite(length)) {
      encoding = length
      length = undefined
    }
  } else {  // legacy
    var swap = encoding
    encoding = offset
    offset = length
    length = swap
  }

  offset = Number(offset) || 0

  if (length < 0 || offset < 0 || offset > this.length) {
    throw new RangeError('attempt to write outside buffer bounds')
  }

  var remaining = this.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }
  encoding = String(encoding || 'utf8').toLowerCase()

  var ret
  switch (encoding) {
    case 'hex':
      ret = hexWrite(this, string, offset, length)
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8Write(this, string, offset, length)
      break
    case 'ascii':
      ret = asciiWrite(this, string, offset, length)
      break
    case 'binary':
      ret = binaryWrite(this, string, offset, length)
      break
    case 'base64':
      ret = base64Write(this, string, offset, length)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = utf16leWrite(this, string, offset, length)
      break
    default:
      throw new TypeError('Unknown encoding: ' + encoding)
  }
  return ret
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  var res = ''
  var tmp = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    if (buf[i] <= 0x7F) {
      res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
      tmp = ''
    } else {
      tmp += '%' + buf[i].toString(16)
    }
  }

  return res + decodeUtf8Char(tmp)
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function binarySlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
  }

  if (newBuf.length) newBuf.parent = this.parent || this

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) >>> 0 & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) >>> 0 & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = value
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = value
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkInt(
      this, value, offset, byteLength,
      Math.pow(2, 8 * byteLength - 1) - 1,
      -Math.pow(2, 8 * byteLength - 1)
    )
  }

  var i = 0
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkInt(
      this, value, offset, byteLength,
      Math.pow(2, 8 * byteLength - 1) - 1,
      -Math.pow(2, 8 * byteLength - 1)
    )
  }

  var i = byteLength - 1
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = value
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
  if (offset < 0) throw new RangeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, target_start, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (target_start >= target.length) target_start = target.length
  if (!target_start) target_start = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (target_start < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - target_start < end - start) {
    end = target.length - target_start + start
  }

  var len = end - start

  if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < len; i++) {
      target[i + target_start] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), target_start)
  }

  return len
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function fill (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new RangeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new RangeError('start out of bounds')
  if (end < 0 || end > this.length) throw new RangeError('end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function toArrayBuffer () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1) {
        buf[i] = this[i]
      }
      return buf.buffer
    }
  } else {
    throw new TypeError('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function _augment (arr) {
  arr.constructor = Buffer
  arr._isBuffer = true

  // save reference to original Uint8Array set method before overwriting
  arr._set = arr.set

  // deprecated, will be removed in node 0.13+
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.indexOf = BP.indexOf
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUIntLE = BP.readUIntLE
  arr.readUIntBE = BP.readUIntBE
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readIntLE = BP.readIntLE
  arr.readIntBE = BP.readIntBE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUIntLE = BP.writeUIntLE
  arr.writeUIntBE = BP.writeUIntBE
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeIntLE = BP.writeIntLE
  arr.writeIntBE = BP.writeIntBE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

var INVALID_BASE64_RE = /[^+\/0-9A-z\-]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function isArrayish (subject) {
  return isArray(subject) || Buffer.isBuffer(subject) ||
      subject && typeof subject === 'object' &&
      typeof subject.length === 'number'
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []
  var i = 0

  for (; i < length; i++) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (leadSurrogate) {
        // 2 leads in a row
        if (codePoint < 0xDC00) {
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          leadSurrogate = codePoint
          continue
        } else {
          // valid surrogate pair
          codePoint = leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00 | 0x10000
          leadSurrogate = null
        }
      } else {
        // no lead yet

        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else {
          // valid lead
          leadSurrogate = codePoint
          continue
        }
      }
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
      leadSurrogate = null
    }

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x200000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

function decodeUtf8Char (str) {
  try {
    return decodeURIComponent(str)
  } catch (err) {
    return String.fromCharCode(0xFFFD) // UTF 8 invalid char
  }
}

},{"base64-js":50,"ieee754":51,"is-array":52}],50:[function(require,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)
	var PLUS_URL_SAFE = '-'.charCodeAt(0)
	var SLASH_URL_SAFE = '_'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS ||
		    code === PLUS_URL_SAFE)
			return 62 // '+'
		if (code === SLASH ||
		    code === SLASH_URL_SAFE)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],51:[function(require,module,exports){
exports.read = function(buffer, offset, isLE, mLen, nBytes) {
  var e, m,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      nBits = -7,
      i = isLE ? (nBytes - 1) : 0,
      d = isLE ? -1 : 1,
      s = buffer[offset + i];

  i += d;

  e = s & ((1 << (-nBits)) - 1);
  s >>= (-nBits);
  nBits += eLen;
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8);

  m = e & ((1 << (-nBits)) - 1);
  e >>= (-nBits);
  nBits += mLen;
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8);

  if (e === 0) {
    e = 1 - eBias;
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity);
  } else {
    m = m + Math.pow(2, mLen);
    e = e - eBias;
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
};

exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0),
      i = isLE ? 0 : (nBytes - 1),
      d = isLE ? 1 : -1,
      s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;

  value = Math.abs(value);

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0;
    e = eMax;
  } else {
    e = Math.floor(Math.log(value) / Math.LN2);
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--;
      c *= 2;
    }
    if (e + eBias >= 1) {
      value += rt / c;
    } else {
      value += rt * Math.pow(2, 1 - eBias);
    }
    if (value * c >= 2) {
      e++;
      c /= 2;
    }

    if (e + eBias >= eMax) {
      m = 0;
      e = eMax;
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen);
      e = e + eBias;
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
      e = 0;
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8);

  e = (e << mLen) | m;
  eLen += mLen;
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8);

  buffer[offset + i - d] |= s * 128;
};

},{}],52:[function(require,module,exports){

/**
 * isArray
 */

var isArray = Array.isArray;

/**
 * toString
 */

var str = Object.prototype.toString;

/**
 * Whether or not the given `val`
 * is an array.
 *
 * example:
 *
 *        isArray([]);
 *        // > true
 *        isArray(arguments);
 *        // > false
 *        isArray('');
 *        // > false
 *
 * @param {mixed} val
 * @return {bool}
 */

module.exports = isArray || function (val) {
  return !! val && '[object Array]' == str.call(val);
};

},{}],53:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        len = arguments.length;
        args = new Array(len - 1);
        for (i = 1; i < len; i++)
          args[i - 1] = arguments[i];
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    len = arguments.length;
    args = new Array(len - 1);
    for (i = 1; i < len; i++)
      args[i - 1] = arguments[i];

    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    var m;
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  var ret;
  if (!emitter._events || !emitter._events[type])
    ret = 0;
  else if (isFunction(emitter._events[type]))
    ret = 1;
  else
    ret = emitter._events[type].length;
  return ret;
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],54:[function(require,module,exports){
var http = module.exports;
var EventEmitter = require('events').EventEmitter;
var Request = require('./lib/request');
var url = require('url')

http.request = function (params, cb) {
    if (typeof params === 'string') {
        params = url.parse(params)
    }
    if (!params) params = {};
    if (!params.host && !params.port) {
        params.port = parseInt(window.location.port, 10);
    }
    if (!params.host && params.hostname) {
        params.host = params.hostname;
    }

    if (!params.protocol) {
        if (params.scheme) {
            params.protocol = params.scheme + ':';
        } else {
            params.protocol = window.location.protocol;
        }
    }

    if (!params.host) {
        params.host = window.location.hostname || window.location.host;
    }
    if (/:/.test(params.host)) {
        if (!params.port) {
            params.port = params.host.split(':')[1];
        }
        params.host = params.host.split(':')[0];
    }
    if (!params.port) params.port = params.protocol == 'https:' ? 443 : 80;
    
    var req = new Request(new xhrHttp, params);
    if (cb) req.on('response', cb);
    return req;
};

http.get = function (params, cb) {
    params.method = 'GET';
    var req = http.request(params, cb);
    req.end();
    return req;
};

http.Agent = function () {};
http.Agent.defaultMaxSockets = 4;

var xhrHttp = (function () {
    if (typeof window === 'undefined') {
        throw new Error('no window object present');
    }
    else if (window.XMLHttpRequest) {
        return window.XMLHttpRequest;
    }
    else if (window.ActiveXObject) {
        var axs = [
            'Msxml2.XMLHTTP.6.0',
            'Msxml2.XMLHTTP.3.0',
            'Microsoft.XMLHTTP'
        ];
        for (var i = 0; i < axs.length; i++) {
            try {
                var ax = new(window.ActiveXObject)(axs[i]);
                return function () {
                    if (ax) {
                        var ax_ = ax;
                        ax = null;
                        return ax_;
                    }
                    else {
                        return new(window.ActiveXObject)(axs[i]);
                    }
                };
            }
            catch (e) {}
        }
        throw new Error('ajax not supported in this browser')
    }
    else {
        throw new Error('ajax not supported in this browser');
    }
})();

http.STATUS_CODES = {
    100 : 'Continue',
    101 : 'Switching Protocols',
    102 : 'Processing',                 // RFC 2518, obsoleted by RFC 4918
    200 : 'OK',
    201 : 'Created',
    202 : 'Accepted',
    203 : 'Non-Authoritative Information',
    204 : 'No Content',
    205 : 'Reset Content',
    206 : 'Partial Content',
    207 : 'Multi-Status',               // RFC 4918
    300 : 'Multiple Choices',
    301 : 'Moved Permanently',
    302 : 'Moved Temporarily',
    303 : 'See Other',
    304 : 'Not Modified',
    305 : 'Use Proxy',
    307 : 'Temporary Redirect',
    400 : 'Bad Request',
    401 : 'Unauthorized',
    402 : 'Payment Required',
    403 : 'Forbidden',
    404 : 'Not Found',
    405 : 'Method Not Allowed',
    406 : 'Not Acceptable',
    407 : 'Proxy Authentication Required',
    408 : 'Request Time-out',
    409 : 'Conflict',
    410 : 'Gone',
    411 : 'Length Required',
    412 : 'Precondition Failed',
    413 : 'Request Entity Too Large',
    414 : 'Request-URI Too Large',
    415 : 'Unsupported Media Type',
    416 : 'Requested Range Not Satisfiable',
    417 : 'Expectation Failed',
    418 : 'I\'m a teapot',              // RFC 2324
    422 : 'Unprocessable Entity',       // RFC 4918
    423 : 'Locked',                     // RFC 4918
    424 : 'Failed Dependency',          // RFC 4918
    425 : 'Unordered Collection',       // RFC 4918
    426 : 'Upgrade Required',           // RFC 2817
    428 : 'Precondition Required',      // RFC 6585
    429 : 'Too Many Requests',          // RFC 6585
    431 : 'Request Header Fields Too Large',// RFC 6585
    500 : 'Internal Server Error',
    501 : 'Not Implemented',
    502 : 'Bad Gateway',
    503 : 'Service Unavailable',
    504 : 'Gateway Time-out',
    505 : 'HTTP Version Not Supported',
    506 : 'Variant Also Negotiates',    // RFC 2295
    507 : 'Insufficient Storage',       // RFC 4918
    509 : 'Bandwidth Limit Exceeded',
    510 : 'Not Extended',               // RFC 2774
    511 : 'Network Authentication Required' // RFC 6585
};
},{"./lib/request":55,"events":53,"url":80}],55:[function(require,module,exports){
var Stream = require('stream');
var Response = require('./response');
var Base64 = require('Base64');
var inherits = require('inherits');

var Request = module.exports = function (xhr, params) {
    var self = this;
    self.writable = true;
    self.xhr = xhr;
    self.body = [];
    
    self.uri = (params.protocol || 'http:') + '//'
        + params.host
        + (params.port ? ':' + params.port : '')
        + (params.path || '/')
    ;
    
    if (typeof params.withCredentials === 'undefined') {
        params.withCredentials = true;
    }

    try { xhr.withCredentials = params.withCredentials }
    catch (e) {}
    
    if (params.responseType) try { xhr.responseType = params.responseType }
    catch (e) {}
    
    xhr.open(
        params.method || 'GET',
        self.uri,
        true
    );

    xhr.onerror = function(event) {
        self.emit('error', new Error('Network error'));
    };

    self._headers = {};
    
    if (params.headers) {
        var keys = objectKeys(params.headers);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (!self.isSafeRequestHeader(key)) continue;
            var value = params.headers[key];
            self.setHeader(key, value);
        }
    }
    
    if (params.auth) {
        //basic auth
        this.setHeader('Authorization', 'Basic ' + Base64.btoa(params.auth));
    }

    var res = new Response;
    res.on('close', function () {
        self.emit('close');
    });
    
    res.on('ready', function () {
        self.emit('response', res);
    });

    res.on('error', function (err) {
        self.emit('error', err);
    });
    
    xhr.onreadystatechange = function () {
        // Fix for IE9 bug
        // SCRIPT575: Could not complete the operation due to error c00c023f
        // It happens when a request is aborted, calling the success callback anyway with readyState === 4
        if (xhr.__aborted) return;
        res.handle(xhr);
    };
};

inherits(Request, Stream);

Request.prototype.setHeader = function (key, value) {
    this._headers[key.toLowerCase()] = value
};

Request.prototype.getHeader = function (key) {
    return this._headers[key.toLowerCase()]
};

Request.prototype.removeHeader = function (key) {
    delete this._headers[key.toLowerCase()]
};

Request.prototype.write = function (s) {
    this.body.push(s);
};

Request.prototype.destroy = function (s) {
    this.xhr.__aborted = true;
    this.xhr.abort();
    this.emit('close');
};

Request.prototype.end = function (s) {
    if (s !== undefined) this.body.push(s);

    var keys = objectKeys(this._headers);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = this._headers[key];
        if (isArray(value)) {
            for (var j = 0; j < value.length; j++) {
                this.xhr.setRequestHeader(key, value[j]);
            }
        }
        else this.xhr.setRequestHeader(key, value)
    }

    if (this.body.length === 0) {
        this.xhr.send('');
    }
    else if (typeof this.body[0] === 'string') {
        this.xhr.send(this.body.join(''));
    }
    else if (isArray(this.body[0])) {
        var body = [];
        for (var i = 0; i < this.body.length; i++) {
            body.push.apply(body, this.body[i]);
        }
        this.xhr.send(body);
    }
    else if (/Array/.test(Object.prototype.toString.call(this.body[0]))) {
        var len = 0;
        for (var i = 0; i < this.body.length; i++) {
            len += this.body[i].length;
        }
        var body = new(this.body[0].constructor)(len);
        var k = 0;
        
        for (var i = 0; i < this.body.length; i++) {
            var b = this.body[i];
            for (var j = 0; j < b.length; j++) {
                body[k++] = b[j];
            }
        }
        this.xhr.send(body);
    }
    else if (isXHR2Compatible(this.body[0])) {
        this.xhr.send(this.body[0]);
    }
    else {
        var body = '';
        for (var i = 0; i < this.body.length; i++) {
            body += this.body[i].toString();
        }
        this.xhr.send(body);
    }
};

// Taken from http://dxr.mozilla.org/mozilla/mozilla-central/content/base/src/nsXMLHttpRequest.cpp.html
Request.unsafeHeaders = [
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "content-transfer-encoding",
    "date",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "user-agent",
    "via"
];

Request.prototype.isSafeRequestHeader = function (headerName) {
    if (!headerName) return false;
    return indexOf(Request.unsafeHeaders, headerName.toLowerCase()) === -1;
};

var objectKeys = Object.keys || function (obj) {
    var keys = [];
    for (var key in obj) keys.push(key);
    return keys;
};

var isArray = Array.isArray || function (xs) {
    return Object.prototype.toString.call(xs) === '[object Array]';
};

var indexOf = function (xs, x) {
    if (xs.indexOf) return xs.indexOf(x);
    for (var i = 0; i < xs.length; i++) {
        if (xs[i] === x) return i;
    }
    return -1;
};

var isXHR2Compatible = function (obj) {
    if (typeof Blob !== 'undefined' && obj instanceof Blob) return true;
    if (typeof ArrayBuffer !== 'undefined' && obj instanceof ArrayBuffer) return true;
    if (typeof FormData !== 'undefined' && obj instanceof FormData) return true;
};

},{"./response":56,"Base64":57,"inherits":58,"stream":77}],56:[function(require,module,exports){
var Stream = require('stream');
var util = require('util');

var Response = module.exports = function (res) {
    this.offset = 0;
    this.readable = true;
};

util.inherits(Response, Stream);

var capable = {
    streaming : true,
    status2 : true
};

function parseHeaders (res) {
    var lines = res.getAllResponseHeaders().split(/\r?\n/);
    var headers = {};
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '') continue;
        
        var m = line.match(/^([^:]+):\s*(.*)/);
        if (m) {
            var key = m[1].toLowerCase(), value = m[2];
            
            if (headers[key] !== undefined) {
            
                if (isArray(headers[key])) {
                    headers[key].push(value);
                }
                else {
                    headers[key] = [ headers[key], value ];
                }
            }
            else {
                headers[key] = value;
            }
        }
        else {
            headers[line] = true;
        }
    }
    return headers;
}

Response.prototype.getResponse = function (xhr) {
    var respType = String(xhr.responseType).toLowerCase();
    if (respType === 'blob') return xhr.responseBlob || xhr.response;
    if (respType === 'arraybuffer') return xhr.response;
    return xhr.responseText;
}

Response.prototype.getHeader = function (key) {
    return this.headers[key.toLowerCase()];
};

Response.prototype.handle = function (res) {
    if (res.readyState === 2 && capable.status2) {
        try {
            this.statusCode = res.status;
            this.headers = parseHeaders(res);
        }
        catch (err) {
            capable.status2 = false;
        }
        
        if (capable.status2) {
            this.emit('ready');
        }
    }
    else if (capable.streaming && res.readyState === 3) {
        try {
            if (!this.statusCode) {
                this.statusCode = res.status;
                this.headers = parseHeaders(res);
                this.emit('ready');
            }
        }
        catch (err) {}
        
        try {
            this._emitData(res);
        }
        catch (err) {
            capable.streaming = false;
        }
    }
    else if (res.readyState === 4) {
        if (!this.statusCode) {
            this.statusCode = res.status;
            this.emit('ready');
        }
        this._emitData(res);
        
        if (res.error) {
            this.emit('error', this.getResponse(res));
        }
        else this.emit('end');
        
        this.emit('close');
    }
};

Response.prototype._emitData = function (res) {
    var respBody = this.getResponse(res);
    if (respBody.toString().match(/ArrayBuffer/)) {
        this.emit('data', new Uint8Array(respBody, this.offset));
        this.offset = respBody.byteLength;
        return;
    }
    if (respBody.length > this.offset) {
        this.emit('data', respBody.slice(this.offset));
        this.offset = respBody.length;
    }
};

var isArray = Array.isArray || function (xs) {
    return Object.prototype.toString.call(xs) === '[object Array]';
};

},{"stream":77,"util":82}],57:[function(require,module,exports){
;(function () {

  var object = typeof exports != 'undefined' ? exports : this; // #8: web workers
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

  function InvalidCharacterError(message) {
    this.message = message;
  }
  InvalidCharacterError.prototype = new Error;
  InvalidCharacterError.prototype.name = 'InvalidCharacterError';

  // encoder
  // [https://gist.github.com/999166] by [https://github.com/nignag]
  object.btoa || (
  object.btoa = function (input) {
    for (
      // initialize result and counter
      var block, charCode, idx = 0, map = chars, output = '';
      // if the next input index does not exist:
      //   change the mapping table to "="
      //   check if d has no fractional digits
      input.charAt(idx | 0) || (map = '=', idx % 1);
      // "8 - idx % 1 * 8" generates the sequence 2, 4, 6, 8
      output += map.charAt(63 & block >> 8 - idx % 1 * 8)
    ) {
      charCode = input.charCodeAt(idx += 3/4);
      if (charCode > 0xFF) {
        throw new InvalidCharacterError("'btoa' failed: The string to be encoded contains characters outside of the Latin1 range.");
      }
      block = block << 8 | charCode;
    }
    return output;
  });

  // decoder
  // [https://gist.github.com/1020396] by [https://github.com/atk]
  object.atob || (
  object.atob = function (input) {
    input = input.replace(/=+$/, '');
    if (input.length % 4 == 1) {
      throw new InvalidCharacterError("'atob' failed: The string to be decoded is not correctly encoded.");
    }
    for (
      // initialize result and counters
      var bc = 0, bs, buffer, idx = 0, output = '';
      // get next character
      buffer = input.charAt(idx++);
      // character found in table? initialize bit storage and add its ascii value;
      ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer,
        // and if not first of each 4 characters,
        // convert the first 8 bits to one ascii character
        bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0
    ) {
      // try to find character in table (0-63, not found => -1)
      buffer = chars.indexOf(buffer);
    }
    return output;
  });

}());

},{}],58:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],59:[function(require,module,exports){
module.exports = Array.isArray || function (arr) {
  return Object.prototype.toString.call(arr) == '[object Array]';
};

},{}],60:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))
},{"_process":61}],61:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;

function drainQueue() {
    if (draining) {
        return;
    }
    draining = true;
    var currentQueue;
    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        var i = -1;
        while (++i < len) {
            currentQueue[i]();
        }
        len = queue.length;
    }
    draining = false;
}
process.nextTick = function (fun) {
    queue.push(fun);
    if (!draining) {
        setTimeout(drainQueue, 0);
    }
};

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],62:[function(require,module,exports){
(function (global){
/*! http://mths.be/punycode v1.2.4 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports;
	var freeModule = typeof module == 'object' && module &&
		module.exports == freeExports && module;
	var freeGlobal = typeof global == 'object' && global;
	if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^ -~]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /\x2E|\u3002|\uFF0E|\uFF61/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		while (length--) {
			array[length] = fn(array[length]);
		}
		return array;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings.
	 * @private
	 * @param {String} domain The domain name.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		return map(string.split(regexSeparators), fn).join('.');
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <http://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * http://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols to a Punycode string of ASCII-only
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name to Unicode. Only the
	 * Punycoded parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it on a string that has already been converted to
	 * Unicode.
	 * @memberOf punycode
	 * @param {String} domain The Punycode domain name to convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(domain) {
		return mapDomain(domain, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name to Punycode. Only the
	 * non-ASCII parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it with a domain that's already in ASCII.
	 * @memberOf punycode
	 * @param {String} domain The domain name to convert, as a Unicode string.
	 * @returns {String} The Punycode representation of the given domain name.
	 */
	function toASCII(domain) {
		return mapDomain(domain, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.2.4',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <http://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && !freeExports.nodeType) {
		if (freeModule) { // in Node.js or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else { // in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else { // in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],63:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],64:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],65:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":63,"./encode":64}],66:[function(require,module,exports){
module.exports = require("./lib/_stream_duplex.js")

},{"./lib/_stream_duplex.js":67}],67:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

module.exports = Duplex;

/*<replacement>*/
var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) keys.push(key);
  return keys;
}
/*</replacement>*/


/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Readable = require('./_stream_readable');
var Writable = require('./_stream_writable');

util.inherits(Duplex, Readable);

forEach(objectKeys(Writable.prototype), function(method) {
  if (!Duplex.prototype[method])
    Duplex.prototype[method] = Writable.prototype[method];
});

function Duplex(options) {
  if (!(this instanceof Duplex))
    return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false)
    this.readable = false;

  if (options && options.writable === false)
    this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false)
    this.allowHalfOpen = false;

  this.once('end', onend);
}

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended)
    return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  process.nextTick(this.end.bind(this));
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

}).call(this,require('_process'))
},{"./_stream_readable":69,"./_stream_writable":71,"_process":61,"core-util-is":72,"inherits":58}],68:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

module.exports = PassThrough;

var Transform = require('./_stream_transform');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough))
    return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function(chunk, encoding, cb) {
  cb(null, chunk);
};

},{"./_stream_transform":70,"core-util-is":72,"inherits":58}],69:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Readable;

/*<replacement>*/
var isArray = require('isarray');
/*</replacement>*/


/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Readable.ReadableState = ReadableState;

var EE = require('events').EventEmitter;

/*<replacement>*/
if (!EE.listenerCount) EE.listenerCount = function(emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

var Stream = require('stream');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var StringDecoder;


/*<replacement>*/
var debug = require('util');
if (debug && debug.debuglog) {
  debug = debug.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/


util.inherits(Readable, Stream);

function ReadableState(options, stream) {
  var Duplex = require('./_stream_duplex');

  options = options || {};

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var defaultHwm = options.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.buffer = [];
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;


  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex)
    this.objectMode = this.objectMode || !!options.readableObjectMode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // when piping, we only care about 'readable' events that happen
  // after read()ing all the bytes and not getting any pushback.
  this.ranOut = false;

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder)
      StringDecoder = require('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  var Duplex = require('./_stream_duplex');

  if (!(this instanceof Readable))
    return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  Stream.call(this);
}

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function(chunk, encoding) {
  var state = this._readableState;

  if (util.isString(chunk) && !state.objectMode) {
    encoding = encoding || state.defaultEncoding;
    if (encoding !== state.encoding) {
      chunk = new Buffer(chunk, encoding);
      encoding = '';
    }
  }

  return readableAddChunk(this, state, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function(chunk) {
  var state = this._readableState;
  return readableAddChunk(this, state, chunk, '', true);
};

function readableAddChunk(stream, state, chunk, encoding, addToFront) {
  var er = chunkInvalid(state, chunk);
  if (er) {
    stream.emit('error', er);
  } else if (util.isNullOrUndefined(chunk)) {
    state.reading = false;
    if (!state.ended)
      onEofChunk(stream, state);
  } else if (state.objectMode || chunk && chunk.length > 0) {
    if (state.ended && !addToFront) {
      var e = new Error('stream.push() after EOF');
      stream.emit('error', e);
    } else if (state.endEmitted && addToFront) {
      var e = new Error('stream.unshift() after end event');
      stream.emit('error', e);
    } else {
      if (state.decoder && !addToFront && !encoding)
        chunk = state.decoder.write(chunk);

      if (!addToFront)
        state.reading = false;

      // if we want the data now, just emit it.
      if (state.flowing && state.length === 0 && !state.sync) {
        stream.emit('data', chunk);
        stream.read(0);
      } else {
        // update the buffer info.
        state.length += state.objectMode ? 1 : chunk.length;
        if (addToFront)
          state.buffer.unshift(chunk);
        else
          state.buffer.push(chunk);

        if (state.needReadable)
          emitReadable(stream);
      }

      maybeReadMore(stream, state);
    }
  } else if (!addToFront) {
    state.reading = false;
  }

  return needMoreData(state);
}



// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended &&
         (state.needReadable ||
          state.length < state.highWaterMark ||
          state.length === 0);
}

// backwards compatibility.
Readable.prototype.setEncoding = function(enc) {
  if (!StringDecoder)
    StringDecoder = require('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 128MB
var MAX_HWM = 0x800000;
function roundUpToNextPowerOf2(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2
    n--;
    for (var p = 1; p < 32; p <<= 1) n |= n >> p;
    n++;
  }
  return n;
}

function howMuchToRead(n, state) {
  if (state.length === 0 && state.ended)
    return 0;

  if (state.objectMode)
    return n === 0 ? 0 : 1;

  if (isNaN(n) || util.isNull(n)) {
    // only flow one buffer at a time
    if (state.flowing && state.buffer.length)
      return state.buffer[0].length;
    else
      return state.length;
  }

  if (n <= 0)
    return 0;

  // If we're asking for more than the target buffer level,
  // then raise the water mark.  Bump up to the next highest
  // power of 2, to prevent increasing it excessively in tiny
  // amounts.
  if (n > state.highWaterMark)
    state.highWaterMark = roundUpToNextPowerOf2(n);

  // don't have that much.  return null, unless we've ended.
  if (n > state.length) {
    if (!state.ended) {
      state.needReadable = true;
      return 0;
    } else
      return state.length;
  }

  return n;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function(n) {
  debug('read', n);
  var state = this._readableState;
  var nOrig = n;

  if (!util.isNumber(n) || n > 0)
    state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 &&
      state.needReadable &&
      (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended)
      endReadable(this);
    else
      emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0)
      endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  }

  if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0)
      state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
  }

  // If _read pushed data synchronously, then `reading` will be false,
  // and we need to re-evaluate how much data we can return to the user.
  if (doRead && !state.reading)
    n = howMuchToRead(nOrig, state);

  var ret;
  if (n > 0)
    ret = fromList(n, state);
  else
    ret = null;

  if (util.isNull(ret)) {
    state.needReadable = true;
    n = 0;
  }

  state.length -= n;

  // If we have nothing in the buffer, then we want to know
  // as soon as we *do* get something into the buffer.
  if (state.length === 0 && !state.ended)
    state.needReadable = true;

  // If we tried to read() past the EOF, then emit end on the next tick.
  if (nOrig !== n && state.ended && state.length === 0)
    endReadable(this);

  if (!util.isNull(ret))
    this.emit('data', ret);

  return ret;
};

function chunkInvalid(state, chunk) {
  var er = null;
  if (!util.isBuffer(chunk) &&
      !util.isString(chunk) &&
      !util.isNullOrUndefined(chunk) &&
      !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}


function onEofChunk(stream, state) {
  if (state.decoder && !state.ended) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync)
      process.nextTick(function() {
        emitReadable_(stream);
      });
    else
      emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}


// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    process.nextTick(function() {
      maybeReadMore_(stream, state);
    });
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended &&
         state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;
    else
      len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function(n) {
  this.emit('error', new Error('not implemented'));
};

Readable.prototype.pipe = function(dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) &&
              dest !== process.stdout &&
              dest !== process.stderr;

  var endFn = doEnd ? onend : cleanup;
  if (state.endEmitted)
    process.nextTick(endFn);
  else
    src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable) {
    debug('onunpipe');
    if (readable === src) {
      cleanup();
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', cleanup);
    src.removeListener('data', ondata);

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain &&
        (!dest._writableState || dest._writableState.needDrain))
      ondrain();
  }

  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    var ret = dest.write(chunk);
    if (false === ret) {
      debug('false write response, pause',
            src._readableState.awaitDrain);
      src._readableState.awaitDrain++;
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EE.listenerCount(dest, 'error') === 0)
      dest.emit('error', er);
  }
  // This is a brutally ugly hack to make sure that our error handler
  // is attached before any userland ones.  NEVER DO THIS.
  if (!dest._events || !dest._events.error)
    dest.on('error', onerror);
  else if (isArray(dest._events.error))
    dest._events.error.unshift(onerror);
  else
    dest._events.error = [onerror, dest._events.error];



  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function() {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain)
      state.awaitDrain--;
    if (state.awaitDrain === 0 && EE.listenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}


Readable.prototype.unpipe = function(dest) {
  var state = this._readableState;

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0)
    return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes)
      return this;

    if (!dest)
      dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest)
      dest.emit('unpipe', this);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++)
      dests[i].emit('unpipe', this);
    return this;
  }

  // try to find the right one.
  var i = indexOf(state.pipes, dest);
  if (i === -1)
    return this;

  state.pipes.splice(i, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1)
    state.pipes = state.pipes[0];

  dest.emit('unpipe', this);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function(ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  // If listening to data, and it has not explicitly been paused,
  // then call resume to start the flow of data on the next tick.
  if (ev === 'data' && false !== this._readableState.flowing) {
    this.resume();
  }

  if (ev === 'readable' && this.readable) {
    var state = this._readableState;
    if (!state.readableListening) {
      state.readableListening = true;
      state.emittedReadable = false;
      state.needReadable = true;
      if (!state.reading) {
        var self = this;
        process.nextTick(function() {
          debug('readable nexttick read 0');
          self.read(0);
        });
      } else if (state.length) {
        emitReadable(this, state);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function() {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    if (!state.reading) {
      debug('resume read 0');
      this.read(0);
    }
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    process.nextTick(function() {
      resume_(stream, state);
    });
  }
}

function resume_(stream, state) {
  state.resumeScheduled = false;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading)
    stream.read(0);
}

Readable.prototype.pause = function() {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  if (state.flowing) {
    do {
      var chunk = stream.read();
    } while (null !== chunk && state.flowing);
  }
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function(stream) {
  var state = this._readableState;
  var paused = false;

  var self = this;
  stream.on('end', function() {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length)
        self.push(chunk);
    }

    self.push(null);
  });

  stream.on('data', function(chunk) {
    debug('wrapped data');
    if (state.decoder)
      chunk = state.decoder.write(chunk);
    if (!chunk || !state.objectMode && !chunk.length)
      return;

    var ret = self.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (util.isFunction(stream[i]) && util.isUndefined(this[i])) {
      this[i] = function(method) { return function() {
        return stream[method].apply(stream, arguments);
      }}(i);
    }
  }

  // proxy certain important events.
  var events = ['error', 'close', 'destroy', 'pause', 'resume'];
  forEach(events, function(ev) {
    stream.on(ev, self.emit.bind(self, ev));
  });

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  self._read = function(n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return self;
};



// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
function fromList(n, state) {
  var list = state.buffer;
  var length = state.length;
  var stringMode = !!state.decoder;
  var objectMode = !!state.objectMode;
  var ret;

  // nothing in the list, definitely empty.
  if (list.length === 0)
    return null;

  if (length === 0)
    ret = null;
  else if (objectMode)
    ret = list.shift();
  else if (!n || n >= length) {
    // read it all, truncate the array.
    if (stringMode)
      ret = list.join('');
    else
      ret = Buffer.concat(list, length);
    list.length = 0;
  } else {
    // read just some of it.
    if (n < list[0].length) {
      // just take a part of the first list item.
      // slice is the same for buffers and strings.
      var buf = list[0];
      ret = buf.slice(0, n);
      list[0] = buf.slice(n);
    } else if (n === list[0].length) {
      // first list is a perfect match
      ret = list.shift();
    } else {
      // complex case.
      // we have enough to cover it, but it spans past the first buffer.
      if (stringMode)
        ret = '';
      else
        ret = new Buffer(n);

      var c = 0;
      for (var i = 0, l = list.length; i < l && c < n; i++) {
        var buf = list[0];
        var cpy = Math.min(n - c, buf.length);

        if (stringMode)
          ret += buf.slice(0, cpy);
        else
          buf.copy(ret, c, 0, cpy);

        if (cpy < buf.length)
          list[0] = buf.slice(cpy);
        else
          list.shift();

        c += cpy;
      }
    }
  }

  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0)
    throw new Error('endReadable called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    process.nextTick(function() {
      // Check that we didn't get one last unshift.
      if (!state.endEmitted && state.length === 0) {
        state.endEmitted = true;
        stream.readable = false;
        stream.emit('end');
      }
    });
  }
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

function indexOf (xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}

}).call(this,require('_process'))
},{"./_stream_duplex":67,"_process":61,"buffer":49,"core-util-is":72,"events":53,"inherits":58,"isarray":59,"stream":77,"string_decoder/":78,"util":48}],70:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.


// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

module.exports = Transform;

var Duplex = require('./_stream_duplex');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);


function TransformState(options, stream) {
  this.afterTransform = function(er, data) {
    return afterTransform(stream, er, data);
  };

  this.needTransform = false;
  this.transforming = false;
  this.writecb = null;
  this.writechunk = null;
}

function afterTransform(stream, er, data) {
  var ts = stream._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb)
    return stream.emit('error', new Error('no writecb in Transform class'));

  ts.writechunk = null;
  ts.writecb = null;

  if (!util.isNullOrUndefined(data))
    stream.push(data);

  if (cb)
    cb(er);

  var rs = stream._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    stream._read(rs.highWaterMark);
  }
}


function Transform(options) {
  if (!(this instanceof Transform))
    return new Transform(options);

  Duplex.call(this, options);

  this._transformState = new TransformState(options, this);

  // when the writable side finishes, then flush out anything remaining.
  var stream = this;

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  this.once('prefinish', function() {
    if (util.isFunction(this._flush))
      this._flush(function(er) {
        done(stream, er);
      });
    else
      done(stream);
  });
}

Transform.prototype.push = function(chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function(chunk, encoding, cb) {
  throw new Error('not implemented');
};

Transform.prototype._write = function(chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform ||
        rs.needReadable ||
        rs.length < rs.highWaterMark)
      this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function(n) {
  var ts = this._transformState;

  if (!util.isNull(ts.writechunk) && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};


function done(stream, er) {
  if (er)
    return stream.emit('error', er);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  var ws = stream._writableState;
  var ts = stream._transformState;

  if (ws.length)
    throw new Error('calling transform done when ws.length != 0');

  if (ts.transforming)
    throw new Error('calling transform done when still transforming');

  return stream.push(null);
}

},{"./_stream_duplex":67,"core-util-is":72,"inherits":58}],71:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// A bit simpler than readable streams.
// Implement an async ._write(chunk, cb), and it'll handle all
// the drain event emission and buffering.

module.exports = Writable;

/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Writable.WritableState = WritableState;


/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Stream = require('stream');

util.inherits(Writable, Stream);

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
}

function WritableState(options, stream) {
  var Duplex = require('./_stream_duplex');

  options = options || {};

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var defaultHwm = options.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex)
    this.objectMode = this.objectMode || !!options.writableObjectMode;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function(er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.buffer = [];

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;
}

function Writable(options) {
  var Duplex = require('./_stream_duplex');

  // Writable ctor is applied to Duplexes, though they're not
  // instanceof Writable, they're instanceof Readable.
  if (!(this instanceof Writable) && !(this instanceof Duplex))
    return new Writable(options);

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function() {
  this.emit('error', new Error('Cannot pipe. Not readable.'));
};


function writeAfterEnd(stream, state, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  process.nextTick(function() {
    cb(er);
  });
}

// If we get something that is not a buffer, string, null, or undefined,
// and we're not in objectMode, then that's an error.
// Otherwise stream chunks are all considered to be of length=1, and the
// watermarks determine how many objects to keep in the buffer, rather than
// how many bytes or characters.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  if (!util.isBuffer(chunk) &&
      !util.isString(chunk) &&
      !util.isNullOrUndefined(chunk) &&
      !state.objectMode) {
    var er = new TypeError('Invalid non-string/buffer chunk');
    stream.emit('error', er);
    process.nextTick(function() {
      cb(er);
    });
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function(chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;

  if (util.isFunction(encoding)) {
    cb = encoding;
    encoding = null;
  }

  if (util.isBuffer(chunk))
    encoding = 'buffer';
  else if (!encoding)
    encoding = state.defaultEncoding;

  if (!util.isFunction(cb))
    cb = function() {};

  if (state.ended)
    writeAfterEnd(this, state, cb);
  else if (validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function() {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function() {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing &&
        !state.corked &&
        !state.finished &&
        !state.bufferProcessing &&
        state.buffer.length)
      clearBuffer(this, state);
  }
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode &&
      state.decodeStrings !== false &&
      util.isString(chunk)) {
    chunk = new Buffer(chunk, encoding);
  }
  return chunk;
}

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, chunk, encoding, cb) {
  chunk = decodeChunk(state, chunk, encoding);
  if (util.isBuffer(chunk))
    encoding = 'buffer';
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret)
    state.needDrain = true;

  if (state.writing || state.corked)
    state.buffer.push(new WriteReq(chunk, encoding, cb));
  else
    doWrite(stream, state, false, len, chunk, encoding, cb);

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev)
    stream._writev(chunk, state.onwrite);
  else
    stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  if (sync)
    process.nextTick(function() {
      state.pendingcb--;
      cb(er);
    });
  else {
    state.pendingcb--;
    cb(er);
  }

  stream._writableState.errorEmitted = true;
  stream.emit('error', er);
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er)
    onwriteError(stream, state, sync, er, cb);
  else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(stream, state);

    if (!finished &&
        !state.corked &&
        !state.bufferProcessing &&
        state.buffer.length) {
      clearBuffer(stream, state);
    }

    if (sync) {
      process.nextTick(function() {
        afterWrite(stream, state, finished, cb);
      });
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished)
    onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}


// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;

  if (stream._writev && state.buffer.length > 1) {
    // Fast case, write everything using _writev()
    var cbs = [];
    for (var c = 0; c < state.buffer.length; c++)
      cbs.push(state.buffer[c].callback);

    // count the one we are adding, as well.
    // TODO(isaacs) clean this up
    state.pendingcb++;
    doWrite(stream, state, true, state.length, state.buffer, '', function(err) {
      for (var i = 0; i < cbs.length; i++) {
        state.pendingcb--;
        cbs[i](err);
      }
    });

    // Clear buffer
    state.buffer = [];
  } else {
    // Slow case, write chunks one-by-one
    for (var c = 0; c < state.buffer.length; c++) {
      var entry = state.buffer[c];
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);

      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        c++;
        break;
      }
    }

    if (c < state.buffer.length)
      state.buffer = state.buffer.slice(c);
    else
      state.buffer.length = 0;
  }

  state.bufferProcessing = false;
}

Writable.prototype._write = function(chunk, encoding, cb) {
  cb(new Error('not implemented'));

};

Writable.prototype._writev = null;

Writable.prototype.end = function(chunk, encoding, cb) {
  var state = this._writableState;

  if (util.isFunction(chunk)) {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (util.isFunction(encoding)) {
    cb = encoding;
    encoding = null;
  }

  if (!util.isNullOrUndefined(chunk))
    this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished)
    endWritable(this, state, cb);
};


function needFinish(stream, state) {
  return (state.ending &&
          state.length === 0 &&
          !state.finished &&
          !state.writing);
}

function prefinish(stream, state) {
  if (!state.prefinished) {
    state.prefinished = true;
    stream.emit('prefinish');
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(stream, state);
  if (need) {
    if (state.pendingcb === 0) {
      prefinish(stream, state);
      state.finished = true;
      stream.emit('finish');
    } else
      prefinish(stream, state);
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished)
      process.nextTick(cb);
    else
      stream.once('finish', cb);
  }
  state.ended = true;
}

}).call(this,require('_process'))
},{"./_stream_duplex":67,"_process":61,"buffer":49,"core-util-is":72,"inherits":58,"stream":77}],72:[function(require,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

function isBuffer(arg) {
  return Buffer.isBuffer(arg);
}
exports.isBuffer = isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}
}).call(this,require("buffer").Buffer)
},{"buffer":49}],73:[function(require,module,exports){
module.exports = require("./lib/_stream_passthrough.js")

},{"./lib/_stream_passthrough.js":68}],74:[function(require,module,exports){
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = require('stream');
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');

},{"./lib/_stream_duplex.js":67,"./lib/_stream_passthrough.js":68,"./lib/_stream_readable.js":69,"./lib/_stream_transform.js":70,"./lib/_stream_writable.js":71,"stream":77}],75:[function(require,module,exports){
module.exports = require("./lib/_stream_transform.js")

},{"./lib/_stream_transform.js":70}],76:[function(require,module,exports){
module.exports = require("./lib/_stream_writable.js")

},{"./lib/_stream_writable.js":71}],77:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Stream;

var EE = require('events').EventEmitter;
var inherits = require('inherits');

inherits(Stream, EE);
Stream.Readable = require('readable-stream/readable.js');
Stream.Writable = require('readable-stream/writable.js');
Stream.Duplex = require('readable-stream/duplex.js');
Stream.Transform = require('readable-stream/transform.js');
Stream.PassThrough = require('readable-stream/passthrough.js');

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;



// old-style streams.  Note that the pipe method (the only relevant
// part of this class) is overridden in the Readable class.

function Stream() {
  EE.call(this);
}

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (EE.listenerCount(this, 'error') === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

},{"events":53,"inherits":58,"readable-stream/duplex.js":66,"readable-stream/passthrough.js":73,"readable-stream/readable.js":74,"readable-stream/transform.js":75,"readable-stream/writable.js":76}],78:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var Buffer = require('buffer').Buffer;

var isBufferEncoding = Buffer.isEncoding
  || function(encoding) {
       switch (encoding && encoding.toLowerCase()) {
         case 'hex': case 'utf8': case 'utf-8': case 'ascii': case 'binary': case 'base64': case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': case 'raw': return true;
         default: return false;
       }
     }


function assertEncoding(encoding) {
  if (encoding && !isBufferEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding);
  }
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters. CESU-8 is handled as part of the UTF-8 encoding.
//
// @TODO Handling all encodings inside a single object makes it very difficult
// to reason about this code, so it should be split up in the future.
// @TODO There should be a utf8-strict encoding that rejects invalid UTF-8 code
// points as used by CESU-8.
var StringDecoder = exports.StringDecoder = function(encoding) {
  this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
  assertEncoding(encoding);
  switch (this.encoding) {
    case 'utf8':
      // CESU-8 represents each of Surrogate Pair by 3-bytes
      this.surrogateSize = 3;
      break;
    case 'ucs2':
    case 'utf16le':
      // UTF-16 represents each of Surrogate Pair by 2-bytes
      this.surrogateSize = 2;
      this.detectIncompleteChar = utf16DetectIncompleteChar;
      break;
    case 'base64':
      // Base-64 stores 3 bytes in 4 chars, and pads the remainder.
      this.surrogateSize = 3;
      this.detectIncompleteChar = base64DetectIncompleteChar;
      break;
    default:
      this.write = passThroughWrite;
      return;
  }

  // Enough space to store all bytes of a single character. UTF-8 needs 4
  // bytes, but CESU-8 may require up to 6 (3 bytes per surrogate).
  this.charBuffer = new Buffer(6);
  // Number of bytes received for the current incomplete multi-byte character.
  this.charReceived = 0;
  // Number of bytes expected for the current incomplete multi-byte character.
  this.charLength = 0;
};


// write decodes the given buffer and returns it as JS string that is
// guaranteed to not contain any partial multi-byte characters. Any partial
// character found at the end of the buffer is buffered up, and will be
// returned when calling write again with the remaining bytes.
//
// Note: Converting a Buffer containing an orphan surrogate to a String
// currently works, but converting a String to a Buffer (via `new Buffer`, or
// Buffer#write) will replace incomplete surrogates with the unicode
// replacement character. See https://codereview.chromium.org/121173009/ .
StringDecoder.prototype.write = function(buffer) {
  var charStr = '';
  // if our last write ended with an incomplete multibyte character
  while (this.charLength) {
    // determine how many remaining bytes this buffer has to offer for this char
    var available = (buffer.length >= this.charLength - this.charReceived) ?
        this.charLength - this.charReceived :
        buffer.length;

    // add the new bytes to the char buffer
    buffer.copy(this.charBuffer, this.charReceived, 0, available);
    this.charReceived += available;

    if (this.charReceived < this.charLength) {
      // still not enough chars in this buffer? wait for more ...
      return '';
    }

    // remove bytes belonging to the current character from the buffer
    buffer = buffer.slice(available, buffer.length);

    // get the character that was split
    charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);

    // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
    var charCode = charStr.charCodeAt(charStr.length - 1);
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      this.charLength += this.surrogateSize;
      charStr = '';
      continue;
    }
    this.charReceived = this.charLength = 0;

    // if there are no more bytes in this buffer, just emit our char
    if (buffer.length === 0) {
      return charStr;
    }
    break;
  }

  // determine and set charLength / charReceived
  this.detectIncompleteChar(buffer);

  var end = buffer.length;
  if (this.charLength) {
    // buffer the incomplete character bytes we got
    buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
    end -= this.charReceived;
  }

  charStr += buffer.toString(this.encoding, 0, end);

  var end = charStr.length - 1;
  var charCode = charStr.charCodeAt(end);
  // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
  if (charCode >= 0xD800 && charCode <= 0xDBFF) {
    var size = this.surrogateSize;
    this.charLength += size;
    this.charReceived += size;
    this.charBuffer.copy(this.charBuffer, size, 0, size);
    buffer.copy(this.charBuffer, 0, 0, size);
    return charStr.substring(0, end);
  }

  // or just emit the charStr
  return charStr;
};

// detectIncompleteChar determines if there is an incomplete UTF-8 character at
// the end of the given buffer. If so, it sets this.charLength to the byte
// length that character, and sets this.charReceived to the number of bytes
// that are available for this character.
StringDecoder.prototype.detectIncompleteChar = function(buffer) {
  // determine how many bytes we have to check at the end of this buffer
  var i = (buffer.length >= 3) ? 3 : buffer.length;

  // Figure out if one of the last i bytes of our buffer announces an
  // incomplete char.
  for (; i > 0; i--) {
    var c = buffer[buffer.length - i];

    // See http://en.wikipedia.org/wiki/UTF-8#Description

    // 110XXXXX
    if (i == 1 && c >> 5 == 0x06) {
      this.charLength = 2;
      break;
    }

    // 1110XXXX
    if (i <= 2 && c >> 4 == 0x0E) {
      this.charLength = 3;
      break;
    }

    // 11110XXX
    if (i <= 3 && c >> 3 == 0x1E) {
      this.charLength = 4;
      break;
    }
  }
  this.charReceived = i;
};

StringDecoder.prototype.end = function(buffer) {
  var res = '';
  if (buffer && buffer.length)
    res = this.write(buffer);

  if (this.charReceived) {
    var cr = this.charReceived;
    var buf = this.charBuffer;
    var enc = this.encoding;
    res += buf.slice(0, cr).toString(enc);
  }

  return res;
};

function passThroughWrite(buffer) {
  return buffer.toString(this.encoding);
}

function utf16DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 2;
  this.charLength = this.charReceived ? 2 : 0;
}

function base64DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 3;
  this.charLength = this.charReceived ? 3 : 0;
}

},{"buffer":49}],79:[function(require,module,exports){
exports.isatty = function () { return false; };

function ReadStream() {
  throw new Error('tty.ReadStream is not implemented');
}
exports.ReadStream = ReadStream;

function WriteStream() {
  throw new Error('tty.ReadStream is not implemented');
}
exports.WriteStream = WriteStream;

},{}],80:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var punycode = require('punycode');

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a puny coded representation of "domain".
      // It only converts the part of the domain name that
      // has non ASCII characters. I.e. it dosent matter if
      // you call it with a domain that already is in ASCII.
      var domainArray = this.hostname.split('.');
      var newOut = [];
      for (var i = 0; i < domainArray.length; ++i) {
        var s = domainArray[i];
        newOut.push(s.match(/[^A-Za-z0-9_-]/) ?
            'xn--' + punycode.encode(s) : s);
      }
      this.hostname = newOut.join('.');
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  Object.keys(this).forEach(function(k) {
    result[k] = this[k];
  }, this);

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    Object.keys(relative).forEach(function(k) {
      if (k !== 'protocol')
        result[k] = relative[k];
    });

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      Object.keys(relative).forEach(function(k) {
        result[k] = relative[k];
      });
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especialy happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!isNull(result.pathname) || !isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host) && (last === '.' || last === '..') ||
      last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last == '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especialy happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!isNull(result.pathname) || !isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

function isString(arg) {
  return typeof arg === "string";
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isNull(arg) {
  return arg === null;
}
function isNullOrUndefined(arg) {
  return  arg == null;
}

},{"punycode":62,"querystring":65}],81:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],82:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":81,"_process":61,"inherits":58}],83:[function(require,module,exports){
var indexOf = require('indexof');

var Object_keys = function (obj) {
    if (Object.keys) return Object.keys(obj)
    else {
        var res = [];
        for (var key in obj) res.push(key)
        return res;
    }
};

var forEach = function (xs, fn) {
    if (xs.forEach) return xs.forEach(fn)
    else for (var i = 0; i < xs.length; i++) {
        fn(xs[i], i, xs);
    }
};

var defineProp = (function() {
    try {
        Object.defineProperty({}, '_', {});
        return function(obj, name, value) {
            Object.defineProperty(obj, name, {
                writable: true,
                enumerable: false,
                configurable: true,
                value: value
            })
        };
    } catch(e) {
        return function(obj, name, value) {
            obj[name] = value;
        };
    }
}());

var globals = ['Array', 'Boolean', 'Date', 'Error', 'EvalError', 'Function',
'Infinity', 'JSON', 'Math', 'NaN', 'Number', 'Object', 'RangeError',
'ReferenceError', 'RegExp', 'String', 'SyntaxError', 'TypeError', 'URIError',
'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape'];

function Context() {}
Context.prototype = {};

var Script = exports.Script = function NodeScript (code) {
    if (!(this instanceof Script)) return new Script(code);
    this.code = code;
};

Script.prototype.runInContext = function (context) {
    if (!(context instanceof Context)) {
        throw new TypeError("needs a 'context' argument.");
    }
    
    var iframe = document.createElement('iframe');
    if (!iframe.style) iframe.style = {};
    iframe.style.display = 'none';
    
    document.body.appendChild(iframe);
    
    var win = iframe.contentWindow;
    var wEval = win.eval, wExecScript = win.execScript;

    if (!wEval && wExecScript) {
        // win.eval() magically appears when this is called in IE:
        wExecScript.call(win, 'null');
        wEval = win.eval;
    }
    
    forEach(Object_keys(context), function (key) {
        win[key] = context[key];
    });
    forEach(globals, function (key) {
        if (context[key]) {
            win[key] = context[key];
        }
    });
    
    var winKeys = Object_keys(win);

    var res = wEval.call(win, this.code);
    
    forEach(Object_keys(win), function (key) {
        // Avoid copying circular objects like `top` and `window` by only
        // updating existing context properties or new properties in the `win`
        // that was only introduced after the eval.
        if (key in context || indexOf(winKeys, key) === -1) {
            context[key] = win[key];
        }
    });

    forEach(globals, function (key) {
        if (!(key in context)) {
            defineProp(context, key, win[key]);
        }
    });
    
    document.body.removeChild(iframe);
    
    return res;
};

Script.prototype.runInThisContext = function () {
    return eval(this.code); // maybe...
};

Script.prototype.runInNewContext = function (context) {
    var ctx = Script.createContext(context);
    var res = this.runInContext(ctx);

    forEach(Object_keys(ctx), function (key) {
        context[key] = ctx[key];
    });

    return res;
};

forEach(Object_keys(Script.prototype), function (name) {
    exports[name] = Script[name] = function (code) {
        var s = Script(code);
        return s[name].apply(s, [].slice.call(arguments, 1));
    };
});

exports.createScript = function (code) {
    return exports.Script(code);
};

exports.createContext = Script.createContext = function (context) {
    var copy = new Context();
    if(typeof context === 'object') {
        forEach(Object_keys(context), function (key) {
            copy[key] = context[key];
        });
    }
    return copy;
};

},{"indexof":84}],84:[function(require,module,exports){

var indexOf = [].indexOf;

module.exports = function(arr, obj){
  if (indexOf) return arr.indexOf(obj);
  for (var i = 0; i < arr.length; ++i) {
    if (arr[i] === obj) return i;
  }
  return -1;
};
},{}]},{},[46])(46)
});